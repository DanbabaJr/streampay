//! Events emitted by the StreamPay reference model.
//!
//! Mirrors the event types emitted by [`streampay_contract`].

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelEvent {
    StreamCreated {
        stream_id: u64,
        sender: String,
        recipient: String,
        token: String,
        deposit: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    },
    Withdrawn {
        stream_id: u64,
        recipient: String,
        amount: i128,
        withdrawn_total: i128,
    },
    StreamCancelled {
        stream_id: u64,
        cancelled_by: String,
        recipient_amount: i128,
        sender_amount: i128,
    },
    StreamToppedUp {
        stream_id: u64,
        sender: String,
        amount: i128,
        new_deposit: i128,
    },
    FeeCharged {
        stream_id: u64,
        token: String,
        payer: String,
        amount: i128,
        fee_bps: u32,
    },
    FeeWithdrawn {
        token: String,
        governor: String,
        recipient: String,
        amount: i128,
        withdrawn_total: i128,
    },
}
