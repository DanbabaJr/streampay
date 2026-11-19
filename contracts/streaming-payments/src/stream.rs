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

use soroban_sdk::{contracttype, Address, BytesN, Env, MuxedAddress, TryFromVal, Val, Vec};

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

/// Storage-record layout of the original, **untagged** stream entries: the
/// value stored under [`DataKey::Stream`] was a bare [`Stream`] struct, so its
/// version could only be *inferred* from the absence of a version tag.
pub const STREAM_RECORD_VERSION_V1: u32 = 1;

/// Storage-record layout that carries an explicit version tag: the stored value
/// is a [`VersionedStream`], so every record states its own layout version on
/// write instead of leaving readers to guess.
pub const STREAM_RECORD_VERSION_V2: u32 = 2;

/// The record layout this build writes. Appending a field to [`Stream`] means
/// bumping this constant (and, if the field is not an `Option`, adding a
/// migration step in [`migrate_stream_record`]).
pub const CURRENT_STREAM_RECORD_VERSION: u32 = STREAM_RECORD_VERSION_V2;

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

/// Maximum number of stream ids a single `withdraw_many` call may carry.
///
/// Tighter than [`MAX_BATCH`] (creation) because each claim entry costs more
/// than a creation entry: it reads a stream record, extends its TTL, resolves
/// oracle time for streams that use an oracle, rewrites the record, emits both
/// a per-stream `Withdrawn` event and a `transfer`, and pays out. 20 is sized so
/// the measured worst case — 20 fully accrued claims plus the summary event —
/// runs at 6.27M CPU against Soroban's 100M-instruction transaction ceiling,
/// leaving room for the caller's own footprint and rent; see
/// `test.rs::withdraw_many_footprint_harness` and `docs/FOOTPRINT.md` §4.1.
pub const MAX_WITHDRAW_BATCH: u32 = 20;

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
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A pending sender-role transfer that the *recipient* must consent to."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " [`PendingOwnership`] moves a role with only the incoming holder's"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " acceptance; a sender change is different in kind, because the recipient's"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " counterparty — who they get paid by, and who can cancel the stream — is"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " being swapped under them. So the transfer is proposed by the current"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " sender and only executes on the recipient's consent"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " (`accept_sender_transfer`), inside the proposal's window."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `nonce` is the caller's freshness marker: it is stored with the proposal,"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " echoed by every event in its lifecycle, and must be repeated exactly by the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " consenting call. A proposal that was replaced (and so carries a different"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " nonce) cannot be executed by accident."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingSenderTransfer {
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sender at the time the proposal was made, and the address whose"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " authorization is required to propose it."
    )]
    pub sender_from: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The address that will hold the sender role once the recipient consents."
    )]
    pub new_sender: Address,
    pub nonce: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the proposal is stale."
    )]
    pub expires_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Whether consenting also moves the refund claim for the existing deposit"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (see [`SenderTransferRecord::refund_rights_transferred`]). Fixed at"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " proposal time so the recipient consents to exactly one meaning."
    )]
    pub transfer_refund_rights: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " One executed sender transfer, appended to [`SenderHistory::transfers`]."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderTransferRecord {
    pub sender_from: Address,
    pub sender_to: Address,
    pub nonce: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at which the recipient's consent executed the transfer."
    )]
    pub at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " True when the amendment explicitly moved the refund claim for the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " existing deposit to `sender_to`. False means the deposit keeps accruing"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " to the original sender's claim even though the role moved — refund"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " rights are only ever moved on purpose, never implied by a role change."
    )]
    pub refund_rights_transferred: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Append-only ledger of who held the sender role for one stream."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `sender_at_creation` is the first entry of the record kept for a stream, and"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the log is never rewritten: consenting to a transfer appends exactly one"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " [`SenderTransferRecord`]. That is what lets an auditor answer \"who funded"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " this deposit?\" after several hops, which the mutable `Stream::sender` field"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " alone cannot.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderHistory {
    pub stream_id: u64,
    pub sender_at_creation: Address,
    pub transfers: Vec<SenderTransferRecord>,
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
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Field order and names are the storage wire format: appending a field is a"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " schema change that bumps [`CURRENT_STREAM_RECORD_VERSION`], and the field"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " must be an `Option` (or defaulted by a migration) so older records keep"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " decoding.")]
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
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Optional because records written before the oracle clock existed carry no"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `use_oracle` key at all; the SDK decodes an absent field as `None`, which"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " means ledger time. Every stream this build writes sets `Some(_)`, so the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " on-ledger shape of new records is unchanged."
    )]
    pub use_oracle: Option<bool>,
}

impl Stream {
    /// Seconds in the stream's full window. Always `>= 1` for a stored stream
    /// (`create_stream` rejects `end_time <= start_time`).
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }

    /// The oracle flag as behaviour. `None` is a pre-oracle record and settles
    /// against ledger time, exactly like `Some(false)`.
    pub fn uses_oracle(&self) -> bool {
        self.use_oracle.unwrap_or(false)
    }
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Parameters for creating a single stream within a batch creation call."
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A persisted [`Stream`] record together with the storage layout version it was"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " written under.")]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " This is the value stored under [`DataKey::Stream`] for every record written"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " by [`put_stream`]; the `version` field is written explicitly, never inferred."
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " [`get_stream_record`] decodes the legacy untagged [`STREAM_RECORD_VERSION_V1`]"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " layout as well, so records created before versioned writes landed keep"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " working until they are migrated.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionedStream {
    pub version: u32,
    pub stream: Stream,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Outcome of [`migrate_stream_record`]: which layout a single stream moved"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " from and to, and whether it moved at all."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamVersionReport {
    pub stream_id: u64,
    pub from_version: u32,
    pub to_version: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " False when the record already carried the current layout, so nothing was"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " rewritten — the proof that migration is idempotent."
    )]
    pub migrated: bool,
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
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " One settled entry of a `withdraw_many` batch claim."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `withdraw_many` answers every requested id (see [`WithdrawEntry`]) and this"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " type describes money that actually moved, so it is also what the batch's"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " [`crate::BatchWithdrawSummary`] event lists."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawOutcome {
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The whole accrued-but-unwithdrawn balance delivered for this stream."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Always positive: an entry that had nothing to pay is an `Err`, not a"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " zero-amount outcome.")]
    pub amount: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The per-entry answer of [`crate::StreamingPayments::withdraw_many`], one per"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " requested id and in request order."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " This is deliberately a struct carrying an amount *or* a code, rather than a"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `Vec<Result<WithdrawOutcome, StreamError>>`. Soroban encodes `Result::Err` as"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " an `ScError`, and the off-chain ScVal decoder (`scValToNative` in"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `@stellar/stellar-sdk`) has no conversion for it, so a batch with even one"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " skipped entry would arrive as a decode failure instead of a partial result —"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " defeating the point of per-entry isolation. A map per entry always decodes,"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " and `code` is the same stable discriminant the contract reports on a revert."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawEntry {
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Tokens delivered for this stream; `0` when the entry was skipped."
    )]
    pub amount: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `0` once the entry settled, otherwise the [`crate::StreamError`] that"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " skipped it, as its numeric code.")]
    pub code: u32,
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

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Pagination bounds for [`crate::StreamingPayments::withdraw_all`]: which slice of the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " recipient's stream index to claim. `limit` is clamped to [`MAX_PAGE_SIZE`]; `0` means"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " \"the largest page\".")]
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageBounds {
    pub offset: u32,
    pub limit: u32,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Total paid out in one asset by a [`crate::StreamingPayments::withdraw_all`] call."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetTransfer {
    pub token: Address,
    pub amount: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A stream [`crate::StreamingPayments::withdraw_all`] skipped, with the numeric code of"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the [`crate::StreamError`] that skipped it."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimFailure {
    pub stream_id: u64,
    pub error_code: u32,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The answer of [`crate::StreamingPayments::withdraw_all`] for one page of the"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " recipient's stream index.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawAllResult {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Payouts aggregated per asset: one token transfer each."
    )]
    pub transfers: Vec<AssetTransfer>,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Streams that paid out, in index order."
    )]
    pub successful_stream_ids: Vec<u64>,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Streams that were skipped, with the reason."
    )]
    pub failed_streams: Vec<ClaimFailure>,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Offset of the next page, or `None` once the index is exhausted."
    )]
    pub next_offset: Option<u32>,
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
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream with the given id. Stored as a [`VersionedStream`] by"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " current builds; [`STREAM_RECORD_VERSION_V1`] records (a bare [`Stream`]"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " with no version tag) remain readable until migrated."
    )]
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
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The pending recipient-consented sender transfer for the given stream."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Kept outside [`Stream`] so proposing changes no accounting field, and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " so the record layout tag of a stream is untouched by role plumbing."
    )]
    PendingSenderTransfer(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Append-only sender-role transfer log for the given stream. Absent until"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the first transfer executes for that stream, which is also when"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " `sender_at_creation` is fixed.")]
    SenderHistory(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The address whose deposit-backed claim receives cancellation refunds for"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the given stream. Absent means \"the current sender\"; the key is written"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " only when the answer must differ from that, which keeps reads of"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " untouched streams free of extra storage."
    )]
    RefundTarget(u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Freeze point of a paused stream. Present only while the stream is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " paused, so accrual for a running stream never depends on this key."
    )]
    StreamPause(u64),
}

/// Freeze point of stream `id` while it is paused; `None` while it streams.
#[inline(never)]
pub fn get_paused_at(env: &Env, id: u64) -> Option<u64> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent StreamPause({id})"));
    env.storage().persistent().get(&DataKey::StreamPause(id))
}

/// Records (`Some`) or clears (`None`) the freeze point of stream `id`.
pub fn set_paused_at(env: &Env, id: u64, paused_at: Option<u64>) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "{} persistent StreamPause({id})",
        if paused_at.is_some() {
            "write"
        } else {
            "remove"
        }
    ));
    let key = DataKey::StreamPause(id);
    match paused_at {
        Some(t) => {
            env.storage().persistent().set(&key, &t);
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        }
        None => env.storage().persistent().remove(&key),
    }
}

/// The timestamp accrual is evaluated at: `now`, or the freeze point while the
/// stream is paused. Resuming shifts the window forward by the paused length,
/// so accrual continues from the frozen amount at the original rate.
#[inline(never)]
pub fn accrual_now(env: &Env, id: u64, now: u64) -> u64 {
    match get_paused_at(env, id) {
        Some(t) => now.min(t),
        None => now,
    }
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
    cancel_amounts_at(
        stream,
        accrual_now(env, stream.id, env.ledger().timestamp()),
    )
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
///
/// A thin wrapper over [`get_stream_record`] that discards the layout version.
pub fn get_stream(env: &Env, id: u64) -> Result<Stream, StreamError> {
    Ok(get_stream_record(env, id)?.stream)
}

/// Loads a stream together with the storage layout version its record carries.
///
/// Both layouts are readable: the current [`VersionedStream`] tag and the
/// legacy untagged [`Stream`] map (reported as [`STREAM_RECORD_VERSION_V1`]).
/// The probe order is deliberate — the tagged layout is tried first, and a
/// record that decodes as *neither* layout is refused with
/// [`StreamError::SchemaVersionUnsupported`] rather than being guessed at.
/// That is the fail-closed half of versioning: a record written by a future
/// build with fields this build has never seen can never be silently
/// mis-decoded into a present-day [`Stream`].
pub fn get_stream_record(env: &Env, id: u64) -> Result<VersionedStream, StreamError> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent Stream({id})"));
    let key = DataKey::Stream(id);
    // Reading as a raw `Val` cannot fail: shape probing happens below with
    // fallible conversions, not through the storage getter's infallible ones.
    let Some(raw): Option<Val> = env.storage().persistent().get(&key) else {
        return Err(surface::reject(Branch::StreamNotFound));
    };
    if let Ok(record) = VersionedStream::try_from_val(env, &raw) {
        // Unknown tags — from the future *or* malformed — are refused: only a
        // layout this build actually understands may be decoded.
        if record.version < STREAM_RECORD_VERSION_V1
            || record.version > CURRENT_STREAM_RECORD_VERSION
        {
            return Err(surface::reject(Branch::SchemaVersionUnsupported));
        }
        return Ok(record);
    }
    if let Ok(stream) = Stream::try_from_val(env, &raw) {
        return Ok(VersionedStream {
            version: STREAM_RECORD_VERSION_V1,
            stream,
        });
    }
    Err(surface::reject(Branch::SchemaVersionUnsupported))
}

/// The storage layout version of one stream record.
pub fn stream_record_version(env: &Env, id: u64) -> Result<u32, StreamError> {
    Ok(get_stream_record(env, id)?.version)
}

/// Re-encodes one stream record under [`CURRENT_STREAM_RECORD_VERSION`].
///
/// Idempotent by construction: a record that already carries the current layout
/// is reported with `migrated = false` and left untouched (no rewrite, so no
/// storage delta and no event). Callable by anyone — it changes no accounting,
/// only the encoding of a record that is already provably equivalent — and it
/// touches exactly one storage entry, which is what bounds its gas.
pub fn migrate_stream_record(env: &Env, id: u64) -> Result<StreamVersionReport, StreamError> {
    let record = get_stream_record(env, id)?;
    if record.version == CURRENT_STREAM_RECORD_VERSION {
        return Ok(StreamVersionReport {
            stream_id: id,
            from_version: record.version,
            to_version: record.version,
            migrated: false,
        });
    }
    put_stream(env, &record.stream);
    Ok(StreamVersionReport {
        stream_id: id,
        from_version: record.version,
        to_version: CURRENT_STREAM_RECORD_VERSION,
        migrated: true,
    })
}

/// Persists a stream under the current versioned layout and extends its storage TTL.
pub fn put_stream(env: &Env, stream: &Stream) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent Stream({})", stream.id));
    let key = DataKey::Stream(stream.id);
    let record = VersionedStream {
        version: CURRENT_STREAM_RECORD_VERSION,
        stream: stream.clone(),
    };
    env.storage().persistent().set(&key, &record);
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

/// Drops `id` from a sender's discovery index — the prune half of a sender-role
/// transfer, so the outgoing sender's listing stops offering a stream they no
/// longer control while the incoming sender's starts offering it.
pub fn unindex_sender(env: &Env, sender: &Address, id: u64) {
    remove_from_index(env, &DataKey::SenderStreams(sender.clone()), id);
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

/// Loads the pending sender transfer for `id`, if one exists, and extends its
/// storage TTL (the same read-then-extend shape as [`get_pending_ownership`]:
/// extending a key that is absent fails).
pub fn get_pending_sender_transfer(env: &Env, id: u64) -> Option<PendingSenderTransfer> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent PendingSenderTransfer({id})"));
    let key = DataKey::PendingSenderTransfer(id);
    let storage = env.storage().persistent();
    let pending: PendingSenderTransfer = storage.get(&key)?;
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

/// Persists a pending sender transfer and extends its storage TTL.
pub fn put_pending_sender_transfer(env: &Env, pending: &PendingSenderTransfer) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "write persistent PendingSenderTransfer({})",
        pending.stream_id
    ));
    let key = DataKey::PendingSenderTransfer(pending.stream_id);
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

/// Removes a pending sender transfer. No-op if none exists.
pub fn remove_pending_sender_transfer(env: &Env, id: u64) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "remove persistent PendingSenderTransfer({id})"
    ));
    env.storage()
        .persistent()
        .remove(&DataKey::PendingSenderTransfer(id));
}

/// The address whose refund claim the remaining deposit belongs to.
///
/// Falls back to `stream.sender` when no explicit target is stored, so every
/// stream that never had a role change or a refund amendment keeps today's
/// behavior with no extra storage read cost in layout terms.
pub fn refund_target(env: &Env, stream: &Stream) -> Address {
    let key = DataKey::RefundTarget(stream.id);
    let storage = env.storage().persistent();
    if let Some(target) = storage.get::<DataKey, Address>(&key) {
        storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        return target;
    }
    stream.sender.clone()
}

/// Pins the refund claim of `id` to `target`.
pub fn put_refund_target(env: &Env, id: u64, target: &Address) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent RefundTarget({id})"));
    let key = DataKey::RefundTarget(id);
    env.storage().persistent().set(&key, target);
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
    available_amount_at_segments(stream, accrual_now(env, stream.id, now), &segments)
}

/// Cancellation split at `now`, honoring the stored schedule.
pub fn cancel_amounts_with_plan(
    env: &Env,
    stream: &Stream,
    now: u64,
) -> Result<(i128, i128), StreamError> {
    let segments = get_rate_segments(env, stream.id);
    cancel_amounts_at_segments(stream, accrual_now(env, stream.id, now), &segments)
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

/// The sender-role log for one stream.
///
/// A stream whose role has never moved has no log: the view then reports the
/// current sender as `sender_at_creation` with an empty history, which is what
/// the append-only log would have been seeded with.
pub fn sender_history(env: &Env, stream: &Stream) -> SenderHistory {
    get_sender_history(env, stream)
}

fn get_sender_history(env: &Env, stream: &Stream) -> SenderHistory {
    let key = DataKey::SenderHistory(stream.id);
    let storage = env.storage().persistent();
    if let Some(history) = storage.get::<DataKey, SenderHistory>(&key) {
        storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        return history;
    }
    SenderHistory {
        stream_id: stream.id,
        sender_at_creation: stream.sender.clone(),
        transfers: Vec::new(env),
    }
}

/// Appends one executed transfer to the stream's log. The existing entries are
/// copied unchanged — the log is append-only, never rewritten.
fn append_sender_history(env: &Env, stream: &Stream, record: &SenderTransferRecord) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "write persistent SenderHistory({})",
        stream.id
    ));
    let key = DataKey::SenderHistory(stream.id);
    let mut history = get_sender_history(env, stream);
    history.transfers.push_back(record.clone());
    env.storage().persistent().set(&key, &history);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Executes a consented sender transfer: the role moves to `new_sender`, the
/// discovery indexes are re-pointed, the refund claim follows only when the
/// proposal said it should, and the transfer is appended to the immutable log.
///
/// The caller has already checked consent, nonce and expiry; this is the
/// effects half, kept separate so the CEI order (reads, then state writes, then
/// the event, then nothing) is readable in one place.
pub fn apply_sender_transfer(
    env: &Env,
    stream: &Stream,
    pending: &PendingSenderTransfer,
) -> Result<Stream, StreamError> {
    let previous_target = refund_target(env, stream);
    let mut updated = stream.clone();
    updated.sender = pending.new_sender.clone();
    put_stream(env, &updated);

    // Index migration for the one hop: the outgoing sender's discovery page
    // stops listing the stream, the incoming sender's starts listing it, and
    // both pages get their TTL extended by the write (`index_sender` and
    // `unindex_sender` share the same append/prune helpers).
    unindex_sender(env, &pending.sender_from, updated.id);
    index_sender(env, &pending.new_sender, updated.id);

    // Refund rights move only on purpose: an amendment that did not ask for it
    // pins the claim to whatever it was before the hop — the original sender's.
    put_refund_target(
        env,
        updated.id,
        if pending.transfer_refund_rights {
            &pending.new_sender
        } else {
            &previous_target
        },
    );

    append_sender_history(
        env,
        stream,
        &SenderTransferRecord {
            sender_from: pending.sender_from.clone(),
            sender_to: pending.new_sender.clone(),
            nonce: pending.nonce,
            at: env.ledger().timestamp(),
            refund_rights_transferred: pending.transfer_refund_rights,
        },
    );

    Ok(updated)
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

/// Removes the first occurrence of `id` from an address index, sharing
/// [`push_to_index`]'s read-modify-write-and-extend shape.
///
/// Returns false when the address has no index entry or never listed `id`, and
/// leaves storage untouched in that case. Order of the remaining ids is
/// preserved, so an index page stays in creation order after a prune.
pub(crate) fn remove_from_index(env: &Env, key: &DataKey, id: u64) -> bool {
    let storage = env.storage().persistent();
    let Some(ids): Option<Vec<u64>> = storage.get(key) else {
        return false;
    };
    let mut kept: Vec<u64> = Vec::new(env);
    let mut pruned = false;
    for index in 0..ids.len() {
        let Some(value) = ids.get(index) else {
            continue;
        };
        if !pruned && value == id {
            pruned = true;
            continue;
        }
        kept.push_back(value);
    }
    if pruned {
        storage.set(key, &kept);
        storage.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }
    pruned
}

/// Returns one page of stream ids from an address index, in creation order.
///
/// `limit` is clamped to [`MAX_PAGE_SIZE`]; an `offset` past the end (or an
/// unknown address) yields an empty page rather than an error. Reading the
/// index extends its TTL, so actively-queried addresses never go cold.
/// Addresses with no index entry never had any streams: return early without
/// touching storage (`extend_ttl` on a never-written key would fail).
pub fn page_stream_ids(env: &Env, key: &DataKey, offset: u32, limit: u32) -> Vec<u64> {
    page_stream_ids_with_len(env, key, offset, limit).0
}

/// [`page_stream_ids`] plus the full length of the index, from the same read.
pub fn page_stream_ids_with_len(
    env: &Env,
    key: &DataKey,
    offset: u32,
    limit: u32,
) -> (Vec<u64>, u32) {
    let storage = env.storage().persistent();
    let Some(ids): Option<Vec<u64>> = storage.get(key) else {
        return (Vec::new(env), 0);
    };
    storage.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let start = offset.min(ids.len());
    let end = start
        .saturating_add(limit.min(MAX_PAGE_SIZE))
        .min(ids.len());
    (ids.slice(start..end), ids.len())
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
