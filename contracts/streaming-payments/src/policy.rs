//! Asset allowlist policy and governance module.
//!
//! An optional, strictly-governed policy module that restricts which assets
//! may be used to create *new* streams, while guaranteeing existing streams of
//! a removed asset remain fully withdrawable and refundable (the anti-brick
//! invariant).
//!
//! # Governance model
//!
//! - **Two-step handoff**: The active admin proposes a new admin via
//!   [`StreamingPayments::policy_propose_handoff`]. The proposed admin must
//!   explicitly accept via [`StreamingPayments::policy_accept_handoff`] before
//!   taking control. A pending handoff can be cancelled at any time by the
//!   current admin via [`StreamingPayments::policy_cancel_handoff`].
//! - **Timelock on allowlist mutations**: Any allowlist change (adding or
//!   removing an asset) is queued via
//!   [`StreamingPayments::policy_propose_asset`] and timestamped. It can only
//!   be executed after a configurable timelock delay has elapsed, giving users
//!   advance notice and time to act. The delay is readable on-chain via
//!   [`StreamingPayments::policy_timelock_delay`].
//! - **Permissionless execution**: Once the timelock delay has elapsed, anyone
//!   may call [`StreamingPayments::policy_execute_asset`] to apply the queued
//!   change. Permissionless execution ensures that a policy change cannot be
//!   delayed, withheld, or held hostage by an unavailable or compromised admin
//!   once approved and matured.
//! - **Opt-in & Anti-brick**: An uninitialized policy module allows all assets
//!   by default. Even when initialized, any asset without an explicit policy
//!   record is allowed. Existing streams are never checked against the allowlist
//!   during `withdraw` or `cancel_stream` (refund), ensuring tokens already locked
//!   in active streams can always be fully settled.

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::StreamError;
use crate::events::{
    PolicyAssetExecuted, PolicyAssetQueued, PolicyHandoffAccepted, PolicyHandoffCancelled,
    PolicyHandoffProposed, PolicyInitialized,
};
use crate::stream::{TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// Default timelock delay: 2 days (172,800 seconds).
pub const DEFAULT_TIMELOCK_DELAY: u64 = 172_800;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Storage keys for the policy module."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Distinct enum ensures no collision with existing `DataKey` keys."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicyDataKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Active admin address (instance storage)."
    )]
    Admin,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposed admin address awaiting acceptance (instance storage)."
    )]
    PendingAdmin,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Configured timelock delay in seconds (instance storage)."
    )]
    TimelockDelay,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Explicit allowlist status for an asset: `true` = allowed, `false` = removed"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (persistent storage). Absent means default allowed."
    )]
    Asset(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Queued allowlist change for an asset (persistent storage)."
    )]
    QueuedAsset(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream policy for a specific asset (persistent storage)."
    )]
    StreamPolicy(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Default global stream policy (instance storage)."
    )]
    GlobalStreamPolicy,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Governance-managed policy floors and ceilings for streams."
)]
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StreamPolicy {
    pub min_rate: i128,
    pub max_rate: i128,
    pub min_duration: u64,
    pub max_duration: u64,
    pub min_deposit: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Queued policy change for an asset awaiting timelock expiry."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedAssetChange {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Desired allowlist state (true = allowed, false = removed)."
    )]
    pub allowed: bool,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Timestamp when the change was queued."
    )]
    pub queued_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the change can be executed."
    )]
    pub executable_after: u64,
}

/// Checks if the policy module has been initialized.
pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&PolicyDataKey::Admin)
}

/// Returns the current admin address, if initialized.
pub fn admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&PolicyDataKey::Admin)
}

/// Returns the proposed new admin address, if a handoff is pending.
pub fn pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&PolicyDataKey::PendingAdmin)
}

/// Returns the configured timelock delay in seconds.
pub fn timelock_delay(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&PolicyDataKey::TimelockDelay)
        .unwrap_or(DEFAULT_TIMELOCK_DELAY)
}

/// Verifies that the caller is the current admin and consumes their authorization.
pub fn require_admin(env: &Env) -> Result<Address, StreamError> {
    let current_admin: Address = env
        .storage()
        .instance()
        .get(&PolicyDataKey::Admin)
        .ok_or_else(|| surface::reject(Branch::PolicyNotInitialized))?;
    current_admin.require_auth();
    Ok(current_admin)
}

/// Checks if an asset is allowed for creating new streams.
///
/// If the policy module is not initialized, all assets are allowed (opt-in).
/// If initialized, an asset with no explicit record is allowed by default.
pub fn is_asset_allowed(env: &Env, asset: &Address) -> bool {
    if !is_initialized(env) {
        return true;
    }
    let key = PolicyDataKey::Asset(asset.clone());
    let allowed: Option<bool> = env.storage().persistent().get(&key);
    allowed.unwrap_or(true)
}

/// Validates that `asset` is allowed before opening a new stream.
///
/// Reverts with [`StreamError::PolicyAssetNotAllowed`] if explicitly removed.
pub fn check_asset_allowed(env: &Env, asset: &Address) -> Result<(), StreamError> {
    if !is_asset_allowed(env, asset) {
        return Err(surface::reject(Branch::PolicyAssetNotAllowed));
    }
    Ok(())
}

/// Initializes the policy module with an initial admin.
///
/// Panics if called more than once.
pub fn init(env: &Env, initial_admin: &Address) {
    if is_initialized(env) {
        panic!("policy already initialized");
    }
    initial_admin.require_auth();

    env.storage()
        .instance()
        .set(&PolicyDataKey::Admin, initial_admin);
    env.storage()
        .instance()
        .set(&PolicyDataKey::TimelockDelay, &DEFAULT_TIMELOCK_DELAY);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    PolicyInitialized {
        admin: initial_admin.clone(),
    }
    .publish(env);
}

/// Sets a new timelock delay (admin-only).
pub fn set_timelock_delay(env: &Env, delay: u64) -> Result<(), StreamError> {
    require_admin(env)?;
    env.storage()
        .instance()
        .set(&PolicyDataKey::TimelockDelay, &delay);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Ok(())
}

/// Queues an allowlist mutation for `asset` with a timelock delay.
pub fn propose_asset(env: &Env, asset: Address, allowed: bool) -> Result<(), StreamError> {
    require_admin(env)?;
    let now = env.ledger().timestamp();
    let delay = timelock_delay(env);
    let executable_after = now.saturating_add(delay);

    let queued = QueuedAssetChange {
        allowed,
        queued_at: now,
        executable_after,
    };

    let key = PolicyDataKey::QueuedAsset(asset.clone());
    env.storage().persistent().set(&key, &queued);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    PolicyAssetQueued {
        asset,
        allowed,
        executable_after,
    }
    .publish(env);

    Ok(())
}

/// Loads a queued change for `asset`, if any.
pub fn get_queued_asset(env: &Env, asset: &Address) -> Option<QueuedAssetChange> {
    let key = PolicyDataKey::QueuedAsset(asset.clone());
    let queued: Option<QueuedAssetChange> = env.storage().persistent().get(&key);
    if queued.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }
    queued
}

/// Executes a queued change after its timelock has elapsed (permissionless).
pub fn execute_asset(env: &Env, asset: Address) -> Result<(), StreamError> {
    if !is_initialized(env) {
        return Err(surface::reject(Branch::PolicyNotInitialized));
    }
    let queued = get_queued_asset(env, &asset)
        .ok_or_else(|| surface::reject(Branch::PolicyNoQueuedChange))?;

    let now = env.ledger().timestamp();
    if now < queued.executable_after {
        return Err(surface::reject(Branch::PolicyTimelockNotElapsed));
    }

    // Effects first: update allowlist and remove queued record.
    let asset_key = PolicyDataKey::Asset(asset.clone());
    env.storage().persistent().set(&asset_key, &queued.allowed);
    env.storage()
        .persistent()
        .extend_ttl(&asset_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let queue_key = PolicyDataKey::QueuedAsset(asset.clone());
    env.storage().persistent().remove(&queue_key);

    PolicyAssetExecuted {
        asset,
        allowed: queued.allowed,
    }
    .publish(env);

    Ok(())
}

/// Proposes a new admin for the two-step handoff (admin-only).
pub fn propose_handoff(env: &Env, new_admin: Address) -> Result<(), StreamError> {
    let current_admin = require_admin(env)?;
    env.storage()
        .instance()
        .set(&PolicyDataKey::PendingAdmin, &new_admin);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    PolicyHandoffProposed {
        current_admin,
        proposed_admin: new_admin,
    }
    .publish(env);

    Ok(())
}

/// Accepts a pending admin handoff (only callable by the proposed new admin).
pub fn accept_handoff(env: &Env) -> Result<(), StreamError> {
    if !is_initialized(env) {
        return Err(surface::reject(Branch::PolicyNotInitialized));
    }
    let pending: Address =
        pending_admin(env).ok_or_else(|| surface::reject(Branch::PolicyNoPendingHandoff))?;
    pending.require_auth();

    env.storage()
        .instance()
        .set(&PolicyDataKey::Admin, &pending);
    env.storage()
        .instance()
        .remove(&PolicyDataKey::PendingAdmin);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    PolicyHandoffAccepted { new_admin: pending }.publish(env);

    Ok(())
}

/// Cancels a pending admin handoff (admin-only).
pub fn cancel_handoff(env: &Env) -> Result<(), StreamError> {
    let _admin = require_admin(env)?;
    let pending: Address =
        pending_admin(env).ok_or_else(|| surface::reject(Branch::PolicyNoPendingHandoff))?;

    env.storage()
        .instance()
        .remove(&PolicyDataKey::PendingAdmin);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    PolicyHandoffCancelled {
        proposed_admin: pending,
    }
    .publish(env);

    Ok(())
}

/// Loads the effective stream policy for `token`, falling back to global policy.
pub fn get_stream_policy(env: &Env, token: Option<Address>) -> Option<StreamPolicy> {
    if let Some(token_addr) = token {
        let key = PolicyDataKey::StreamPolicy(token_addr);
        if let Some(policy) = env.storage().persistent().get::<_, StreamPolicy>(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
            return Some(policy);
        }
    }
    env.storage()
        .instance()
        .get(&PolicyDataKey::GlobalStreamPolicy)
}

/// Sets the stream policy for `token` (or default global policy if `token` is None).
pub fn set_stream_policy(
    env: &Env,
    token: Option<Address>,
    new_policy: StreamPolicy,
) -> Result<(), StreamError> {
    let old_policy = get_stream_policy(env, token.clone());
    if let Some(ref token_addr) = token {
        let key = PolicyDataKey::StreamPolicy(token_addr.clone());
        env.storage().persistent().set(&key, &new_policy);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    } else {
        env.storage()
            .instance()
            .set(&PolicyDataKey::GlobalStreamPolicy, &new_policy);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }

    crate::events::StreamPolicySet {
        token,
        old_policy,
        new_policy,
    }
    .publish(env);

    Ok(())
}

/// Pure validation of stream creation arguments against policy floors and ceilings.
///
/// Returns typed append-only errors ([`StreamError::PolicyDepositBelowFloor`],
/// [`StreamError::PolicyDurationBelowFloor`], [`StreamError::PolicyDurationAboveCeiling`],
/// [`StreamError::PolicyRateBelowFloor`], [`StreamError::PolicyRateAboveCeiling`]).
pub fn validate_stream_args(
    policy: Option<&StreamPolicy>,
    deposit: i128,
    duration: u64,
) -> Result<(), StreamError> {
    if let Some(p) = policy {
        if p.min_deposit > 0 && deposit < p.min_deposit {
            return Err(surface::reject(Branch::PolicyDepositBelowFloor));
        }
        if p.min_duration > 0 && duration < p.min_duration {
            return Err(surface::reject(Branch::PolicyDurationBelowFloor));
        }
        if p.max_duration > 0 && duration > p.max_duration {
            return Err(surface::reject(Branch::PolicyDurationAboveCeiling));
        }
        let rate = deposit / (duration.max(1) as i128);
        if p.min_rate > 0 && rate < p.min_rate {
            return Err(surface::reject(Branch::PolicyRateBelowFloor));
        }
        if p.max_rate > 0 && rate > p.max_rate {
            return Err(surface::reject(Branch::PolicyRateAboveCeiling));
        }
    }
    Ok(())
}

/// Grandfather-aware validation for stream top-ups.
///
/// Existing streams grandfather: policy changes to duration do not block top-ups
/// on already-running streams. Only mutations that would cause the stream itself
/// to violate deposit or rate limits (e.g. rate ceiling exceeded or rate below floor)
/// are rejected.
pub fn validate_top_up_args(
    policy: Option<&StreamPolicy>,
    new_deposit: i128,
    duration: u64,
) -> Result<(), StreamError> {
    if let Some(p) = policy {
        if p.min_deposit > 0 && new_deposit < p.min_deposit {
            return Err(surface::reject(Branch::PolicyDepositBelowFloor));
        }
        let rate = new_deposit / (duration.max(1) as i128);
        if p.min_rate > 0 && rate < p.min_rate {
            return Err(surface::reject(Branch::PolicyRateBelowFloor));
        }
        if p.max_rate > 0 && rate > p.max_rate {
            return Err(surface::reject(Branch::PolicyRateAboveCeiling));
        }
    }
    Ok(())
}

/// Validation of an explicitly negotiated rate against the policy rate bounds.
///
/// A renegotiation states its rate directly (`amount_per_second`), so there is no
/// deposit/duration quotient to derive it from, and the stream's window is
/// unchanged, so the duration bounds are not re-checked. Only the rate floor and
/// ceiling bind.
pub fn validate_rate_args(
    policy: Option<&StreamPolicy>,
    amount_per_second: i128,
) -> Result<(), StreamError> {
    if let Some(p) = policy {
        if p.min_rate > 0 && amount_per_second < p.min_rate {
            return Err(surface::reject(Branch::RatePolicyBelowFloor));
        }
        if p.max_rate > 0 && amount_per_second > p.max_rate {
            return Err(surface::reject(Branch::RatePolicyAboveCeiling));
        }
    }
    Ok(())
}
