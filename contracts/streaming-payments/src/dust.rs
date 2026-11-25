//! Dust protection and sweep economics (#78).
//!
//! Three public-interface additions live here:
//!
//! * [`MIN_STREAM_DEPOSIT`] — the smallest deposit any creation path accepts.
//! * [`MIN_CLAIM_AMOUNT`] — the smallest single claim (`withdraw` /
//!   `withdraw_max`) accepted while a stream is still accruing.
//! * [`SWEEP_GRACE_SECONDS`] — how long a finished stream stays readable before
//!   anyone may sweep its storage with `sweep_stream`.
//!
//! All amounts are in the token's smallest unit. Stellar Asset Contract tokens
//! (every classic asset, including XLM and the major stablecoins) carry 7
//! decimals, so `10_000_000` base units is one whole token. The fee and rent
//! arithmetic behind each value, with its sources and which inputs are
//! estimates, is in `docs/DUST_ECONOMICS.md`.
//!
//! What a sweep does *not* do: Soroban never refunds rent that was prepaid for
//! a ledger entry when the entry is deleted, so `sweep_stream` returns no rent
//! to anyone. It moves no tokens either, because a stream only qualifies once
//! it holds none (see [`sweep_blocker`]). The refund target is recorded in the
//! `StreamSwept` event as the party the stream's remainder already went to.
//!
//! The sweep predicate ([`sweep_blocker`]) is the security-critical line: it is
//! a conjunction of independent refusals, and a stream is sweepable only when
//! *every* one of them passes.

use soroban_sdk::Env;

use crate::dispute::{self, DisputeKey};
use crate::hooks::{self, HookEventClass};
use crate::oracle;
use crate::receivables;
use crate::stream::{self, DataKey, Stream, StreamStatus};
use crate::surface::Branch;

/// Smallest single claim, in token base units, accepted by `withdraw` and
/// `withdraw_max` while the stream is still accruing: 0.1 token at 7 decimals.
///
/// A claim is one Soroban invocation that rewrites the stream record, moves
/// tokens through the token contract and emits events. Priced with the mainnet
/// fee configuration in `docs/DUST_ECONOMICS.md`, such a call costs an
/// estimated ~0.0009 XLM, and up to ~0.025 XLM on the claim that also renews
/// the stream record's TTL. The floor is about 4x that worst case for a token
/// valued at parity with XLM. Waiting is free while the stream accrues, so
/// refusing a sub-floor claim costs the recipient nothing; once accrual stops
/// (window over, or paused) the floor lifts so no balance is ever stranded.
pub const MIN_CLAIM_AMOUNT: i128 = 1_000_000;

/// Smallest deposit, in token base units, any creation path accepts: one whole
/// token at 7 decimals, i.e. ten floor-sized claims.
///
/// Creating a stream writes new persistent entries whose rent is prepaid for
/// the network's minimum persistent TTL; with the mainnet configuration that
/// costs an estimated ~0.105-0.175 XLM, almost all of it rent. At one token
/// the create-plus-one-claim overhead is roughly 11-17% of everything the
/// stream can ever deliver (at XLM parity); a tenth of that deposit would let
/// the overhead exceed the stream's whole value.
pub const MIN_STREAM_DEPOSIT: i128 = 10 * MIN_CLAIM_AMOUNT;

/// Seconds after a stream's `end_time` before `sweep_stream` may remove it: 30
/// days, so recipients, senders and indexers can still read a finished stream
/// for a full month after its window closes.
pub const SWEEP_GRACE_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Whether the mid-stream claim floor binds at `now` (the stream's own
/// resolved clock): only while the window is open and the stream is not
/// paused. Once accrual has stopped, any positive amount may be claimed, so
/// the floor can never strand a balance.
pub fn claim_floor_applies(env: &Env, s: &Stream, now: u64) -> bool {
    now < s.end_time && stream::get_paused_at(env, s.id).is_none()
}

/// Refuses a mid-stream claim below [`MIN_CLAIM_AMOUNT`].
pub fn check_claim(
    env: &Env,
    s: &Stream,
    now: u64,
    amount: i128,
    branch: Branch,
) -> Result<(), crate::StreamError> {
    if amount < MIN_CLAIM_AMOUNT && claim_floor_applies(env, s, now) {
        return Err(crate::surface::reject(branch));
    }
    Ok(())
}

/// Whether anything still holds a claim on, or a lock over, a terminal stream.
///
/// Every check reads the storage key that would carry the claim, so nothing
/// here trusts a cached flag. Any `true` blocks the sweep:
///
/// * a held reentrancy lock (a hook callback is mid-flight);
/// * an open dispute (its bond is still escrowed by the contract);
/// * a pending ownership, rate-change or sender-transfer proposal (each has
///   its own cancel/expire path, which the proposer can still use);
/// * an advance that is not fully repaid (the lender's claim);
/// * an unmet release condition;
/// * any registered hook (an integrator still points at the stream; either
///   party, or the registrant, can unregister it).
///
/// A pause marker is deliberately *not* on this list. It only freezes accrual,
/// which a terminal status already ends for good, and `resume_stream` refuses
/// a stream that is not `Active`, so a marker left by a stream that was
/// cancelled or drained while paused could never be cleared and would make it
/// unsweepable forever. A paused stream that is still `Active` is refused by
/// the status check before this function runs.
pub fn is_encumbered(env: &Env, id: u64) -> bool {
    hooks::is_stream_locked(env, id)
        || dispute::get_dispute_opt(env, id).is_some()
        || stream::get_pending_ownership(env, id).is_some()
        || stream::get_pending_rate_change(env, id).is_some()
        || stream::get_pending_sender_transfer(env, id).is_some()
        || receivables::get_advance(env, id).is_some_and(|a| a.repaid < a.total_owed)
        || oracle::is_release_gated(env, id)
        || [
            HookEventClass::Withdraw,
            HookEventClass::Cancel,
            HookEventClass::Complete,
        ]
        .into_iter()
        .any(|class| hooks::get_hook(env, id, class).is_some())
}

/// The sweep qualification predicate: `None` when the stream may be swept,
/// otherwise the branch that refuses it.
///
/// A stream qualifies only when all of the following hold:
///
/// 1. its status is terminal — `Depleted` (`withdrawn == deposit`: every token
///    was paid out) or `Cancelled` (`cancel_stream` paid the recipient the
///    accrued remainder and the refund target the unaccrued one in the same
///    transaction). Either way the contract holds no token for it. The `match`
///    is exhaustive, so a future status fails to compile here instead of
///    silently qualifying;
/// 2. the ledger clock is at or past `end_time + SWEEP_GRACE_SECONDS`
///    (saturating, so an `end_time` near `u64::MAX` can never wrap into the
///    past);
/// 3. nothing encumbers it ([`is_encumbered`]).
pub fn sweep_blocker(env: &Env, s: &Stream, now: u64) -> Option<Branch> {
    match s.status {
        StreamStatus::Active => return Some(Branch::SweepStreamActive),
        StreamStatus::Depleted | StreamStatus::Cancelled => {}
    }
    if now < s.end_time.saturating_add(SWEEP_GRACE_SECONDS) {
        return Some(Branch::SweepGraceNotElapsed);
    }
    if is_encumbered(env, s.id) {
        return Some(Branch::SweepStreamEncumbered);
    }
    None
}

/// Removes a qualified stream's per-stream footprint and returns how many
/// persistent entries were deleted.
///
/// Deleted when present: the stream record, its rate schedule, its
/// refund-target override, its sender history, a stale pause marker, the
/// dispute round counter, and a met release condition together with its
/// publishers' attestations. (An advance record never outlives full
/// repayment or a paying cancel, and an outstanding one blocks the sweep, so
/// there is none to delete.) The stream's id is
/// also pruned from the current sender's and recipient's discovery indexes
/// (those entries are rewritten, not deleted, and are not counted).
///
/// Kept on purpose: the `StreamFee` record (treasury reconciliation scans it)
/// and any template lineage record (provenance). Must only be called after
/// [`sweep_blocker`] returned `None`: the condition record is removed
/// unconditionally here because the predicate already proved it met.
pub fn remove_footprint(env: &Env, s: &Stream) -> u32 {
    let storage = env.storage().persistent();
    let mut removed = 0u32;
    for key in [
        DataKey::Stream(s.id),
        DataKey::RateSegments(s.id),
        DataKey::RefundTarget(s.id),
        DataKey::SenderHistory(s.id),
        DataKey::StreamPause(s.id),
    ] {
        if storage.has(&key) {
            storage.remove(&key);
            removed += 1;
        }
    }
    let count_key = DisputeKey::Count(s.id);
    if storage.has(&count_key) {
        storage.remove(&count_key);
        removed += 1;
    }
    if let Some(condition) = oracle::get_condition(env, s.id) {
        for publisher in condition.publishers.iter() {
            let key = DataKey::ConditionAttestation(s.id, publisher);
            if storage.has(&key) {
                storage.remove(&key);
                removed += 1;
            }
        }
        storage.remove(&DataKey::StreamCondition(s.id));
        removed += 1;
    }
    stream::remove_from_index(env, &DataKey::SenderStreams(s.sender.clone()), s.id);
    stream::remove_from_index(env, &DataKey::RecipientStreams(s.recipient.clone()), s.id);
    removed
}
