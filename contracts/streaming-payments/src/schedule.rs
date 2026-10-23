//! Scheduled stream intents: sender-authorized, keeper-executable stream
//! creation.
//!
//! A sender can pre-authorize the creation of a stream at a future time — or a
//! recurring "cron" of streams — by calling
//! [`crate::StreamingPayments::schedule_stream`]. The sender's authorization is
//! consumed at scheduling time (their signature over the scheduling invocation
//! is verified by the host), and the **exact** scheduling parameters are
//! committed into a [`ScheduledIntent::params_hash`]. A permissionless keeper
//! then calls [`crate::StreamingPayments::execute_scheduled`] to materialize
//! each occurrence, paying itself the escrowed per-occurrence fee.
//!
//! # Non-replayability & scope bounding
//!
//! - **One execution per occurrence.** Each `execute_scheduled` call decrements
//!   `occurrences_remaining`; a one-shot intent becomes terminal after its one
//!   execution. A second execution of a completed occurrence reverts with
//!   [`StreamError::IntentNotPending`].
//! - **Expiry.** No occurrence may be executed at/after `expires_at`
//!   ([`StreamError::IntentExpired`]); the escrow is then refundable to the
//!   sender via `reclaim_expired`.
//! - **Exact parameters.** `params_hash` is a SHA-256 commitment over every
//!   immutable scheduling parameter. Execution recomputes it from storage and
//!   refuses to proceed if it no longer matches
//!   ([`StreamError::IntentParamsMismatch`]).
//! - **Timing gates.** An occurrence cannot be executed before its `due` time
//!   ([`StreamError::IntentNotYetExecutable`]) and only the sender may cancel,
//!   and only before the execution window opens
//!   ([`StreamError::IntentNotCancellable`]).
//!
//! See `docs/SCHEDULED_INTENTS.md` for the full threat model, keeper economics,
//! and the under-funded-keeper griefing analysis.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env};

use crate::errors::StreamError;
use crate::stream::{self, DataKey, MAX_DURATION_SECONDS};
use crate::surface::{reject, Branch};

/// Maximum number of occurrences a single recurring intent may schedule.
/// Bounds the up-front escrow and the per-call bookkeeping.
pub const MAX_OCCURRENCES: u32 = 1000;

/// TTL maintenance for intent entries, mirroring streams (see `stream.rs`).
const TTL_THRESHOLD_LEDGERS: u32 = 200_000;
const TTL_EXTEND_LEDGERS: u32 = 500_000;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Lifecycle state of a scheduled intent."
)]
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum IntentStatus {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Authorized and (partially) executable; some occurrences remain."
    )]
    Pending,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Every occurrence has been materialized into a stream. Terminal."
    )]
    Executed,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancelled by the sender before the execution window opened. Terminal."
    )]
    Cancelled,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Passed `expires_at` with occurrences outstanding; escrow refunded."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " Terminal.")]
    Expired,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A sender-authorized, keeper-executable intent to create one or more streams."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `deposit` and `fee_budget` are *per occurrence*: the sender escrows"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `(deposit + fee_budget) * occurrences_total` at scheduling time. Each"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " execution creates one stream and pays the keeper one `fee_budget`."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledIntent {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Deposit escrowed for *each* occurrence."
    )]
    pub deposit: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Scheduled start of the first occurrence."
    )]
    pub start_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Scheduled end of the first occurrence (`end_time > start_time`)."
    )]
    pub end_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Whether created streams may be cancelled by their recipient."
    )]
    pub cancelable: bool,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Seconds between occurrence starts; `0` for a one-shot intent."
    )]
    pub interval: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total occurrences this intent will ever create (`>= 1`)."
    )]
    pub occurrences_total: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Occurrences not yet materialized."
    )]
    pub occurrences_remaining: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Keeper fee escrowed for *each* occurrence (`>= 0`)."
    )]
    pub fee_budget: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Earliest time the first occurrence may be executed."
    )]
    pub execute_after: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " After this time no occurrence may be executed."
    )]
    pub expires_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " SHA-256 commitment over every immutable scheduling parameter."
    )]
    pub params_hash: BytesN<32>,
    pub status: IntentStatus,
}

impl ScheduledIntent {
    /// Seconds in a single occurrence's window (`>= 1`).
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }

    /// Number of occurrences already materialized.
    pub fn executed_count(&self) -> u32 {
        self.occurrences_total
            .saturating_sub(self.occurrences_remaining)
    }

    /// Half-open window `[start, end)` of occurrence `index` (0-based).
    ///
    /// Saturating arithmetic is used to avoid panics; the recurrence window is
    /// validated at scheduling time so saturation is unreachable for stored
    /// intents.
    pub fn occurrence_window(&self, index: u32) -> (u64, u64) {
        let shift = self.interval.saturating_mul(index as u64);
        (
            self.start_time.saturating_add(shift),
            self.end_time.saturating_add(shift),
        )
    }

    /// Earliest time occurrence `index` may be executed.
    pub fn occurrence_due(&self, index: u32) -> u64 {
        self.execute_after
            .saturating_add(self.interval.saturating_mul(index as u64))
    }

    /// Escrow still locked for the outstanding occurrences.
    pub fn remaining_escrow(&self) -> Result<i128, StreamError> {
        let per = self
            .deposit
            .checked_add(self.fee_budget)
            .ok_or(StreamError::MathOverflow)?;
        per.checked_mul(self.occurrences_remaining as i128)
            .ok_or(StreamError::MathOverflow)
    }
}

#[allow(clippy::too_many_arguments)]
/// Computes the SHA-256 commitment over the immutable scheduling parameters.
///
/// Addresses are canonicalized via their StrKey string form so the commitment
/// is stable and platform-independent. Mutable bookkeeping (`status`,
/// `occurrences_remaining`, generated `id`) is deliberately excluded, so the
/// commitment stays constant for the lifetime of the intent.
pub fn params_hash(
    env: &Env,
    sender: &Address,
    recipient: &Address,
    token: &Address,
    deposit: i128,
    start_time: u64,
    end_time: u64,
    cancelable: bool,
    interval: u64,
    occurrences: u32,
    fee_budget: i128,
    execute_after: u64,
    expires_at: u64,
) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&sender.to_string().to_bytes());
    buf.append(&recipient.to_string().to_bytes());
    buf.append(&token.to_string().to_bytes());
    buf.extend_from_slice(&deposit.to_be_bytes());
    buf.extend_from_slice(&start_time.to_be_bytes());
    buf.extend_from_slice(&end_time.to_be_bytes());
    buf.extend_from_slice(&[cancelable as u8]);
    buf.extend_from_slice(&interval.to_be_bytes());
    buf.extend_from_slice(&occurrences.to_be_bytes());
    buf.extend_from_slice(&fee_budget.to_be_bytes());
    buf.extend_from_slice(&execute_after.to_be_bytes());
    buf.extend_from_slice(&expires_at.to_be_bytes());
    env.crypto().sha256(&buf).to_bytes()
}

/// Recomputes the commitment from a stored intent; used as a defensive
/// integrity check at execution time.
pub fn intent_params_hash(env: &Env, intent: &ScheduledIntent) -> BytesN<32> {
    params_hash(
        env,
        &intent.sender,
        &intent.recipient,
        &intent.token,
        intent.deposit,
        intent.start_time,
        intent.end_time,
        intent.cancelable,
        intent.interval,
        intent.occurrences_total,
        intent.fee_budget,
        intent.execute_after,
        intent.expires_at,
    )
}

#[allow(clippy::too_many_arguments)]
/// Validates a scheduling request, mirroring the stream-creation checks plus
/// the scheduling constraints. Returns the total escrow to pull on success.
pub fn validate_schedule(
    env: &Env,
    deposit: i128,
    start_time: u64,
    end_time: u64,
    interval: u64,
    occurrences: u32,
    fee_budget: i128,
    execute_after: u64,
    expires_at: u64,
) -> Result<i128, StreamError> {
    if deposit <= 0 {
        return Err(StreamError::ZeroAmount);
    }
    if end_time <= start_time {
        return Err(StreamError::InvalidTimeRange);
    }
    let duration = end_time - start_time;
    if duration > MAX_DURATION_SECONDS {
        return Err(StreamError::DurationTooLong);
    }
    stream::validate_capacity(deposit, duration)?;

    if fee_budget < 0 {
        return Err(reject(Branch::ScheduleInvalidParameters));
    }
    if occurrences == 0 || occurrences > MAX_OCCURRENCES {
        return Err(reject(Branch::ScheduleInvalidParameters));
    }
    if occurrences == 1 {
        if interval != 0 {
            return Err(reject(Branch::ScheduleInvalidParameters));
        }
    } else if interval == 0 {
        return Err(reject(Branch::ScheduleInvalidParameters));
    }

    let now = env.ledger().timestamp();
    if start_time <= now {
        return Err(StreamError::StartTimeInPast);
    }
    if execute_after < now {
        return Err(reject(Branch::ScheduleInvalidParameters));
    }
    if execute_after > start_time {
        return Err(reject(Branch::ScheduleInvalidParameters));
    }
    if expires_at <= execute_after {
        return Err(reject(Branch::ScheduleInvalidParameters));
    }

    // The whole recurrence window must fit in u64.
    let last_shift = interval
        .checked_mul((occurrences - 1) as u64)
        .ok_or_else(|| reject(Branch::ScheduleInvalidParameters))?;
    end_time
        .checked_add(last_shift)
        .ok_or_else(|| reject(Branch::ScheduleInvalidParameters))?;

    // The full up-front escrow must fit in i128.
    let per = deposit
        .checked_add(fee_budget)
        .ok_or(StreamError::MathOverflow)?;
    per.checked_mul(occurrences as i128)
        .ok_or(StreamError::MathOverflow)
}

/// Hands out the next intent id (1-based) and stores the incremented counter.
pub fn next_intent_id(env: &Env) -> u64 {
    let key = DataKey::NextIntentId;
    let id: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    env.storage().persistent().set(&key, &id.saturating_add(1));
    id
}

/// Loads an intent, or returns [`StreamError::IntentNotFound`].
pub fn get_intent(env: &Env, id: u64) -> Result<ScheduledIntent, StreamError> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent Intent({id})"));
    env.storage()
        .persistent()
        .get(&DataKey::Intent(id))
        .ok_or_else(|| reject(Branch::IntentNotFound))
}

/// Persists an intent and extends its storage TTL.
pub fn put_intent(env: &Env, intent: &ScheduledIntent) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent Intent({})", intent.id));
    let key = DataKey::Intent(intent.id);
    env.storage().persistent().set(&key, intent);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Appends an intent's id to its sender's intent index.
pub fn index_intent(env: &Env, intent: &ScheduledIntent) {
    stream::push_to_index(
        env,
        &DataKey::SenderIntents(intent.sender.clone()),
        intent.id,
    );
}
