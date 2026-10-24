//! Recipient-initiated disputes with an economically bounded timelock.
//!
//! The recipient of an active stream can flag it as disputed (wrong
//! address, coerced creation) by posting a bond. While a dispute is open
//! the stream's principal and lifecycle are frozen — `cancel_stream` and
//! `top_up` revert with [`StreamError::DisputeActive`] — until the sender
//! resolves it or the timelock expires and the stream resumes normally.
//!
//! Policy (see `docs/ARCHITECTURE.md` for the full reasoning):
//!
//! * Accrual keeps running and accrued funds stay withdrawable during a
//!   dispute. A dispute freezes *mutations to the stream*, never payments
//!   the recipient has already earned.
//! * The dispute is a separate storage entry; the `Stream` record itself is
//!   untouched. Presence of a `Dispute` entry is the single source of truth
//!   for "this stream is disputed".
//! * Anti-griefing: raising costs a bond — 5% of the deposit, multiplied by
//!   the dispute round for that stream — that is slashed to the sender on a
//!   bad-faith rejection, and split 50/50 (sender rounds up) on expiry.
//!   Blocking a stream for another week always costs the recipient, and the
//!   cost escalates with every round.

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::StreamError;

/// How long a dispute freezes the stream before it can expire: 7 days.
/// Long enough for a responsive sender to act, short enough that a
/// griefing round blocks the sender for at most one week.
pub const DISPUTE_TIMEOUT_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Base dispute bond as basis points of the stream deposit: 5%.
pub const DISPUTE_BOND_BPS: u128 = 500;

/// Floor for any dispute bond, in whole token units. Keeps disputes on
/// dust-sized streams from being free.
pub const MIN_DISPUTE_BOND: i128 = 1;

/// TTL maintenance, in ledgers (~5 seconds per ledger on Stellar mainnet).
/// Matches the stream entries: an open dispute is actively worked on, and
/// the count stays hot alongside it.
const TTL_THRESHOLD_LEDGERS: u32 = 200_000;
const TTL_EXTEND_LEDGERS: u32 = 500_000;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " An open dispute on a stream. Stored only while the dispute is live;"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " resolution/expiry deletes the entry."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream recipient who raised it (always the stream's recipient)."
    )]
    pub raised_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Bond held by the contract for the duration of the dispute."
    )]
    pub bond: i128,
    pub started_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " First ledger timestamp at which the dispute can be expired."
    )]
    pub expires_at: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Storage keys for dispute state, kept separate from the stream keys so"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " existing stream serialization never changes."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The open dispute of the given stream, if any."
    )]
    Active(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Number of disputes ever raised on the given stream (persists across"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " resolution/expiry; drives the escalating bond)."
    )]
    Count(u64),
}

/// Bond required to raise the next dispute on a stream with `deposit` that
/// has already been disputed `prior_disputes` times.
///
/// `bond = max(MIN_DISPUTE_BOND, deposit * 5% * (prior + 1))`. Linear
/// escalation makes serial griefing progressively more expensive: round n
/// risks n-times the base bond. Pure and checked — returns
/// [`StreamError::MathOverflow`] instead of panicking when the product
/// leaves `u128` (unreachable for realistic deposits: it tolerates any
/// amount below `u128::MAX / (500 * rounds)`).
pub fn required_bond(deposit: i128, prior_disputes: u32) -> Result<i128, StreamError> {
    if deposit <= 0 {
        return Ok(MIN_DISPUTE_BOND);
    }
    let rounds = (prior_disputes as u128) + 1;
    let scaled = (deposit as u128)
        .checked_mul(DISPUTE_BOND_BPS)
        .and_then(|p| p.checked_mul(rounds))
        .ok_or(StreamError::MathOverflow)?;
    let bond = (scaled / 10_000).max(MIN_DISPUTE_BOND as u128);
    // `bond <= deposit * rounds * BPS / 10000 <= deposit * rounds`, and the
    // checked product above guarantees it fits `u128` — but it may exceed
    // `i128::MAX` for deposits near the top of `i128`; report as overflow.
    i128::try_from(bond).map_err(|_| StreamError::MathOverflow)
}

/// Bond split when a dispute expires without a verdict:
/// `(sender_share, recipient_share)`.
///
/// The sender is compensated for a week of frozen control even though no
/// bad-faith verdict was reached; refunding the full bond on expiry would
/// make serial disputes free for a patient griefer. Rounding favors the
/// sender (odd bonds pay the extra unit there), and the shares always sum
/// back to `bond`.
pub fn bond_shares(bond: i128) -> (i128, i128) {
    let recipient_share = bond / 2;
    (bond - recipient_share, recipient_share)
}

/// Loads the open dispute of a stream, or returns
/// [`StreamError::DisputeNotFound`].
pub fn get_dispute(env: &Env, stream_id: u64) -> Result<Dispute, StreamError> {
    get_dispute_opt(env, stream_id)
        .ok_or_else(|| crate::surface::reject(crate::surface::Branch::DisputeNotOpen))
}

/// Returns the open dispute of a stream, or `None` when it is undisputed.
pub fn get_dispute_opt(env: &Env, stream_id: u64) -> Option<Dispute> {
    env.storage()
        .persistent()
        .get(&DisputeKey::Active(stream_id))
}

/// Stores the open dispute and extends its TTL.
pub fn put_dispute(env: &Env, dispute: &Dispute) {
    let key = DisputeKey::Active(dispute.stream_id);
    env.storage().persistent().set(&key, dispute);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Removes the open dispute entry (resolution or expiry).
pub fn delete_dispute(env: &Env, stream_id: u64) {
    env.storage()
        .persistent()
        .remove(&DisputeKey::Active(stream_id));
}

/// Number of disputes previously raised on this stream (drives the next
/// bond round). Absent key means zero.
pub fn dispute_count(env: &Env, stream_id: u64) -> u32 {
    env.storage()
        .persistent()
        .get(&DisputeKey::Count(stream_id))
        .unwrap_or(0)
}

/// Records a newly raised dispute round and returns the updated count.
pub fn bump_dispute_count(env: &Env, stream_id: u64) -> u32 {
    let key = DisputeKey::Count(stream_id);
    let prior: u32 = env.storage().persistent().get(&key).unwrap_or(0);
    let count = prior.saturating_add(1);
    env.storage().persistent().set(&key, &count);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    count
}
