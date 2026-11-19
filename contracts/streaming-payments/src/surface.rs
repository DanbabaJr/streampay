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
//! * `docs/ERROR_SURFACE.md` is generated from the same table (see
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
    // ------------------------------------------------------------- disputes
    CancelDuringDispute,
    TopUpDuringDispute,
    RaiseDisputeAlreadyActive,
    DisputeNotOpen,
    ExpireDisputeTooEarly,
    ResolveCallerNotSender,
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
    // ------------------------------------------------------- sponsor registry
    /// `register_sponsor`: a budget cap (period or per-beneficiary) is <= 0.
    RegisterLimitNonPositive,
    // ---------------------------------------------------- sponsored_withdraw
    SponsoredWithdrawAmountNonPositive,
    SponsoredWithdrawAmountExceedsAvailable,
    /// No sponsor budget is registered under the caller-supplied address.
    SponsorNotFound,
    /// The sponsor's registered budget is paused.
    SponsorInactive,
    /// The beneficiary never enrolled an ed25519 consent key.
    BeneficiaryNotEnrolled,
    /// The relayed claim was submitted after its signed `deadline`.
    ClaimExpired,
    /// The claim's nonce was already spent for this (sponsor, beneficiary).
    ClaimNonceReplay,
    /// The claim would push the sponsor's current-period spend over its cap.
    SponsorBudgetPeriodExceeded,
    /// The claim would push this beneficiary's window spend over its cap.
    SponsorBudgetBeneficiaryExceeded,
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
    // ------------------------------------------------------------ policy
    /// `create_stream`: asset is not on the policy allowlist.
    PolicyAssetNotAllowed,
    /// `policy_execute_asset`: timelock delay has not elapsed.
    PolicyTimelockNotElapsed,
    /// `policy_execute_asset`: no change queued for the asset.
    PolicyNoQueuedChange,
    /// policy admin entrypoints called before initialization.
    PolicyNotInitialized,
    /// `policy_accept_handoff` / `policy_cancel_handoff`: no handoff pending.
    PolicyNoPendingHandoff,
    // ---------------------------------------------------- create_streams_batch
    /// `create_streams_batch`: entries is empty.
    CreateBatchEmpty,
    /// `create_streams_batch`: entries length exceeds MAX_BATCH.
    CreateBatchTooLarge,
    // ------------------------------------------------ upgrade & freeze
    /// The contract is currently frozen for maintenance or upgrade.
    ContractFrozen,
    /// Storage migration was invoked while the contract is not frozen.
    MigrationNotFrozen,
    /// `execute_upgrade`: no upgrade proposal is pending.
    ExecuteUpgradeNoPending,
    /// `cancel_upgrade`: no upgrade proposal is pending.
    CancelUpgradeNoPending,
    /// `execute_upgrade`: the timelock delay has not yet expired.
    TimelockNotExpired,
    /// `propose_upgrade`: the proposed delay is shorter than MIN_UPGRADE_DELAY_SECONDS.
    UpgradeDelayTooShort,
    /// `migrate_storage`: the schema has already been migrated to the target version.
    AlreadyMigrated,
    // ------------------------------------------------ stream policy floors
    PolicyRateBelowFloor,
    PolicyRateAboveCeiling,
    PolicyDurationBelowFloor,
    PolicyDurationAboveCeiling,
    PolicyDepositBelowFloor,
    // ------------------------------------------------------------- oracle
    InvalidOracleThreshold,
    OraclePublishersNotConfigured,
    OracleReportTooOld,
    NotOraclePublisher,
    // ---------------------------------------------- ownership transfer
    /// `propose_ownership_transfer`: the caller is neither the sender nor the
    /// recipient.
    ProposeNotAuthorized,
    /// `propose_ownership_transfer`: the target already holds that role.
    ProposeInvalidTarget,
    /// `propose_ownership_transfer`: an unexpired proposal already exists.
    ProposeAlreadyPending,
    /// `accept_ownership_transfer`: the caller is not the named target.
    AcceptNotTarget,
    /// `accept_ownership_transfer`: the proposal's acceptance window elapsed.
    OwnershipProposalExpired,
    /// `accept_ownership_transfer` / `cancel_ownership_transfer`: no proposal
    /// is stored for the stream.
    NoPendingOwnership,
    /// `cancel_ownership_transfer`: the caller did not create the proposal.
    CancelProposalNotProposer,
    // ------------------------------------------------------------ governance
    // Issue #119: admin actions behind the two-key timelock. Named after the
    // rule that refuses the call, because the rule *is* the security property.
    /// A governance entrypoint called before the signer set was bootstrapped.
    GovernanceNotInitialized,
    /// `governance_bootstrap` on a contract that already has a signer set.
    GovernanceAlreadyInitialized,
    /// The caller is not in the signer set.
    NotGovernanceSigner,
    /// A proposed signer set lists the same address twice — one key in two slots.
    GovernanceDuplicateSigner,
    /// A proposed signer set is empty.
    GovernanceSignerSetEmpty,
    /// A proposed signer set exceeds MAX_SIGNERS.
    GovernanceTooManySigners,
    /// A proposed signer set cannot supply two distinct signatures.
    GovernanceSignersNotDistinct,
    /// No proposal is stored under the supplied id.
    GovernanceProposalNotFound,
    /// `governance_execute`: the veto window is still open.
    GovernanceVetoWindowOpen,
    /// `governance_veto`: the veto window has closed.
    GovernanceVetoWindowClosed,
    /// A configured veto window below MIN_VETO_WINDOW_SECONDS.
    GovernanceVetoWindowTooShort,
    /// The proposal was vetoed and is dead.
    GovernanceAlreadyVetoed,
    /// The proposal has already been executed.
    GovernanceAlreadyExecuted,
    /// `governance_sign`: this address already signed the proposal.
    GovernanceDuplicateSignature,
    /// `governance_execute`: not enough distinct, still-current signatures.
    GovernanceSignaturesInsufficient,
    /// A migrated admin entry point called directly after bootstrap.
    GovernanceTimelockRequired,
    // ---------------------------------------------- rate renegotiation
    /// `propose_rate_change`: the caller is neither the sender nor the
    /// recipient.
    RateProposeNotAuthorized,
    /// `propose_rate_change`: the proposed rate is zero or negative.
    RateProposalAmountNonPositive,
    /// `propose_rate_change`: the stream window has already elapsed, so there is
    /// no future rate to agree on.
    RateProposalWindowElapsed,
    /// `propose_rate_change`: an unexpired rate proposal already exists.
    RateProposalPending,
    /// `accept_rate_change`: the caller is not the proposal's named counterparty.
    RateAcceptNotTarget,
    /// `accept_rate_change`: a proposal participant no longer holds a stream
    /// role (an ownership transfer took the proposal out of scope).
    RateAcceptStaleParties,
    /// `accept_rate_change`: the proposal's acceptance window elapsed.
    RateProposalExpired,
    /// `accept_rate_change` / `cancel_rate_change`: no proposal is stored for
    /// the stream.
    NoPendingRateChange,
    /// `cancel_rate_change`: the caller did not create the proposal.
    RateCancelNotProposer,
    /// `accept_rate_change`: `rate * remaining_seconds` (or the resulting
    /// deposit) does not fit `i128`.
    RateReserveOverflow,
    /// `streamed_amount_at_segments`: the per-segment terms would overflow
    /// `i128` when summed.
    RateSegmentSumOverflow,
    /// `accept_rate_change`: `deposit - owed` would underflow (an
    /// invariant-violating stored stream).
    RateHeadroomUnderflow,
    /// `accept_rate_change`: the stream would exceed `MAX_RATE_SEGMENTS`.
    RateSegmentLimitReached,
    /// `accept_rate_change`: the new rate is below the governance policy floor.
    RatePolicyBelowFloor,
    /// `accept_rate_change`: the new rate exceeds the governance policy ceiling.
    RatePolicyAboveCeiling,
    /// `accept_rate_change`: the token refused the pull of the shortfall the
    /// rate increase requires.
    RateTopUpTransferFailed,
    /// `accept_rate_change`: the token refused the refund of the freed escrow.
    RateRefundFailed,
    // ------------------------------------------------ schema versioning
    /// `stream::get_stream_record`: the stored record is tagged with a layout
    /// version this build does not understand (or has a shape that matches
    /// neither the current versioned layout nor the legacy one).
    SchemaVersionUnsupported,
    // ------------------------------------------ sender-role transfer
    /// `accept_sender_transfer` / `expire_sender_transfer`: no proposal is
    /// stored for the stream.
    SenderTransferNotFound,
    /// `accept_sender_transfer`: the acceptance window elapsed.
    SenderTransferExpired,
    /// `expire_sender_transfer`: the proposal is still inside its window.
    SenderTransferNotExpired,
    /// `accept_sender_transfer`: the presented nonce is not the stored one.
    SenderTransferNonceMismatch,
    /// `propose_sender_transfer`: an unexpired proposal already exists.
    SenderTransferPending,
    /// `accept_sender_transfer`: the caller is not the stream's recipient.
    SenderTransferNotConsenter,
    // ------------------------------------------------ refund routing
    /// `set_refund_target`: the caller is not the stream's current sender, so
    /// they cannot re-route a deposit they did not fund.
    RefundTargetNotSender,
    /// `create_stream_with_refund` / `set_refund_target`: the address already
    /// holds the refund claim, so the routing changes nothing.
    RefundTargetUnchanged,
    // ------------------------------------------------ batch withdraw (#205)
    /// `withdraw_many`: the id vector is empty. Rejected with its own code
    /// rather than the creation-batch `BatchEmpty` so clients can tell which
    /// batch API they mis-called.
    WithdrawManyEmpty,
    /// `withdraw_many`: the id vector exceeds `MAX_WITHDRAW_BATCH`.
    WithdrawManyTooLarge,
    /// `withdraw_many`: the same stream id appears more than once, so the
    /// second entry would claim against state the first one already rewrote.
    WithdrawManyDuplicateIds,
    /// `withdraw_many`: an entry belongs to a recipient other than the caller.
    /// One holder can never claim another's stream through a batch.
    WithdrawManyNotStreamRecipient,
    /// `withdraw_many`: summing the per-entry amounts into the summary's
    /// `total` would overflow `i128`.
    WithdrawManyTotalOverflow,
    // ------------------------------------------------------- pause / resume
    /// `pause_stream` / `resume_stream`: the caller is not the stream sender.
    PauseNotAuthorized,
    /// `pause_stream`: the stream is already paused.
    PauseAlreadyPaused,
    /// `resume_stream`: the stream is not paused.
    ResumeNotPaused,
}

impl Branch {
    /// Every branch, in declaration order. The matrix test walks this list and
    /// the coverage test requires each [`StreamError`] variant to be produced by
    /// one of these (or retired).
    pub const ALL: [Branch; 133] = [
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
        Branch::CancelDuringDispute,
        Branch::TopUpDuringDispute,
        Branch::RaiseDisputeAlreadyActive,
        Branch::DisputeNotOpen,
        Branch::ExpireDisputeTooEarly,
        Branch::ResolveCallerNotSender,
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
        Branch::RegisterLimitNonPositive,
        Branch::SponsoredWithdrawAmountNonPositive,
        Branch::SponsoredWithdrawAmountExceedsAvailable,
        Branch::SponsorNotFound,
        Branch::SponsorInactive,
        Branch::BeneficiaryNotEnrolled,
        Branch::ClaimExpired,
        Branch::ClaimNonceReplay,
        Branch::SponsorBudgetPeriodExceeded,
        Branch::SponsorBudgetBeneficiaryExceeded,
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
        Branch::PolicyAssetNotAllowed,
        Branch::PolicyTimelockNotElapsed,
        Branch::PolicyNoQueuedChange,
        Branch::PolicyNotInitialized,
        Branch::PolicyNoPendingHandoff,
        Branch::CreateBatchEmpty,
        Branch::CreateBatchTooLarge,
        Branch::ContractFrozen,
        Branch::MigrationNotFrozen,
        Branch::ExecuteUpgradeNoPending,
        Branch::CancelUpgradeNoPending,
        Branch::TimelockNotExpired,
        Branch::UpgradeDelayTooShort,
        Branch::AlreadyMigrated,
        Branch::PolicyRateBelowFloor,
        Branch::PolicyRateAboveCeiling,
        Branch::PolicyDurationBelowFloor,
        Branch::PolicyDurationAboveCeiling,
        Branch::PolicyDepositBelowFloor,
        Branch::InvalidOracleThreshold,
        Branch::OraclePublishersNotConfigured,
        Branch::OracleReportTooOld,
        Branch::NotOraclePublisher,
        Branch::ProposeNotAuthorized,
        Branch::ProposeInvalidTarget,
        Branch::ProposeAlreadyPending,
        Branch::AcceptNotTarget,
        Branch::OwnershipProposalExpired,
        Branch::NoPendingOwnership,
        Branch::CancelProposalNotProposer,
        Branch::GovernanceNotInitialized,
        Branch::GovernanceAlreadyInitialized,
        Branch::NotGovernanceSigner,
        Branch::GovernanceDuplicateSigner,
        Branch::GovernanceSignerSetEmpty,
        Branch::GovernanceTooManySigners,
        Branch::GovernanceSignersNotDistinct,
        Branch::GovernanceProposalNotFound,
        Branch::GovernanceVetoWindowOpen,
        Branch::GovernanceVetoWindowClosed,
        Branch::GovernanceVetoWindowTooShort,
        Branch::GovernanceAlreadyVetoed,
        Branch::GovernanceAlreadyExecuted,
        Branch::GovernanceDuplicateSignature,
        Branch::GovernanceSignaturesInsufficient,
        Branch::GovernanceTimelockRequired,
        Branch::RateProposeNotAuthorized,
        Branch::RateProposalAmountNonPositive,
        Branch::RateProposalWindowElapsed,
        Branch::RateProposalPending,
        Branch::RateAcceptNotTarget,
        Branch::RateAcceptStaleParties,
        Branch::RateProposalExpired,
        Branch::NoPendingRateChange,
        Branch::RateCancelNotProposer,
        Branch::RateReserveOverflow,
        Branch::RateSegmentSumOverflow,
        Branch::RateHeadroomUnderflow,
        Branch::RateSegmentLimitReached,
        Branch::RatePolicyBelowFloor,
        Branch::RatePolicyAboveCeiling,
        Branch::RateTopUpTransferFailed,
        Branch::RateRefundFailed,
        Branch::SchemaVersionUnsupported,
        Branch::SenderTransferNotFound,
        Branch::SenderTransferExpired,
        Branch::SenderTransferNotExpired,
        Branch::SenderTransferNonceMismatch,
        Branch::SenderTransferPending,
        Branch::SenderTransferNotConsenter,
        Branch::RefundTargetNotSender,
        Branch::RefundTargetUnchanged,
        Branch::WithdrawManyEmpty,
        Branch::WithdrawManyTooLarge,
        Branch::WithdrawManyDuplicateIds,
        Branch::WithdrawManyNotStreamRecipient,
        Branch::WithdrawManyTotalOverflow,
        Branch::PauseNotAuthorized,
        Branch::PauseAlreadyPaused,
        Branch::ResumeNotPaused,
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
            Branch::CreateBatchEmpty | Branch::CreateBatchTooLarge => &["create_streams_batch"],
            Branch::WithdrawAmountNonPositive | Branch::WithdrawAmountExceedsAvailable => {
                &["withdraw"]
            }
            Branch::WithdrawMaxNothingToWithdraw => {
                &["withdraw_max", "withdraw_many", "withdraw_all"]
            }
            Branch::WithdrawManyEmpty
            | Branch::WithdrawManyTooLarge
            | Branch::WithdrawManyDuplicateIds => &["withdraw_many"],
            Branch::WithdrawManyNotStreamRecipient => &["withdraw_many", "withdraw_all"],
            Branch::WithdrawManyTotalOverflow => &["withdraw_many", "withdraw_all"],
            Branch::CancelStreamNotCancellable | Branch::CancelStreamNotAuthorized => {
                &["cancel_stream"]
            }
            Branch::TopUpAmountNonPositive | Branch::TopUpDepositOverflow => &["top_up"],
            Branch::CancelDuringDispute => &["cancel_stream"],
            Branch::TopUpDuringDispute => &["top_up"],
            Branch::RaiseDisputeAlreadyActive => &["raise_dispute"],
            Branch::DisputeNotOpen => &["get_dispute", "resolve_dispute", "expire_dispute"],
            Branch::ExpireDisputeTooEarly => &["expire_dispute"],
            Branch::ResolveCallerNotSender => &["resolve_dispute"],
            Branch::StreamNotFound => &[
                "get_stream",
                "available",
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "cancel_stream",
                "top_up",
                "raise_dispute",
                "expire_dispute",
                "resolve_dispute",
                "required_dispute_bond",
                "sponsored_withdraw",
                "propose_ownership_transfer",
                "accept_ownership_transfer",
                "propose_rate_change",
                "accept_rate_change",
                "propose_sender_transfer",
                "accept_sender_transfer",
                "set_refund_target",
                "stream_record_version",
                "migrate_stream_version",
                "refund_target",
                "sender_history",
                "pause_stream",
                "resume_stream",
            ],
            Branch::StreamNotActive => &[
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "cancel_stream",
                "top_up",
                "raise_dispute",
                "sponsored_withdraw",
                "propose_ownership_transfer",
                "accept_ownership_transfer",
                "propose_rate_change",
                "accept_rate_change",
                "propose_sender_transfer",
                "accept_sender_transfer",
                "set_refund_target",
                "pause_stream",
                "resume_stream",
            ],
            Branch::CapacityOverflow => &["create_stream", "top_up", "accept_rate_change"],
            Branch::RateProductOverflow => &[
                "streamed_at",
                "available",
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "cancel_stream",
                "sponsored_withdraw",
                "accept_rate_change",
            ],
            Branch::AvailableBalanceOverflow => &[
                "available",
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
            ],
            Branch::CancelSplitOverflow => &["cancel_stream"],
            Branch::SetFeeRateTooHigh => &["set_fee_bps"],
            Branch::GovernorNotAllowed => &[
                "set_fee_bps",
                "nominate_governor",
                "withdraw_treasury",
                "set_frozen",
                "propose_upgrade",
                "cancel_upgrade",
                "execute_upgrade",
                "migrate_storage",
                "set_stream_policy",
                "governance_bootstrap",
            ],
            Branch::AcceptGovernorNoPending | Branch::AcceptGovernorNotNominee => {
                &["accept_governor"]
            }
            Branch::WithdrawTreasuryAmountNonPositive | Branch::WithdrawTreasuryExceedsBalance => {
                &["withdraw_treasury"]
            }
            Branch::PayoutOverflow => &[
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "sponsored_withdraw",
            ],
            // ----------------------------------------------------- sponsor module
            Branch::RegisterLimitNonPositive => &["register_sponsor"],
            Branch::SponsoredWithdrawAmountNonPositive
            | Branch::SponsoredWithdrawAmountExceedsAvailable
            | Branch::SponsorNotFound
            | Branch::SponsorInactive
            | Branch::BeneficiaryNotEnrolled
            | Branch::ClaimExpired
            | Branch::ClaimNonceReplay
            | Branch::SponsorBudgetPeriodExceeded
            | Branch::SponsorBudgetBeneficiaryExceeded => &["sponsored_withdraw"],
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
            Branch::RecipientPayoutFailed => &[
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "cancel_stream",
            ],
            Branch::SenderRefundFailed => &["cancel_stream"],
            Branch::TreasuryPayoutFailed => &["withdraw_treasury"],
            Branch::PolicyAssetNotAllowed => &["create_stream", "create_streams"],
            Branch::PolicyTimelockNotElapsed | Branch::PolicyNoQueuedChange => {
                &["policy_execute_asset"]
            }
            Branch::PolicyNotInitialized => &[
                "policy_execute_asset",
                "policy_propose_asset",
                "policy_propose_handoff",
                "policy_accept_handoff",
                "policy_cancel_handoff",
                "policy_set_timelock_delay",
            ],
            Branch::PolicyNoPendingHandoff => &["policy_accept_handoff", "policy_cancel_handoff"],
            Branch::ContractFrozen => &[
                "create_stream",
                "create_streams",
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "cancel_stream",
                "top_up",
                "propose_ownership_transfer",
                "accept_ownership_transfer",
                "cancel_ownership_transfer",
                "propose_rate_change",
                "accept_rate_change",
                "cancel_rate_change",
                "propose_sender_transfer",
                "accept_sender_transfer",
                "expire_sender_transfer",
                "set_refund_target",
                "create_stream_with_refund",
                "migrate_stream_version",
            ],
            Branch::MigrationNotFrozen | Branch::AlreadyMigrated => &["migrate_storage"],
            Branch::ExecuteUpgradeNoPending | Branch::TimelockNotExpired => &["execute_upgrade"],
            Branch::CancelUpgradeNoPending => &["cancel_upgrade"],
            Branch::UpgradeDelayTooShort => &["propose_upgrade"],
            Branch::PolicyDepositBelowFloor
            | Branch::PolicyRateBelowFloor
            | Branch::PolicyRateAboveCeiling => &["create_stream", "create_streams", "top_up"],
            Branch::PolicyDurationBelowFloor | Branch::PolicyDurationAboveCeiling => {
                &["create_stream", "create_streams"]
            }
            Branch::InvalidOracleThreshold => &["set_oracle_config"],
            Branch::OraclePublishersNotConfigured
            | Branch::OracleReportTooOld
            | Branch::NotOraclePublisher => &["submit_oracle_time"],
            Branch::ProposeNotAuthorized | Branch::ProposeInvalidTarget => {
                &["propose_ownership_transfer", "propose_sender_transfer"]
            }
            Branch::ProposeAlreadyPending => &["propose_ownership_transfer"],
            Branch::AcceptNotTarget | Branch::OwnershipProposalExpired => {
                &["accept_ownership_transfer"]
            }
            Branch::NoPendingOwnership => {
                &["accept_ownership_transfer", "cancel_ownership_transfer"]
            }
            Branch::CancelProposalNotProposer => &["cancel_ownership_transfer"],
            // ------------------------------------------------------------ governance
            Branch::GovernanceNotInitialized => &[
                "governance_propose",
                "governance_sign",
                "governance_veto",
                "governance_execute",
            ],
            Branch::GovernanceAlreadyInitialized => &["governance_bootstrap"],
            Branch::NotGovernanceSigner => {
                &["governance_propose", "governance_sign", "governance_veto"]
            }
            Branch::GovernanceDuplicateSigner
            | Branch::GovernanceSignerSetEmpty
            | Branch::GovernanceTooManySigners
            | Branch::GovernanceSignersNotDistinct => &[
                "governance_bootstrap",
                "governance_propose",
                "governance_execute",
            ],
            Branch::GovernanceVetoWindowTooShort => &["governance_bootstrap", "governance_propose"],
            Branch::GovernanceProposalNotFound => {
                &["governance_sign", "governance_veto", "governance_execute"]
            }
            Branch::GovernanceVetoWindowOpen | Branch::GovernanceSignaturesInsufficient => {
                &["governance_execute"]
            }
            Branch::GovernanceVetoWindowClosed => &["governance_veto"],
            Branch::GovernanceAlreadyVetoed => {
                &["governance_sign", "governance_veto", "governance_execute"]
            }
            Branch::GovernanceAlreadyExecuted => {
                &["governance_sign", "governance_veto", "governance_execute"]
            }
            Branch::GovernanceDuplicateSignature => &["governance_sign"],
            Branch::GovernanceTimelockRequired => &[
                "set_fee_bps",
                "nominate_governor",
                "withdraw_treasury",
                "set_stream_policy",
                "set_frozen",
                "propose_upgrade",
                "execute_upgrade",
                "migrate_storage",
                "set_oracle_config",
            ],
            // ---------------------------------------------- rate renegotiation
            Branch::RateProposeNotAuthorized
            | Branch::RateProposalAmountNonPositive
            | Branch::RateProposalPending => &["propose_rate_change"],
            // A stream can reach `end_time` while an offer is open, so both
            // sides of the handshake can find the window already elapsed.
            Branch::RateProposalWindowElapsed => &["propose_rate_change", "accept_rate_change"],
            Branch::RateAcceptNotTarget
            | Branch::RateAcceptStaleParties
            | Branch::RateProposalExpired
            | Branch::RateReserveOverflow
            | Branch::RateHeadroomUnderflow
            | Branch::RateSegmentLimitReached
            | Branch::RatePolicyBelowFloor
            | Branch::RatePolicyAboveCeiling
            | Branch::RateTopUpTransferFailed
            | Branch::RateRefundFailed => &["accept_rate_change"],
            // ------------------------------------------------------- pause / resume
            Branch::PauseNotAuthorized => &["pause_stream", "resume_stream"],
            Branch::PauseAlreadyPaused => &["pause_stream"],
            Branch::ResumeNotPaused => &["resume_stream"],
            Branch::NoPendingRateChange => &["accept_rate_change", "cancel_rate_change"],
            Branch::RateCancelNotProposer => &["cancel_rate_change"],
            Branch::RateSegmentSumOverflow => &[
                "available",
                "withdraw",
                "withdraw_max",
                "cancel_stream",
                "sponsored_withdraw",
                "accept_rate_change",
                "top_up",
            ],
            Branch::SchemaVersionUnsupported => &[
                "get_stream",
                "available",
                "withdraw",
                "withdraw_max",
                "withdraw_many",
                "withdraw_all",
                "cancel_stream",
                "top_up",
                "sponsored_withdraw",
                "stream_record_version",
                "migrate_stream_version",
            ],
            Branch::SenderTransferNotFound => &["accept_sender_transfer", "expire_sender_transfer"],
            Branch::SenderTransferExpired | Branch::SenderTransferNonceMismatch => {
                &["accept_sender_transfer"]
            }
            Branch::SenderTransferNotExpired => &["expire_sender_transfer"],
            Branch::SenderTransferPending => &["propose_sender_transfer"],
            Branch::SenderTransferNotConsenter => &["accept_sender_transfer"],
            Branch::RefundTargetNotSender => &["set_refund_target"],
            Branch::RefundTargetUnchanged => &["create_stream_with_refund", "set_refund_target"],
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
            Branch::CancelDuringDispute => StreamError::DisputeActive,
            Branch::TopUpDuringDispute => StreamError::DisputeActive,
            Branch::RaiseDisputeAlreadyActive => StreamError::DisputeActive,
            Branch::DisputeNotOpen => StreamError::DisputeNotFound,
            Branch::ExpireDisputeTooEarly => StreamError::DisputeNotExpired,
            Branch::ResolveCallerNotSender => StreamError::NotAuthorized,
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
            Branch::RegisterLimitNonPositive => StreamError::ZeroAmount,
            Branch::SponsoredWithdrawAmountNonPositive => StreamError::ZeroAmount,
            Branch::SponsoredWithdrawAmountExceedsAvailable => StreamError::AmountExceedsAvailable,
            Branch::SponsorNotFound => StreamError::SponsorNotFound,
            Branch::SponsorInactive => StreamError::SponsorInactive,
            Branch::BeneficiaryNotEnrolled => StreamError::BeneficiaryNotEnrolled,
            Branch::ClaimExpired => StreamError::ClaimExpired,
            Branch::ClaimNonceReplay => StreamError::ClaimNonceReplay,
            Branch::SponsorBudgetPeriodExceeded => StreamError::SponsorBudgetExceeded,
            Branch::SponsorBudgetBeneficiaryExceeded => StreamError::BeneficiaryBudgetExceeded,
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
            Branch::PolicyAssetNotAllowed => StreamError::PolicyAssetNotAllowed,
            Branch::PolicyTimelockNotElapsed => StreamError::PolicyTimelockNotElapsed,
            Branch::PolicyNoQueuedChange => StreamError::PolicyNoQueuedChange,
            Branch::PolicyNotInitialized => StreamError::PolicyNotInitialized,
            Branch::PolicyNoPendingHandoff => StreamError::PolicyNoPendingHandoff,
            Branch::CreateBatchEmpty => StreamError::BatchEmpty,
            Branch::CreateBatchTooLarge => StreamError::BatchTooLarge,
            Branch::ContractFrozen => StreamError::ContractFrozen,
            Branch::MigrationNotFrozen => StreamError::ContractNotFrozen,
            Branch::ExecuteUpgradeNoPending | Branch::CancelUpgradeNoPending => {
                StreamError::NoPendingUpgrade
            }
            Branch::TimelockNotExpired => StreamError::TimelockNotExpired,
            Branch::UpgradeDelayTooShort => StreamError::UpgradeDelayTooShort,
            Branch::AlreadyMigrated => StreamError::AlreadyMigrated,
            Branch::PolicyRateBelowFloor => StreamError::PolicyRateBelowFloor,
            Branch::PolicyRateAboveCeiling => StreamError::PolicyRateAboveCeiling,
            Branch::PolicyDurationBelowFloor => StreamError::PolicyDurationBelowFloor,
            Branch::PolicyDurationAboveCeiling => StreamError::PolicyDurationAboveCeiling,
            Branch::PolicyDepositBelowFloor => StreamError::PolicyDepositBelowFloor,
            Branch::InvalidOracleThreshold => StreamError::InvalidOracleThreshold,
            Branch::OraclePublishersNotConfigured => StreamError::OraclePublishersNotConfigured,
            Branch::OracleReportTooOld => StreamError::OracleReportTooOld,
            Branch::NotOraclePublisher => StreamError::NotOraclePublisher,
            Branch::ProposeNotAuthorized
            | Branch::AcceptNotTarget
            | Branch::CancelProposalNotProposer => StreamError::NotAuthorized,
            Branch::ProposeInvalidTarget => StreamError::InvalidTransferTarget,
            Branch::ProposeAlreadyPending => StreamError::OwnershipProposalPending,
            Branch::OwnershipProposalExpired => StreamError::OwnershipProposalExpired,
            Branch::NoPendingOwnership => StreamError::NoPendingOwnership,
            // ---------------------------------------------- rate renegotiation
            Branch::RateProposeNotAuthorized
            | Branch::RateAcceptNotTarget
            | Branch::RateAcceptStaleParties
            | Branch::RateCancelNotProposer => StreamError::NotAuthorized,
            Branch::RateProposalAmountNonPositive => StreamError::ZeroAmount,
            Branch::RateProposalWindowElapsed => StreamError::InvalidTimeRange,
            Branch::RateProposalPending => StreamError::RateProposalPending,
            Branch::RateProposalExpired => StreamError::RateProposalExpired,
            Branch::NoPendingRateChange => StreamError::NoPendingRateChange,
            Branch::RateReserveOverflow
            | Branch::RateSegmentSumOverflow
            | Branch::RateHeadroomUnderflow => StreamError::MathOverflow,
            Branch::RateSegmentLimitReached => StreamError::TooManyRateSegments,
            Branch::RatePolicyBelowFloor => StreamError::PolicyRateBelowFloor,
            Branch::RatePolicyAboveCeiling => StreamError::PolicyRateAboveCeiling,
            Branch::RateTopUpTransferFailed => StreamError::TopUpTransferFailed,
            Branch::RateRefundFailed => StreamError::SenderRefundFailed,
            // ------------------------------------------------------- pause / resume
            Branch::PauseNotAuthorized => StreamError::NotAuthorized,
            Branch::PauseAlreadyPaused | Branch::ResumeNotPaused => {
                StreamError::InvalidPauseTransition
            }
            Branch::GovernanceNotInitialized => StreamError::GovernanceNotInitialized,
            Branch::GovernanceAlreadyInitialized => StreamError::GovernanceAlreadyInitialized,
            Branch::NotGovernanceSigner => StreamError::NotGovernanceSigner,
            Branch::GovernanceDuplicateSigner => StreamError::GovernanceDuplicateSigner,
            Branch::GovernanceSignerSetEmpty => StreamError::GovernanceSignerSetEmpty,
            Branch::GovernanceTooManySigners => StreamError::GovernanceTooManySigners,
            Branch::GovernanceSignersNotDistinct => StreamError::GovernanceSignersNotDistinct,
            Branch::GovernanceProposalNotFound => StreamError::GovernanceProposalNotFound,
            Branch::GovernanceVetoWindowOpen => StreamError::GovernanceVetoWindowOpen,
            Branch::GovernanceVetoWindowClosed => StreamError::GovernanceVetoWindowClosed,
            Branch::GovernanceVetoWindowTooShort => StreamError::GovernanceVetoWindowTooShort,
            Branch::GovernanceAlreadyVetoed => StreamError::GovernanceAlreadyVetoed,
            Branch::GovernanceAlreadyExecuted => StreamError::GovernanceAlreadyExecuted,
            Branch::GovernanceDuplicateSignature => StreamError::GovernanceDuplicateSignature,
            Branch::GovernanceSignaturesInsufficient => {
                StreamError::GovernanceSignaturesInsufficient
            }
            Branch::GovernanceTimelockRequired => StreamError::GovernanceTimelockRequired,
            Branch::SchemaVersionUnsupported => StreamError::SchemaVersionUnsupported,
            Branch::SenderTransferNotFound => StreamError::SenderTransferNotFound,
            Branch::SenderTransferExpired => StreamError::SenderTransferExpired,
            Branch::SenderTransferNotExpired => StreamError::SenderTransferNotExpired,
            Branch::SenderTransferNonceMismatch => StreamError::SenderTransferNonceMismatch,
            Branch::SenderTransferPending => StreamError::SenderTransferPending,
            Branch::SenderTransferNotConsenter => StreamError::SenderTransferNotConsenter,
            Branch::RefundTargetNotSender => StreamError::RefundTargetNotSender,
            Branch::RefundTargetUnchanged => StreamError::RefundTargetUnchanged,
            Branch::WithdrawManyEmpty => StreamError::WithdrawBatchEmpty,
            Branch::WithdrawManyTooLarge => StreamError::WithdrawBatchTooLarge,
            Branch::WithdrawManyDuplicateIds => StreamError::WithdrawDuplicateStreamIds,
            Branch::WithdrawManyNotStreamRecipient => StreamError::NotAuthorized,
            Branch::WithdrawManyTotalOverflow => StreamError::MathOverflow,
        }
    }

    /// Human-readable condition, used to generate `docs/ERROR_SURFACE.md`.
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
            Branch::CancelDuringDispute => "an open dispute freezes cancel_stream",
            Branch::TopUpDuringDispute => "an open dispute freezes top_up",
            Branch::RaiseDisputeAlreadyActive => "raise_dispute called while a dispute is open",
            Branch::DisputeNotOpen => "no open dispute exists on the stream",
            Branch::ExpireDisputeTooEarly => {
                "expire_dispute called before the dispute timelock elapsed"
            }
            Branch::ResolveCallerNotSender => "resolve_dispute called by a non-sender",
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
            Branch::RegisterLimitNonPositive => {
                "a sponsor budget cap (per-period or per-beneficiary) is zero or negative"
            }
            Branch::SponsoredWithdrawAmountNonPositive => {
                "a sponsored claim requests a zero or negative payout"
            }
            Branch::SponsoredWithdrawAmountExceedsAvailable => {
                "a sponsored claim exceeds the stream's accrued-but-unwithdrawn balance"
            }
            Branch::SponsorNotFound => "no sponsor budget is registered for the address",
            Branch::SponsorInactive => "the sponsor's budget is paused (inactive)",
            Branch::BeneficiaryNotEnrolled => {
                "the beneficiary has not enrolled an ed25519 consent key"
            }
            Branch::ClaimExpired => "the relayed claim was submitted after its deadline",
            Branch::ClaimNonceReplay => "the claim's nonce was already spent for this pair",
            Branch::SponsorBudgetPeriodExceeded => {
                "the claim would exceed the sponsor's per-period budget cap"
            }
            Branch::SponsorBudgetBeneficiaryExceeded => {
                "the claim would exceed the per-beneficiary budget cap"
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
            Branch::PolicyAssetNotAllowed => {
                "the asset is not permitted by the policy module allowlist"
            }
            Branch::PolicyTimelockNotElapsed => {
                "the timelock delay has not elapsed for this queued policy change"
            }
            Branch::PolicyNoQueuedChange => "no policy change is queued for the specified asset",
            Branch::PolicyNotInitialized => "the policy module has not been initialized",
            Branch::PolicyNoPendingHandoff => "no admin handoff proposal is pending",
            Branch::CreateBatchEmpty => "entries is empty",
            Branch::CreateBatchTooLarge => "entries length exceeds MAX_BATCH",
            Branch::ContractFrozen => "the contract is frozen for maintenance or upgrade",
            Branch::MigrationNotFrozen => "storage migration requires the contract to be frozen",
            Branch::ExecuteUpgradeNoPending => "execute_upgrade called with no upgrade pending",
            Branch::CancelUpgradeNoPending => "cancel_upgrade called with no upgrade pending",
            Branch::TimelockNotExpired => "upgrade timelock delay has not yet expired",
            Branch::UpgradeDelayTooShort => {
                "proposed upgrade delay is shorter than MIN_UPGRADE_DELAY_SECONDS"
            }
            Branch::AlreadyMigrated => {
                "storage has already been migrated to the target schema version"
            }
            Branch::PolicyRateBelowFloor => "stream rate is below the governance policy floor",
            Branch::PolicyRateAboveCeiling => "stream rate exceeds the governance policy ceiling",
            Branch::PolicyDurationBelowFloor => {
                "stream duration is below the governance policy floor"
            }
            Branch::PolicyDurationAboveCeiling => {
                "stream duration exceeds the governance policy ceiling"
            }
            Branch::PolicyDepositBelowFloor => {
                "stream deposit is below the governance policy floor"
            }
            Branch::InvalidOracleThreshold => {
                "oracle threshold is invalid (e.g. zero or exceeds publisher count)"
            }
            Branch::OraclePublishersNotConfigured => "oracle publishers are not configured",
            Branch::OracleReportTooOld => "oracle report timestamp is too far in the past or future",
            Branch::NotOraclePublisher => "the caller is not an authorized oracle publisher",
            Branch::ProposeNotAuthorized => {
                "the caller is neither the current sender nor the current recipient"
            }
            Branch::ProposeInvalidTarget => "the proposed target already holds that role",
            Branch::ProposeAlreadyPending => {
                "an unexpired ownership proposal already exists for the stream"
            }
            Branch::AcceptNotTarget => "the caller is not the proposal's named new owner",
            Branch::OwnershipProposalExpired => {
                "the proposal's acceptance window has elapsed"
            }
            Branch::NoPendingOwnership => "no ownership proposal is stored for the stream",
            Branch::CancelProposalNotProposer => {
                "the caller did not create the pending ownership proposal"
            }
            // ---------------------------------------------- rate renegotiation
            Branch::RateProposeNotAuthorized => {
                "the caller is neither the current sender nor the current recipient"
            }
            Branch::RateProposalAmountNonPositive => {
                "the proposed amount_per_second is zero or negative"
            }
            Branch::RateProposalWindowElapsed => {
                "the stream's end_time is at or before the current time, so no window is left to re-rate"
            }
            Branch::RateProposalPending => {
                "an unexpired rate-change proposal already exists for the stream"
            }
            Branch::RateAcceptNotTarget => {
                "the caller is not the proposal's named counterparty"
            }
            Branch::RateAcceptStaleParties => {
                "the proposal's proposer or counterparty no longer holds a role on the stream"
            }
            Branch::RateProposalExpired => {
                "the rate proposal's acceptance window has elapsed"
            }
            Branch::NoPendingRateChange => "no rate-change proposal is stored for the stream",
            Branch::RateCancelNotProposer => {
                "the caller did not create the pending rate-change proposal"
            }
            Branch::RateReserveOverflow => {
                "amount_per_second * remaining_seconds (or owed + that reserve) would overflow i128"
            }
            Branch::RateSegmentSumOverflow => {
                "adding a per-segment term would overflow i128 (accrual sum, or a top-up onto a segment's allocation)"
            }
            Branch::RateHeadroomUnderflow => {
                "deposit - owed would underflow (an invariant-violating stored stream)"
            }
            Branch::RateSegmentLimitReached => {
                "the stream already carries MAX_RATE_SEGMENTS rate-change segments"
            }
            Branch::RatePolicyBelowFloor => {
                "the new rate is below the governance policy rate floor"
            }
            Branch::RatePolicyAboveCeiling => {
                "the new rate exceeds the governance policy rate ceiling"
            }
            Branch::RateTopUpTransferFailed => {
                "the token refuses the pull of the shortfall a rate increase requires"
            }
            Branch::RateRefundFailed => {
                "the token refuses the refund of the escrow a rate decrease frees"
            }
            // ------------------------------------------------------- pause / resume
            Branch::PauseNotAuthorized => "the caller is not the stream's sender",
            Branch::PauseAlreadyPaused => "the stream is already paused",
            Branch::ResumeNotPaused => "the stream is not paused",
            // ------------------------------------------------------------ governance
            Branch::GovernanceNotInitialized => {
                "the governance signer set has not been bootstrapped"
            }
            Branch::GovernanceAlreadyInitialized => {
                "governance_bootstrap was called but a signer set already exists"
            }
            Branch::NotGovernanceSigner => "the caller is not a member of the signer set",
            Branch::GovernanceDuplicateSigner => {
                "the signer set lists the same address twice (one key in two slots)"
            }
            Branch::GovernanceSignerSetEmpty => "the signer set is empty",
            Branch::GovernanceTooManySigners => "the signer set exceeds MAX_SIGNERS",
            Branch::GovernanceSignersNotDistinct => {
                "the signer set holds fewer than two distinct keys"
            }
            Branch::GovernanceProposalNotFound => "no proposal is stored under the id",
            Branch::GovernanceVetoWindowOpen => {
                "execution was attempted before the veto window closed"
            }
            Branch::GovernanceVetoWindowClosed => {
                "a veto was attempted after the veto window closed"
            }
            Branch::GovernanceVetoWindowTooShort => {
                "the veto window is shorter than MIN_VETO_WINDOW_SECONDS"
            }
            Branch::GovernanceAlreadyVetoed => "the proposal was vetoed and is dead",
            Branch::GovernanceAlreadyExecuted => "the proposal has already been executed",
            Branch::GovernanceDuplicateSignature => {
                "this address already signed the proposal; execution needs two distinct keys"
            }
            Branch::GovernanceSignaturesInsufficient => {
                "fewer than the required distinct, still-current signatures are recorded"
            }
            Branch::GovernanceTimelockRequired => {
                "the action requires an executed governance proposal now that governance is bootstrapped"
            }
            Branch::SchemaVersionUnsupported => {
                "the stored record carries a layout version this build does not understand"
            }
            Branch::SenderTransferNotFound => {
                "no sender-transfer proposal is stored for the stream"
            }
            Branch::SenderTransferExpired => {
                "the sender transfer's acceptance window has elapsed"
            }
            Branch::SenderTransferNotExpired => {
                "the sender transfer is still inside its acceptance window"
            }
            Branch::SenderTransferNonceMismatch => {
                "the presented nonce does not match the stored proposal's nonce"
            }
            Branch::SenderTransferPending => {
                "an unexpired sender-transfer proposal already exists for the stream"
            }
            Branch::SenderTransferNotConsenter => {
                "the caller is not the stream's recipient"
            }
            Branch::RefundTargetNotSender => {
                "the caller is not the stream's current sender, so they do not own the deposit being routed"
            }
            Branch::RefundTargetUnchanged => {
                "the address already holds the refund claim, so routing to it changes nothing"
            }
            Branch::WithdrawManyEmpty => "the batch withdraw was requested with zero stream ids",
            Branch::WithdrawManyTooLarge => {
                "the batch withdraw exceeds MAX_WITHDRAW_BATCH stream ids"
            }
            Branch::WithdrawManyDuplicateIds => {
                "the same stream id appears more than once in the batch"
            }
            Branch::WithdrawManyNotStreamRecipient => {
                "a stream in the batch belongs to a different recipient than the caller"
            }
            Branch::WithdrawManyTotalOverflow => {
                "summing the batch's per-stream payouts into the summary total would overflow"
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
            //   * `streamed_amount_at_segments`: segment accrual is monotonic in
            //     `now` and each window is elapsed at most once, so every partial
            //     sum is bounded by the schedule at `end_time` — which is
            //     `owed + reserved`, the deposit `accept_rate_change` just checked
            //     against `i128::MAX`.
            //   * `segments_after_topup`: `allocation + amount <= new_deposit`,
            //     which the caller already checked against `i128::MAX`.
            //   * `accept_rate_change`'s `deposit - owed`: `owed` is the accrued
            //     amount at the boundary, so the difference is the unaccrued
            //     remainder and cannot go negative.
            //   * `withdraw_many`: every entry pays out through `pay_out`, so
            //     the batch total is the recipient's balance increase and is
            //     likewise bounded by `i128::MAX`.
            Branch::PayoutOverflow
            | Branch::AvailableBalanceOverflow
            | Branch::CancelSplitOverflow
            | Branch::RateSegmentSumOverflow
            | Branch::RateHeadroomUnderflow
            | Branch::WithdrawManyTotalOverflow => Reachability::Defensive,
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
