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

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Errors returned by the StreamPay contract."
)]
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StreamError {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No stream exists with the provided id."
    )]
    StreamNotFound = 1,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Retired — never produced.** Reserved role check; retained so the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " numeric code is never reused. See `docs/ERROR_SURFACE.md`."
    )]
    NotStreamSender = 2,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Retired — never produced.** Reserved role check; retained so the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " numeric code is never reused. See `docs/ERROR_SURFACE.md`."
    )]
    NotStreamRecipient = 3,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream is not `cancelable`, so the recipient cannot cancel it."
    )]
    StreamNotCancellable = 4,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream is cancelled or depleted; the operation is not permitted."
    )]
    StreamNotActive = 5,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `start_time` is before the current ledger timestamp."
    )]
    StartTimeInPast = 6,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `end_time` is not strictly after `start_time`."
    )]
    InvalidTimeRange = 7,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream duration exceeds the maximum supported duration."
    )]
    DurationTooLong = 8,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A provided amount (deposit, top-up, or withdrawal) is zero or negative."
    )]
    ZeroAmount = 9,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The requested withdrawal exceeds the accrued, unwithdrawn balance."
    )]
    AmountExceedsAvailable = 10,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An intermediate computation would overflow; all math is checked."
    )]
    MathOverflow = 11,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The caller is not permitted to perform this action."
    )]
    NotAuthorized = 12,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw_max` found nothing accrued-but-unwithdrawn to pay out."
    )]
    NothingToWithdraw = 13,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The requested fee rate exceeds the protocol cap (`MAX_FEE_BPS`)."
    )]
    FeeRateTooHigh = 14,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The caller is not the treasury governor."
    )]
    NotGovernor = 15,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `accept_governor` was called but no governor nomination is pending."
    )]
    NoPendingGovernor = 16,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A treasury withdrawal exceeds the fees collected minus fees already"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " withdrawn for that token.")]
    InsufficientTreasuryBalance = 17,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No sponsor budget is registered for the provided sponsor address."
    )]
    SponsorNotFound = 49,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sponsor's budget exists but is currently paused (inactive)."
    )]
    SponsorInactive = 50,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The beneficiary has no registered ed25519 consent key; they must"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " enroll once before a claim can be sponsored on their behalf."
    )]
    BeneficiaryNotEnrolled = 51,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A sponsored claim was relayed after its signed `deadline`."
    )]
    ClaimExpired = 52,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The claim's nonce was already spent by this sponsor for this"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " beneficiary — a replay of a previously sponsored call."
    )]
    ClaimNonceReplay = 53,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Paying this claim would exceed the sponsor's per-period budget cap."
    )]
    SponsorBudgetExceeded = 54,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Paying this claim would exceed the per-beneficiary cap within the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " sponsor's current budget window.")]
    BeneficiaryBudgetExceeded = 55,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No scheduled intent exists with the provided id."
    )]
    IntentNotFound = 18,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The scheduled intent is not pending (already executed, cancelled, or"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " expired), so the operation is not permitted."
    )]
    IntentNotPending = 19,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Execution was attempted before the intent's `execute_after` (for the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " next outstanding occurrence).")]
    IntentNotYetExecutable = 20,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Execution or cancellation was attempted at/after the intent's"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `expires_at`; the funds are reclaimable via `reclaim_expired`."
    )]
    IntentExpired = 21,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sender tried to cancel an intent whose execution window has already"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " opened; cancellation is only allowed before `execute_after`."
    )]
    IntentNotCancellable = 22,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The scheduling parameters are inconsistent (bad occurrence/interval"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " combination, negative fee budget, ordering of `execute_after` /"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `start_time` / `expires_at`, or an overflowing recurrence window)."
    )]
    InvalidScheduleParameters = 23,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A defensive integrity check failed: the stored intent's parameters no"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " longer hash to the commitment recorded when it was scheduled."
    )]
    IntentParamsMismatch = 24,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `reclaim_expired` was called before the intent's `expires_at`."
    )]
    IntentNotExpired = 25,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The token pull in `create_stream` failed: the sender's balance or"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " allowance was insufficient (the pull covers `deposit_amount + fee`),"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or the asset refused the transfer (frozen/unauthorized/deauthorized"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " holder, or any non-compliant token). Nothing is persisted when it"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " fails, so no stream id is consumed."
    )]
    DepositTransferFailed = 26,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The token pull in `top_up` failed (see"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::DepositTransferFailed`]; the stream's deposit is left"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " untouched).")]
    TopUpTransferFailed = 27,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The payout of accrued funds to the stream recipient failed — from"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw`, `withdraw_max`, or the recipient leg of `cancel_stream`."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " State changes made before the transfer are rolled back with the error."
    )]
    RecipientPayoutFailed = 28,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The refund of unaccrued funds back to the sender failed during"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `cancel_stream` (the recipient leg, if any, was already paid)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The cancellation is rolled back in full, so the stream stays active."
    )]
    SenderRefundFailed = 29,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The payout of collected protocol fees failed in `withdraw_treasury`."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The recorded withdrawal and the `FeeWithdrawn` event are rolled back"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " with it, so the fee ledger stays unchanged."
    )]
    TreasuryPayoutFailed = 30,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The asset is not permitted by the policy module allowlist."
    )]
    PolicyAssetNotAllowed = 31,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The timelock delay has not elapsed for this queued policy change."
    )]
    PolicyTimelockNotElapsed = 32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No policy change is queued for the specified asset."
    )]
    PolicyNoQueuedChange = 33,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The policy module has not been initialized."
    )]
    PolicyNotInitialized = 34,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No admin handoff proposal is pending."
    )]
    PolicyNoPendingHandoff = 35,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The contract is currently frozen for maintenance or upgrade."
    )]
    ContractFrozen = 36,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The operation requires the contract to be frozen."
    )]
    ContractNotFrozen = 37,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An upgrade operation was attempted but no upgrade is pending."
    )]
    NoPendingUpgrade = 38,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The upgrade timelock delay has not yet expired."
    )]
    TimelockNotExpired = 39,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed upgrade delay is shorter than the minimum timelock."
    )]
    UpgradeDelayTooShort = 40,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The storage migration has already been completed."
    )]
    AlreadyMigrated = 41,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream rate is below the governance policy floor."
    )]
    PolicyRateBelowFloor = 42,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream rate exceeds the governance policy ceiling."
    )]
    PolicyRateAboveCeiling = 43,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream duration is below the governance policy floor."
    )]
    PolicyDurationBelowFloor = 44,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream duration exceeds the governance policy ceiling."
    )]
    PolicyDurationAboveCeiling = 45,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream deposit is below the governance policy floor."
    )]
    PolicyDepositBelowFloor = 46,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Batch creation was requested with zero entries."
    )]
    BatchEmpty = 47,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Batch creation was requested with more entries than MAX_BATCH."
    )]
    BatchTooLarge = 48,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Oracle threshold is invalid (e.g., zero or exceeds publisher count)."
    )]
    InvalidOracleThreshold = 56,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Oracle publishers are not configured."
    )]
    OraclePublishersNotConfigured = 57,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Oracle report timestamp is too far in the past or future."
    )]
    OracleReportTooOld = 58,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The caller is not an authorized oracle publisher."
    )]
    NotOraclePublisher = 59,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No two-step ownership proposal exists for this stream."
    )]
    NoPendingOwnership = 60,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The pending ownership proposal's acceptance window has elapsed; the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " target must be proposed again by the current role holder."
    )]
    OwnershipProposalExpired = 61,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed new owner is already the current holder of that role."
    )]
    InvalidTransferTarget = 62,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An unexpired ownership proposal already exists for this stream; cancel"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or accept it before proposing another."
    )]
    OwnershipProposalPending = 63,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A governance entrypoint was called before the signer set was bootstrapped."
    )]
    GovernanceNotInitialized = 64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `governance_bootstrap` was called, but the signer set already exists."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Bootstrap is one-time; later sets arrive as an executed `SetSigners`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " proposal, so no key can re-establish governance over an existing one."
    )]
    GovernanceAlreadyInitialized = 65,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The caller is not a member of the governance signer set."
    )]
    NotGovernanceSigner = 66,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed signer set lists the same address twice. Refused rather than"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " deduplicated: two slots held by one key are one key."
    )]
    GovernanceDuplicateSigner = 67,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed signer set is empty."
    )]
    GovernanceSignerSetEmpty = 68,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed signer set exceeds `MAX_SIGNERS`."
    )]
    GovernanceTooManySigners = 69,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposed signer set does not hold two distinct keys, so it could never"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " satisfy the two-signature rule.")]
    GovernanceSignersNotDistinct = 70,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No proposal is stored under the supplied id."
    )]
    GovernanceProposalNotFound = 71,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Execution was attempted while the veto window is still open."
    )]
    GovernanceVetoWindowOpen = 72,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A veto was attempted after the window closed; the proposal is matured and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " executable (execute-on-timeout), so the way to stop it now is to rotate"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the keys it would act through, not to veto it."
    )]
    GovernanceVetoWindowClosed = 73,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The requested veto window is shorter than `MIN_VETO_WINDOW_SECONDS`."
    )]
    GovernanceVetoWindowTooShort = 74,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposal was vetoed and is therefore dead."
    )]
    GovernanceAlreadyVetoed = 75,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposal has already been executed."
    )]
    GovernanceAlreadyExecuted = 76,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " This address has already signed the proposal. Execution needs two"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *distinct* signatures, so a second one from the same key is refused."
    )]
    GovernanceDuplicateSignature = 77,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Fewer than the required distinct, still-current signatures are recorded."
    )]
    GovernanceSignaturesInsufficient = 78,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The action requires an executed governance proposal now that the signer"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " set is bootstrapped; the direct entry point is closed."
    )]
    GovernanceTimelockRequired = 79,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A dispute is open on the stream: `cancel_stream` and `top_up` are"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " frozen until the sender resolves it or the timelock expires."
    )]
    DisputeActive = 80,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No open dispute exists on the stream."
    )]
    DisputeNotFound = 81,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The dispute's timelock has not elapsed yet."
    )]
    DisputeNotExpired = 82,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No rate-change proposal is stored for this stream."
    )]
    NoPendingRateChange = 83,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The pending rate-change proposal's acceptance window has elapsed; the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " rate must be proposed again by a stream party."
    )]
    RateProposalExpired = 84,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An unexpired rate-change proposal already exists for this stream; cancel"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or accept it before proposing another."
    )]
    RateProposalPending = 85,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stream already carries the maximum number of rate segments"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (`MAX_RATE_SEGMENTS`); cancel it or open a new stream instead."
    )]
    TooManyRateSegments = 86,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A stored record uses a layout this build does not understand: its"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " version tag is from the future, or its shape decodes as neither the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " current versioned layout nor the legacy untagged one. Reads fail closed"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " rather than guessing — see `stream::get_stream_record`."
    )]
    SchemaVersionUnsupported = 87,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No sender-transfer proposal is stored for the stream, or the one that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " was there has already been executed, cancelled or replaced."
    )]
    SenderTransferNotFound = 88,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sender-transfer proposal's acceptance window has elapsed; the role"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " did not move. Reclaim the stale entry with `expire_sender_transfer`."
    )]
    SenderTransferExpired = 89,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `expire_sender_transfer` refused to reclaim a proposal that is still"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " inside its acceptance window — only the recipient's consent or the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " window ending may end a proposal."
    )]
    SenderTransferNotExpired = 90,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The nonce presented with the consent does not match the nonce stored"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " with the proposal, so the consent is aimed at a different (or already"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " replaced) proposal.")]
    SenderTransferNonceMismatch = 91,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An unexpired sender-transfer proposal already exists for this stream;"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " let it expire, execute or reclaim it before proposing another."
    )]
    SenderTransferPending = 92,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The caller is not the stream's recipient, so their consent cannot"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " execute a sender-role transfer.")]
    SenderTransferNotConsenter = 93,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Only the current sender may route the refund of their deposit. The"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " refund claim is the counterpart of the money that funded the stream, so"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " a stranger cannot redirect it by calling `set_refund_target`."
    )]
    RefundTargetNotSender = 94,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The requested refund target already holds the claim, so the amendment"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " would rewrite the same address and emit an event that reports no"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " change. Rejected so the log only ever records real routing changes."
    )]
    RefundTargetUnchanged = 95,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw_many` was called with an empty list of stream ids. Rejected"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " as its own code rather than `BatchEmpty` (47), which is documented as a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *creation* batch precondition, so callers can tell the two apart."
    )]
    WithdrawBatchEmpty = 96,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw_many` was called with more stream ids than"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `MAX_WITHDRAW_BATCH`. The cap is what keeps a single claim call inside"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the transaction budget; split larger sets across several calls."
    )]
    WithdrawBatchTooLarge = 97,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw_many` was given the same stream id more than once. The second"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " entry would claim against state the first entry already mutated (and,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " for `withdraw_max`-style amounts, would silently double-count the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " available balance), so the whole call is rejected instead of"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " de-duplicated.")]
    WithdrawDuplicateStreamIds = 98,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Invalid pause transition: `pause_stream` on a stream that is already"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " paused, or `resume_stream` on a stream that is not paused."
    )]
    InvalidPauseTransition = 99,
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
        StreamError::PolicyAssetNotAllowed,
        StreamError::PolicyTimelockNotElapsed,
        StreamError::PolicyNoQueuedChange,
        StreamError::PolicyNotInitialized,
        StreamError::PolicyNoPendingHandoff,
        StreamError::ContractFrozen,
        StreamError::ContractNotFrozen,
        StreamError::NoPendingUpgrade,
        StreamError::TimelockNotExpired,
        StreamError::UpgradeDelayTooShort,
        StreamError::AlreadyMigrated,
        StreamError::PolicyRateBelowFloor,
        StreamError::PolicyRateAboveCeiling,
        StreamError::PolicyDurationBelowFloor,
        StreamError::PolicyDurationAboveCeiling,
        StreamError::PolicyDepositBelowFloor,
        StreamError::BatchEmpty,
        StreamError::BatchTooLarge,
        StreamError::SponsorNotFound,
        StreamError::SponsorInactive,
        StreamError::BeneficiaryNotEnrolled,
        StreamError::ClaimExpired,
        StreamError::ClaimNonceReplay,
        StreamError::SponsorBudgetExceeded,
        StreamError::BeneficiaryBudgetExceeded,
        StreamError::InvalidOracleThreshold,
        StreamError::OraclePublishersNotConfigured,
        StreamError::OracleReportTooOld,
        StreamError::NotOraclePublisher,
        StreamError::NoPendingOwnership,
        StreamError::OwnershipProposalExpired,
        StreamError::InvalidTransferTarget,
        StreamError::OwnershipProposalPending,
        StreamError::GovernanceNotInitialized,
        StreamError::GovernanceAlreadyInitialized,
        StreamError::NotGovernanceSigner,
        StreamError::GovernanceDuplicateSigner,
        StreamError::GovernanceSignerSetEmpty,
        StreamError::GovernanceTooManySigners,
        StreamError::GovernanceSignersNotDistinct,
        StreamError::GovernanceProposalNotFound,
        StreamError::GovernanceVetoWindowOpen,
        StreamError::GovernanceVetoWindowClosed,
        StreamError::GovernanceVetoWindowTooShort,
        StreamError::GovernanceAlreadyVetoed,
        StreamError::GovernanceAlreadyExecuted,
        StreamError::GovernanceDuplicateSignature,
        StreamError::GovernanceSignaturesInsufficient,
        StreamError::GovernanceTimelockRequired,
        StreamError::DisputeActive,
        StreamError::DisputeNotFound,
        StreamError::DisputeNotExpired,
        StreamError::NoPendingRateChange,
        StreamError::RateProposalExpired,
        StreamError::RateProposalPending,
        StreamError::TooManyRateSegments,
        StreamError::SchemaVersionUnsupported,
        StreamError::SenderTransferNotFound,
        StreamError::SenderTransferExpired,
        StreamError::SenderTransferNotExpired,
        StreamError::SenderTransferNonceMismatch,
        StreamError::SenderTransferPending,
        StreamError::SenderTransferNotConsenter,
        StreamError::RefundTargetNotSender,
        StreamError::RefundTargetUnchanged,
        StreamError::WithdrawBatchEmpty,
        StreamError::WithdrawBatchTooLarge,
        StreamError::WithdrawDuplicateStreamIds,
        StreamError::InvalidPauseTransition,
    ];

    /// The stable numeric value carried across the contract boundary
    /// (`Error(Contract, #code)`), i.e. the enum discriminant.
    pub const fn code(self) -> u32 {
        self as u32
    }
}
