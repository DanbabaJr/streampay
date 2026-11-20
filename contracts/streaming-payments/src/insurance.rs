use soroban_sdk::{contracttype, token::TokenClient, Address, Env};

use crate::errors::StreamError;
use crate::events::{ClaimFiled, ClaimPaid, ClaimRejected, PremiumAccrued};
use crate::stream::{get_stream, StreamStatus, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// Default insurance fee slice: 0 bps (opt-in by governance).
pub const DEFAULT_INSURANCE_SLICE_BPS: u32 = 0;
pub const DEFAULT_MAX_PAYOUT_PER_INCIDENT: i128 = 100_000_000_000;
pub const DEFAULT_MAX_PAYOUT_PER_EPOCH: i128 = 500_000_000_000;
pub const DEFAULT_EPOCH_DURATION_SECONDS: u64 = 30 * 24 * 60 * 60; // 30 days
pub const DEFAULT_CLAIM_TIMELOCK_SECONDS: u64 = 2 * 24 * 60 * 60; // 2 days

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsurancePool {
    pub token: Address,
    pub balance: i128,
    pub total_premiums: i128,
    pub total_claims_paid: i128,
    pub epoch_start: u64,
    pub epoch_claims_paid: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsuranceConfig {
    pub fee_slice_bps: u32,
    pub max_payout_per_incident: i128,
    pub max_payout_per_epoch: i128,
    pub epoch_duration_seconds: u64,
    pub claim_timelock_seconds: u64,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ClaimStatus {
    Pending = 1,
    Approved = 2,
    Paid = 3,
    Rejected = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsuranceClaim {
    pub claim_id: u64,
    pub stream_id: u64,
    pub token: Address,
    pub recipient: Address,
    pub amount: i128,
    pub filed_at: u64,
    pub timelock_until: u64,
    pub status: ClaimStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InsuranceDataKey {
    Pool(Address),
    Config,
    Claim(u64),
    NextClaimId,
}

pub fn get_config(env: &Env) -> InsuranceConfig {
    env.storage()
        .instance()
        .get(&InsuranceDataKey::Config)
        .unwrap_or(InsuranceConfig {
            fee_slice_bps: DEFAULT_INSURANCE_SLICE_BPS,
            max_payout_per_incident: DEFAULT_MAX_PAYOUT_PER_INCIDENT,
            max_payout_per_epoch: DEFAULT_MAX_PAYOUT_PER_EPOCH,
            epoch_duration_seconds: DEFAULT_EPOCH_DURATION_SECONDS,
            claim_timelock_seconds: DEFAULT_CLAIM_TIMELOCK_SECONDS,
        })
}

pub fn set_config(env: &Env, config: &InsuranceConfig) {
    env.storage().instance().set(&InsuranceDataKey::Config, config);
}

pub fn get_next_claim_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&InsuranceDataKey::NextClaimId)
        .unwrap_or(1u64)
}

pub fn increment_claim_id(env: &Env) -> u64 {
    let id = get_next_claim_id(env);
    let next = id.saturating_add(1);
    env.storage()
        .instance()
        .set(&InsuranceDataKey::NextClaimId, &next);
    id
}

pub fn get_pool(env: &Env, token: &Address) -> Option<InsurancePool> {
    env.storage()
        .persistent()
        .get(&InsuranceDataKey::Pool(token.clone()))
}

pub fn put_pool(env: &Env, pool: &InsurancePool) {
    let key = InsuranceDataKey::Pool(pool.token.clone());
    env.storage().persistent().set(&key, pool);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn get_claim(env: &Env, claim_id: u64) -> Option<InsuranceClaim> {
    env.storage()
        .persistent()
        .get(&InsuranceDataKey::Claim(claim_id))
}

pub fn put_claim(env: &Env, claim: &InsuranceClaim) {
    let key = InsuranceDataKey::Claim(claim.claim_id);
    env.storage().persistent().set(&key, claim);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Routes a governance-set slice of protocol fees into the segregated insurance pool.
/// Returns the remaining fee portion that stays in protocol treasury.
pub fn route_fee_slice(env: &Env, token: &Address, total_fee: i128) -> i128 {
    if total_fee <= 0 {
        return 0;
    }
    let config = get_config(env);
    if config.fee_slice_bps == 0 {
        return total_fee;
    }

    let insurance_slice = (total_fee.saturating_mul(config.fee_slice_bps as i128)) / 10_000;
    let treasury_remains = total_fee.saturating_sub(insurance_slice);

    if insurance_slice > 0 {
        let now = env.ledger().timestamp();
        let mut pool = get_pool(env, token).unwrap_or(InsurancePool {
            token: token.clone(),
            balance: 0,
            total_premiums: 0,
            total_claims_paid: 0,
            epoch_start: now,
            epoch_claims_paid: 0,
        });

        pool.balance = pool.balance.saturating_add(insurance_slice);
        pool.total_premiums = pool.total_premiums.saturating_add(insurance_slice);
        put_pool(env, &pool);

        PremiumAccrued {
            token: token.clone(),
            amount: insurance_slice,
            pool_balance: pool.balance,
        }
        .publish(env);
    }

    treasury_remains
}

/// Files an insurance claim for stream default or cancelled/clawed back deposit.
pub fn file_claim(
    env: &Env,
    caller: &Address,
    stream_id: u64,
    amount: i128,
) -> Result<u64, StreamError> {
    caller.require_auth();
    if amount <= 0 {
        return Err(surface::reject(Branch::InsuranceCapExceeded));
    }

    let stream = get_stream(env, stream_id)?;
    if stream.recipient != *caller {
        return Err(surface::reject(Branch::InsuranceInvalidLossProof));
    }
    // Stream must have defaulted, been cancelled or be depleted
    if stream.status == StreamStatus::Active && env.ledger().timestamp() < stream.end_time {
        return Err(surface::reject(Branch::InsuranceInvalidLossProof));
    }

    let config = get_config(env);
    if amount > config.max_payout_per_incident {
        return Err(surface::reject(Branch::InsuranceCapExceeded));
    }

    let now = env.ledger().timestamp();
    let claim_id = increment_claim_id(env);
    let timelock_until = now.saturating_add(config.claim_timelock_seconds);

    let claim = InsuranceClaim {
        claim_id,
        stream_id,
        token: stream.token.clone(),
        recipient: caller.clone(),
        amount,
        filed_at: now,
        timelock_until,
        status: ClaimStatus::Pending,
    };
    put_claim(env, &claim);

    ClaimFiled {
        claim_id,
        stream_id,
        recipient: caller.clone(),
        amount,
    }
    .publish(env);

    Ok(claim_id)
}

/// Governance timelock approval of an insurance claim.
pub fn approve_claim(env: &Env, governor: &Address, claim_id: u64) -> Result<(), StreamError> {
    governor.require_auth();
    let mut claim = get_claim(env, claim_id)
        .ok_or_else(|| surface::reject(Branch::InsuranceClaimNotFound))?;

    if claim.status != ClaimStatus::Pending {
        return Err(surface::reject(Branch::InsuranceClaimNotApproved));
    }
    let now = env.ledger().timestamp();
    if now < claim.timelock_until {
        return Err(surface::reject(Branch::InsuranceClaimTimelockNotElapsed));
    }

    claim.status = ClaimStatus::Approved;
    put_claim(env, &claim);
    Ok(())
}

/// Governance rejection of an insurance claim.
pub fn reject_claim(
    env: &Env,
    governor: &Address,
    claim_id: u64,
    reason: u32,
) -> Result<(), StreamError> {
    governor.require_auth();
    let mut claim = get_claim(env, claim_id)
        .ok_or_else(|| surface::reject(Branch::InsuranceClaimNotFound))?;

    if claim.status != ClaimStatus::Pending {
        return Err(surface::reject(Branch::InsuranceClaimNotApproved));
    }

    claim.status = ClaimStatus::Rejected;
    put_claim(env, &claim);

    ClaimRejected { claim_id, reason }.publish(env);
    Ok(())
}

/// Payout an approved insurance claim.
/// Enforces solvency invariant: pool liabilities never exceed pool assets!
/// Follows CEI ordering: checks -> state mutations/event -> token interaction.
pub fn payout_claim(env: &Env, claim_id: u64) -> Result<(), StreamError> {
    let mut claim = get_claim(env, claim_id)
        .ok_or_else(|| surface::reject(Branch::InsuranceClaimNotFound))?;

    if claim.status != ClaimStatus::Approved {
        return Err(surface::reject(Branch::InsuranceClaimNotApproved));
    }

    let mut pool = get_pool(env, &claim.token)
        .ok_or_else(|| surface::reject(Branch::InsurancePoolInsolvent))?;

    // Solvency invariant check
    if pool.balance < claim.amount {
        return Err(surface::reject(Branch::InsurancePoolInsolvent));
    }

    let config = get_config(env);
    if claim.amount > config.max_payout_per_incident {
        return Err(surface::reject(Branch::InsuranceCapExceeded));
    }

    // Check epoch cap with rollover
    let now = env.ledger().timestamp();
    if now >= pool.epoch_start.saturating_add(config.epoch_duration_seconds) {
        pool.epoch_start = now;
        pool.epoch_claims_paid = 0;
    }

    let new_epoch_claims = pool.epoch_claims_paid.saturating_add(claim.amount);
    if new_epoch_claims > config.max_payout_per_epoch {
        return Err(surface::reject(Branch::InsuranceCapExceeded));
    }

    // CEI Effects: update pool and claim before external call
    pool.balance = pool.balance.saturating_sub(claim.amount);
    pool.total_claims_paid = pool.total_claims_paid.saturating_add(claim.amount);
    pool.epoch_claims_paid = new_epoch_claims;
    claim.status = ClaimStatus::Paid;

    put_pool(env, &pool);
    put_claim(env, &claim);

    ClaimPaid {
        claim_id,
        recipient: claim.recipient.clone(),
        amount: claim.amount,
        remaining_balance: pool.balance,
    }
    .publish(env);

    // CEI Interactions: move tokens to recipient
    let current_contract = env.current_contract_address();
    TokenClient::new(env, &claim.token)
        .try_transfer(&current_contract, &claim.recipient, &claim.amount)
        .map_err(|_| surface::reject(Branch::RecipientPayoutFailed))?
        .map_err(|_| surface::reject(Branch::RecipientPayoutFailed))?;

    Ok(())
}
