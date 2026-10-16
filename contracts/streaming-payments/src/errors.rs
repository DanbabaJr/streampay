//! Error types for StreamPay.
//!
//! Every expected failure is expressed as a [`StreamError`] variant with a
//! stable numeric code, so clients can branch on failures without parsing
//! strings. The contract never panics on expected failure paths: all public
//! entrypoints return `Result<_, StreamError>` and all arithmetic is checked.
//!
//! Codes are part of the public interface — never renumber or reuse a variant;
//! only append new ones at the bottom with the next free code. A variant that
//! turns out to be unreachable is *retired* (kept, documented, and excluded
//! from coverage in `surface.rs`) rather than removed or reused, so the wire
//! codes of every existing client stay valid forever.
//!
//! Token-side failures are always translated into one of the `*TransferFailed`
//! variants below. A token contract's own error numbers live in the same
//! `Error(Contract, #N)` namespace as this enum's codes, so letting a raw
//! token failure surface would let — say — a token's `#5` masquerade as
//! [`StreamError::StreamNotActive`] in clients. The contract therefore invokes
//! every token transfer through the SDK's fallible (`try_`) client and maps
//! any failure to a distinct StreamPay code; the original token error is
//! intentionally not propagated.
//!
//! [`StreamError::ALL`] mirrors the variant set for the generated error-surface
//! coverage test. The exhaustive match in
//! `error_surface_test::stream_error_variant_list_is_exhaustive` fails to
//! compile when a variant is added, forcing the author to extend `ALL` (and the
//! `Branch` registry) in the same change.

use soroban_sdk::contracterror;

/// Errors returned by the StreamPay contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StreamError {
    /// No stream exists with the provided id.
    StreamNotFound = 1,
    /// **Retired — never produced.** Reserved role check; retained so the
    /// numeric code is never reused. See `docs/ERRORS.md`.
    NotStreamSender = 2,
    /// **Retired — never produced.** Reserved role check; retained so the
    /// numeric code is never reused. See `docs/ERRORS.md`.
    NotStreamRecipient = 3,
    /// The stream is not `cancelable`, so the recipient cannot cancel it.
    StreamNotCancellable = 4,
    /// The stream is cancelled or depleted; the operation is not permitted.
    StreamNotActive = 5,
    /// `start_time` is before the current ledger timestamp.
    StartTimeInPast = 6,
    /// `end_time` is not strictly after `start_time`.
    InvalidTimeRange = 7,
    /// The stream duration exceeds the maximum supported duration.
    DurationTooLong = 8,
    /// A provided amount (deposit, top-up, or withdrawal) is zero or negative.
    ZeroAmount = 9,
    /// The requested withdrawal exceeds the accrued, unwithdrawn balance.
    AmountExceedsAvailable = 10,
    /// An intermediate computation would overflow; all math is checked.
    MathOverflow = 11,
    /// The caller is not permitted to perform this action.
    NotAuthorized = 12,
    /// `withdraw_max` found nothing accrued-but-unwithdrawn to pay out.
    NothingToWithdraw = 13,
    /// A metadata attestation tag exceeds `MAX_TAG_LEN` bytes. Appended after
    /// the treasury codes (1–17), per the append-only code policy.
    MetadataTagTooLong = 18,
    /// A stream has reached `MAX_ATTESTATIONS_PER_STREAM` attestations.
    MetadataLimitReached = 19,
    /// The requested fee rate exceeds the protocol cap (`MAX_FEE_BPS`).
    FeeRateTooHigh = 14,
    /// The caller is not the treasury governor.
    NotGovernor = 15,
    /// `accept_governor` was called but no governor nomination is pending.
    NoPendingGovernor = 16,
    /// A treasury withdrawal exceeds the fees collected minus fees already
    /// withdrawn for that token.
    InsufficientTreasuryBalance = 17,
    /// No scheduled intent exists with the provided id.
    IntentNotFound = 18,
    /// The scheduled intent is not pending (already executed, cancelled, or
    /// expired), so the operation is not permitted.
    IntentNotPending = 19,
    /// Execution was attempted before the intent's `execute_after` (for the
    /// next outstanding occurrence).
    IntentNotYetExecutable = 20,
    /// Execution or cancellation was attempted at/after the intent's
    /// `expires_at`; the funds are reclaimable via `reclaim_expired`.
    IntentExpired = 21,
    /// The sender tried to cancel an intent whose execution window has already
    /// opened; cancellation is only allowed before `execute_after`.
    IntentNotCancellable = 22,
    /// The scheduling parameters are inconsistent (bad occurrence/interval
    /// combination, negative fee budget, ordering of `execute_after` /
    /// `start_time` / `expires_at`, or an overflowing recurrence window).
    InvalidScheduleParameters = 23,
    /// A defensive integrity check failed: the stored intent's parameters no
    /// longer hash to the commitment recorded when it was scheduled.
    IntentParamsMismatch = 24,
    /// `reclaim_expired` was called before the intent's `expires_at`.
    IntentNotExpired = 25,
    /// The token pull in `create_stream` failed: the sender's balance or
    /// allowance was insufficient (the pull covers `deposit_amount + fee`),
    /// or the asset refused the transfer (frozen/unauthorized/deauthorized
    /// holder, or any non-compliant token). Nothing is persisted when it
    /// fails, so no stream id is consumed.
    DepositTransferFailed = 26,
    /// The token pull in `top_up` failed (see
    /// [`StreamError::DepositTransferFailed`]; the stream's deposit is left
    /// untouched).
    TopUpTransferFailed = 27,
    /// The payout of accrued funds to the stream recipient failed — from
    /// `withdraw`, `withdraw_max`, or the recipient leg of `cancel_stream`.
    /// State changes made before the transfer are rolled back with the error.
    RecipientPayoutFailed = 28,
    /// The refund of unaccrued funds back to the sender failed during
    /// `cancel_stream` (the recipient leg, if any, was already paid).
    /// The cancellation is rolled back in full, so the stream stays active.
    SenderRefundFailed = 29,
    /// The payout of collected protocol fees failed in `withdraw_treasury`.
    /// The recorded withdrawal and the `FeeWithdrawn` event are rolled back
    /// with it, so the fee ledger stays unchanged.
    TreasuryPayoutFailed = 30,
}

impl StreamError {
    /// Every variant, in code order. The error-surface coverage test iterates
    /// this list, so a code no entrypoint can produce is a test failure unless
    /// it is listed as retired in `crate::surface::RETIRED_CODES`.
    pub const ALL: &'static [StreamError] = &[
        StreamError::StreamNotFound,
        StreamError::NotStreamSender,
        StreamError::NotStreamRecipient,
        StreamError::StreamNotCancellable,
        StreamError::StreamNotActive,
        StreamError::StartTimeInPast,
        StreamError::InvalidTimeRange,
        StreamError::DurationTooLong,
        StreamError::ZeroAmount,
        StreamError::AmountExceedsAvailable,
        StreamError::MathOverflow,
        StreamError::NotAuthorized,
        StreamError::NothingToWithdraw,
        StreamError::MetadataTagTooLong,
        StreamError::MetadataLimitReached,
        StreamError::FeeRateTooHigh,
        StreamError::NotGovernor,
        StreamError::NoPendingGovernor,
        StreamError::InsufficientTreasuryBalance,
        StreamError::IntentNotFound,
        StreamError::IntentNotPending,
        StreamError::IntentNotYetExecutable,
        StreamError::IntentExpired,
        StreamError::IntentNotCancellable,
        StreamError::InvalidScheduleParameters,
        StreamError::IntentParamsMismatch,
        StreamError::IntentNotExpired,
        StreamError::DepositTransferFailed,
        StreamError::TopUpTransferFailed,
        StreamError::RecipientPayoutFailed,
        StreamError::SenderRefundFailed,
        StreamError::TreasuryPayoutFailed,
    ];

    /// The stable numeric value carried across the contract boundary
    /// (`Error(Contract, #code)`), i.e. the enum discriminant.
    pub const fn code(self) -> u32 {
        self as u32
    }
}
