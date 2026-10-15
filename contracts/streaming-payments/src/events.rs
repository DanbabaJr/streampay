//! Events emitted by StreamPay.
//!
//! Every event is keyed by `stream_id` as a topic, so indexers can filter per
//! stream efficiently. Non-`#[topic]` fields are event data.

use soroban_sdk::{contractevent, Address, BytesN, String};

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
}
