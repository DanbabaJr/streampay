//! Error-surface instrumentation.
//!
//! Every expected failure in the contract funnels through [`reject`]: a
//! rejection site names a [`Branch`] — one `(entrypoint, condition)` validation
//! decision — instead of returning a bare [`StreamError`]. The branch registry
//! is the single source of truth for the mapping
//! `(entrypoint, condition) -> error code`, so that:
//!
//! * the generated test matrix (`error_surface_test.rs`) can prove that every
//!   *reachable* branch fires its declared code, and
//! * `docs/ERRORS.md` is generated from the same table (see
//!   `examples/error_surface_doc.rs`) and diffed in CI.
//!
//! Because the table is data, a hand-maintained list of "which test covers
//! which code" never exists: the mapping is emitted from here.
//!
//! Instrumentation is test-only. In non-test builds [`reject`] compiles down to
//! the error it returns (the `#[cfg(test)]` trace is the only overhead, and it
//! disappears entirely in the Wasm build).

use crate::errors::StreamError;

/// Whether a rejection branch is expected to be reachable at runtime.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Reachability {
    /// A probe in `error_surface_test.rs` triggers this branch, and the test
    /// asserts the exact branch (not merely *an* error) fired.
    Reachable,
    /// A defensive guard whose precondition cannot occur for any stored stream,
    /// because the contract's invariants rule it out. Documented, and reported
    /// as unreachable by the coverage test rather than probed.
    Defensive,
}

/// One validation decision in the contract.
///
/// A branch is a single `(entrypoint, condition)` pair that maps to exactly one
/// [`StreamError`]. Branch-level (rather than code-level) granularity is what
/// makes the matrix meaningful: several branches may intentionally share a code
/// (e.g. every zero-amount rejection is [`StreamError::ZeroAmount`]).
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Branch {
    // --------------------------------------------------------- create_stream
    CreateDepositNonPositive,
    CreateStartTimeInPast,
    CreateInvalidTimeRange,
    CreateDurationTooLong,
    // -------------------------------------------------------------- withdraw
    WithdrawAmountNonPositive,
    WithdrawAmountExceedsAvailable,
    // ---------------------------------------------------------- withdraw_max
    WithdrawMaxNothingToWithdraw,
    // --------------------------------------------------------- cancel_stream
    CancelStreamNotCancellable,
    CancelStreamNotAuthorized,
    // --------------------------------------------------------------- top_up
    TopUpAmountNonPositive,
    TopUpDepositOverflow,
    // ------------------------------------------------------ attach_metadata
    /// `attach_metadata`: the caller is neither the stream's sender nor its
    /// recipient.
    AttachMetadataNotAuthorized,
    /// `attach_metadata`: the tag is longer than `MAX_TAG_LEN` bytes.
    AttachMetadataTagTooLong,
    /// `attach_metadata`: the stream already holds
    /// `MAX_ATTESTATIONS_PER_STREAM` attestations.
    AttachMetadataLimitReached,
    // ------------------------------------------------- shared storage/math
    /// `stream.rs::get_stream` finds no stored entry.
    StreamNotFound,
    /// A terminal (cancelled/depleted) stream is mutated.
    StreamNotActive,
    /// `validate_capacity`: `deposit * duration` would exceed `u128`.
    CapacityOverflow,
    /// `streamed_at`: `deposit * elapsed` would exceed `u128`.
    RateProductOverflow,
    /// `available_amount`: `streamed - withdrawn` would underflow.
    AvailableBalanceOverflow,
    /// `cancel_amounts`: the pro-rata split would underflow.
    CancelSplitOverflow,
    /// `pay_out`: `withdrawn + amount` would overflow `i128`.
    PayoutOverflow,
    // ----------------------------------------------------------- treasury
    /// `set_fee_bps`: the requested rate exceeds `MAX_FEE_BPS`.
    SetFeeRateTooHigh,
    /// `set_fee_bps` / `nominate_governor` / `withdraw_treasury`: the caller
    /// is not the treasury governor.
    GovernorNotAllowed,
    /// `accept_governor`: no nomination is pending.
    AcceptGovernorNoPending,
    /// `accept_governor`: the caller is not the nominated address.
    AcceptGovernorNotNominee,
    /// `withdraw_treasury`: amount is zero or negative.
    WithdrawTreasuryAmountNonPositive,
    /// `withdraw_treasury`: amount exceeds fees collected minus fees already
    /// withdrawn.
    WithdrawTreasuryExceedsBalance,
    // --------------------------------------------------- scheduled intents
    /// No stored intent exists for the supplied id.
    IntentNotFound,
    /// An operation requiring a pending intent found a terminal intent.
    IntentNotPending,
    /// `execute_scheduled`: the next occurrence is not due yet.
    IntentNotYetExecutable,
    /// `execute_scheduled` / `cancel_scheduled`: the intent expired.
    IntentExpired,
    /// `cancel_scheduled`: the execution window has opened.
    IntentNotCancellable,
    /// A schedule parameter is inconsistent or outside its supported bounds.
    ScheduleInvalidParameters,
    /// A stored intent no longer matches its authorization commitment.
    IntentParamsMismatch,
    /// `reclaim_expired`: the intent has not expired yet.
    IntentNotExpired,
    // --------------------------------------------------- token interactions
    /// `create_stream`: the token refused the pull of `deposit_amount + fee`
    /// (missing balance/allowance, a non-transferable asset, a non-SEP-41
    /// callee). Nothing is persisted, so no stream id is consumed.
    CreateDepositTransferFailed,
    /// `top_up`: the token refused the pull of the added funds; `deposit` is
    /// left unchanged.
    TopUpTransferFailed,
    /// `withdraw` / `withdraw_max` / the recipient leg of `cancel_stream`: the
    /// token refused the payout to the stream recipient.
    RecipientPayoutFailed,
    /// `cancel_stream`: the token refused the refund of unaccrued funds to the
    /// sender; the whole cancellation rolls back.
    SenderRefundFailed,
    /// `withdraw_treasury`: the token refused the payout of collected fees.
    TreasuryPayoutFailed,
}

impl Branch {
    /// Every branch, in declaration order. The matrix test walks this list and
    /// the coverage test requires each [`StreamError`] variant to be produced by
    /// one of these (or retired).
    pub const ALL: [Branch; 27] = [
    pub const ALL: [Branch; 37] = [
        Branch::CreateDepositNonPositive,
        Branch::CreateStartTimeInPast,
        Branch::CreateInvalidTimeRange,
        Branch::CreateDurationTooLong,
        Branch::WithdrawAmountNonPositive,
        Branch::WithdrawAmountExceedsAvailable,
        Branch::WithdrawMaxNothingToWithdraw,
        Branch::CancelStreamNotCancellable,
        Branch::CancelStreamNotAuthorized,
        Branch::TopUpAmountNonPositive,
        Branch::TopUpDepositOverflow,
        Branch::AttachMetadataNotAuthorized,
        Branch::AttachMetadataTagTooLong,
        Branch::AttachMetadataLimitReached,
        Branch::StreamNotFound,
        Branch::StreamNotActive,
        Branch::CapacityOverflow,
        Branch::RateProductOverflow,
        Branch::AvailableBalanceOverflow,
        Branch::CancelSplitOverflow,
        Branch::PayoutOverflow,
        Branch::SetFeeRateTooHigh,
        Branch::GovernorNotAllowed,
        Branch::AcceptGovernorNoPending,
        Branch::AcceptGovernorNotNominee,
        Branch::WithdrawTreasuryAmountNonPositive,
        Branch::WithdrawTreasuryExceedsBalance,
        Branch::IntentNotFound,
        Branch::IntentNotPending,
        Branch::IntentNotYetExecutable,
        Branch::IntentExpired,
        Branch::IntentNotCancellable,
        Branch::ScheduleInvalidParameters,
        Branch::IntentParamsMismatch,
        Branch::IntentNotExpired,
        Branch::CreateDepositTransferFailed,
        Branch::TopUpTransferFailed,
        Branch::RecipientPayoutFailed,
        Branch::SenderRefundFailed,
        Branch::TreasuryPayoutFailed,
    ];

    /// The entrypoint(s) through which this branch can fire. Shared helpers
    /// (storage lookups, accrual math) can be reached from several entrypoints;
    /// the matrix lists them all.
    pub const fn entrypoints(self) -> &'static [&'static str] {
        match self {
            Branch::CreateDepositNonPositive
            | Branch::CreateStartTimeInPast
            | Branch::CreateInvalidTimeRange
            | Branch::CreateDurationTooLong => &["create_stream", "create_streams"],
            Branch::WithdrawAmountNonPositive | Branch::WithdrawAmountExceedsAvailable => {
                &["withdraw"]
            }
            Branch::WithdrawMaxNothingToWithdraw => &["withdraw_max"],
            Branch::CancelStreamNotCancellable | Branch::CancelStreamNotAuthorized => {
                &["cancel_stream"]
            }
            Branch::TopUpAmountNonPositive | Branch::TopUpDepositOverflow => &["top_up"],
            Branch::AttachMetadataNotAuthorized
            | Branch::AttachMetadataTagTooLong
            | Branch::AttachMetadataLimitReached => &["attach_metadata"],
            Branch::StreamNotFound => &[
                "get_stream",
                "available",
                "withdraw",
                "withdraw_max",
                "cancel_stream",
                "top_up",
            ],
            Branch::StreamNotActive => &["withdraw", "withdraw_max", "cancel_stream", "top_up"],
            Branch::CapacityOverflow => &["create_stream", "create_streams", "top_up"],
            Branch::RateProductOverflow => &[
                "streamed_at",
                "available",
                "withdraw",
                "withdraw_max",
                "cancel_stream",
            ],
            Branch::AvailableBalanceOverflow => &["available", "withdraw", "withdraw_max"],
            Branch::CancelSplitOverflow => &["cancel_stream"],
            Branch::PayoutOverflow => &["withdraw", "withdraw_max"],
            Branch::SetFeeRateTooHigh => &["set_fee_bps"],
            Branch::GovernorNotAllowed => {
                &["set_fee_bps", "nominate_governor", "withdraw_treasury"]
            }
            Branch::AcceptGovernorNoPending | Branch::AcceptGovernorNotNominee => {
                &["accept_governor"]
            }
            Branch::WithdrawTreasuryAmountNonPositive | Branch::WithdrawTreasuryExceedsBalance => {
                &["withdraw_treasury"]
            }
            Branch::IntentNotFound => &[
                "get_intent",
                "execute_scheduled",
                "cancel_scheduled",
                "reclaim_expired",
            ],
            Branch::IntentNotPending => {
                &["execute_scheduled", "cancel_scheduled", "reclaim_expired"]
            }
            Branch::IntentNotYetExecutable
            | Branch::IntentExpired
            | Branch::IntentParamsMismatch => &["execute_scheduled"],
            Branch::IntentNotCancellable => &["cancel_scheduled"],
            Branch::ScheduleInvalidParameters => &["schedule_stream"],
            Branch::IntentNotExpired => &["reclaim_expired"],
            Branch::CreateDepositTransferFailed => &["create_stream", "create_streams"],
            Branch::TopUpTransferFailed => &["top_up"],
            Branch::RecipientPayoutFailed => &["withdraw", "withdraw_max", "cancel_stream"],
            Branch::SenderRefundFailed => &["cancel_stream"],
            Branch::TreasuryPayoutFailed => &["withdraw_treasury"],
        }
    }

    /// The error code this branch returns. Exhaustive by construction: adding a
    /// branch without a code is a compile error, which is what makes "no branch
    /// without a code" a property of the type system rather than a convention.
    pub const fn error(self) -> StreamError {
        match self {
            Branch::CreateDepositNonPositive => StreamError::ZeroAmount,
            Branch::CreateStartTimeInPast => StreamError::StartTimeInPast,
            Branch::CreateInvalidTimeRange => StreamError::InvalidTimeRange,
            Branch::CreateDurationTooLong => StreamError::DurationTooLong,
            Branch::WithdrawAmountNonPositive => StreamError::ZeroAmount,
            Branch::WithdrawAmountExceedsAvailable => StreamError::AmountExceedsAvailable,
            Branch::WithdrawMaxNothingToWithdraw => StreamError::NothingToWithdraw,
            Branch::CancelStreamNotCancellable => StreamError::StreamNotCancellable,
            Branch::CancelStreamNotAuthorized => StreamError::NotAuthorized,
            Branch::TopUpAmountNonPositive => StreamError::ZeroAmount,
            Branch::TopUpDepositOverflow => StreamError::MathOverflow,
            Branch::AttachMetadataNotAuthorized => StreamError::NotAuthorized,
            Branch::AttachMetadataTagTooLong => StreamError::MetadataTagTooLong,
            Branch::AttachMetadataLimitReached => StreamError::MetadataLimitReached,
            Branch::StreamNotFound => StreamError::StreamNotFound,
            Branch::StreamNotActive => StreamError::StreamNotActive,
            Branch::CapacityOverflow => StreamError::MathOverflow,
            Branch::RateProductOverflow => StreamError::MathOverflow,
            Branch::AvailableBalanceOverflow => StreamError::MathOverflow,
            Branch::CancelSplitOverflow => StreamError::MathOverflow,
            Branch::PayoutOverflow => StreamError::MathOverflow,
            Branch::SetFeeRateTooHigh => StreamError::FeeRateTooHigh,
            Branch::GovernorNotAllowed | Branch::AcceptGovernorNotNominee => {
                StreamError::NotGovernor
            }
            Branch::AcceptGovernorNoPending => StreamError::NoPendingGovernor,
            Branch::WithdrawTreasuryAmountNonPositive => StreamError::ZeroAmount,
            Branch::WithdrawTreasuryExceedsBalance => StreamError::InsufficientTreasuryBalance,
            Branch::IntentNotFound => StreamError::IntentNotFound,
            Branch::IntentNotPending => StreamError::IntentNotPending,
            Branch::IntentNotYetExecutable => StreamError::IntentNotYetExecutable,
            Branch::IntentExpired => StreamError::IntentExpired,
            Branch::IntentNotCancellable => StreamError::IntentNotCancellable,
            Branch::ScheduleInvalidParameters => StreamError::InvalidScheduleParameters,
            Branch::IntentParamsMismatch => StreamError::IntentParamsMismatch,
            Branch::IntentNotExpired => StreamError::IntentNotExpired,
            Branch::CreateDepositTransferFailed => StreamError::DepositTransferFailed,
            Branch::TopUpTransferFailed => StreamError::TopUpTransferFailed,
            Branch::RecipientPayoutFailed => StreamError::RecipientPayoutFailed,
            Branch::SenderRefundFailed => StreamError::SenderRefundFailed,
            Branch::TreasuryPayoutFailed => StreamError::TreasuryPayoutFailed,
        }
    }

    /// Human-readable condition, used to generate `docs/ERRORS.md`.
    pub const fn condition(self) -> &'static str {
        match self {
            Branch::CreateDepositNonPositive => "deposit_amount is zero or negative",
            Branch::CreateStartTimeInPast => "start_time is before the current ledger timestamp",
            Branch::CreateInvalidTimeRange => {
                "end_time is not strictly after start_time (zero or negative duration)"
            }
            Branch::CreateDurationTooLong => "duration exceeds MAX_DURATION_SECONDS (100 years)",
            Branch::WithdrawAmountNonPositive => "withdraw amount is zero or negative",
            Branch::WithdrawAmountExceedsAvailable => {
                "amount exceeds the accrued-but-unwithdrawn balance"
            }
            Branch::WithdrawMaxNothingToWithdraw => {
                "nothing has accrued yet, or everything accrued was already withdrawn"
            }
            Branch::CancelStreamNotCancellable => {
                "the recipient calls cancel_stream on a stream created non-cancelable"
            }
            Branch::CancelStreamNotAuthorized => {
                "the caller is neither the sender nor the recipient"
            }
            Branch::TopUpAmountNonPositive => "top-up amount is zero or negative",
            Branch::TopUpDepositOverflow => "deposit + amount would overflow i128",
            Branch::AttachMetadataNotAuthorized => {
                "the attester is neither the stream's sender nor its recipient"
            }
            Branch::AttachMetadataTagTooLong => "the tag exceeds MAX_TAG_LEN (32) bytes",
            Branch::AttachMetadataLimitReached => {
                "the stream already holds MAX_ATTESTATIONS_PER_STREAM (32) attestations"
            }
            Branch::StreamNotFound => "no stream is stored under the id",
            Branch::StreamNotActive => "the stream status is Cancelled or Depleted",
            Branch::CapacityOverflow => "deposit * duration would overflow u128",
            Branch::RateProductOverflow => "deposit * elapsed would overflow u128",
            Branch::AvailableBalanceOverflow => {
                "withdrawn exceeds streamed (an invariant-violating stored stream)"
            }
            Branch::CancelSplitOverflow => "the cancel pro-rata split would underflow",
            Branch::PayoutOverflow => "withdrawn + amount would overflow i128",
            Branch::SetFeeRateTooHigh => "new_fee_bps exceeds MAX_FEE_BPS (the protocol cap)",
            Branch::GovernorNotAllowed => "the caller is not the treasury governor",
            Branch::AcceptGovernorNoPending => "accept_governor with no nomination pending",
            Branch::AcceptGovernorNotNominee => "the caller is not the nominated governor",
            Branch::WithdrawTreasuryAmountNonPositive => {
                "treasury withdrawal amount is zero or negative"
            }
            Branch::WithdrawTreasuryExceedsBalance => {
                "amount exceeds fees collected minus fees already withdrawn"
            }
            Branch::IntentNotFound => "no scheduled intent is stored under the id",
            Branch::IntentNotPending => "the intent is already executed, cancelled, or expired",
            Branch::IntentNotYetExecutable => "the next occurrence has not reached execute_after",
            Branch::IntentExpired => "the intent has reached expires_at",
            Branch::IntentNotCancellable => "the execution window opened before cancellation",
            Branch::ScheduleInvalidParameters => {
                "schedule parameters are inconsistent or out of bounds"
            }
            Branch::IntentParamsMismatch => {
                "stored parameters do not match the authorization commitment"
            }
            Branch::IntentNotExpired => "the intent has not reached expires_at",
            Branch::CreateDepositTransferFailed => {
                "the token refuses the deposit (+fee) pull (allowance, balance, or a non-compliant token)"
            }
            Branch::TopUpTransferFailed => {
                "the token refuses the pull of the added funds"
            }
            Branch::RecipientPayoutFailed => {
                "the token refuses a payout to the recipient"
            }
            Branch::SenderRefundFailed => "the token refuses the refund to the sender",
            Branch::TreasuryPayoutFailed => {
                "the token refuses the payout of collected protocol fees"
            }
        }
    }

    /// Reachability classification; drives whether the matrix test probes it.
    pub const fn reachability(self) -> Reachability {
        match self {
            // Invariant-protected guards. For every stored stream
            // `0 <= withdrawn <= streamed <= deposit <= i128::MAX`, so none of
            // these checked operations can cross an i128 boundary:
            //   * `pay_out`: `withdrawn + amount <= streamed <= i128::MAX`.
            //   * `available_amount`: `streamed - withdrawn` may go negative for
            //     a corrupt entry but never below `i128::MIN` (it equals
            //     `-withdrawn`, and `withdrawn <= i128::MAX`).
            //   * `cancel_amounts`: same bound on both subtractions.
            Branch::PayoutOverflow
            | Branch::AvailableBalanceOverflow
            | Branch::CancelSplitOverflow => Reachability::Defensive,
            _ => Reachability::Reachable,
        }
    }
}

/// Error codes that are intentionally unreachable.
///
/// Retired under the append-only policy: the numeric slot is reserved forever
/// (never reused) but no entrypoint can produce the variant. The coverage test
/// treats exactly these as exempt; any *other* code with zero branches fails CI.
///
/// * `NotStreamSender` (2) / `NotStreamRecipient` (3) — reserved role checks
///   from the original draft. The contract uses `NotAuthorized` (12) and
///   branches on sender/recipient identity directly, so these were never wired
///   in. Kept for wire compatibility.
pub const RETIRED_CODES: &[StreamError] = &[
    StreamError::NotStreamSender,
    StreamError::NotStreamRecipient,
];

/// Records a rejection branch and returns the error it maps to.
///
/// Used at every validation site instead of returning [`StreamError`] literals,
/// so the branch (and therefore the documented mapping) is exercised by the
/// code path itself.
#[inline]
pub fn reject(branch: Branch) -> StreamError {
    #[cfg(test)]
    trace::record(branch);
    branch.error()
}

/// Test-only branch trace.
///
/// The trace is thread-local: `cargo test` runs each test on its own thread and
/// the contract executes synchronously on the caller's thread, so the matrix
/// test observes exactly the branches it triggers — never a concurrent test's.
#[cfg(test)]
pub mod trace {
    use super::Branch;
    use std::cell::RefCell;
    use std::thread_local;
    use std::vec::Vec;

    thread_local! {
        static HITS: RefCell<Vec<Branch>> = const { RefCell::new(Vec::new()) };
    }

    /// Note that `branch` fired on this thread.
    pub fn record(branch: Branch) {
        HITS.with(|hits| hits.borrow_mut().push(branch));
    }

    /// Take the branches recorded since the last drain, leaving the trace empty.
    pub fn drain() -> Vec<Branch> {
        HITS.with(|hits| core::mem::take(&mut *hits.borrow_mut()))
    }

    /// Forget every recorded branch.
    pub fn clear() {
        HITS.with(|hits| hits.borrow_mut().clear());
    }
}
