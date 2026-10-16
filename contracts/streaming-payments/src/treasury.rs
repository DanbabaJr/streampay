//! Treasury accounting: protocol fees, their accumulation, governance, and
//! the public reads that make the fee ledger independently verifiable.
//!
//! # Fee model
//!
//! Fees are charged **at the deposit boundary only**: when a stream is
//! created, the sender pays `deposit + fee` in one pull, where
//! `fee = deposit * fee_bps / 10_000` (floored). The stream's `deposit`
//! is exactly the requested amount — nothing in the per-second accrual math
//! (`streamed_at`, `available_amount`, `cancel_amounts`) ever sees the fee.
//! At `fee_bps == 0` (the default, and the only state any v0.3 deployment
//! ever ran in) no fee is computed, no extra tokens are pulled, no treasury
//! state is written and no `FeeCharged` event is emitted: behavior is
//! bit-for-bit identical to a fee-less contract.
//!
//! The fee is **non-refundable** and sits entirely outside the stream: on
//! cancel the recipient still receives `streamed - withdrawn` and the sender
//! `deposit - streamed`, exactly as without fees; the fee is never part of
//! either leg.
//!
//! # Accumulation and withdrawal governance
//!
//! Fees accumulate in a per-token accounting entry ([`Treasury`]): every
//! charged fee adds to `charged_total`, every governor withdrawal adds to
//! `withdrawn_total`. The collectible balance is `charged_total -
//! withdrawn_total` (checked). Withdrawals are governor-gated, one-shot per
//! call, and emit `FeeWithdrawn` *before* moving tokens (CEI).
//!
//! The governor is bound at deploy time by the contract constructor
//! (`__constructor(governor)`), so there is no front-runnable bootstrap
//! window. Later rotations are two-step (`nominate_governor` +
//! `accept_governor`) so a typo'd address can never strand the treasury.
//!
//! # Verification
//!
//! The core invariant is `charged_total == sum of all FeeCharged events ==
//! sum of per-stream stored fees`, provable from public reads alone:
//!
//! - `treasury_status(token)` — totals + config, one call.
//! - `verify_treasury(token, start_id, count)` — bounded scan over the
//!   stream-id space summing stored per-stream fees; anyone pages through
//!   ids `1..=total_streams()` and compares against `charged_total`.
//! - `stream_fee(stream_id)` — per-stream fee, cross-checkable against each
//!   `FeeCharged` event (amount and effective bps are both in the event).
//!
//! `scripts/verify-fees.ts` automates all three cross-checks (stored
//! totals vs. scanned fees vs. decoded events) against a public RPC.

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::StreamError;
use crate::stream::{DataKey, MAX_PAGE_SIZE, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

/// Basis-point denominator: `10_000` bps == 100 %.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Hard cap on the configurable protocol fee: 100 bps (1 %).
///
/// This is a protocol-level constant, not governance-settable: it bounds the
/// worst-case sender cost at creation and keeps the fee layer economically
/// conservative. Raising it would require a new Wasm release (and is an
/// explicit, auditable interface change).
pub const MAX_FEE_BPS: u32 = 100;

/// Per-token fee accounting.
///
/// Kept in persistent storage under [`DataKey::Treasury`], written only by
/// fee-affecting entrypoints, so it changes strictly in step with the
/// `FeeCharged` / `FeeWithdrawn` event streams.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Treasury {
    /// Total fees ever charged for this token (Σ `FeeCharged` events).
    pub charged_total: i128,
    /// Total fees ever withdrawn for this token (Σ `FeeWithdrawn` events).
    pub withdrawn_total: i128,
}

impl Treasury {
    /// Fees currently held for this token: charged minus withdrawn. Checked;
    /// a consistent contract can never underflow here.
    pub fn collectible(&self) -> Result<i128, StreamError> {
        self.charged_total
            .checked_sub(self.withdrawn_total)
            .ok_or(StreamError::MathOverflow)
    }
}

/// Stored per-stream fee: amount plus the token it was charged in. The
/// token rides along so the shared id-space verification scan can filter one
/// token's fees without a second lookup per id.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamFeeRecord {
    pub token: Address,
    pub amount: i128,
}

/// Pure fee math: the protocol fee for a `deposit` at `fee_bps`, in smallest
/// token units, floored. Zero for zero/negative deposits (callers reject
/// those anyway) and for rates that round below one whole unit — a fee that
/// floors to zero charges nothing, emits nothing, and stores nothing.
///
/// Checked math: `deposit * fee_bps` is widened to `u128`; if even that
/// cannot hold the product (deposit near `i128::MAX` at high bps), returns
/// [`StreamError::MathOverflow`] instead of wrapping. The result is
/// `< deposit` whenever `0 < fee_bps < 10_000`, so the narrowing cast is
/// safe whenever the product fit.
pub fn fee_amount(deposit: i128, fee_bps: u32) -> Result<i128, StreamError> {
    if fee_bps == 0 || deposit <= 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(StreamError::MathOverflow)?;
    Ok((product / (BPS_DENOMINATOR as u128)) as i128)
}

/// Currently configured fee rate in basis points. Absent (pre-fee
/// deployments or simply never set) means 0 — fees disabled.
pub fn current_fee_bps(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
}

/// Persists the fee rate (instance storage; governor-gated at the call
/// site).
pub fn set_fee_bps(env: &Env, bps: u32) {
    env.storage().instance().set(&DataKey::FeeBps, &bps);
}

/// The treasury governor. Falls back to the contract's own address only for
/// deployments that somehow lack the constructor-set value (unreachable via
/// this codebase's deploy path; keeps the read total for verifiers).
pub fn governor(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Governor)
        .unwrap_or_else(|| env.current_contract_address())
}

/// The pending governor nominee, if any (two-step rotation in progress).
pub fn pending_governor(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingGovernor)
}

/// Business-rule governor check with a typed error: a stranger gets
/// [`StreamError::NotGovernor`] rather than an SDK auth panic; only a
/// matching governor's authorization is consumed.
pub fn require_governor(env: &Env, caller: &Address) -> Result<(), StreamError> {
    let stored: Address = env
        .storage()
        .instance()
        .get(&DataKey::Governor)
        .ok_or_else(|| surface::reject(Branch::GovernorNotAllowed))?;
    if stored != *caller {
        return Err(surface::reject(Branch::GovernorNotAllowed));
    }
    caller.require_auth();
    Ok(())
}

/// Loads the treasury accounting for `token`; missing entries read as zero.
pub fn get_treasury(env: &Env, token: &Address) -> Treasury {
    env.storage()
        .persistent()
        .get(&DataKey::Treasury(token.clone()))
        .unwrap_or(Treasury {
            charged_total: 0,
            withdrawn_total: 0,
        })
}

/// Persists treasury accounting for `token` and extends its TTL, so a
/// treasury in active use never archives.
pub fn put_treasury(env: &Env, token: &Address, treasury: &Treasury) {
    let key = DataKey::Treasury(token.clone());
    env.storage().persistent().set(&key, treasury);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Effects-side of charging a fee at stream creation: bumps the token's
/// `charged_total`, stores the per-stream fee, and extends TTLs. The
/// `FeeCharged` event is published by the caller (so event ordering within
/// `create_stream` stays explicit); this function performs no token
/// transfers (interaction already happened at the pull).
pub fn apply_fee(
    env: &Env,
    token: &Address,
    stream_id: u64,
    amount: i128,
) -> Result<(), StreamError> {
    let mut treasury = get_treasury(env, token);
    treasury.charged_total = treasury
        .charged_total
        .checked_add(amount)
        .ok_or(StreamError::MathOverflow)?;
    put_treasury(env, token, &treasury);

    let fee_key = DataKey::StreamFee(stream_id);
    env.storage().persistent().set(
        &fee_key,
        &StreamFeeRecord {
            token: token.clone(),
            amount,
        },
    );
    env.storage()
        .persistent()
        .extend_ttl(&fee_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Ok(())
}

/// The fee charged for one stream at creation (0 when absent — the stream
/// predates the fee layer, was created while `fee_bps == 0`, or its fee
/// floored to zero). Callers that expose this publicly should first check
/// the stream exists.
pub fn stream_fee(env: &Env, stream_id: u64) -> i128 {
    let record: Option<StreamFeeRecord> = env
        .storage()
        .persistent()
        .get(&DataKey::StreamFee(stream_id));
    record.map_or(0, |r| r.amount)
}

/// One call snapshot of the treasury state for a token: governance, current
/// fee configuration, and the fee ledger totals that verifiers reconcile
/// against events and per-stream fees.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreasuryStatus {
    /// The token this accounting belongs to.
    pub token: Address,
    /// Current treasury governor.
    pub governor: Address,
    /// Pending governor nominee, if a rotation is awaiting acceptance.
    pub pending_governor: Option<Address>,
    /// Currently configured fee rate in basis points (0 = fees disabled).
    pub fee_bps: u32,
    /// The protocol cap on `fee_bps` (published so clients need no constant).
    pub max_fee_bps: u32,
    /// Total fees ever charged for this token (Σ `FeeCharged` events).
    pub charged_total: i128,
    /// Total fees ever withdrawn for this token (Σ `FeeWithdrawn` events).
    pub withdrawn_total: i128,
    /// Fees currently held: `charged_total - withdrawn_total`.
    pub collectible: i128,
}

/// Result of one bounded verification scan over the stream-id space
/// (see [`crate::StreamingPayments::verify_treasury`]).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeScan {
    /// Token whose fees were scanned.
    pub token: Address,
    /// First stream id of the scan window.
    pub start_id: u64,
    /// Number of stream ids actually examined (window may be shorter than
    /// requested near the end of the id space).
    pub scanned_count: u32,
    /// Sum of per-stream stored fees within the window.
    pub fees_in_range: i128,
    /// Where the next scan window starts (scan is finished when
    /// `done` is true).
    pub next_start: u64,
    /// True when the window reached the end of the id space — paging from
    /// id 1 until `done` visits every stream exactly once.
    pub done: bool,
}

/// One bounded page of the verification scan: sums stored per-stream fees
/// over `[start_id, start_id + count)` clamped to the live id space, extends
/// the TTL of every fee entry it touches (an actively-verified ledger never
/// archives), and reports where to continue. Deliberately bounded per call
/// (`count` clamped to [`MAX_PAGE_SIZE`]) — no unbounded scans.
pub fn scan_fees(env: &Env, token: &Address, start_id: u64, count: u32) -> FeeScan {
    // Next id to hand out; streams occupy ids 1..=next_id-1.
    let next_id: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::NextStreamId)
        .unwrap_or(1);
    let start = start_id.max(1);
    let end = start
        .saturating_add((count.min(MAX_PAGE_SIZE)) as u64)
        .min(next_id);

    let mut fees_in_range: i128 = 0;
    let mut scanned: u32 = 0;
    let mut id = start;
    while id < end {
        let key = DataKey::StreamFee(id);
        let stored: Option<StreamFeeRecord> = env.storage().persistent().get(&key);
        if let Some(record) = stored {
            // Other tokens' fees share the id space; filter them out so the
            // scanned sum reconciles exactly with this token's totals.
            if record.token == *token {
                // A consistent contract can never overflow here (Σ fees per
                // token equals charged_total, itself checked on write); the
                // saturating form keeps even a corrupted scan panic-free.
                fees_in_range = fees_in_range.saturating_add(record.amount);
            }
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        }
        id = id.saturating_add(1);
        scanned = scanned.saturating_add(1);
    }

    FeeScan {
        token: token.clone(),
        start_id: start,
        scanned_count: scanned,
        fees_in_range,
        next_start: end.max(start),
        done: end >= next_id,
    }
}
