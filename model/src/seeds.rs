//! Corpus seeds derived from unit and property test scenarios.

use crate::action::{Action, ActionSequence};

const DAY: u32 = 86400;
const DEPOSIT: i128 = 10_000_000_000;

/// 1. Create stream and linearly withdraw in increments.
pub fn seed_create_and_linear_withdraw() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: DAY,
            duration_secs: 10 * DAY,
            cancelable: true,
        },
        Action::AdvanceTime { seconds: 3 * DAY }, // 2 days elapsed of 10
        Action::Withdraw {
            stream_id: 1,
            amount: 2 * DEPOSIT / 10,
        },
        Action::AdvanceTime { seconds: 8 * DAY }, // past end
        Action::Withdraw {
            stream_id: 1,
            amount: 8 * DEPOSIT / 10,
        },
    ])
}

/// 2. Multiple sequential partial withdrawals.
pub fn seed_multiple_partial_withdrawals() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 20 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 2 * DAY },
        Action::Withdraw {
            stream_id: 1,
            amount: DEPOSIT / 20,
        },
        Action::AdvanceTime { seconds: 3 * DAY },
        Action::Withdraw {
            stream_id: 1,
            amount: 3 * DEPOSIT / 20,
        },
        Action::AdvanceTime { seconds: 20 * DAY },
        Action::Withdraw {
            stream_id: 1,
            amount: 16 * DEPOSIT / 20,
        },
    ])
}

/// 3. WithdrawMax draining the stream.
pub fn seed_withdraw_max() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 1,
            recipient_idx: 2,
            deposit_amount: DEPOSIT,
            start_delay_secs: DAY,
            duration_secs: 10 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 6 * DAY }, // 5 days elapsed
        Action::WithdrawMax { stream_id: 1 },
        Action::AdvanceTime { seconds: 10 * DAY }, // ended
        Action::WithdrawMax { stream_id: 1 },
        Action::WithdrawMax { stream_id: 1 }, // Depleted: fails with StreamNotActive
    ])
}

/// 4. Cancellation by sender with pro-rata split.
pub fn seed_cancel_by_sender() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 3 * DAY },
        Action::CancelStream {
            caller_idx: 0, // sender
            stream_id: 1,
        },
        Action::CancelStream {
            caller_idx: 0,
            stream_id: 1, // fails with StreamNotActive
        },
    ])
}

/// 5. Cancellation by recipient on cancelable stream.
pub fn seed_cancel_by_recipient_cancelable() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 2,
            recipient_idx: 3,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: true,
        },
        Action::AdvanceTime { seconds: 5 * DAY },
        Action::CancelStream {
            caller_idx: 3, // recipient
            stream_id: 1,
        },
    ])
}

/// 6. Cancellation attempted by recipient on non-cancelable stream (rejected).
pub fn seed_cancel_by_recipient_non_cancelable_rejected() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 2 * DAY },
        Action::CancelStream {
            caller_idx: 1, // recipient
            stream_id: 1,  // fails with StreamNotCancellable
        },
    ])
}

/// 7. Cancel before start refunds 100% to sender.
pub fn seed_cancel_before_start() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 5 * DAY,
            duration_secs: 10 * DAY,
            cancelable: true,
        },
        Action::AdvanceTime { seconds: 2 * DAY }, // still 3 days before start
        Action::CancelStream {
            caller_idx: 0,
            stream_id: 1,
        },
    ])
}

/// 8. Cancel after end pays 100% to recipient.
pub fn seed_cancel_after_end() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 5 * DAY,
            cancelable: true,
        },
        Action::AdvanceTime { seconds: 10 * DAY }, // past end
        Action::CancelStream {
            caller_idx: 0,
            stream_id: 1,
        },
    ])
}

/// 9. Top-up increases deposit and accrual pro-rata.
pub fn seed_top_up_pro_rata() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 2 * DAY },
        Action::TopUp {
            caller_idx: 0, // sender
            stream_id: 1,
            amount: DEPOSIT / 2,
        },
        Action::AdvanceTime { seconds: 2 * DAY },
        Action::WithdrawMax { stream_id: 1 },
    ])
}

/// 10. Top-up after end is immediately withdrawable.
pub fn seed_top_up_after_end() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 5 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 10 * DAY },
        Action::TopUp {
            caller_idx: 0,
            stream_id: 1,
            amount: DEPOSIT,
        },
        Action::WithdrawMax { stream_id: 1 },
    ])
}

/// 11. Governor rotation (two-step).
pub fn seed_governor_two_step_rotation() -> ActionSequence {
    ActionSequence::new(vec![
        Action::NominateGovernor {
            caller_is_gov: false, // stranger fails
            nominee_idx: 1,
        },
        Action::NominateGovernor {
            caller_is_gov: true, // governor nominates User1
            nominee_idx: 1,
        },
        Action::AcceptGovernor {
            caller_idx: 2, // wrong user fails
        },
        Action::AcceptGovernor {
            caller_idx: 1, // nominee succeeds
        },
        Action::SetFeeBps {
            caller_is_gov: false, // old governor fails
            new_fee_bps: 50,
        },
    ])
}

/// 12. Protocol fees charged and withdrawn.
pub fn seed_protocol_fees_and_treasury_withdraw() -> ActionSequence {
    ActionSequence::new(vec![
        Action::SetFeeBps {
            caller_is_gov: true,
            new_fee_bps: 100, // 1%
        },
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: false,
        },
        Action::WithdrawTreasury {
            caller_is_gov: true,
            recipient_idx: 3,
            amount: 50_000_000,
        },
        Action::WithdrawTreasury {
            caller_is_gov: true,
            recipient_idx: 3,
            amount: 100_000_000, // exceeds collectible -> fails
        },
    ])
}

/// 13. Invalid inputs rejected properly.
pub fn seed_invalid_inputs_rejected() -> ActionSequence {
    ActionSequence::new(vec![
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: 0, // fails ZeroAmount
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: false,
        },
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 0, // fails InvalidTimeRange
            cancelable: false,
        },
        Action::SetFeeBps {
            caller_is_gov: true,
            new_fee_bps: 101, // exceeds MAX_FEE_BPS
        },
        Action::Withdraw {
            stream_id: 999, // unknown
            amount: 100,
        },
    ])
}

/// 14. Complex interleaved multi-stream lifecycle.
pub fn seed_complex_interleaved_lifecycle() -> ActionSequence {
    ActionSequence::new(vec![
        Action::SetFeeBps {
            caller_is_gov: true,
            new_fee_bps: 25,
        },
        Action::CreateStream {
            sender_idx: 0,
            recipient_idx: 1,
            deposit_amount: DEPOSIT,
            start_delay_secs: 0,
            duration_secs: 10 * DAY,
            cancelable: true,
        },
        Action::CreateStream {
            sender_idx: 1,
            recipient_idx: 2,
            deposit_amount: 2 * DEPOSIT,
            start_delay_secs: DAY,
            duration_secs: 5 * DAY,
            cancelable: false,
        },
        Action::AdvanceTime { seconds: 2 * DAY },
        Action::Withdraw {
            stream_id: 1,
            amount: DEPOSIT / 10,
        },
        Action::TopUp {
            caller_idx: 1,
            stream_id: 2,
            amount: DEPOSIT / 2,
        },
        Action::AdvanceTime { seconds: 2 * DAY },
        Action::WithdrawMax { stream_id: 2 },
        Action::CancelStream {
            caller_idx: 0,
            stream_id: 1,
        },
        Action::WithdrawTreasury {
            caller_is_gov: true,
            recipient_idx: 0,
            amount: 10_000,
        },
        Action::AdvanceTime { seconds: 5 * DAY },
        Action::WithdrawMax { stream_id: 2 },
    ])
}

/// Returns all 14 baseline seeded scenarios.
pub fn all_seeded_scenarios() -> Vec<(&'static str, ActionSequence)> {
    vec![
        (
            "01_create_and_linear_withdraw",
            seed_create_and_linear_withdraw(),
        ),
        (
            "02_multiple_partial_withdrawals",
            seed_multiple_partial_withdrawals(),
        ),
        ("03_withdraw_max", seed_withdraw_max()),
        ("04_cancel_by_sender", seed_cancel_by_sender()),
        (
            "05_cancel_by_recipient_cancelable",
            seed_cancel_by_recipient_cancelable(),
        ),
        (
            "06_cancel_by_recipient_non_cancelable_rejected",
            seed_cancel_by_recipient_non_cancelable_rejected(),
        ),
        ("07_cancel_before_start", seed_cancel_before_start()),
        ("08_cancel_after_end", seed_cancel_after_end()),
        ("09_top_up_pro_rata", seed_top_up_pro_rata()),
        ("10_top_up_after_end", seed_top_up_after_end()),
        (
            "11_governor_two_step_rotation",
            seed_governor_two_step_rotation(),
        ),
        (
            "12_protocol_fees_and_treasury_withdraw",
            seed_protocol_fees_and_treasury_withdraw(),
        ),
        ("13_invalid_inputs_rejected", seed_invalid_inputs_rejected()),
        (
            "14_complex_interleaved_lifecycle",
            seed_complex_interleaved_lifecycle(),
        ),
    ]
}
