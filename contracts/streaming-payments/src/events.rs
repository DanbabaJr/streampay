//! Events emitted by StreamPay.
//!
//! Per-stream events are keyed by `stream_id`; `StreamsCreated` is keyed by
//! sender and carries the batch ids. Non-topic fields are event data.

use soroban_sdk::{contractevent, Address, BytesN, String, Vec};

/// Emitted when a new stream is created and its deposit pulled in.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreated {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
}

/// Emitted once after an atomic batch creates its streams.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamsCreated {
    #[topic]
    pub sender: Address,
    pub stream_ids: Vec<u64>,
}

/// Emitted when the recipient withdraws accrued funds.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    /// Total withdrawn from the stream after this withdrawal.
    pub withdrawn_total: i128,
}

/// Emitted when a stream is cancelled. The recipient's accrued balance and
/// the sender's refund are both paid atomically in the same transaction.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelled {
    #[topic]
    pub stream_id: u64,
    pub cancelled_by: Address,
    /// Amount paid out to the recipient at cancellation.
    pub recipient_amount: i128,
    /// Amount refunded to the sender at cancellation.
    pub sender_amount: i128,
}

/// Emitted when the sender adds funds to an existing stream.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamToppedUp {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub amount: i128,
    /// Stream deposit after the top-up.
    pub new_deposit: i128,
}

/// Emitted when a party attaches a hash-linked metadata attestation to a
/// stream. Append-only: this event is the durable record that
/// `attester` claimed `content_hash` (tagged `tag`) at `timestamp`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataAttached {
    #[topic]
    pub stream_id: u64,
    /// Position of the attestation in the stream's append-only list.
    pub index: u32,
    pub attester: Address,
    pub content_hash: BytesN<32>,
    pub tag: String,
    pub timestamp: u64,
/// Emitted when a sender pre-authorizes a future (optionally recurring)
/// stream creation and escrows the deposit plus keeper fee budget.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamScheduled {
    #[topic]
    pub intent_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    /// Deposit escrowed for *each* occurrence.
    pub deposit: i128,
    /// Scheduled start of the first occurrence (later occurrences are shifted
    /// by `interval`).
    pub start_time: u64,
    /// Scheduled end of the first occurrence.
    pub end_time: u64,
    pub cancelable: bool,
    /// Seconds between occurrence starts; `0` for a one-shot intent.
    pub interval: u64,
    /// Total number of streams this intent will create.
    pub occurrences: u32,
    /// Keeper fee escrowed for *each* occurrence.
    pub fee_budget: i128,
    /// Earliest time the first occurrence may be executed.
    pub execute_after: u64,
    /// After this time no occurrence may be executed; the escrow is reclaimable.
    pub expires_at: u64,
}

/// Emitted when a keeper executes one occurrence of a scheduled intent,
/// creating the stream and paying itself the escrowed per-occurrence fee.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledStreamExecuted {
    #[topic]
    pub intent_id: u64,
    pub keeper: Address,
    /// The newly created stream id.
    pub stream_id: u64,
    /// Zero-based index of the occurrence just executed.
    pub occurrence_index: u32,
    /// Occurrences still outstanding after this execution.
    pub occurrences_remaining: u32,
    /// Fee paid to the keeper for this execution.
    pub fee_paid: i128,
}

/// Emitted when a sender cancels a not-yet-executable intent and is refunded
/// the escrow for all outstanding occurrences.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledIntentCancelled {
    #[topic]
    pub intent_id: u64,
    pub sender: Address,
    /// Total refunded (deposit + fee budget for every outstanding occurrence).
    pub refund: i128,
}

/// Emitted when an intent passed `expires_at` with occurrences outstanding and
/// its escrow was returned to the sender.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledIntentExpired {
    #[topic]
    pub intent_id: u64,
    pub sender: Address,
    /// Total refunded for the outstanding occurrences.
    pub refund: i128,
}

/// Emitted exactly once per funded stream that owes a protocol fee, in the
/// same transaction as (and immediately after) `StreamCreated`. Keyed by
/// `stream_id` so fee history is auditable per stream; the stream's stored
/// fee (`stream_fee` read) and the token's `treasury_status` totals must
/// always reconcile with the sum of these events — that reconciliation is
/// the treasury invariant, checkable by anyone via `verify_treasury` and
/// `scripts/verify-fees.ts`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeCharged {
    #[topic]
    pub stream_id: u64,
    pub token: Address,
    /// The sender who paid the fee on top of the deposit.
    pub payer: Address,
    /// Fee amount in smallest token units (deposit * fee_bps / 10_000, floored).
    pub amount: i128,
    /// The fee rate in basis points that produced this amount.
    pub fee_bps: u32,
}

/// Emitted when the treasury governor withdraws accumulated protocol fees for
/// one token. Keyed by `token` (treasury accounting is per token);
/// `withdrawn_total` carries the cumulative withdrawn amount so event
/// consumers can reconcile against `treasury_status` without reading state.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeWithdrawn {
    #[topic]
    pub token: Address,
    /// The governor who authorized the withdrawal.
    pub governor: Address,
    /// Where the withdrawn fees were sent.
    pub recipient: Address,
    pub amount: i128,
    /// Total fees withdrawn for this token after this withdrawal.
    pub withdrawn_total: i128,
}
