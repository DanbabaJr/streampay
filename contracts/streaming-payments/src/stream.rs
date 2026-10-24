//! Stream state, storage, and the checked accrual math.
//!
//! Accrual is linear over the stream window: a stream funded with `deposit`
//! between `start_time` and `end_time` streams `deposit * elapsed / duration`
//! tokens, floored to whole token units. All arithmetic is checked (`u128`
//! intermediate products) and returns [`StreamError::MathOverflow`] instead of
//! overflowing or panicking.
//!
//! A renegotiated rate does not change that: it appends a [`RateSegment`]
//! window that starts where the change was accepted and ends at the stream's
//! `end_time`. Accrual is then the sum of one floored pro-rata term per segment
//! ([`segment_accrual`]), and the segments partition `[start_time, end_time)`.
//! Nothing before a segment boundary is ever recomputed, so an accepted rate
//! change cannot retroactively move what the recipient already earned. With no
//! segments stored the sum degenerates to exactly the single-window formula
//! above — bit for bit — which is what
//! `test::empty_plan_matches_single_window_formula` proves by exhaustive
//! comparison.

use soroban_sdk::{contracttype, Address, BytesN, Env, MuxedAddress, Vec};

use crate::errors::StreamError;
use crate::surface::{self, Branch};

/// Minimum delay for an upgrade proposal timelock: 24 hours.
pub const MIN_UPGRADE_DELAY_SECONDS: u64 = 86_400;

/// Initial schema version (v1).
pub const INITIAL_SCHEMA_VERSION: u32 = 1;

/// Target schema version after migration (v2).
pub const TARGET_SCHEMA_VERSION: u32 = 2;

/// Maximum number of streams processed per migration call.
pub const MAX_MIGRATION_BATCH_SIZE: u32 = 50;

/// Maximum supported stream duration: 100 years, including leap days
/// (36,525 days). Bounds worst-case rate multiplications and rejects
/// nonsensical windows early.
pub const MAX_DURATION_SECONDS: u64 = 3_155_760_000;

/// Maximum number of stream ids a single paginated index query may return.
/// Callers asking for more are clamped down; this bounds per-call footprint
/// of the address-index views.
pub const MAX_PAGE_SIZE: u32 = 50;

/// Minimum number of stream entries permitted in a batch.
pub const MIN_BATCH: u32 = 1;

/// Maximum number of stream entries permitted in a batch.
///
/// Bounded to 25 because each stream creation emits a `StreamCreated` event
/// and a token `transfer` event (~600 bytes combined). At 25 streams, event
/// size is ~15.5 KB, safely within Soroban's network limit of 16,384 bytes (16 KB),
/// and consumes ~16.2M CPU instructions (~16% of the 100M transaction budget).
pub const MAX_BATCH: u32 = 25;

/// Lifetime of a pending ownership proposal, in seconds (7 days).
///
/// A proposal that is not accepted within this window becomes stale: it can no
/// longer be accepted (the target must ask the current role holder to propose
/// again), but the current holder can still cancel it explicitly or replace it
/// with a fresh proposal. Expiry is enforced against the ledger timestamp, not
/// storage TTL, so the semantics are identical on every network.
pub const OWNERSHIP_PROPOSAL_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Lifetime of a pending rate-change proposal, in seconds (7 days).
///
/// Same window and same semantics as [`OWNERSHIP_PROPOSAL_TTL_SECONDS`], and
/// deliberately a separate constant: the two are independent knobs, and a
/// negotiation that must be re-priced (a rate is only fair at the moment it is
/// accepted) can need a different horizon from a name change. Expiry is
/// enforced against the ledger timestamp, not storage TTL.
pub const RATE_PROPOSAL_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Maximum number of rate segments one stream may carry.
///
/// Every renegotiation replaces the tail of the schedule with one new window,
/// so a stream accumulates at most one segment per accepted change. The cap
/// bounds the size of the stored schedule (and therefore the footprint of every
/// accrual read, which walks it): 32 segments is under 2 KB of entries, well
/// inside Soroban's per-entry limits, and far more rate changes than a
/// human-scale payroll stream will ever hold.
pub const MAX_RATE_SEGMENTS: u32 = 32;

/// TTL maintenance, in ledgers (~5 seconds per ledger on Stellar mainnet).
///
/// Streams live in persistent storage: entries that go untouched are
/// eventually archived off-chain (and auto-restored at a fee when next read).
/// Every mutating entrypoint extends the stream entry's TTL, so a stream that
/// is actually being used never goes cold.
pub(crate) const TTL_THRESHOLD_LEDGERS: u32 = 200_000; // extend when TTL drops below ~11.5 days
pub(crate) const TTL_EXTEND_LEDGERS: u32 = 500_000; // extend to ~29 days

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The role being handed over by a two-step ownership transfer."
)]
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OwnershipRole {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The payer: may top up and cancel, and receives cancellation refunds."
    )]
    Sender,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The claimant: may withdraw accrued funds."
    )]
    Recipient,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A pending two-step ownership proposal for one stream."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Proposals live under their own storage key ([`DataKey::PendingOwnership`])"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " rather than inside [`Stream`], so accepting or cancelling one leaves the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " stream's accounting fields untouched and the dedicated key can be given its"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " own TTL treatment.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingOwnership {
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The current role holder that created the proposal (and the only address"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " allowed to cancel it).")]
    pub proposed_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The address that must accept the role before it takes effect."
    )]
    pub new_owner: Address,
    pub role: OwnershipRole,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the proposal is stale."
    )]
    pub expires_at: u64,
}

#[cfg_attr(not(target_family = "wasm"), doc = " Lifecycle state of a stream.")]
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Running; funds accrue and can be withdrawn or topped up."
    )]
    Active,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancelled; remaining funds were split at cancellation. Terminal."
    )]
    Cancelled,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Fully streamed and fully withdrawn. Terminal."
    )]
    Depleted,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " One window of a stream's piecewise rate schedule."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A segment reserves `allocation` tokens for the half-open window"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `[start_time, end_time)` and accrues them pro rata over `basis_seconds`:"
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(not(target_family = "wasm"), doc = " ```text")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " floor(allocation * elapsed_within_window / basis_seconds)"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " ```")]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `basis_seconds` is normally the window's own length, which makes the term"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " exact (no rounding at all) whenever `allocation` is a whole multiple of it —"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the shape every renegotiated segment has, because it is priced as"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `amount_per_second * window_length`. It is the *original* stream duration for"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the first segment of a renegotiated stream, whose `allocation` is the deposit"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the schedule started from: keeping that pair untouched is what makes an"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " accepted change unable to re-price the past."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Because each window is a sub-interval of the stream, the elapsed part of it"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " is never longer than `basis_seconds`, which is the condition"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " [`validate_capacity`] needs to guarantee the product cannot overflow."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateSegment {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " First timestamp this segment accrues at (inclusive)."
    )]
    pub start_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Last timestamp this segment accrues at (exclusive)."
    )]
    pub end_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Tokens reserved for the window, as of the segment being accepted."
    )]
    pub allocation: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Divisor of the pro-rata term; see the struct docs."
    )]
    pub basis_seconds: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A pending two-step rate change for one stream."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Like [`PendingOwnership`], this lives under its own storage key"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " ([`DataKey::PendingRateChange`]) rather than inside [`Stream`], and the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " schedule it would install lives under [`DataKey::RateSegments`]. Neither is"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " part of the `Stream` entry, so an existing stream's stored XDR keeps its"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " layout: a stream created before this feature accrues exactly as it did, and a"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " rate change that is proposed and then cancelled leaves no trace in the"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " stream's accounting fields.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRateChange {
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream party that created the proposal (and the only address allowed"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " to cancel it).")]
    pub proposed_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The other party: the address whose acceptance makes the change effective."
    )]
    pub counterparty: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed rate, in whole token units per second, for the window that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " starts when the proposal is accepted."
    )]
    pub amount_per_second: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the proposal is stale. What the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " proposal commits to is the *rate*; the funds movement it implies is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " computed from the schedule at the moment it is accepted."
    )]
    pub expires_at: u64,
}

#[cfg_attr(not(target_family = "wasm"), doc = " Full state of a payment stream.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total amount funded into the stream (original deposit + top-ups)."
    )]
    pub deposit: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total amount paid to the recipient so far (withdrawals + cancel payout)."
    )]
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " If true, the recipient may also cancel and reclaim their accrued balance."
    )]
    pub cancelable: bool,
    pub status: StreamStatus,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " If true, settles against external oracle time feed instead of ledger time."
    )]
    pub use_oracle: bool,
}

impl Stream {
    /// Seconds in the stream's full window. Always `>= 1` for a stored stream
    /// (`create_stream` rejects `end_time <= start_time`).
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Parameters for creating a single stream within a batch creation call."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchEntry {
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Proposed contract upgrade pending timelock expiration."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub unlock_time: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Progress report for on-chain storage migration."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationStatus {
    pub current_version: u32,
    pub target_version: u32,
    pub cursor: u64,
    pub total_streams: u64,
    pub is_complete: bool,
}

#[cfg_attr(not(target_family = "wasm"), doc = " Storage keys for the contract.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Next stream id to hand out; ids start at 1."
    )]
    NextStreamId,
    #[cfg_attr(not(target_family = "wasm"), doc = " The stream with the given id.")]
    Stream(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Append-only index of stream ids where the given address is the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recipient. Advisory (discovery) data: the `Stream` entries remain the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " source of truth, and terminal streams keep their place in the index."
    )]
    RecipientStreams(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Append-only index of stream ids created (as sender) by the given"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " address. Same advisory semantics as [`DataKey::RecipientStreams`]."
    )]
    SenderStreams(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Append-only list of metadata attestations attached to a stream, in"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " attach order. Never rewritten in place — entries only ever grow."
    )]
    Attestations(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Append-only index of attestations on the streams where the given address"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is a party (sender or recipient), so either side can enumerate them"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " without knowing the stream ids up front. Advisory, like the stream"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " indexes above.")]
    PartyAttestations(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Next scheduled-intent id to hand out; ids start at 1."
    )]
    NextIntentId,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The scheduled intent with the given id."
    )]
    Intent(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Append-only index of scheduled-intent ids created (as sender) by the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " given address. Same advisory semantics as [`DataKey::SenderStreams`]."
    )]
    SenderIntents(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Treasury governor address (instance storage; set once by the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " contract constructor, later by two-step nomination/acceptance)."
    )]
    Governor,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Pending governor nominee (instance storage; set by"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `nominate_governor`, cleared by `accept_governor`)."
    )]
    PendingGovernor,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Configured protocol fee in basis points (instance storage; absent"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " means 0 — fees disabled, the v0.3 behavior)."
    )]
    FeeBps,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Per-token fee accounting: fees charged minus fees withdrawn"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (persistent storage; written only by fee-affecting entrypoints)."
    )]
    Treasury(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Fee charged for one stream at creation time (persistent storage;"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " written only when the fee rounds above zero, so absent == 0)."
    )]
    StreamFee(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Schema version for storage layout evolution (instance storage)."
    )]
    SchemaVersion,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Freeze state: when true, all state-mutating entrypoints revert (instance storage)."
    )]
    ContractFrozen,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposed contract upgrade pending timelock expiration (instance storage)."
    )]
    PendingUpgrade,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Highest stream id processed by storage migration (instance storage)."
    )]
    MigrationCursor,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Global oracle configuration (instance storage)."
    )]
    OracleConfig,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Most recent timestamp report from a publisher (persistent storage)."
    )]
    OracleReport(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The pending two-step ownership proposal for the given stream, if any."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " At most one proposal exists per stream at a time."
    )]
    PendingOwnership(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The pending two-step rate-change proposal for the given stream, if any."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " At most one proposal exists per stream at a time."
    )]
    PendingRateChange(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream's piecewise rate schedule, as segments in window order."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Absent means the stream still accrues at its original single-window"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " rate, so accrual for every pre-renegotiation stream never reads this key."
    )]
    RateSegments(u64),
}

/// Seconds elapsed of the stream window at the given timestamp `now`.
pub fn elapsed_seconds_at(now: u64, start_time: u64, end_time: u64) -> u64 {
    if now <= start_time {
        0
    } else if now >= end_time {
        // MUTANT-SUPPRESS: replace - with + is acceptable because this branch
        // is only reachable when now >= end_time, which means the full duration
        // has already elapsed. The test elapsed_after_end_returns_full_duration
        // verifies that the full deposit is available at this point. The mutation
        // would cause an overflow in the subsequent streamed_at calculation,
        // which is caught by MathOverflow. This is an unreachable code path given
        // the contract's usage pattern.
        end_time - start_time
    } else {
        now - start_time
    }
}

#[allow(dead_code)]
/// Seconds elapsed of the stream window at the current ledger time.
///
/// The window is half-open `[start_time, end_time)`: at `now == start_time`
/// nothing has accrued yet; at `now >= end_time` the full duration has elapsed.
pub fn elapsed_seconds(env: &Env, start_time: u64, end_time: u64) -> u64 {
    elapsed_seconds_at(env.ledger().timestamp(), start_time, end_time)
}

/// Validates that `deposit * duration` — the worst-case rate multiplication —
/// fits in `u128`, so [`streamed_amount`] can never overflow for this stream.
///
/// `duration` must be `>= 1` (enforced by `create_stream`).
pub fn validate_capacity(deposit: i128, duration: u64) -> Result<(), StreamError> {
    let cap = u128::MAX / (duration.max(1) as u128);
    if (deposit as u128) > cap {
        return Err(surface::reject(Branch::CapacityOverflow));
    }
    Ok(())
}

/// Pure rate computation: amount streamed after `elapsed` seconds of a
/// `duration`-second window funded with `deposit`.
///
/// Linear rate: `deposit * elapsed / duration`, floored to whole token units,
/// capped at `deposit`. Checked math throughout; returns
/// [`StreamError::MathOverflow`] rather than overflowing or panicking. Exposed
/// as a pure function so tests and fuzzing can exercise it without an
/// environment.
pub fn streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError> {
    if elapsed == 0 || deposit <= 0 || duration == 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(elapsed as u128)
        .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?;
    let streamed = (product / (duration.max(1) as u128)).min(deposit as u128);
    // `streamed <= deposit <= i128::MAX`, so the narrowing cast cannot wrap.
    Ok(streamed as i128)
}

/// Amount streamed (accrued) at reference timestamp `now`.
pub fn streamed_amount_at(stream: &Stream, now: u64) -> Result<i128, StreamError> {
    let elapsed = elapsed_seconds_at(now, stream.start_time, stream.end_time);
    streamed_at(stream.deposit, stream.duration(), elapsed)
}

/// Amount accrued by one rate segment at reference timestamp `now`.
///
/// The segment's own window is clamped exactly like a stream window
/// ([`elapsed_seconds_at`]), then [`streamed_at`] prices the elapsed part of it.
/// That reuse is the point: a segment *is* the single-window formula, evaluated
/// over its slice of the stream, so a schedule with one segment covering the
/// whole window is the pre-renegotiation behavior by construction. The
/// `allocation` cap inside `streamed_at` is inert here because a window is never
/// longer than its own `basis_seconds`.
pub fn segment_accrual(segment: &RateSegment, now: u64) -> Result<i128, StreamError> {
    streamed_at(
        segment.allocation,
        segment.basis_seconds.max(1),
        elapsed_seconds_at(now, segment.start_time, segment.end_time),
    )
}

/// Amount streamed (accrued) at `now` under a piecewise rate schedule.
///
/// `segments` empty means "never renegotiated" and takes the single-window path
/// unchanged: same function, same rounding, no storage read. Otherwise the
/// accrual is the sum of [`segment_accrual`] over the schedule, whose windows
/// partition `[start_time, end_time)` — so the total is bounded by `deposit` and
/// is monotonic in `now`.
pub fn streamed_amount_at_segments(
    stream: &Stream,
    now: u64,
    segments: &Vec<RateSegment>,
) -> Result<i128, StreamError> {
    if segments.is_empty() {
        return streamed_amount_at(stream, now);
    }
    let mut total: i128 = 0;
    let mut index = 0;
    while index < segments.len() {
        // `index < segments.len()`, so this is a defensive bound check only.
        let segment = segments.get(index).ok_or(StreamError::MathOverflow)?;
        total = total
            .checked_add(segment_accrual(&segment, now)?)
            .ok_or_else(|| surface::reject(Branch::RateSegmentSumOverflow))?;
        index += 1;
    }
    Ok(total)
}

/// Accrued-but-unwithdrawn balance at `now`, honoring the rate schedule.
pub fn available_amount_at_segments(
    stream: &Stream,
    now: u64,
    segments: &Vec<RateSegment>,
) -> Result<i128, StreamError> {
    if stream.status == StreamStatus::Cancelled {
        return Ok(0);
    }
    let streamed = streamed_amount_at_segments(stream, now, segments)?;
    streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(|| surface::reject(Branch::AvailableBalanceOverflow))
}

/// Cancellation split at `now`, honoring the rate schedule:
/// `(recipient_amount, sender_amount)`.
pub fn cancel_amounts_at_segments(
    stream: &Stream,
    now: u64,
    segments: &Vec<RateSegment>,
) -> Result<(i128, i128), StreamError> {
    let streamed = streamed_amount_at_segments(stream, now, segments)?;
    let recipient_amount = streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
    let sender_amount = stream
        .deposit
        .checked_sub(streamed)
        .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
    Ok((recipient_amount, sender_amount))
}

/// `segment` clipped so its window ends at `boundary`.
///
/// Returns `None` when the segment starts at or after the boundary (the new rate
/// covers it entirely) or is squeezed to an empty window. The `allocation` and
/// `basis_seconds` pair is carried over untouched, which is what keeps the
/// accrued-so-far amount of a clipped segment exactly what it was before the
/// change: the pro-rata term is evaluated over a shorter window of the same
/// line, never re-based onto the new one.
fn clip_segment(segment: &RateSegment, boundary: u64) -> Option<RateSegment> {
    if segment.start_time >= boundary {
        return None;
    }
    let end_time = segment.end_time.min(boundary);
    if end_time <= segment.start_time {
        return None;
    }
    Some(RateSegment {
        start_time: segment.start_time,
        end_time,
        allocation: segment.allocation,
        basis_seconds: segment.basis_seconds,
    })
}

/// The schedule to store once a change accepted at `boundary` reserves
/// `tail_allocation` tokens for `[boundary, end_time)`.
///
/// Segments before the boundary are clipped, segments at or after it are
/// dropped, and the new window is appended, so the result still partitions
/// `[start_time, end_time)`. A stream with no schedule yet contributes its
/// original single-window formula as the head segment: `allocation = deposit`,
/// `basis_seconds = duration`, which is exactly what [`streamed_at`] used.
pub fn segments_after_change(
    env: &Env,
    stream: &Stream,
    existing: &Vec<RateSegment>,
    boundary: u64,
    tail_allocation: i128,
) -> Result<Vec<RateSegment>, StreamError> {
    let mut kept = Vec::new(env);
    if existing.is_empty() {
        let head = RateSegment {
            start_time: stream.start_time,
            end_time: stream.end_time,
            allocation: stream.deposit,
            basis_seconds: stream.duration(),
        };
        if let Some(clipped) = clip_segment(&head, boundary) {
            kept.push_back(clipped);
        }
    } else {
        let mut index = 0;
        while index < existing.len() {
            let segment = existing.get(index).ok_or(StreamError::MathOverflow)?;
            if let Some(clipped) = clip_segment(&segment, boundary) {
                kept.push_back(clipped);
            }
            index += 1;
        }
    }

    if kept.len() >= MAX_RATE_SEGMENTS {
        return Err(surface::reject(Branch::RateSegmentLimitReached));
    }
    let remaining = stream.end_time - boundary;
    validate_capacity(tail_allocation, remaining)?;
    kept.push_back(RateSegment {
        start_time: boundary,
        end_time: stream.end_time,
        allocation: tail_allocation,
        basis_seconds: remaining,
    });
    Ok(kept)
}

#[allow(dead_code)]
/// Amount streamed (accrued) at the current ledger time.
///
/// See [`streamed_at`] for the rate semantics.
pub fn streamed_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    streamed_amount_at(stream, env.ledger().timestamp())
}

/// Accrued-but-unwithdrawn balance at reference timestamp `now`. Zero for
/// cancelled streams.
pub fn available_amount_at(stream: &Stream, now: u64) -> Result<i128, StreamError> {
    if stream.status == StreamStatus::Cancelled {
        return Ok(0);
    }
    let streamed = streamed_amount_at(stream, now)?;
    streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(|| surface::reject(Branch::AvailableBalanceOverflow))
}

#[allow(dead_code)]
/// Accrued-but-unwithdrawn balance at the current ledger time. Zero for
/// cancelled streams (their payout was settled atomically at cancellation).
pub fn available_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    available_amount_at(stream, env.ledger().timestamp())
}

/// Payout split at cancellation at reference timestamp `now`: `(recipient_amount, sender_amount)`.
pub fn cancel_amounts_at(stream: &Stream, now: u64) -> Result<(i128, i128), StreamError> {
    let streamed = streamed_amount_at(stream, now)?;
    let recipient_amount = streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
    let sender_amount = stream
        .deposit
        .checked_sub(streamed)
        .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
    Ok((recipient_amount, sender_amount))
}

#[allow(dead_code)]
/// Payout split at cancellation: `(recipient_amount, sender_amount)`.
///
/// The recipient receives their accrued-but-unwithdrawn balance; the sender is
/// refunded the unaccrued remainder.
pub fn cancel_amounts(env: &Env, stream: &Stream) -> Result<(i128, i128), StreamError> {
    cancel_amounts_at(stream, env.ledger().timestamp())
}

/// Address helper: token transfer destinations are muxed addresses.
pub(crate) fn muxed(addr: &Address) -> MuxedAddress {
    addr.clone().into()
}

/// Hands out the next stream id (1-based) and stores the incremented counter.
pub fn next_stream_id(env: &Env) -> u64 {
    let key = DataKey::NextStreamId;
    let id: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    env.storage().persistent().set(&key, &id.saturating_add(1));
    id
}

/// Reserves a contiguous range of stream ids with one persistent write.
pub fn reserve_stream_ids(env: &Env, count: u32) -> Result<u64, StreamError> {
    let key = DataKey::NextStreamId;
    let first: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    let next = first
        .checked_add(count as u64)
        .ok_or(StreamError::MathOverflow)?;
    env.storage().persistent().set(&key, &next);
    Ok(first)
}

/// Loads a stream, or returns [`StreamError::StreamNotFound`].
pub fn get_stream(env: &Env, id: u64) -> Result<Stream, StreamError> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent Stream({id})"));
    env.storage()
        .persistent()
        .get(&DataKey::Stream(id))
        .ok_or_else(|| surface::reject(Branch::StreamNotFound))
}

/// Persists a stream and extends its storage TTL.
pub fn put_stream(env: &Env, stream: &Stream) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent Stream({})", stream.id));
    let key = DataKey::Stream(stream.id);
    env.storage().persistent().set(&key, stream);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Appends a stream's id to both parties' address indexes.
///
/// Called after each stream created by `create_stream` or `create_streams`
/// is persisted.
/// Cancel/deplete/top-up flows intentionally do not touch the indexes: they
/// are append-only discovery aids keyed by *creation*, not by lifecycle.
pub fn index_stream(env: &Env, stream: &Stream) {
    index_sender(env, &stream.sender, stream.id);
    index_recipient(env, &stream.recipient, stream.id);
}

/// Appends `id` to the sender's discovery index. Called on creation and when
/// an accepted ownership transfer installs a new sender.
pub fn index_sender(env: &Env, sender: &Address, id: u64) {
    push_to_index(env, &DataKey::SenderStreams(sender.clone()), id);
}

/// Appends `id` to the recipient's discovery index. Called on creation and
/// when an accepted ownership transfer installs a new recipient.
pub fn index_recipient(env: &Env, recipient: &Address, id: u64) {
    push_to_index(env, &DataKey::RecipientStreams(recipient.clone()), id);
}

/// Loads the pending ownership proposal for `id`, if one exists, and extends
/// its storage TTL.
///
/// The `Some` check matters: `extend_ttl` on a key that was never written (or
/// was removed) fails, so we only extend after a successful read.
pub fn get_pending_ownership(env: &Env, id: u64) -> Option<PendingOwnership> {
    let key = DataKey::PendingOwnership(id);
    let storage = env.storage().persistent();
    let pending: PendingOwnership = storage.get(&key)?;
    storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Some(pending)
}

/// Persists a pending ownership proposal and extends its storage TTL.
pub fn put_pending_ownership(env: &Env, pending: &PendingOwnership) {
    let key = DataKey::PendingOwnership(pending.stream_id);
    env.storage().persistent().set(&key, pending);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Removes a pending ownership proposal. No-op if none exists.
pub fn remove_pending_ownership(env: &Env, id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingOwnership(id));
}

/// Loads the pending rate-change proposal for `id`, if one exists, and extends
/// its storage TTL.
///
/// Same `Some` discipline as [`get_pending_ownership`]: `extend_ttl` on a key
/// that was never written fails, so it only runs after a successful read.
pub fn get_pending_rate_change(env: &Env, id: u64) -> Option<PendingRateChange> {
    let key = DataKey::PendingRateChange(id);
    let storage = env.storage().persistent();
    let pending: PendingRateChange = storage.get(&key)?;
    storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Some(pending)
}

/// Persists a pending rate-change proposal and extends its storage TTL.
pub fn put_pending_rate_change(env: &Env, pending: &PendingRateChange) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "write persistent PendingRateChange({})",
        pending.stream_id
    ));
    let key = DataKey::PendingRateChange(pending.stream_id);
    env.storage().persistent().set(&key, pending);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Removes a pending rate-change proposal. No-op if none exists.
pub fn remove_pending_rate_change(env: &Env, id: u64) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("remove persistent PendingRateChange({id})"));
    env.storage()
        .persistent()
        .remove(&DataKey::PendingRateChange(id));
}

/// Loads a stream's rate schedule; empty when it still accrues at its original
/// single-window rate. Reading extends the entry's storage TTL.
///
/// The empty-`Vec` return is deliberate: every accrual path can call this
/// unconditionally and hand the result straight to
/// [`streamed_amount_at_segments`], which treats an empty schedule as "use the
/// single-window formula" without reading this key at all.
pub fn get_rate_segments(env: &Env, id: u64) -> Vec<RateSegment> {
    let key = DataKey::RateSegments(id);
    let storage = env.storage().persistent();
    let Some(segments): Option<Vec<RateSegment>> = storage.get(&key) else {
        return Vec::new(env);
    };
    storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    segments
}

/// Persists a rate schedule and extends its storage TTL. An empty schedule is
/// stored as *removed*, so "no segments" has exactly one representation and
/// [`get_rate_segments`] never reads back an entry it could have skipped.
pub fn put_rate_segments(env: &Env, id: u64, segments: &Vec<RateSegment>) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "{} persistent RateSegments({id})",
        if segments.is_empty() {
            "remove"
        } else {
            "write"
        }
    ));
    let key = DataKey::RateSegments(id);
    if segments.is_empty() {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, segments);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Accrued-but-unwithdrawn balance at `now`, honoring the stored schedule.
pub fn available_amount_with_plan(
    env: &Env,
    stream: &Stream,
    now: u64,
) -> Result<i128, StreamError> {
    let segments = get_rate_segments(env, stream.id);
    available_amount_at_segments(stream, now, &segments)
}

/// Cancellation split at `now`, honoring the stored schedule.
pub fn cancel_amounts_with_plan(
    env: &Env,
    stream: &Stream,
    now: u64,
) -> Result<(i128, i128), StreamError> {
    let segments = get_rate_segments(env, stream.id);
    cancel_amounts_at_segments(stream, now, &segments)
}

/// Adds `amount` of freshly escrowed funds to the window that is currently
/// being streamed, so a top-up on a renegotiated stream stays claimable.
///
/// `existing` must be non-empty (callers skip this for a single-window stream,
/// whose `deposit` alone carries the top-up). The last window's `allocation`
/// grows while its `basis_seconds` stays the window length, so the added funds
/// stream at the new rate across that window — including the part of it already
/// elapsed, which is exactly how `top_up` behaves on an unrenegotiated stream.
/// Every segment before it is untouched, so a top-up can never re-price an
/// accepted rate.
pub fn segments_after_topup(
    existing: &Vec<RateSegment>,
    amount: i128,
) -> Result<Vec<RateSegment>, StreamError> {
    let mut segments = existing.clone();
    let last = segments
        .len()
        .checked_sub(1)
        .ok_or(StreamError::MathOverflow)?;
    // `last < segments.len()`, so this is a defensive bound check only.
    let mut tail = segments.get(last).ok_or(StreamError::MathOverflow)?;
    tail.allocation = tail
        .allocation
        .checked_add(amount)
        .ok_or_else(|| surface::reject(Branch::RateSegmentSumOverflow))?;
    validate_capacity(tail.allocation, tail.basis_seconds)?;
    segments.set(last, tail);
    Ok(segments)
}

pub(crate) fn push_to_index(env: &Env, key: &DataKey, id: u64) {
    let mut ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(id);
    env.storage().persistent().set(key, &ids);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns one page of stream ids from an address index, in creation order.
///
/// `limit` is clamped to [`MAX_PAGE_SIZE`]; an `offset` past the end (or an
/// unknown address) yields an empty page rather than an error. Reading the
/// index extends its TTL, so actively-queried addresses never go cold.
/// Addresses with no index entry never had any streams: return early without
/// touching storage (`extend_ttl` on a never-written key would fail).
pub fn page_stream_ids(env: &Env, key: &DataKey, offset: u32, limit: u32) -> Vec<u64> {
    let storage = env.storage().persistent();
    let Some(ids): Option<Vec<u64>> = storage.get(key) else {
        return Vec::new(env);
    };
    storage.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let start = offset.min(ids.len());
    let end = start
        .saturating_add(limit.min(MAX_PAGE_SIZE))
        .min(ids.len());
    ids.slice(start..end)
}

/// Returns the current schema version (defaults to INITIAL_SCHEMA_VERSION if unset).
pub fn schema_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::SchemaVersion)
        .unwrap_or(INITIAL_SCHEMA_VERSION)
}

/// Persists the new schema version and extends instance storage TTL.
pub fn set_schema_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::SchemaVersion, &version);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Checks whether the contract is currently frozen.
pub fn is_frozen(env: &Env) -> bool {
    #[cfg(test)]
    crate::cei_trace::record("read instance ContractFrozen");
    env.storage()
        .instance()
        .get(&DataKey::ContractFrozen)
        .unwrap_or(false)
}

/// Updates the contract freeze state and extends instance storage TTL.
pub fn set_frozen(env: &Env, frozen: bool) {
    #[cfg(test)]
    crate::cei_trace::record("write instance ContractFrozen");
    env.storage()
        .instance()
        .set(&DataKey::ContractFrozen, &frozen);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns the pending contract upgrade proposal, if one exists.
pub fn pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().instance().get(&DataKey::PendingUpgrade)
}

/// Sets the pending contract upgrade proposal and extends instance storage TTL.
pub fn set_pending_upgrade(env: &Env, pending: &PendingUpgrade) {
    env.storage()
        .instance()
        .set(&DataKey::PendingUpgrade, pending);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Removes any pending contract upgrade proposal and extends instance storage TTL.
pub fn remove_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgrade);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns the current migration cursor (highest stream id migrated so far).
pub fn migration_cursor(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MigrationCursor)
        .unwrap_or(0)
}

/// Sets the migration cursor and extends instance storage TTL.
pub fn set_migration_cursor(env: &Env, cursor: u64) {
    env.storage()
        .instance()
        .set(&DataKey::MigrationCursor, &cursor);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}
