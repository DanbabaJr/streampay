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
    /// A metadata attestation tag exceeds `MAX_TAG_LEN` bytes.
    MetadataTagTooLong = 14,
    /// A stream has reached `MAX_ATTESTATIONS_PER_STREAM` attestations.
    MetadataLimitReached = 15,
    /// The requested fee rate exceeds the protocol cap (`MAX_FEE_BPS`).
    FeeRateTooHigh = 14,
    /// The caller is not the treasury governor.
    NotGovernor = 15,
    /// `accept_governor` was called but no governor nomination is pending.
    NoPendingGovernor = 16,
    /// A treasury withdrawal exceeds the fees collected minus fees already
    /// withdrawn for that token.
    InsufficientTreasuryBalance = 17,
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
    ];

    /// The stable numeric value carried across the contract boundary
    /// (`Error(Contract, #code)`), i.e. the enum discriminant.
    pub const fn code(self) -> u32 {
        self as u32
    }
}
