#![no_std]

//! StreamPay: continuous, linear streaming payments for Stellar (Soroban).
//!
//! Lock a deposit and let it accrue to a recipient per second between
//! `start_time` and `end_time` — for payroll, DAO contributor pay,
//! subscriptions, or vesting. The recipient withdraws accrued funds at any
//! time; the sender can top up or cancel with a fair pro-rata refund.
//!
//! # Entry points
//!
//! - [`StreamingPayments::create_stream`] — open a stream and pull the deposit
//! - [`StreamingPayments::create_streams`] — atomically create a batch of streams
//! - [`StreamingPayments::withdraw`] — recipient claims accrued funds
//! - [`StreamingPayments::withdraw_max`] — recipient claims *all* accrued
//!   funds in one atomic call
//! - [`StreamingPayments::withdraw_all`] — recipient batch-claims accrued
//!   funds across all streams with pagination and asset aggregation
//! - [`StreamingPayments::cancel_stream`] — sender (or recipient, if the
//!   stream is `cancelable`) closes the stream with a pro-rata split
//! - [`StreamingPayments::top_up`] — add funds to a running stream
//! - [`StreamingPayments::raise_dispute`] — recipient flags the stream
//!   (wrong address, coerced creation) for a bond; cancel/top-up are frozen
//!   until the sender resolves or the timelock expires
//! - [`StreamingPayments::resolve_dispute`] — sender accepts (unwind +
//!   refund bond) or rejects as bad-faith (bond slashed, stream resumes)
//! - [`StreamingPayments::expire_dispute`] — anyone, after the timelock:
//!   bond split, stream resumes
//! - [`StreamingPayments::propose_ownership_transfer`] /
//!   [`StreamingPayments::accept_ownership_transfer`] /
//!   [`StreamingPayments::cancel_ownership_transfer`] — two-step handoff of
//!   the sender (payer) or recipient (claimant) role
//! - [`StreamingPayments::propose_rate_change`] /
//!   [`StreamingPayments::accept_rate_change`] /
//!   [`StreamingPayments::cancel_rate_change`] — two-step renegotiation of the
//!   streaming rate, rebalancing the deposit at acceptance so neither party can
//!   change what is owed alone
//! - [`StreamingPayments::create_stream_with_refund`] /
//!   [`StreamingPayments::set_refund_target`] — route the refund of the
//!   unstreamed remainder to an address other than the sender
//! - [`StreamingPayments::sponsored_withdraw`] — an operator relays a
//!   recipient’s claim and a sponsor absorbs the gas, guarded by a budget
//!   ledger and nonce replay protection (see the `sponsor` module docs)
//! - [`StreamingPayments::register_sponsor`] /
//!   [`StreamingPayments::enroll_beneficiary`] /
//!   [`StreamingPayments::rotate_operator_key`] — sponsorship setup
//! - [`StreamingPayments::get_stream`] / [`StreamingPayments::available`] /
//!   [`StreamingPayments::pending_ownership_transfer`] — read-only views
//! - [`StreamingPayments::get_dispute`] /
//!   [`StreamingPayments::required_dispute_bond`] — dispute read-only views
//! - [`StreamingPayments::recipient_streams`] /
//!   [`StreamingPayments::sender_streams`] — paginated on-chain discovery
//!   indexes per address
//! - [`StreamingPayments::treasury_status`] /
//!   [`StreamingPayments::stream_fee`] / [`StreamingPayments::verify_treasury`] —
//!   open verification reads for the protocol-fee ledger (see `treasury.rs`)
//!
//! # Invariants
//!
//! - `0 <= withdrawn <= streamed <= deposit` for every stored stream.
//! - The contract's token balance always covers `sum(deposit - withdrawn)`
//!   over live (non-cancelled) streams, plus all outstanding dispute bonds,
//!   plus `charged_total - withdrawn_total` over all token treasuries (funds
//!   are only ever moved by these entry points; a cancelled stream holds
//!   nothing once its split was paid).
//! - All state changes happen *before* token transfers (checks-effects-
//!   interactions), so reentrant token callbacks cannot over-withdraw.
//! - Every token call goes through the SDK's fallible (`try_`) client and a
//!   failure is re-raised as a distinct `StreamError` transfer-failure code
//!   (18–22). Token contract errors share the `Error(Contract, #N)` namespace
//!   with this contract's codes, so propagating them raw would let a token's
//!   own code masquerade as a StreamPay code in clients. Because the failure
//!   is still returned as `Err`, the whole invocation — including any effects
//!   written before the transfer — rolls back atomically.
//! - `treasury.charged_total == sum of FeeCharged events == sum of stored
//!   per-stream fees`, provable from public reads (see `treasury.rs`).
//! - A dispute freezes cancel/top-up only: accrual keeps running and the
//!   recipient can always withdraw accrued funds, dispute or not.

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod cei_trace;
mod client_parity_test;
#[cfg(test)]
mod clock_skew_test;
#[cfg(test)]
mod differential_harness;
#[cfg(test)]
mod differential_test;
#[cfg(test)]
mod error_surface_test;

mod dispute;
mod errors;
#[cfg(test)]
mod event_registry;
mod events;
mod governance;
#[cfg(test)]
mod governance_test;
mod oracle;
mod policy;
mod schedule;
#[cfg(test)]
mod schedule_test;
#[cfg(test)]
mod schema_guard_test;
pub(crate) mod sponsor;
#[cfg(test)]
mod sponsor_test;
#[cfg(test)]
mod storage_golden;
mod stream;
pub mod surface;
#[cfg(test)]
mod test;
#[cfg(any(test, feature = "testutils"))]
pub mod test_client;
mod treasury;
pub mod verification;

use soroban_sdk::{
    contract, contractimpl, contracttype, token::TokenClient, Address, BytesN, ConversionError,
    Env, Error as SorobanError, InvokeError, MuxedAddress, Vec,
};

use surface::Branch;

pub use dispute::{
    bond_shares, required_bond, Dispute, DISPUTE_BOND_BPS, DISPUTE_TIMEOUT_SECONDS,
    MIN_DISPUTE_BOND,
};
pub use errors::StreamError;
pub use events::{
    BatchWithdrawSummary, BeneficiaryEnrolled, ContractFrozenStateChanged, ContractUpgraded,
    DisputeExpired, DisputeRaised, DisputeResolved, FeeCharged, FeeWithdrawn,
    GovernanceActionExecuted, GovernanceActionProposed, GovernanceActionSigned,
    GovernanceActionVetoed, GovernanceSignersSet, OperatorKeyRotated, OracleConfigUpdated,
    OracleStaleFallback, OracleTimeReported, OwnershipAccepted, OwnershipProposed,
    PolicyAssetExecuted, PolicyAssetQueued, PolicyHandoffAccepted, PolicyHandoffCancelled,
    PolicyHandoffProposed, PolicyInitialized, RateChangeAccepted, RateChangeProposed,
    ScheduledIntentCancelled, ScheduledIntentExpired, ScheduledStreamExecuted,
    SenderTransferExpired, SenderTransferProposed, SenderTransferred, SponsorActiveSet,
    SponsorClaim, SponsorRegistered, StorageMigrated, StreamCancelled, StreamCreated, StreamPaused,
    StreamPolicySet, StreamRecordMigrated, StreamRefundTargetChanged, StreamResumed,
    StreamScheduled, StreamToppedUp, StreamsCreated, UpgradeCancelled, UpgradeProposed, Withdrawn,
};
pub use governance::{
    GovernanceAction, Proposal, DEFAULT_VETO_WINDOW_SECONDS, MAX_SIGNERS, MIN_VETO_WINDOW_SECONDS,
    REQUIRED_SIGNATURES, ROTATION_WINDOW_MULTIPLIER,
};
pub use oracle::{OracleConfig, OracleReport, ResolvedTime, DEFAULT_MAX_STALE_SECONDS};
pub use policy::{
    validate_rate_args, validate_stream_args, validate_top_up_args, QueuedAssetChange, StreamPolicy,
};
pub use schedule::{IntentStatus, ScheduledIntent, MAX_OCCURRENCES};
pub use sponsor::{PeriodSpend, SponsorConfig};
// `streamed_at` is re-exported for the fuzz target and downstream rate
// calculators: it is a pure function requiring no `Env`.
pub use stream::{
    streamed_amount_at_segments, streamed_at, AssetTransfer, BatchEntry, ClaimFailure,
    MigrationStatus, OwnershipRole, PageBounds, PendingOwnership, PendingRateChange,
    PendingSenderTransfer, PendingUpgrade, RateSegment, SenderHistory, SenderTransferRecord,
    Stream, StreamStatus, StreamVersionReport, VersionedStream, WithdrawAllResult, WithdrawEntry,
    WithdrawOutcome, CURRENT_STREAM_RECORD_VERSION, INITIAL_SCHEMA_VERSION, MAX_BATCH,
    MAX_DURATION_SECONDS, MAX_MIGRATION_BATCH_SIZE, MAX_PAGE_SIZE, MAX_RATE_SEGMENTS,
    MAX_WITHDRAW_BATCH, MIN_BATCH, MIN_UPGRADE_DELAY_SECONDS, OWNERSHIP_PROPOSAL_TTL_SECONDS,
    RATE_PROPOSAL_TTL_SECONDS, STREAM_RECORD_VERSION_V1, STREAM_RECORD_VERSION_V2,
    TARGET_SCHEMA_VERSION,
};
pub use treasury::{fee_amount, FeeScan, Treasury, TreasuryStatus, BPS_DENOMINATOR, MAX_FEE_BPS};

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Parameters for one stream in a [`StreamingPayments::create_streams`] call."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamInput {
    pub recipient: Address,
    pub token: Address,
    pub deposit_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The StreamPay streaming-payments contract."
)]
#[contract]
pub struct StreamingPayments;

/// Outcome of an SDK fallible (`try_`) call on a token contract: an outer
/// `Err` is a failed invocation (token contract error or host failure), an
/// inner `Err` a return-value conversion failure (a non-SEP-41 return type).
type TokenCall<T> = Result<Result<T, ConversionError>, Result<SorobanError, InvokeError>>;

/// Unwraps a token call, mapping **every** failure mode to `on_failure`.
///
/// A token's own error code must never escape this contract: contract error
/// numbers are per-contract and clients see them as `Error(Contract, #N)`, so
/// a token's `#5` would otherwise be indistinguishable from
/// [`StreamError::StreamNotActive`] (#5). Callers must always propagate the
/// mapped error with `?`: returning `Err` aborts the top-level invocation, so
/// effects already written in this call roll back together with the failed
/// (and therefore fully rolled-back) token transfer — no partial state and no
/// partial event log can survive a failed transfer.
fn token_result<T>(res: TokenCall<T>, on_failure: Branch) -> Result<T, StreamError> {
    match res {
        Ok(Ok(value)) => Ok(value),
        // Conversion failures mean the callee did not return a SEP-41 shaped
        // value; treat a non-compliant token exactly like a failed transfer.
        // Both failure modes are reported through the branch registry, so the
        // error-surface matrix sees the exact `(entrypoint, condition)` that
        // refused the call.
        Ok(Err(_)) | Err(_) => Err(surface::reject(on_failure)),
    }
}

/// Pulls `amount` of `token` from `payer` into this contract via
/// `transfer_from`, mapping a token-side failure (insufficient balance or
/// allowance, a non-transferable asset, a non-token contract) to the code
/// `on_failure` declares.
fn pull(
    env: &Env,
    token: &Address,
    payer: &Address,
    amount: i128,
    on_failure: Branch,
) -> Result<(), StreamError> {
    #[cfg(test)]
    cei_trace::record("transfer_from token");
    let current_contract = env.current_contract_address();
    let res = TokenClient::new(env, token).try_transfer_from(
        &current_contract,
        payer,
        &current_contract,
        &amount,
    );
    token_result(res, on_failure)
}

/// Sends `amount` of `token` held by `from` to `recipient` via
/// `transfer`, mapping a token-side failure to the code `on_failure` declares.
fn push_from(
    env: &Env,
    token: &Address,
    from: &Address,
    recipient: &MuxedAddress,
    amount: i128,
    on_failure: Branch,
) -> Result<(), StreamError> {
    #[cfg(test)]
    cei_trace::record(match on_failure {
        Branch::RecipientPayoutFailed => "transfer recipient payout",
        Branch::SenderRefundFailed => "transfer sender refund",
        Branch::TreasuryPayoutFailed => "transfer treasury payout",
        Branch::RateRefundFailed => "transfer rate refund",
        _ => "transfer token",
    });
    let res = TokenClient::new(env, token).try_transfer(from, recipient, &amount);
    token_result(res, on_failure)
}

/// Sends `amount` of `token` held by this contract to `recipient` via
/// `transfer`, mapping a token-side failure to the code `on_failure` declares.
fn push(
    env: &Env,
    token: &Address,
    recipient: &MuxedAddress,
    amount: i128,
    on_failure: Branch,
) -> Result<(), StreamError> {
    push_from(
        env,
        token,
        &env.current_contract_address(),
        recipient,
        amount,
        on_failure,
    )
}

#[contractimpl]
impl StreamingPayments {
    /// Shared body of `pause_stream` / `resume_stream` (one copy in the Wasm).
    fn set_paused(
        env: &Env,
        caller: Address,
        stream_id: u64,
        pause: bool,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(env)?;
        caller.require_auth();
        let mut s = stream::get_stream(env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if caller != s.sender {
            return Err(surface::reject(Branch::PauseNotAuthorized));
        }
        let paused_at = stream::get_paused_at(env, stream_id);
        let now = oracle::resolve_stream_time(env, stream_id, s.uses_oracle()).timestamp;
        if pause {
            if paused_at.is_some() {
                return Err(surface::reject(Branch::PauseAlreadyPaused));
            }
            stream::set_paused_at(env, stream_id, Some(now));
            #[cfg(test)]
            cei_trace::record("event StreamPaused");
            StreamPaused {
                stream_id,
                paused_at: now,
            }
            .publish(env);
            return Ok(());
        }
        let Some(paused_at) = paused_at else {
            return Err(surface::reject(Branch::ResumeNotPaused));
        };
        // Shift the window by the time spent paused *inside* it: a pause taken
        // before `start_time` only shifts by however far `now` is past it, and
        // one taken at or after `end_time` changes nothing about accrual.
        let shift = if paused_at >= s.end_time {
            0
        } else {
            now.saturating_sub(paused_at.max(s.start_time))
        };
        if shift > 0 {
            s.start_time = s.start_time.saturating_add(shift);
            s.end_time = s.end_time.saturating_add(shift);
            let mut segments = stream::get_rate_segments(env, stream_id);
            for i in 0..segments.len() {
                let mut seg = segments.get_unchecked(i);
                seg.start_time = seg.start_time.saturating_add(shift);
                seg.end_time = seg.end_time.saturating_add(shift);
                segments.set(i, seg);
            }
            if !segments.is_empty() {
                stream::put_rate_segments(env, stream_id, &segments);
            }
            stream::put_stream(env, &s);
        }
        stream::set_paused_at(env, stream_id, None);
        #[cfg(test)]
        cei_trace::record("event StreamResumed");
        StreamResumed {
            stream_id,
            new_end_time: s.end_time,
        }
        .publish(env);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Internal helper: verifies that mutating entrypoints are not called"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " while the contract is frozen for maintenance or upgrade."
    )]
    fn require_not_frozen(env: &Env) -> Result<(), StreamError> {
        if stream::is_frozen(env) {
            return Err(surface::reject(Branch::ContractFrozen));
        }
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Deploy-time constructor: binds the treasury governor."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Binding governance in the deployment transaction (rather than via a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " later `initialize` call) removes the front-running window where an"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " attacker could claim an uninitialized treasury. The fee rate starts"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " at 0 and is configured afterwards via"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::set_fee_bps`]."
    )]
    pub fn __constructor(env: Env, governor: Address) {
        env.storage()
            .instance()
            .set(&stream::DataKey::Governor, &governor);
        env.storage()
            .instance()
            .extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Creates a linear payment stream and pulls `deposit_amount` of `token`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " from `sender` into this contract."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sender must first approve this contract as a spender on `token`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (`token.approve(sender, streaming_contract, deposit_amount, ...)`)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " When a protocol fee is configured, the approval (and the pull) cover"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `deposit_amount + fee`, where `fee = deposit_amount * fee_bps / 10_000`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is charged once, here at the deposit boundary — never during"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " accrual or payout. At `fee_bps == 0` the call is identical to the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " fee-less contract: same pull, same events, same state."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `start_time` must not be in the past (UIs pass the current time to"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   start streaming immediately).")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `end_time` must be strictly after `start_time` (zero-duration streams"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   are rejected) and at most `MAX_DURATION_SECONDS` long."
    )]
    #[allow(clippy::too_many_arguments)] // 8-arg surface is the intended client API
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `cancelable` controls whether the recipient may also call"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   `cancel_stream` to reclaim their accrued balance."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the new stream id (monotonically increasing, starting at 1)."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The deposit pull is mapped to [`StreamError::DepositTransferFailed`]"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (missing balance/allowance, or an asset that refuses the transfer);"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " nothing is persisted when it fails, so no stream id is consumed."
    )]
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> Result<u64, StreamError> {
        Self::create_stream_with_oracle(
            env,
            sender,
            recipient,
            token,
            deposit_amount,
            start_time,
            end_time,
            cancelable,
            false,
        )
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Creates a payment stream with optional oracle reference time source."
    )]
    #[allow(clippy::too_many_arguments)]
    pub fn create_stream_with_oracle(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        use_oracle: bool,
    ) -> Result<u64, StreamError> {
        Self::require_not_frozen(&env)?;
        sender.require_auth();

        let now = env.ledger().timestamp();
        Self::validate_stream_creation(now, deposit_amount, start_time, end_time)?;

        // Policy check: if the policy module is active, the asset must be on
        // the allowlist. Uninitialized policy permits all assets (opt-in).
        policy::check_asset_allowed(&env, &token)?;

        let stream_policy = policy::get_stream_policy(&env, Some(token.clone()));
        let duration = end_time - start_time;
        policy::validate_stream_args(stream_policy.as_ref(), deposit_amount, duration)?;

        // Protocol fee, computed at the deposit boundary only. The accrual
        // math (`deposit`, `streamed_at`, cancel splits) never sees it.
        let fee_bps = treasury::current_fee_bps(&env);
        let fee = treasury::fee_amount(deposit_amount, fee_bps)?;
        let pull_amount = deposit_amount
            .checked_add(fee)
            .ok_or(StreamError::MathOverflow)?;

        // Interaction: pull the deposit (plus fee, when configured) from
        // the sender. A token-side failure maps to a distinct code; returning
        // `Err` aborts before anything is persisted (no id consumed, no fee
        // recorded, no event emitted).
        pull(
            &env,
            &token,
            &sender,
            pull_amount,
            Branch::CreateDepositTransferFailed,
        )?;

        // Effects: persist the stream and announce it (shared leg with the
        // batch and scheduled paths below).
        Self::persist_new_stream(
            &env,
            sender,
            recipient,
            token,
            deposit_amount,
            start_time,
            end_time,
            cancelable,
            use_oracle,
            fee,
            fee_bps,
        )
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Creates a stream whose unstreamed remainder is refundable to `refund_to`"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " rather than to the sender.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The refund claim normally travels with the sender role; pinning it at"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " creation is how a payer routes a cancellation back to the account that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " actually funded the deposit — a treasury behind the signing key, a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " corporate payer whose payroll wallet is ephemeral, or a parent grant that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " must reclaim what its beneficiary's stream never spent. Accrual, the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recipient's claims and `cancel_stream`'s authorization are untouched: only"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the destination of the *remainder* changes, so"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `0 <= withdrawn <= streamed <= deposit` and the conservation invariant are"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " identical to [`StreamingPayments::create_stream`]."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `refund_to` must differ from `sender` — that is already where the claim"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " sits, and refusing the no-op keeps the event log to real routing changes."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The address is *not* required to exist, hold a balance, or be able to"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " receive: routing to an address that cannot accept the transfer surfaces"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " later as [`StreamError::SenderRefundFailed`] on the cancellation, so this"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is the sender's own risk to take, and the reason the choice is announced"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " by `StreamRefundTargetChanged` rather than stored silently."
    )]
    #[allow(clippy::too_many_arguments)]
    pub fn create_stream_with_refund(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        refund_to: Address,
    ) -> Result<u64, StreamError> {
        Self::require_not_frozen(&env)?;
        if refund_to == sender {
            return Err(surface::reject(Branch::RefundTargetUnchanged));
        }

        // The deposit, the escrow and every creation check are the plain
        // creation path; nothing about routing changes them.
        let id = Self::create_stream_with_oracle(
            env.clone(),
            sender.clone(),
            recipient,
            token,
            deposit_amount,
            start_time,
            end_time,
            cancelable,
            false,
        )?;

        // Effects, then the event — same CEI shape as the amendment path. No
        // token moves here: the deposit is already escrowed in the contract.
        stream::put_refund_target(&env, id, &refund_to);

        #[cfg(test)]
        cei_trace::record("event StreamRefundTargetChanged");
        StreamRefundTargetChanged {
            stream_id: id,
            previous_target: sender,
            new_target: refund_to,
            at_creation: true,
        }
        .publish(&env);

        Ok(id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Re-routes the refund of a stream's unstreamed remainder to `refund_to`."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Only the current sender may call this, and only while the stream is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `Active`: the claim is the counterpart of the money that funded the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stream, so nobody else gets to redirect it, and once the stream is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cancelled or depleted there is no remainder left to route."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Routing to the sender's own address is the way to *undo* a previous"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " routing (or to make a routed claim follow the role again), and is a real"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " change whenever the pinned target differs from the current sender — see"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::refund_target`]."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The claim is deliberately *not* re-derived from the role on every hop: a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " consented sender transfer keeps whatever routing was in force, which is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " why [`StreamingPayments::propose_sender_transfer`] carries an explicit"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `transfer_refund_rights` flag instead of implying one here. A top-up by a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " later sender therefore enlarges the pot that the *pinned* target reclaims"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " — route with intent.")]
    pub fn set_refund_target(
        env: Env,
        caller: Address,
        stream_id: u64,
        refund_to: Address,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if caller != s.sender {
            return Err(surface::reject(Branch::RefundTargetNotSender));
        }
        let previous = stream::refund_target(&env, &s);
        if previous == refund_to {
            return Err(surface::reject(Branch::RefundTargetUnchanged));
        }

        stream::put_refund_target(&env, stream_id, &refund_to);

        #[cfg(test)]
        cei_trace::record("event StreamRefundTargetChanged");
        StreamRefundTargetChanged {
            stream_id,
            previous_target: previous,
            new_target: refund_to,
            at_creation: false,
        }
        .publish(&env);

        Ok(())
    }

    fn validate_stream_creation(
        now: u64,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<(), StreamError> {
        if deposit_amount <= 0 {
            return Err(surface::reject(Branch::CreateDepositNonPositive));
        }
        if start_time < now {
            return Err(surface::reject(Branch::CreateStartTimeInPast));
        }
        if end_time <= start_time {
            return Err(surface::reject(Branch::CreateInvalidTimeRange));
        }
        // The ordered range check above makes this subtraction safe.
        let duration = end_time - start_time;
        if duration > MAX_DURATION_SECONDS {
            return Err(surface::reject(Branch::CreateDurationTooLong));
        }
        stream::validate_capacity(deposit_amount, duration)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Shared effects leg for every creation path: allocates the next stream"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " id, persists the stream, indexes it under both parties, applies the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " protocol fee when one is owed, then emits [`StreamCreated`] (and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`FeeCharged`] after it when a fee was charged). No authorization and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " no token movement: callers are responsible for the checks and for"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " having the deposit escrowed in the contract (scheduled execution uses"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " an intent's already-escrowed deposit and passes `fee = 0`)."
    )]
    #[allow(clippy::too_many_arguments)]
    fn persist_new_stream(
        env: &Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        use_oracle: bool,
        fee: i128,
        fee_bps: u32,
    ) -> Result<u64, StreamError> {
        let id = stream::next_stream_id(env);
        let s = Stream {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit,
            withdrawn: 0,
            start_time,
            end_time,
            cancelable,
            status: StreamStatus::Active,
            use_oracle: Some(use_oracle),
        };
        stream::put_stream(env, &s);
        stream::index_stream(env, &s);
        if fee > 0 {
            // Effects: accumulate the fee in the token's treasury and store
            // the per-stream fee before any event announces it.
            treasury::apply_fee(env, &token, id, fee)?;
        }

        #[cfg(test)]
        cei_trace::record("event StreamCreated");
        StreamCreated {
            stream_id: id,
            sender,
            recipient,
            token,
            deposit,
            start_time,
            end_time,
            cancelable,
        }
        .publish(env);

        if fee > 0 {
            FeeCharged {
                stream_id: id,
                token: s.token.clone(),
                payer: s.sender.clone(),
                amount: fee,
                fee_bps,
            }
            .publish(env);
        }

        Ok(id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Creates multiple streams atomically, authorizing the sender once and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " grouping deposits into one token pull per token. Every item uses the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " same validation and fee rules as `create_stream`; if any item is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " invalid, the entire transaction (including transfers and state writes)"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is rolled back. An empty input returns an empty vector without auth."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Emits one `StreamsCreated` event containing all ids; individual"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `FeeCharged` events are still emitted when fees apply."
    )]
    pub fn create_streams(
        env: Env,
        sender: Address,
        inputs: Vec<StreamInput>,
    ) -> Result<Vec<u64>, StreamError> {
        Self::require_not_frozen(&env)?;
        let mut ids = Vec::new(&env);
        let count = inputs.len();
        if count == 0 {
            return Ok(ids);
        }

        sender.require_auth();

        let now = env.ledger().timestamp();
        let fee_bps = treasury::current_fee_bps(&env);
        let mut pull_totals: Vec<(Address, i128)> = Vec::new(&env);
        let mut fees = Vec::new(&env);
        let mut index = 0;
        while index < count {
            let input = inputs.get(index).ok_or(StreamError::MathOverflow)?;
            Self::validate_stream_creation(
                now,
                input.deposit_amount,
                input.start_time,
                input.end_time,
            )?;
            policy::check_asset_allowed(&env, &input.token)?;

            let stream_policy = policy::get_stream_policy(&env, Some(input.token.clone()));
            let duration = input.end_time - input.start_time;
            policy::validate_stream_args(stream_policy.as_ref(), input.deposit_amount, duration)?;

            let fee = treasury::fee_amount(input.deposit_amount, fee_bps)?;
            let pull_amount = input
                .deposit_amount
                .checked_add(fee)
                .ok_or(StreamError::MathOverflow)?;
            let mut token_index = 0;
            let mut found = false;
            while token_index < pull_totals.len() {
                let (token, total) = pull_totals
                    .get(token_index)
                    .ok_or(StreamError::MathOverflow)?;
                if token == input.token {
                    pull_totals.set(
                        token_index,
                        (
                            token,
                            total
                                .checked_add(pull_amount)
                                .ok_or(StreamError::MathOverflow)?,
                        ),
                    );
                    found = true;
                    break;
                }
                token_index += 1;
            }
            if !found {
                pull_totals.push_back((input.token, pull_amount));
            }
            fees.push_back(fee);
            index += 1;
        }

        let first_id = stream::reserve_stream_ids(&env, count)?;
        index = 0;
        while index < count {
            let id = first_id
                .checked_add(index as u64)
                .ok_or(StreamError::MathOverflow)?;
            ids.push_back(id);
            index += 1;
        }

        let mut token_index = 0;
        while token_index < pull_totals.len() {
            let (token, amount) = pull_totals
                .get(token_index)
                .ok_or(StreamError::MathOverflow)?;
            // A token-side refusal maps to [`StreamError::DepositTransferFailed`]
            // like the single-stream path: the whole batch aborts and every
            // effect written so far (including the reserved ids) rolls back.
            pull(
                &env,
                &token,
                &sender,
                amount,
                Branch::CreateDepositTransferFailed,
            )?;
            token_index += 1;
        }

        let mut index = 0;
        while index < count {
            let input = inputs.get(index).ok_or(StreamError::MathOverflow)?;
            let id = ids.get(index).ok_or(StreamError::MathOverflow)?;
            let fee = fees.get(index).ok_or(StreamError::MathOverflow)?;
            let created = Stream {
                id,
                sender: sender.clone(),
                recipient: input.recipient,
                token: input.token,
                deposit: input.deposit_amount,
                withdrawn: 0,
                start_time: input.start_time,
                end_time: input.end_time,
                cancelable: input.cancelable,
                status: StreamStatus::Active,
                use_oracle: Some(false),
            };
            stream::put_stream(&env, &created);
            stream::index_stream(&env, &created);
            if fee > 0 {
                treasury::apply_fee(&env, &created.token, id, fee)?;
                FeeCharged {
                    stream_id: id,
                    token: created.token.clone(),
                    payer: sender.clone(),
                    amount: fee,
                    fee_bps,
                }
                .publish(&env);
            }
            index += 1;
        }

        StreamsCreated {
            sender,
            stream_ids: ids.clone(),
        }
        .publish(&env);

        Ok(ids)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Creates a batch of payment streams in a single transaction."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Semantics are all-or-nothing per entry but best-effort across the batch:"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " each entry validates its parameters and attempts its own deposit pull."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Failures are reported per-entry in the returned vector without aborting"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or rolling back successfully created sibling streams."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The entire batch call reverts if `entries` is empty ([`StreamError::BatchEmpty`])"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or exceeds [`MAX_BATCH`] ([`StreamError::BatchTooLarge`])."
    )]
    pub fn create_streams_batch(
        env: Env,
        entries: Vec<BatchEntry>,
    ) -> Result<Vec<Result<u64, StreamError>>, StreamError> {
        let count = entries.len();
        if count < stream::MIN_BATCH {
            return Err(surface::reject(Branch::CreateBatchEmpty));
        }
        if count > stream::MAX_BATCH {
            return Err(surface::reject(Branch::CreateBatchTooLarge));
        }

        let mut results = Vec::new(&env);
        let mut authorized_senders = Vec::new(&env);
        for entry in entries.iter() {
            if !authorized_senders.contains(&entry.sender) {
                entry.sender.require_auth();
                authorized_senders.push_back(entry.sender.clone());
            }
            let res = Self::create_single_batch_entry(&env, &entry);
            results.push_back(res);
        }

        Ok(results)
    }

    fn create_single_batch_entry(env: &Env, entry: &BatchEntry) -> Result<u64, StreamError> {
        Self::validate_stream_creation(
            env.ledger().timestamp(),
            entry.deposit,
            entry.start_time,
            entry.end_time,
        )?;

        let fee_bps = treasury::current_fee_bps(env);
        let fee = treasury::fee_amount(entry.deposit, fee_bps)?;
        let pull_amount = entry
            .deposit
            .checked_add(fee)
            .ok_or(StreamError::MathOverflow)?;

        let pull_res = TokenClient::new(env, &entry.token).try_transfer_from(
            &env.current_contract_address(),
            &entry.sender,
            &env.current_contract_address(),
            &pull_amount,
        );
        match pull_res {
            Ok(Ok(())) => {}
            _ => return Err(StreamError::AmountExceedsAvailable),
        }

        Self::persist_new_stream(
            env,
            entry.sender.clone(),
            entry.recipient.clone(),
            entry.token.clone(),
            entry.deposit,
            entry.start_time,
            entry.end_time,
            entry.cancelable,
            false,
            fee,
            fee_bps,
        )
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Withdraws up to `amount` of the accrued-but-unwithdrawn balance and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " pays it to the stream recipient. Only the recipient can call this"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (their authorization is required)."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reverts with [`StreamError::AmountExceedsAvailable`] if `amount`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " exceeds what has accrued so far; before `start_time` nothing has"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " accrued, at or after `end_time` the full remainder is available."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A token-side failure to deliver the payout returns"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::RecipientPayoutFailed`] and rolls the recorded"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " `withdrawn` update back with it.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " # Ordering against `cancel_stream` (same-ledger race)"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw` and `cancel_stream` are strictly serial: each invocation"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " runs to completion — including its CEI state writes — before the next"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " begins, even when both land in the same ledger. There is no"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " interleaving and no partial application; whichever call executes"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " first wins, and the loser observes the post-write state:"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * If `cancel_stream` executes first, the stream is already `Cancelled`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   when `withdraw` runs, so it reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::StreamNotActive`] (code 5) without moving tokens."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * If `withdraw` executes first, a subsequent `cancel_stream` splits"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   only the *remaining* balance (`streamed − withdrawn`). If this"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   withdrawal drained the stream (`withdrawn == deposit`, status"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   `Depleted`), the cancel instead reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::StreamNotActive`] (code 5)."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The losing call never mutates state, so the funds-conservation"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " outcome is identical to the serial composition: the recipient"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " receives exactly the amount accrued at the later call and the sender"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is refunded the unaccrued remainder. Regression tests pin these"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " sequences in `test.rs` (`race_*`); the race table lives in"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " `docs/ARCHITECTURE.md` §6.1.")]
    pub fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawAmountNonPositive));
        }
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;

        let resolved = oracle::resolve_stream_time(&env, stream_id, s.uses_oracle());
        let available = stream::available_amount_with_plan(&env, &s, resolved.timestamp)?;
        if amount > available {
            return Err(surface::reject(Branch::WithdrawAmountExceedsAvailable));
        }

        Self::pay_out(&env, &mut s, amount)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Withdraws the entire accrued-but-unwithdrawn balance in one call and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " returns the amount paid. Only the recipient can call this (their"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " authorization is required).")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " This is the atomic form of \"read `available`, then `withdraw` it\":"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " clients never risk a stale amount between the two calls. Reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::NothingToWithdraw`] when nothing has accrued yet (or"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " everything accrued has already been withdrawn), with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::StreamNotActive`] on cancelled or depleted streams, and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " with [`StreamError::RecipientPayoutFailed`] if the token refuses the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " payout (state rolls back unchanged)."
    )]
    pub fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        Self::require_not_frozen(&env)?;
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;
        Self::settle_accrued(&env, stream_id, &mut s)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Claims the entire accrued balance of up to [`MAX_WITHDRAW_BATCH`] streams"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " in one transaction, through the exact single-stream claim path."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Every entry runs [`Self::settle_accrued`] — the same function"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw_max` uses — so the batch inherits the CEI ordering, accrual"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " math, TTL extension and per-stream [`Withdrawn`] event of the audited"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " single path instead of restating any of it. One authorization covers the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " batch: the caller must be the recipient of *every* stream listed, so a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " holder can never claim a counterparty's stream by adding its id"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (rejected per-entry with [`StreamError::NotAuthorized`])."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Per-entry isolation.** A stream that fails a pre-payout check — not"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " found, not yours, not active, nothing accrued, overflow — comes back as a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`WithdrawEntry`] carrying that error's code and `amount: 0`, and is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *skipped*: its siblings still pay out. Payout failures are the deliberate"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " exception:")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::RecipientPayoutFailed`] aborts the whole call, because"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the effects of a claim (the `withdrawn` update, the `Withdrawn` event)"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " are written *before* the token interaction, as CEI requires, and a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " published event cannot be un-published. Skipping a failed payout would"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " therefore mean un-writing state after an external call — the exact"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " reentrancy hazard the ordering exists to prevent. Aborting instead lets"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the host roll the transaction back as if it never ran."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **`strict`.** `false` (the default behaviour) keeps partial success: the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " call settles what it can and reports the rest. `true` turns any"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " per-entry rejection into a revert of the whole call, returning that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " error, so an all-or-nothing claim either settles every stream or none."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The call reverts before reading any state when `stream_ids` is empty"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " ([`StreamError::WithdrawBatchEmpty`]), longer than"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`MAX_WITHDRAW_BATCH`] ([`StreamError::WithdrawBatchTooLarge`]), or"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " contains a repeated id ([`StreamError::WithdrawDuplicateStreamIds`]) —"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " a duplicate would otherwise claim against state its first occurrence has"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " already rewritten.")]
    pub fn withdraw_many(
        env: Env,
        recipient: Address,
        stream_ids: Vec<u64>,
        strict: bool,
    ) -> Result<Vec<WithdrawEntry>, StreamError> {
        let count = stream_ids.len();
        if count == 0 {
            return Err(surface::reject(Branch::WithdrawManyEmpty));
        }
        if count > stream::MAX_WITHDRAW_BATCH {
            return Err(surface::reject(Branch::WithdrawManyTooLarge));
        }
        let mut seen = Vec::new(&env);
        for id in stream_ids.iter() {
            if seen.contains(id) {
                return Err(surface::reject(Branch::WithdrawManyDuplicateIds));
            }
            seen.push_back(id);
        }

        Self::require_not_frozen(&env)?;
        recipient.require_auth();

        let mut entries = Vec::new(&env);
        let mut paid = Vec::new(&env);
        let mut total: i128 = 0;
        let mut skipped: u32 = 0;
        for id in stream_ids.iter() {
            let result = Self::authorize_batch_withdrawal(&env, id, &recipient)
                .and_then(|mut s| Self::settle_accrued(&env, id, &mut s));
            if strict {
                // Any per-entry rejection aborts the batch, so the entries that
                // already settled are rolled back with it.
                if let Err(error) = &result {
                    return Err(*error);
                }
            } else if result == Err(StreamError::RecipientPayoutFailed) {
                // The one error that cannot be reported per entry. This entry's
                // effects — the `withdrawn` update and the `Withdrawn` event —
                // were written before the token was called, as CEI requires,
                // and neither can be un-written nor un-published for a single
                // entry. Reporting it as a skip would leave the ledger claiming
                // that money left when nothing moved, so the whole call
                // reverts and the host discards every entry's effects instead.
                return Err(StreamError::RecipientPayoutFailed);
            }
            let entry = match result {
                Ok(amount) => {
                    total = total
                        .checked_add(amount)
                        .ok_or_else(|| surface::reject(Branch::WithdrawManyTotalOverflow))?;
                    paid.push_back(WithdrawOutcome {
                        stream_id: id,
                        amount,
                    });
                    WithdrawEntry {
                        stream_id: id,
                        amount,
                        code: 0,
                    }
                }
                Err(error) => {
                    skipped += 1;
                    WithdrawEntry {
                        stream_id: id,
                        amount: 0,
                        code: error.code(),
                    }
                }
            };
            entries.push_back(entry);
        }

        #[cfg(test)]
        cei_trace::record("event BatchWithdrawSummary");
        BatchWithdrawSummary {
            settled: paid.clone(),
            total,
            requested: count,
            skipped,
            recipient,
        }
        .publish(&env);

        Ok(entries)
    }

    /// Shared claim tail for `withdraw_max` and every `withdraw_many` entry:
    /// resolve the stream's clock, take the whole accrued-but-unwithdrawn
    /// balance, and pay it out. Takes the already-authorized stream so the two
    /// entrypoints differ only in how they authorize.
    fn settle_accrued(env: &Env, stream_id: u64, s: &mut Stream) -> Result<i128, StreamError> {
        let amount = Self::accrued_balance(env, stream_id, s)?;
        Self::pay_out(env, s, amount)?;
        Ok(amount)
    }

    /// The whole accrued-but-unwithdrawn balance at the stream's own clock;
    /// `NothingToWithdraw` when it is zero.
    fn accrued_balance(env: &Env, stream_id: u64, s: &Stream) -> Result<i128, StreamError> {
        let resolved = oracle::resolve_stream_time(env, stream_id, s.uses_oracle());
        let amount = stream::available_amount_with_plan(env, s, resolved.timestamp)?;
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawMaxNothingToWithdraw));
        }
        Ok(amount)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Claims every stream on one page of the recipient's index in one transaction,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " paying one aggregated transfer per asset instead of one per stream."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The page is `page_bounds` (default: offset 0, [`MAX_PAGE_SIZE`] streams; a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `limit` of 0 or above the cap is clamped to it), which keeps a call under the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " ledger-entry limit. `next_offset` is `Some` while the index has more streams."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Each stream goes through the same checks and accrual math as `withdraw_max`."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A stream that fails one of them before paying (not yours, not active, nothing"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " accrued, overflow) is reported in `failed_streams` and skipped; the others"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " still pay. As in `withdraw_many`, a refused token transfer is the exception:"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " state and `Withdrawn` events are written before tokens move, so"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::RecipientPayoutFailed`] reverts the whole call."
    )]
    pub fn withdraw_all(
        env: Env,
        recipient: Address,
        page_bounds: Option<PageBounds>,
    ) -> Result<WithdrawAllResult, StreamError> {
        Self::require_not_frozen(&env)?;
        recipient.require_auth();

        let offset = page_bounds.map(|b| b.offset).unwrap_or(0);
        let limit = match page_bounds.map(|b| b.limit) {
            None | Some(0) => stream::MAX_PAGE_SIZE,
            Some(l) => l.min(stream::MAX_PAGE_SIZE),
        };

        let key = stream::DataKey::RecipientStreams(recipient.clone());
        let (stream_ids, total_count) = stream::page_stream_ids_with_len(&env, &key, offset, limit);
        let end = offset.saturating_add(stream_ids.len());
        let next_offset = if end < total_count { Some(end) } else { None };

        let mut transfers: Vec<AssetTransfer> = Vec::new(&env);
        let mut successful_stream_ids = Vec::new(&env);
        let mut failed_streams = Vec::new(&env);

        // Checks and effects for every stream first; no tokens move in this loop.
        for id in stream_ids.iter() {
            let claim = Self::authorize_batch_withdrawal(&env, id, &recipient).and_then(|mut s| {
                let amount = Self::accrued_balance(&env, id, &s)?;
                let slot = transfers.iter().position(|t| t.token == s.token);
                let total = slot
                    .map_or(Some(amount), |i| {
                        transfers.get_unchecked(i as u32).amount.checked_add(amount)
                    })
                    .ok_or_else(|| surface::reject(Branch::WithdrawManyTotalOverflow))?;
                Self::record_payout(&env, &mut s, amount)?;
                let transfer = AssetTransfer {
                    token: s.token.clone(),
                    amount: total,
                };
                match slot {
                    Some(i) => transfers.set(i as u32, transfer),
                    None => transfers.push_back(transfer),
                }
                Ok(())
            });
            match claim {
                Ok(()) => successful_stream_ids.push_back(id),
                Err(error) => failed_streams.push_back(ClaimFailure {
                    stream_id: id,
                    error_code: error.code(),
                }),
            }
        }

        // Interactions: one transfer per asset. A refusal reverts everything above.
        for t in transfers.iter() {
            push(
                &env,
                &t.token,
                &stream::muxed(&recipient),
                t.amount,
                Branch::RecipientPayoutFailed,
            )?;
        }

        Ok(WithdrawAllResult {
            transfers,
            successful_stream_ids,
            failed_streams,
            next_offset,
        })
    }

    /// Batch-mode authorization: the stream must exist, belong to the batch
    /// caller, and be active.
    ///
    /// The identity check runs *before* any authorization is required, because
    /// a `require_auth` failure for a stranger's recipient aborts the whole
    /// transaction rather than producing a per-entry error — the batch could
    /// not report the offending entry if it got that far.
    fn authorize_batch_withdrawal(
        env: &Env,
        stream_id: u64,
        recipient: &Address,
    ) -> Result<Stream, StreamError> {
        let s = stream::get_stream(env, stream_id)?;
        if &s.recipient != recipient {
            return Err(surface::reject(Branch::WithdrawManyNotStreamRecipient));
        }
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        Ok(s)
    }

    /// Shared preamble for both withdrawal paths: load the stream, require
    /// the recipient's authorization, and reject terminal streams.
    fn authorize_withdrawal(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
        let s = stream::get_stream(env, stream_id)?;
        s.recipient.require_auth();
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        Ok(s)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Shared payout tail for both withdrawal paths, checks-effects-"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " interactions ordered: record `withdrawn` and emit the event *before*"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " moving tokens, so a reentrant token callback can never double-spend."
    )]
    fn pay_out(env: &Env, s: &mut Stream, amount: i128) -> Result<(), StreamError> {
        Self::record_payout(env, s, amount)?;
        push(
            env,
            &s.token,
            &stream::muxed(&s.recipient),
            amount,
            Branch::RecipientPayoutFailed,
        )
    }

    /// The checks-effects half of [`Self::pay_out`]: books `amount` as withdrawn
    /// and emits `Withdrawn`. The caller owes the recipient the token transfer.
    fn record_payout(env: &Env, s: &mut Stream, amount: i128) -> Result<(), StreamError> {
        s.withdrawn = s
            .withdrawn
            .checked_add(amount)
            .ok_or_else(|| surface::reject(Branch::PayoutOverflow))?;
        if s.withdrawn == s.deposit {
            s.status = StreamStatus::Depleted;
        }
        stream::put_stream(env, s);

        #[cfg(test)]
        cei_trace::record("event Withdrawn");
        Withdrawn {
            stream_id: s.id,
            recipient: s.recipient.clone(),
            amount,
            withdrawn_total: s.withdrawn,
        }
        .publish(env);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancels a stream: pays the recipient their accrued-but-unwithdrawn"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " balance and refunds the sender the unaccrued remainder, atomically."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Callable by the sender always, and by the recipient only if the stream"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " was created with `cancelable = true`. Cancelling an already-cancelled"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or depleted stream reverts with [`StreamError::StreamNotActive`]."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Each payout leg maps a token-side failure to its own code —"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::RecipientPayoutFailed`] for the recipient's accrued"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " share and [`StreamError::SenderRefundFailed`] for the sender's refund —"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " and any failure rolls the whole cancellation back: the stream stays"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `Active`, `withdrawn` is restored, and no event survives."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " # Ordering against `withdraw` (same-ledger race)"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The counterpart of the ordering documented on"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::withdraw`]: cancellation is atomic and sees the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdrawn` balance as of *its* execution point."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * If the recipient's `withdraw` executes first, the cancel splits the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   remainder only (`streamed − withdrawn` to the recipient,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   `deposit − streamed` to the sender). If that withdrawal already"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   drained the stream to `Depleted`, the cancel reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::StreamNotActive`] (code 5)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * If this cancel executes first, the stream is `Cancelled` and any"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   later `withdraw` / `withdraw_max` reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::StreamNotActive`] (code 5)."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Last write wins in execution order; no interleaving exists within a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " ledger, and the losing call leaves state and balances untouched."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Pinned by the `race_*` regression tests in `test.rs`; see"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `docs/ARCHITECTURE.md` §6.1 for the race table."
    )]
    pub fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if dispute::get_dispute_opt(&env, stream_id).is_some() {
            return Err(surface::reject(Branch::CancelDuringDispute));
        }
        if caller != s.sender {
            if caller == s.recipient {
                if !s.cancelable {
                    return Err(surface::reject(Branch::CancelStreamNotCancellable));
                }
            } else {
                return Err(surface::reject(Branch::CancelStreamNotAuthorized));
            }
        }

        let resolved = oracle::resolve_stream_time(&env, stream_id, s.uses_oracle());
        let (recipient_amount, sender_amount) =
            stream::cancel_amounts_with_plan(&env, &s, resolved.timestamp)?;
        // Resolved before the state write: the refund belongs to the claim that
        // backed the deposit, which only stays the same as `s.sender` until a
        // consented transfer or an amendment says otherwise.
        let refund_to = stream::refund_target(&env, &s);

        // Effects first (CEI): finalise state before moving tokens.
        s.status = StreamStatus::Cancelled;
        s.withdrawn = s
            .withdrawn
            .checked_add(recipient_amount)
            .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
        stream::put_stream(&env, &s);

        #[cfg(test)]
        cei_trace::record("event StreamCancelled");
        StreamCancelled {
            stream_id,
            cancelled_by: caller,
            recipient_amount,
            sender_amount,
        }
        .publish(&env);

        // MUTANT-SUPPRESS: replace > with >= is acceptable because recipient_amount
        // is only 0 when cancel_amounts computes 0 (cancel before start). The test
        // cancel_at_exact_start_pays_sender_everything verifies correct behavior
        // without the transfer. The >= mutation would only add a no-op transfer of
        // 0 tokens, which is functionally equivalent but unnecessary.
        if recipient_amount > 0 || sender_amount > 0 {
            let current_contract = env.current_contract_address();
            if recipient_amount > 0 {
                push_from(
                    &env,
                    &s.token,
                    &current_contract,
                    &stream::muxed(&s.recipient),
                    recipient_amount,
                    Branch::RecipientPayoutFailed,
                )?;
            }
            if sender_amount > 0 {
                push_from(
                    &env,
                    &s.token,
                    &current_contract,
                    &stream::muxed(&refund_to),
                    sender_amount,
                    Branch::SenderRefundFailed,
                )?;
            }
        }

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Pauses an active stream (sender only), freezing accrual at the stream's"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " current clock. The recipient can still withdraw what accrued before the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " pause; nothing further accrues until [`Self::resume_stream`]. Pausing an"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " already-paused stream returns [`StreamError::InvalidPauseTransition`]."
    )]
    pub fn pause_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError> {
        Self::set_paused(&env, caller, stream_id, true)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Resumes a paused stream (sender only). The stream window (and any rate"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " segments) shift forward by the paused length, so accrual continues from"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the frozen amount at the original rate and the full deposit still"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " streams. Resuming a stream that is not paused returns"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::InvalidPauseTransition`]."
    )]
    pub fn resume_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError> {
        Self::set_paused(&env, caller, stream_id, false)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Adds funds to an existing active stream. The deposit grows and accrual"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " remains linear over the original window, so the recipient's accrued"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " amount increases pro-rata immediately (Sablier-v1 `increaseAmount`"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " semantics).")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Top-ups are rejected on cancelled or depleted streams. Topping up a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stream that has already passed `end_time` adds fully-accrued funds the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recipient can withdraw immediately."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A token-side failure to pull the funds returns"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::TopUpTransferFailed`] and leaves `deposit` unchanged."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Note: extending `end_time` is intentionally not supported in v1 —"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " retroactively re-baselining accrual is lossy for the recipient; see"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `docs/ARCHITECTURE.md` for the design considerations and roadmap."
    )]
    pub fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        if amount <= 0 {
            return Err(surface::reject(Branch::TopUpAmountNonPositive));
        }
        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        s.sender.require_auth();
        if dispute::get_dispute_opt(&env, stream_id).is_some() {
            return Err(surface::reject(Branch::TopUpDuringDispute));
        }

        let new_deposit = s
            .deposit
            .checked_add(amount)
            .ok_or_else(|| surface::reject(Branch::TopUpDepositOverflow))?;
        // A renegotiated stream prices each window on its own terms, so its
        // capacity check is per segment (`segments_after_topup`) and the added
        // funds grow the window being streamed. An unrenegotiated stream needs
        // the single-window check below instead.
        let segments = stream::get_rate_segments(&env, stream_id);
        let new_segments = if segments.is_empty() {
            stream::validate_capacity(new_deposit, s.duration())?;
            segments
        } else {
            stream::segments_after_topup(&segments, amount)?
        };

        let stream_policy = policy::get_stream_policy(&env, Some(s.token.clone()));
        policy::validate_top_up_args(stream_policy.as_ref(), new_deposit, s.duration())?;

        // Interaction: pull the added funds from the sender. A token-side
        // failure maps to a distinct code; the effects below never run, and
        // no partial state survives the `Err`.
        pull(
            &env,
            &s.token,
            &s.sender,
            amount,
            Branch::TopUpTransferFailed,
        )?;

        // Effects: record the new deposit and announce it.
        s.deposit = new_deposit;
        stream::put_stream(&env, &s);
        if !new_segments.is_empty() {
            stream::put_rate_segments(&env, stream_id, &new_segments);
        }

        #[cfg(test)]
        cei_trace::record("event StreamToppedUp");
        StreamToppedUp {
            stream_id,
            sender: s.sender.clone(),
            amount,
            new_deposit,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Recipient-initiated dispute: flags this stream (wrong address,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " coerced creation) and freezes its cancel/top-up mutations until the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " sender calls [`StreamingPayments::resolve_dispute`] or the timelock"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " elapses and anyone calls [`StreamingPayments::expire_dispute`]."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Only the stream's recipient can raise it (their authorization is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " required), only on an active, undisputed stream. Anti-griefing: the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recipient posts a bond ([`StreamingPayments::required_dispute_bond`],"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " a share of the deposit that escalates with every dispute round on"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the stream) via a prior token approval, held by the contract until"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " resolution. Accrual keeps running and accrued funds stay withdrawable"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " throughout — the freeze targets the stream's lifecycle, not the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " recipient's earned balance.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the recorded dispute (bond, window, expiry timestamp)."
    )]
    pub fn raise_dispute(env: Env, stream_id: u64) -> Result<Dispute, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if dispute::get_dispute_opt(&env, stream_id).is_some() {
            return Err(surface::reject(Branch::RaiseDisputeAlreadyActive));
        }
        s.recipient.require_auth();

        let bond = dispute::required_bond(s.deposit, dispute::dispute_count(&env, stream_id))?;

        // Interaction: pull the bond from the recipient (a prior approval is
        // required, like `create_stream`'s deposit pull).
        TokenClient::new(&env, &s.token).transfer_from(
            &env.current_contract_address(),
            &s.recipient,
            &env.current_contract_address(),
            &bond,
        );

        // Effects: open the dispute and record the round (escalating bond).
        let now = env.ledger().timestamp();
        let d = Dispute {
            stream_id,
            raised_by: s.recipient.clone(),
            bond,
            started_at: now,
            expires_at: now.saturating_add(dispute::DISPUTE_TIMEOUT_SECONDS),
        };
        dispute::put_dispute(&env, &d);
        dispute::bump_dispute_count(&env, stream_id);

        DisputeRaised {
            stream_id,
            recipient: s.recipient,
            bond,
            expires_at: d.expires_at,
        }
        .publish(&env);

        Ok(d)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Sender-only resolution of an open dispute:"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `accept = true` — the dispute is legitimate: the bond is refunded"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   to the recipient and the stream is unwound with the standard"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   pro-rata cancel split (a `StreamCancelled` event accompanies the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   `DisputeResolved`). If the stream already depleted during the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   dispute (the recipient withdrew everything), only the bond is"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   refunded.")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `accept = false` — bad faith: the bond is slashed to the sender as"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   compensation for the frozen window, and the stream resumes normal"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   operation immediately.")]
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        stream_id: u64,
        accept: bool,
    ) -> Result<(), StreamError> {
        caller.require_auth();

        let mut s = stream::get_stream(&env, stream_id)?;
        let d = dispute::get_dispute(&env, stream_id)?;
        if caller != s.sender {
            return Err(surface::reject(Branch::ResolveCallerNotSender));
        }

        // Effects: close the dispute, then optionally unwind the stream.
        dispute::delete_dispute(&env, stream_id);

        let (recipient_settlement, sender_settlement) =
            if accept && s.status == StreamStatus::Active {
                let amounts = stream::cancel_amounts(&env, &s)?;
                s.status = StreamStatus::Cancelled;
                s.withdrawn = s
                    .withdrawn
                    .checked_add(amounts.0)
                    .ok_or(StreamError::MathOverflow)?;
                stream::put_stream(&env, &s);

                StreamCancelled {
                    stream_id,
                    cancelled_by: caller.clone(),
                    recipient_amount: amounts.0,
                    sender_amount: amounts.1,
                }
                .publish(&env);
                amounts
            } else {
                (0, 0)
            };

        DisputeResolved {
            stream_id,
            sender: s.sender.clone(),
            accept,
            bond: d.bond,
        }
        .publish(&env);

        // Interactions last (CEI): bond refund/slash plus settlement.
        let token = TokenClient::new(&env, &s.token);
        let bond_to_recipient = if accept { d.bond } else { 0 };
        let bond_to_sender = if accept { 0 } else { d.bond };
        if bond_to_recipient + recipient_settlement > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.recipient),
                &(bond_to_recipient + recipient_settlement),
            );
        }
        if bond_to_sender + sender_settlement > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.sender),
                &(bond_to_sender + sender_settlement),
            );
        }

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Closes a dispute whose timelock has fully elapsed: the bond is split"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (sender receives the upper half as compensation for the frozen"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " window, the recipient the remainder) and the stream resumes normally."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Callable by anyone once `now >= expires_at` — no authorization is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " involved and no funds ever move to the trigger. Reverting the split"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " to a full bond refund would make serial disputes free for a patient"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " griefer; see `docs/ARCHITECTURE.md` for the griefing-threshold math."
    )]
    pub fn expire_dispute(env: Env, stream_id: u64) -> Result<(), StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        let d = dispute::get_dispute(&env, stream_id)?;
        if env.ledger().timestamp() < d.expires_at {
            return Err(surface::reject(Branch::ExpireDisputeTooEarly));
        }

        // Effects: close the dispute; the stream entry was never touched.
        dispute::delete_dispute(&env, stream_id);
        let (sender_share, recipient_share) = dispute::bond_shares(d.bond);

        DisputeExpired {
            stream_id,
            recipient: s.recipient.clone(),
            bond: d.bond,
            sender_share,
            recipient_share,
        }
        .publish(&env);

        // Interactions last (CEI).
        let token = TokenClient::new(&env, &s.token);
        if recipient_share > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.recipient),
                &recipient_share,
            );
        }
        if sender_share > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.sender),
                &sender_share,
            );
        }

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposes handing the caller's stream role (sender or recipient) to"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `new_owner`. The role does not move until `new_owner` calls"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::accept_ownership_transfer`]."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * Only the current sender or recipient may propose; their authorization"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   is required. A stranger is rejected with [`StreamError::NotAuthorized`]."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * The stream must be `Active`: ownership of a cancelled or depleted"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   stream has no future claims and cannot be transferred."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * Proposing to the current holder of the same role is rejected with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::InvalidTransferTarget`]."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * At most one unexpired proposal exists per stream. Proposing again"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   while one is pending reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::OwnershipProposalPending`]; an expired proposal is"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   removed and replaced.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " No tokens move and no accounting field changes at proposal time. The"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " target is recorded under its own storage key with a seven-day"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " acceptance window ([`OWNERSHIP_PROPOSAL_TTL_SECONDS`])."
    )]
    pub fn propose_ownership_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
        new_owner: Address,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        let role = Self::role_of(&s, &caller)?;
        let current_owner = match role {
            OwnershipRole::Sender => &s.sender,
            OwnershipRole::Recipient => &s.recipient,
        };
        if new_owner == *current_owner {
            return Err(surface::reject(Branch::ProposeInvalidTarget));
        }

        let now = env.ledger().timestamp();
        if let Some(existing) = stream::get_pending_ownership(&env, stream_id) {
            if now < existing.expires_at {
                return Err(surface::reject(Branch::ProposeAlreadyPending));
            }
            // Stale proposals are cleared lazily so a fresh target can be
            // proposed without a separate cleanup transaction.
            stream::remove_pending_ownership(&env, stream_id);
        }

        let pending = PendingOwnership {
            stream_id,
            proposed_by: caller.clone(),
            new_owner: new_owner.clone(),
            role,
            expires_at: now.saturating_add(OWNERSHIP_PROPOSAL_TTL_SECONDS),
        };
        stream::put_pending_ownership(&env, &pending);

        OwnershipProposed {
            stream_id,
            current_owner: caller,
            new_owner,
            role,
            expires_at: pending.expires_at,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Accepts a pending ownership proposal. Only the proposal's `new_owner`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " may call this, and their authorization is required."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " On success the sender or recipient role moves to the caller. The"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stream's accounting fields (`deposit`, `withdrawn`, `start_time`,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `end_time`, `token`, `status`, `use_oracle`) are untouched, so accrual"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " and the `0 <= withdrawn <= streamed <= deposit` invariant are unchanged:"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " what moves is the right to future payouts (recipient) or future top-ups"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " / cancellation refunds (sender). The stream id is appended to the new"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " holder's discovery index; the previous holder's append-only index keeps"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " its historical entry.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Expired proposals cannot be accepted: the call reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::OwnershipProposalExpired`]. Reverts roll back storage"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " writes, so the stale entry stays stored but is ignored forever after"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " its window; a later proposal replaces it (see"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::propose_ownership_transfer`])."
    )]
    pub fn accept_ownership_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let pending = stream::get_pending_ownership(&env, stream_id)
            .ok_or_else(|| surface::reject(Branch::NoPendingOwnership))?;
        if caller != pending.new_owner {
            return Err(surface::reject(Branch::AcceptNotTarget));
        }
        if env.ledger().timestamp() >= pending.expires_at {
            return Err(surface::reject(Branch::OwnershipProposalExpired));
        }

        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }

        // The proposal could only have been created by the address currently
        // holding `role`, and role transfers always clear the pending key, so
        // `proposed_by` is the previous owner by construction.
        let previous_owner = match pending.role {
            OwnershipRole::Sender => {
                s.sender = caller.clone();
                pending.proposed_by.clone()
            }
            OwnershipRole::Recipient => {
                s.recipient = caller.clone();
                pending.proposed_by.clone()
            }
        };

        stream::put_stream(&env, &s);
        match pending.role {
            OwnershipRole::Sender => stream::index_sender(&env, &caller, stream_id),
            OwnershipRole::Recipient => stream::index_recipient(&env, &caller, stream_id),
        }
        stream::remove_pending_ownership(&env, stream_id);

        OwnershipAccepted {
            stream_id,
            previous_owner,
            new_owner: caller,
            role: pending.role,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancels a pending ownership proposal. Only the current role holder that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " created the proposal may cancel it; their authorization is required."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancelling is allowed after the proposal's acceptance window has"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " elapsed (it simply clears the stale entry). It emits no event: the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " proposal never changed the stream, and `OwnershipProposed` remains the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " permanent record that a proposal once existed."
    )]
    pub fn cancel_ownership_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let pending = stream::get_pending_ownership(&env, stream_id)
            .ok_or_else(|| surface::reject(Branch::NoPendingOwnership))?;
        if caller != pending.proposed_by {
            return Err(surface::reject(Branch::CancelProposalNotProposer));
        }
        stream::remove_pending_ownership(&env, stream_id);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a stream's pending ownership proposal, if any."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reading extends the proposal's storage TTL; unknown streams simply"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " return `None`.")]
    pub fn pending_ownership_transfer(env: Env, stream_id: u64) -> Option<PendingOwnership> {
        stream::get_pending_ownership(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposes handing the **sender** role of a stream to a new address."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Only the current sender may propose, and the proposal does not move the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " role: a sender transfer changes who pays the recipient and who can"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cancel the stream, so it is the *recipient's* decision to take. The"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " proposal therefore waits for [`StreamingPayments::accept_sender_transfer`]"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " from the recipient, inside `OWNERSHIP_PROPOSAL_TTL_SECONDS`."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `nonce` is the caller's freshness marker. It is stored with the proposal,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " echoed by the proposal's events and must be repeated exactly by the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " consent, so a consent can never land on a proposal that was replaced in"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " the meantime.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `transfer_refund_rights` decides, up front, what the recipient is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " consenting to: with `false` (the default meaning auditors expect) the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " deposit's refund claim stays with the original sender, and only the role"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " moves; with `true` the claim moves to `new_sender` as well. Refund rights"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " are never implied by a role change — the flag is the whole mechanism."
    )]
    pub fn propose_sender_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
        new_sender: Address,
        nonce: u64,
        transfer_refund_rights: bool,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if caller != s.sender {
            return Err(surface::reject(Branch::ProposeNotAuthorized));
        }
        // The recipient stays who they are; handing the payer role to the
        // recipient would collapse both roles onto one address.
        if new_sender == s.sender || new_sender == s.recipient {
            return Err(surface::reject(Branch::ProposeInvalidTarget));
        }

        let now = env.ledger().timestamp();
        if let Some(existing) = stream::get_pending_sender_transfer(&env, stream_id) {
            if now < existing.expires_at {
                return Err(surface::reject(Branch::SenderTransferPending));
            }
            // A proposal that aged out is replaced here rather than requiring a
            // separate cleanup call; `expire_sender_transfer` exists for anyone
            // who wants the reclaim (and its event) on its own.
            stream::remove_pending_sender_transfer(&env, stream_id);
        }

        let pending = PendingSenderTransfer {
            stream_id,
            sender_from: caller.clone(),
            new_sender: new_sender.clone(),
            nonce,
            expires_at: now.saturating_add(OWNERSHIP_PROPOSAL_TTL_SECONDS),
            transfer_refund_rights,
        };
        stream::put_pending_sender_transfer(&env, &pending);

        #[cfg(test)]
        cei_trace::record("event SenderTransferProposed");
        SenderTransferProposed {
            stream_id,
            sender_from: caller,
            new_sender,
            nonce,
            expires_at: pending.expires_at,
            transfer_refund_rights,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Executes a proposed sender transfer on the recipient's consent."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The caller must be the stream's **recipient** — the party whose"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " counterparty changes — and must present the proposal's nonce. On success"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the role moves, the sender discovery indexes are re-pointed for both"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " sides, and the hop is appended to the stream's immutable sender log."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `deposit`, `withdrawn`, the time window and the token are untouched, so"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " accrual and the `0 <= withdrawn <= streamed <= deposit` invariant are"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " unchanged.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An elapsed window is [`StreamError::SenderTransferExpired`], never a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " silent no-op; the stale entry is then reclaimed with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::expire_sender_transfer`]."
    )]
    pub fn accept_sender_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
        nonce: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let pending = stream::get_pending_sender_transfer(&env, stream_id)
            .ok_or_else(|| surface::reject(Branch::SenderTransferNotFound))?;
        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if caller != s.recipient {
            return Err(surface::reject(Branch::SenderTransferNotConsenter));
        }
        if nonce != pending.nonce {
            return Err(surface::reject(Branch::SenderTransferNonceMismatch));
        }
        if env.ledger().timestamp() >= pending.expires_at {
            return Err(surface::reject(Branch::SenderTransferExpired));
        }

        // Effects (CEI): state first, then the event. No tokens move — this
        // entrypoint changes roles only.
        stream::apply_sender_transfer(&env, &s, &pending)?;
        stream::remove_pending_sender_transfer(&env, stream_id);

        #[cfg(test)]
        cei_trace::record("event SenderTransferred");
        SenderTransferred {
            stream_id,
            sender_from: pending.sender_from,
            sender_to: pending.new_sender.clone(),
            nonce,
            refund_rights_transferred: pending.transfer_refund_rights,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reclaims a sender-transfer proposal whose acceptance window has elapsed."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Permissionless like the version-migration path: nothing about removing a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " dead proposal can move funds or change an accounting field, so any keeper"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " may pay the gas to free the storage. Returns the reclaimed nonce so the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " caller can confirm which proposal they removed."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Refuses while the proposal is still live ([`StreamError::"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " SenderTransferNotExpired`]) — the window, not a third party, is what ends"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " a recipient's option to consent — and with [`StreamError::"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " SenderTransferNotFound`] when there is nothing to reclaim."
    )]
    pub fn expire_sender_transfer(env: Env, stream_id: u64) -> Result<u64, StreamError> {
        Self::require_not_frozen(&env)?;

        let pending = stream::get_pending_sender_transfer(&env, stream_id)
            .ok_or_else(|| surface::reject(Branch::SenderTransferNotFound))?;
        if env.ledger().timestamp() < pending.expires_at {
            return Err(surface::reject(Branch::SenderTransferNotExpired));
        }
        stream::remove_pending_sender_transfer(&env, stream_id);

        #[cfg(test)]
        cei_trace::record("event SenderTransferExpired");
        SenderTransferExpired {
            stream_id,
            sender_from: pending.sender_from.clone(),
            new_sender: pending.new_sender.clone(),
            nonce: pending.nonce,
        }
        .publish(&env);

        Ok(pending.nonce)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a stream's pending sender transfer, if any."
    )]
    pub fn pending_sender_transfer(env: Env, stream_id: u64) -> Option<PendingSenderTransfer> {
        stream::get_pending_sender_transfer(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The append-only sender-role log of a stream: who held the payer role at"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " creation and every consented hop since. Never rewritten, so the answer to"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " \"who funded this deposit?\" survives any number of transfers."
    )]
    pub fn sender_history(env: Env, stream_id: u64) -> Result<SenderHistory, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        Ok(stream::sender_history(&env, &s))
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The address that receives the refund of the unstreamed remainder when the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stream is cancelled. Equal to the current sender unless a sender transfer"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " left the claim behind (or an amendment moved it on purpose)."
    )]
    pub fn refund_target(env: Env, stream_id: u64) -> Result<Address, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        Ok(stream::refund_target(&env, &s))
    }

    /// Resolves which role `caller` currently holds on `s`.
    fn role_of(s: &Stream, caller: &Address) -> Result<OwnershipRole, StreamError> {
        if caller == &s.sender {
            Ok(OwnershipRole::Sender)
        } else if caller == &s.recipient {
            Ok(OwnershipRole::Recipient)
        } else {
            Err(surface::reject(Branch::ProposeNotAuthorized))
        }
    }

    // --------------------------------------------- rate renegotiation (#54) --
    //
    // The sender and the recipient can agree a new `amount_per_second` for the
    // rest of a running stream. Neither can impose it alone: the change needs
    // the counterparty's acceptance, and the funds movement it implies is
    // computed from the stored schedule at the moment of acceptance, never at
    // proposal time.

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposes a new streaming rate for `stream_id`. The change takes"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " effect only when the counterparty calls"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::accept_rate_change`], and only from that moment"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " onward: everything accrued before it is untouched."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * Either party may propose; their authorization is required. A"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   stranger is rejected with [`StreamError::NotAuthorized`]."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * The stream must be `Active` and its window must not have elapsed:"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   a rate for a finished stream would be a no-op that still rebalances"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   funds, so it is rejected with [`StreamError::InvalidTimeRange`]."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `amount_per_second` must be positive ([`StreamError::ZeroAmount`])."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * At most one unexpired proposal exists per stream. Proposing again"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   while one is pending reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   [`StreamError::RateProposalPending`]; an expired proposal is"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   removed and replaced.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Governance policy for the *proposed* rate is checked at acceptance,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " not here: the ceilings that bind are the ones in force when the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " change becomes effective, and they can move during the acceptance"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " window. No tokens move and no accounting field changes at proposal"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " time; the offer is recorded under its own storage key with a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " seven-day acceptance window ([`RATE_PROPOSAL_TTL_SECONDS`])."
    )]
    pub fn propose_rate_change(
        env: Env,
        caller: Address,
        stream_id: u64,
        amount_per_second: i128,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if amount_per_second <= 0 {
            return Err(surface::reject(Branch::RateProposalAmountNonPositive));
        }
        let now = env.ledger().timestamp();
        if now >= s.end_time {
            return Err(surface::reject(Branch::RateProposalWindowElapsed));
        }
        let counterparty = if caller == s.sender {
            s.recipient.clone()
        } else if caller == s.recipient {
            s.sender.clone()
        } else {
            return Err(surface::reject(Branch::RateProposeNotAuthorized));
        };

        if let Some(existing) = stream::get_pending_rate_change(&env, stream_id) {
            if now < existing.expires_at {
                return Err(surface::reject(Branch::RateProposalPending));
            }
            // Expired proposals are cleared lazily so a fresh offer needs no
            // separate cleanup transaction.
            stream::remove_pending_rate_change(&env, stream_id);
        }

        let pending = PendingRateChange {
            stream_id,
            proposed_by: caller.clone(),
            counterparty: counterparty.clone(),
            amount_per_second,
            expires_at: now.saturating_add(RATE_PROPOSAL_TTL_SECONDS),
        };
        stream::put_pending_rate_change(&env, &pending);

        #[cfg(test)]
        cei_trace::record("event RateChangeProposed");
        RateChangeProposed {
            stream_id,
            proposed_by: caller,
            counterparty,
            amount_per_second,
            expires_at: pending.expires_at,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Accepts a pending rate change, rebalancing the deposit atomically."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Only the proposal's counterparty may accept, and their authorization"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is required. The rate itself was fixed by the proposal; what acceptance"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " computes is what that rate now costs:"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `owed` — accrued at the change boundary `t` under the schedule that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   was in force until now, i.e. `streamed` at `t`. It is carried into"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   the new schedule untouched, which is what makes the change unable to"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   re-price the past.")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `reserved` — `amount_per_second * (end_time - t)`, an exact integer"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   product, floored by nothing and rounded by nothing: the new segment"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   accrues that amount over exactly that window, so it is fully streamed"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   at `end_time` with no rounding residue."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * `adjustment` — `reserved - (deposit - owed)`. Positive means the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   old reserve no longer covers the new rate and the sender tops up the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   shortfall; negative means the sender is refunded the freed remainder."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The deposit becomes `owed + reserved`, so the accrual endpoint still"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " equals the deposit and the invariant `withdrawn <= streamed <= deposit`"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " holds across the whole change.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Funds movement follows the direction of the change: a top-up is pulled"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *before* any effect is written (like `top_up`), so a token that refuses"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the pull leaves the schedule and the deposit untouched; a refund is paid"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *after* the effects (like `cancel_stream`), so a token that refuses the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " refund rolls the whole acceptance back and the proposal survives for a"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " retry.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " An expired proposal cannot be accepted"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " ([`StreamError::RateProposalExpired`]), and neither can one whose parties"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " have moved on: if a role transferred after the offer was made, the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recorded proposer/counterparty pair is no longer the stream's sender and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recipient, and acceptance reverts with [`StreamError::NotAuthorized`]."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stale offer blocks nothing — its proposer can always cancel it."
    )]
    pub fn accept_rate_change(
        env: Env,
        caller: Address,
        stream_id: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let pending = stream::get_pending_rate_change(&env, stream_id)
            .ok_or_else(|| surface::reject(Branch::NoPendingRateChange))?;
        if caller != pending.counterparty {
            return Err(surface::reject(Branch::RateAcceptNotTarget));
        }
        if env.ledger().timestamp() >= pending.expires_at {
            return Err(surface::reject(Branch::RateProposalExpired));
        }

        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        // The recorded pair must still be exactly the stream's parties, in the
        // same roles. A transfer of either role invalidates the offer rather
        // than letting a change negotiated with an ex-party bind their
        // successor's funds.
        let still_negotiating = (caller == s.sender && pending.proposed_by == s.recipient)
            || (caller == s.recipient && pending.proposed_by == s.sender);
        if !still_negotiating {
            return Err(surface::reject(Branch::RateAcceptStaleParties));
        }

        // The boundary is the stream's own clock (oracle-resolved like every
        // other accrual read), clamped into the window: a proposal made before
        // `start_time` starts the new rate at `start_time`, and one that outlives
        // `end_time` has nothing left to re-rate.
        let resolved = oracle::resolve_stream_time(&env, stream_id, s.uses_oracle());
        let boundary = stream::accrual_now(&env, stream_id, resolved.timestamp).max(s.start_time);
        if boundary >= s.end_time {
            return Err(surface::reject(Branch::RateProposalWindowElapsed));
        }
        let remaining = (s.end_time - boundary) as i128;

        policy::validate_rate_args(
            policy::get_stream_policy(&env, Some(s.token.clone())).as_ref(),
            pending.amount_per_second,
        )?;

        let segments = stream::get_rate_segments(&env, stream_id);
        let owed = stream::streamed_amount_at_segments(&s, boundary, &segments)?;
        // Exact by construction: the new segment's basis is its own window
        // length, so `reserved` is what it streams, to the token.
        let reserved = pending
            .amount_per_second
            .checked_mul(remaining)
            .ok_or_else(|| surface::reject(Branch::RateReserveOverflow))?;
        // `owed <= deposit` is the stream invariant, so the headroom check below
        // can only fire on a corrupt entry; the reserve checks are real guards —
        // a proposed rate is unbounded until the rebalancing is priced.
        let headroom = s
            .deposit
            .checked_sub(owed)
            .ok_or_else(|| surface::reject(Branch::RateHeadroomUnderflow))?;
        let adjustment = reserved
            .checked_sub(headroom)
            .ok_or_else(|| surface::reject(Branch::RateReserveOverflow))?;
        let new_deposit = s
            .deposit
            .checked_add(adjustment)
            .ok_or_else(|| surface::reject(Branch::RateReserveOverflow))?;
        stream::validate_capacity(reserved, remaining as u64)?;
        let new_segments = stream::segments_after_change(&env, &s, &segments, boundary, reserved)?;

        if adjustment > 0 {
            // A recipient accepting an increase takes funds from the sender, who
            // has not signed this call — so their authorization is required too.
            s.sender.require_auth();
            pull(
                &env,
                &s.token,
                &s.sender,
                adjustment,
                Branch::RateTopUpTransferFailed,
            )?;
        }

        // Effects: install the schedule, then the deposit it sums to, then clear
        // the offer. `withdrawn` never moves, so nothing already claimed is
        // re-priced or re-claimable.
        s.deposit = new_deposit;
        stream::put_stream(&env, &s);
        stream::put_rate_segments(&env, stream_id, &new_segments);
        stream::remove_pending_rate_change(&env, stream_id);

        #[cfg(test)]
        cei_trace::record("event RateChangeAccepted");
        RateChangeAccepted {
            stream_id,
            accepted_by: caller,
            new_amount_per_second: pending.amount_per_second,
            effective_from: boundary,
            owed_at_change: owed,
            reserved_at_new_rate: reserved,
            adjustment,
            deposit: new_deposit,
        }
        .publish(&env);

        if adjustment < 0 {
            let refund = -adjustment;
            push(
                &env,
                &s.token,
                &stream::muxed(&s.sender),
                refund,
                Branch::RateRefundFailed,
            )?;
        }

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancels a pending rate proposal. Only the address that created it"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " may cancel, and its authorization is required."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancellation is allowed after the acceptance window elapsed (it simply"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " clears the stale entry) and on a stream that has since been cancelled"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " or depleted, which is what lets a proposer clean up after the fact."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " It emits no event: the proposal never changed the stream, and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `RateChangeProposed` remains the permanent record that one existed."
    )]
    pub fn cancel_rate_change(
        env: Env,
        caller: Address,
        stream_id: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        caller.require_auth();

        let pending = stream::get_pending_rate_change(&env, stream_id)
            .ok_or_else(|| surface::reject(Branch::NoPendingRateChange))?;
        if caller != pending.proposed_by {
            return Err(surface::reject(Branch::RateCancelNotProposer));
        }
        stream::remove_pending_rate_change(&env, stream_id);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a stream's pending rate proposal, if any."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reading extends the proposal's storage TTL; unknown streams return"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " `None`.")]
    pub fn pending_rate_change(env: Env, stream_id: u64) -> Option<PendingRateChange> {
        stream::get_pending_rate_change(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a stream's rate schedule. Empty means the stream"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " still accrues at its original rate over `[start_time, end_time)`: the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " single-window formula, with no stored segment to consult."
    )]
    pub fn rate_segments(env: Env, stream_id: u64) -> Vec<RateSegment> {
        stream::get_rate_segments(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a stream's full state."
    )]
    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError> {
        stream::get_stream(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a stream's open dispute. Reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::DisputeNotFound`] when the stream is undisputed"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (disputes exist only while open; resolution and expiry remove them)."
    )]
    pub fn get_dispute(env: Env, stream_id: u64) -> Result<Dispute, StreamError> {
        dispute::get_dispute(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The bond a recipient must post (and pre-approve) to raise the next"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " dispute on this stream: 5% of the deposit, multiplied by the number"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " of disputes already raised on it, floored at one token unit."
    )]
    pub fn required_dispute_bond(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        dispute::required_bond(s.deposit, dispute::dispute_count(&env, stream_id))
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of the accrued-but-unwithdrawn balance at the current"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " ledger time. Zero before `start_time` and for cancelled streams; the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " full remainder at or after `end_time`."
    )]
    pub fn available(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        let resolved = oracle::resolve_stream_time(&env, stream_id, s.uses_oracle());
        stream::available_amount_with_plan(&env, &s, resolved.timestamp)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A page of stream ids where `recipient` is the recipient, in creation"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " order (oldest first). `limit` is clamped to `MAX_PAGE_SIZE`; paginate"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " by advancing `offset`. Unknown addresses yield an empty page."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Discovery view only: it does not authorize anything and terminal"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (cancelled/depleted) streams keep their ids — read each stream's"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " `status` for lifecycle state.")]
    pub fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(
            &env,
            &stream::DataKey::RecipientStreams(recipient),
            offset,
            limit,
        )
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A page of stream ids created by `sender`, in creation order. Same"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " pagination and advisory semantics as [`StreamingPayments::recipient_streams`]."
    )]
    pub fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::SenderStreams(sender), offset, limit)
    }

    // ------------------------------------------------- scheduled intents ----

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Pre-authorizes the creation of one or more streams at a future time and"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " escrows the up-front cost.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `sender` must authorize this call (their signature over the invocation"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is verified by the host). The contract escrows"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `(deposit_amount + fee_budget) * occurrences` of `token`:"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `deposit_amount` per occurrence funds the stream, and `fee_budget` per"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " occurrence is the reward paid to whichever keeper later executes it."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * A **one-shot** intent is scheduled with `occurrences = 1` and"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   `interval = 0`.")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " * A **recurring** intent is scheduled with `occurrences > 1` and a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   strictly positive `interval` (seconds between occurrence starts). The"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = "   `i`-th occurrence's stream window is `[start_time + i*interval,"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "   end_time + i*interval)`.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Timing constraints: `execute_after <= start_time`, `now <= execute_after`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " and `start_time` must be strictly in the future; `expires_at >"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " execute_after` bounds the execution window. The exact parameters are"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " committed into the intent's `params_hash`."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the new intent id (monotonically increasing, starting at 1)."
    )]
    #[allow(clippy::too_many_arguments)] // the scheduling surface is intentionally explicit
    pub fn schedule_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        interval: u64,
        occurrences: u32,
        fee_budget: i128,
        execute_after: u64,
        expires_at: u64,
    ) -> Result<u64, StreamError> {
        sender.require_auth();

        let total_escrow = schedule::validate_schedule(
            &env,
            deposit_amount,
            start_time,
            end_time,
            interval,
            occurrences,
            fee_budget,
            execute_after,
            expires_at,
        )?;

        // Effects first (CEI): persist the exact authorized intent before the
        // token call. If the transfer fails, Soroban rolls the whole invocation
        // back, including these writes and the event.
        let id = schedule::next_intent_id(&env);
        let params_hash = schedule::params_hash(
            &env,
            &sender,
            &recipient,
            &token,
            deposit_amount,
            start_time,
            end_time,
            cancelable,
            interval,
            occurrences,
            fee_budget,
            execute_after,
            expires_at,
        );
        let intent = ScheduledIntent {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
            interval,
            occurrences_total: occurrences,
            occurrences_remaining: occurrences,
            fee_budget,
            execute_after,
            expires_at,
            params_hash,
            status: IntentStatus::Pending,
        };
        schedule::put_intent(&env, &intent);
        schedule::index_intent(&env, &intent);

        StreamScheduled {
            intent_id: id,
            sender: sender.clone(),
            recipient,
            token: token.clone(),
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
            interval,
            occurrences,
            fee_budget,
            execute_after,
            expires_at,
        }
        .publish(&env);

        // Interaction: pull the whole escrow (deposit + fee budget, for every
        // occurrence) into the contract. Reentrant token code cannot observe an
        // unregistered schedule or execute against an intent without state.
        TokenClient::new(&env, &token).transfer_from(
            &env.current_contract_address(),
            &sender,
            &env.current_contract_address(),
            &total_escrow,
        );

        Ok(id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Executes the next due occurrence of a scheduled intent, creating the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stream and paying `keeper` the escrowed per-occurrence fee."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Permissionless**: any address may call as `keeper`, but `keeper` must"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " authorize the call (so the fee cannot be front-run and redirected to a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " copycat). The contract enforces that the intent is pending, is within its"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `[execute_after, expires_at)` window for the next occurrence, and that"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " its stored parameters still match the scheduling commitment."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Execution is **once per occurrence**: each call decrements"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `occurrences_remaining`, and a second call for an already-executed"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " occurrence (or a completed one-shot) reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::IntentNotPending`]. Returns the created stream id."
    )]
    pub fn execute_scheduled(
        env: Env,
        intent_id: u64,
        keeper: Address,
    ) -> Result<u64, StreamError> {
        keeper.require_auth();

        let mut intent = schedule::get_intent(&env, intent_id)?;
        if intent.status != IntentStatus::Pending {
            return Err(surface::reject(Branch::IntentNotPending));
        }

        // Defensive: the stored parameters must still hash to the commitment
        // recorded when the sender authorized the intent.
        if schedule::intent_params_hash(&env, &intent) != intent.params_hash {
            return Err(surface::reject(Branch::IntentParamsMismatch));
        }

        let now = env.ledger().timestamp();
        if now >= intent.expires_at {
            return Err(surface::reject(Branch::IntentExpired));
        }
        let index = intent.executed_count();
        if now < intent.occurrence_due(index) {
            return Err(surface::reject(Branch::IntentNotYetExecutable));
        }

        let (start_time, end_time) = intent.occurrence_window(index);

        // Effects first (CEI): advance the intent before moving any tokens.
        intent.occurrences_remaining = intent
            .occurrences_remaining
            .checked_sub(1)
            .ok_or(StreamError::MathOverflow)?;
        if intent.occurrences_remaining == 0 {
            intent.status = IntentStatus::Executed;
        }
        schedule::put_intent(&env, &intent);

        // The stream deposit is already escrowed; only bookkeeping is required.
        let stream_id = Self::persist_new_stream(
            &env,
            intent.sender.clone(),
            intent.recipient.clone(),
            intent.token.clone(),
            intent.deposit,
            start_time,
            end_time,
            intent.cancelable,
            false,
            0,
            0,
        )?;

        // Pay the keeper its escrowed fee for this occurrence.
        let fee_paid = intent.fee_budget;
        if fee_paid > 0 {
            #[cfg(test)]
            cei_trace::record("transfer keeper fee");
            TokenClient::new(&env, &intent.token).transfer(
                &env.current_contract_address(),
                stream::muxed(&keeper),
                &fee_paid,
            );
        }

        #[cfg(test)]
        cei_trace::record("event ScheduledStreamExecuted");
        ScheduledStreamExecuted {
            intent_id,
            keeper,
            stream_id,
            occurrence_index: index,
            occurrences_remaining: intent.occurrences_remaining,
            fee_paid,
        }
        .publish(&env);

        Ok(stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancels a pending scheduled intent and refunds the sender the escrow for"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " every outstanding occurrence.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Only the intent's sender may cancel (their authorization is required),"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " and only **before the execution window opens** (`now < execute_after`)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Once the window is open, keepers may execute and cancellation is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " disallowed ([`StreamError::IntentNotCancellable`]) to remove a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cancel/execute race that would otherwise burn keeper gas. After"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `expires_at`, use [`StreamingPayments::reclaim_expired`] instead."
    )]
    pub fn cancel_scheduled(env: Env, sender: Address, intent_id: u64) -> Result<(), StreamError> {
        sender.require_auth();

        let mut intent = schedule::get_intent(&env, intent_id)?;
        if intent.status != IntentStatus::Pending {
            return Err(surface::reject(Branch::IntentNotPending));
        }
        if sender != intent.sender {
            return Err(StreamError::NotAuthorized);
        }

        let now = env.ledger().timestamp();
        if now >= intent.expires_at {
            return Err(surface::reject(Branch::IntentExpired));
        }
        if now >= intent.execute_after {
            return Err(surface::reject(Branch::IntentNotCancellable));
        }

        let refund = intent.remaining_escrow()?;

        // Effects first (CEI).
        intent.status = IntentStatus::Cancelled;
        schedule::put_intent(&env, &intent);

        if refund > 0 {
            #[cfg(test)]
            cei_trace::record("transfer scheduled refund");
            TokenClient::new(&env, &intent.token).transfer(
                &env.current_contract_address(),
                stream::muxed(&intent.sender),
                &refund,
            );
        }

        #[cfg(test)]
        cei_trace::record("event ScheduledIntentCancelled");
        ScheduledIntentCancelled {
            intent_id,
            sender: intent.sender.clone(),
            refund,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reclaims a pending intent that passed `expires_at` without being fully"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " executed, refunding the sender the escrow for every outstanding"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " occurrence.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Permissionless**: anyone may trigger the refund (the funds always go"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " to the sender), so abandoned intents cannot lock capital indefinitely."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reverts with [`StreamError::IntentExpired`]-style semantics via"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::IntentNotExpired`] if called too early, and with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::IntentNotPending`] if the intent is terminal."
    )]
    pub fn reclaim_expired(env: Env, intent_id: u64) -> Result<(), StreamError> {
        let mut intent = schedule::get_intent(&env, intent_id)?;
        if intent.status != IntentStatus::Pending {
            return Err(surface::reject(Branch::IntentNotPending));
        }
        let now = env.ledger().timestamp();
        if now < intent.expires_at {
            return Err(surface::reject(Branch::IntentNotExpired));
        }

        let refund = intent.remaining_escrow()?;

        // Effects first (CEI).
        intent.status = IntentStatus::Expired;
        schedule::put_intent(&env, &intent);

        if refund > 0 {
            #[cfg(test)]
            cei_trace::record("transfer scheduled refund");
            TokenClient::new(&env, &intent.token).transfer(
                &env.current_contract_address(),
                stream::muxed(&intent.sender),
                &refund,
            );
        }

        #[cfg(test)]
        cei_trace::record("event ScheduledIntentExpired");
        ScheduledIntentExpired {
            intent_id,
            sender: intent.sender.clone(),
            refund,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of a scheduled intent's full state."
    )]
    pub fn get_intent(env: Env, intent_id: u64) -> Result<ScheduledIntent, StreamError> {
        schedule::get_intent(&env, intent_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A page of scheduled-intent ids created by `sender`, in creation order."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Same pagination and advisory semantics as"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamingPayments::sender_streams`]."
    )]
    pub fn sender_intents(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::SenderIntents(sender), offset, limit)
    }

    // ------------------------------------------------------------ treasury --
    //
    // The optional protocol-fee layer: configuration (governor-gated),
    // governance withdrawal, and the open verification reads. Design and
    // invariants live in `treasury.rs`; the decision table for fees vs.
    // cancel refunds is in `docs/ARCHITECTURE.md`.

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Sets the protocol fee rate (basis points on each new stream's"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " deposit, charged once at creation). Governor-only. Reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::FeeRateTooHigh`] above [`MAX_FEE_BPS`] (the protocol"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cap) and with [`StreamError::NotGovernor`] for any other caller."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Changes apply only to streams created afterwards: fees are a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " property of the deposit boundary a stream actually crossed, never"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " retroactively.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Once the governance signer set is bootstrapped this path closes and the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " action must arrive as an executed proposal ([`StreamError::GovernanceTimelockRequired`])."
    )]
    pub fn set_fee_bps(env: Env, caller: Address, new_fee_bps: u32) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::apply_set_fee_bps(&env, new_fee_bps)
    }

    /// The effect half of [`Self::set_fee_bps`], shared with the governance
    /// dispatcher so a timelocked proposal and a direct call cannot drift apart.
    fn apply_set_fee_bps(env: &Env, new_fee_bps: u32) -> Result<(), StreamError> {
        if new_fee_bps > MAX_FEE_BPS {
            return Err(surface::reject(Branch::SetFeeRateTooHigh));
        }
        treasury::set_fee_bps(env, new_fee_bps);
        env.storage()
            .instance()
            .extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Nominates `new_governor` as the next treasury governor (governor-only,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " step 1 of a two-step rotation). Two steps mean a typo'd address can"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " never irreversibly strand the treasury: only an address that can"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " prove control (`accept_governor`) ever becomes governor."
    )]
    pub fn nominate_governor(
        env: Env,
        caller: Address,
        new_governor: Address,
    ) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::apply_nominate_governor(&env, new_governor)
    }

    fn apply_nominate_governor(env: &Env, new_governor: Address) -> Result<(), StreamError> {
        env.storage()
            .instance()
            .set(&stream::DataKey::PendingGovernor, &new_governor);
        env.storage()
            .instance()
            .extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Completes a governor rotation (step 2): the nominated address proves"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " control by authorizing this call and becomes the governor. Reverts"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " with [`StreamError::NoPendingGovernor`] when nothing is pending and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::NotGovernor`] for a caller who is not the nominee."
    )]
    pub fn accept_governor(env: Env, caller: Address) -> Result<(), StreamError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&stream::DataKey::PendingGovernor)
            .ok_or_else(|| surface::reject(Branch::AcceptGovernorNoPending))?;
        if pending != caller {
            return Err(surface::reject(Branch::AcceptGovernorNotNominee));
        }
        caller.require_auth();
        env.storage()
            .instance()
            .set(&stream::DataKey::Governor, &caller);
        env.storage()
            .instance()
            .remove(&stream::DataKey::PendingGovernor);
        env.storage()
            .instance()
            .extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Withdraws accumulated protocol fees for `token` to `recipient`."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Governor-only; bounded by fees collected minus fees already"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " withdrawn ([`StreamError::InsufficientTreasuryBalance`])."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Effects-interactions ordered: `FeeWithdrawn` is emitted and the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " accounting persisted *before* the token transfer. A token-side failure"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " to pay out returns [`StreamError::TreasuryPayoutFailed`], rolling the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " recorded withdrawal and the event back with it."
    )]
    pub fn withdraw_treasury(
        env: Env,
        caller: Address,
        token: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::apply_withdraw_treasury(&env, &caller, token, recipient, amount)
    }

    fn apply_withdraw_treasury(
        env: &Env,
        actor: &Address,
        token: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawTreasuryAmountNonPositive));
        }
        let mut t = treasury::get_treasury(env, &token);
        if amount > t.collectible()? {
            return Err(surface::reject(Branch::WithdrawTreasuryExceedsBalance));
        }

        // Effects (CEI): record the withdrawal and announce it before the
        // tokens move.
        t.withdrawn_total = t
            .withdrawn_total
            .checked_add(amount)
            .ok_or(StreamError::MathOverflow)?;
        treasury::put_treasury(env, &token, &t);

        #[cfg(test)]
        cei_trace::record("event FeeWithdrawn");
        FeeWithdrawn {
            token: token.clone(),
            governor: actor.clone(),
            recipient: recipient.clone(),
            amount,
            withdrawn_total: t.withdrawn_total,
        }
        .publish(env);

        // Interaction: a token-side failure maps to its own code and rolls
        // the recorded withdrawal and the `FeeWithdrawn` event back with it.
        push(
            env,
            &token,
            &stream::muxed(&recipient),
            amount,
            Branch::TreasuryPayoutFailed,
        )?;

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " One-call treasury snapshot for `token`: governor, pending nominee,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " current fee configuration, and the fee ledger totals that must"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " reconcile with the `FeeCharged` / `FeeWithdrawn` event streams."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " Public, read-only, no auth.")]
    pub fn treasury_status(env: Env, token: Address) -> TreasuryStatus {
        let t = treasury::get_treasury(&env, &token);
        let collectible = t.collectible().unwrap_or(0);
        TreasuryStatus {
            token,
            governor: treasury::governor(&env),
            pending_governor: treasury::pending_governor(&env),
            fee_bps: treasury::current_fee_bps(&env),
            max_fee_bps: MAX_FEE_BPS,
            charged_total: t.charged_total,
            withdrawn_total: t.withdrawn_total,
            collectible,
        }
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The protocol fee charged for `stream_id` at creation, in smallest"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " token units. Zero for streams created while fees were disabled (or"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " whose fee rounded to zero). Reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::StreamNotFound`] for unknown ids."
    )]
    pub fn stream_fee(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        stream::get_stream(&env, stream_id)?;
        Ok(treasury::stream_fee(&env, stream_id))
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " One bounded page of the fee verification scan: sums stored"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " per-stream fees for `token` over a window of the stream-id space"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " (`count` clamped to [`MAX_PAGE_SIZE`]). Page from id 1 until `done`"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is true; the summed `fees_in_range` values must equal"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `treasury_status(token).charged_total` — and both must equal the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " amounts in the contract's `FeeCharged` events. That three-way"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " equality is the treasury invariant, verifiable by anyone from"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " public reads alone (see `scripts/verify-fees.ts`)."
    )]
    pub fn verify_treasury(env: Env, token: Address, start_id: u64, count: u32) -> FeeScan {
        treasury::scan_fees(&env, &token, start_id, count)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Number of streams ever created (ids are `1..=total_streams()`)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Public convenience for verifiers to know the scan range."
    )]
    pub fn total_streams(env: Env) -> u64 {
        let next: u64 = env
            .storage()
            .persistent()
            .get(&stream::DataKey::NextStreamId)
            .unwrap_or(1);
        next.saturating_sub(1)
    }

    // ------------------------------------------------------- sponsorship ------
    // Thin delegators onto the `sponsor` module, which holds the budget ledger,
    // the replay/nonce bookkeeping, and the ed25519 inner-authorization checks.

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Registers (or reconfigures) a sponsor budget and its authorized operator"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " (relayer) key. See [`sponsor`].")]
    #[allow(clippy::too_many_arguments)] // mirrors sponsor::register_sponsor's surface
    pub fn register_sponsor(
        env: Env,
        sponsor: Address,
        token: Address,
        per_period_limit: i128,
        per_beneficiary_limit: i128,
        window_seconds: u64,
        operator_key: soroban_sdk::BytesN<32>,
    ) -> Result<(), StreamError> {
        sponsor::register_sponsor(
            env,
            sponsor,
            token,
            per_period_limit,
            per_beneficiary_limit,
            window_seconds,
            operator_key,
        )
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Pauses or resumes a sponsor's budget."
    )]
    pub fn set_sponsor_active(env: Env, sponsor: Address, active: bool) -> Result<(), StreamError> {
        sponsor::set_sponsor_active(env, sponsor, active)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Rotates a sponsor's authorized operator (relayer) key."
    )]
    pub fn rotate_operator_key(
        env: Env,
        sponsor: Address,
        new_operator_key: soroban_sdk::BytesN<32>,
    ) -> Result<(), StreamError> {
        sponsor::rotate_operator_key(env, sponsor, new_operator_key)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Binds (or rotates) a beneficiary's ed25519 consent key."
    )]
    pub fn enroll_beneficiary(
        env: Env,
        beneficiary: Address,
        public_key: soroban_sdk::BytesN<32>,
    ) -> Result<(), StreamError> {
        sponsor::enroll_beneficiary(env, beneficiary, public_key)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Relays a beneficiary's withdrawal with a sponsor absorbing the gas. See"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`sponsor`] for the inner-authorization and budget semantics."
    )]
    #[allow(clippy::too_many_arguments)] // the full relay surface is the intended client API
    pub fn sponsored_withdraw(
        env: Env,
        sponsor: Address,
        beneficiary: Address,
        stream_id: u64,
        amount: i128,
        nonce: u64,
        deadline: u64,
        operator_sig: soroban_sdk::BytesN<64>,
        beneficiary_sig: soroban_sdk::BytesN<64>,
    ) -> Result<(), StreamError> {
        sponsor::sponsored_withdraw(
            env,
            sponsor,
            beneficiary,
            stream_id,
            amount,
            nonce,
            deadline,
            operator_sig,
            beneficiary_sig,
        )
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reads a sponsor's budget configuration, if any."
    )]
    pub fn get_sponsor(env: Env, sponsor: Address) -> Option<sponsor::SponsorConfig> {
        sponsor::get_config(&env, &sponsor)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reads a beneficiary's enrolled consent key, if any."
    )]
    pub fn get_beneficiary_public_key(
        env: Env,
        beneficiary: Address,
    ) -> Option<soroban_sdk::BytesN<32>> {
        sponsor::get_beneficiary_key(&env, &beneficiary)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sponsor's current-window spend."
    )]
    pub fn sponsor_period_spend(env: Env, sponsor: Address) -> sponsor::PeriodSpend {
        sponsor::get_period(&env, &sponsor::SponsorKey::SponsorPeriod(sponsor))
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A beneficiary's spend within a sponsor's current window."
    )]
    pub fn beneficiary_spend(
        env: Env,
        sponsor: Address,
        beneficiary: Address,
    ) -> sponsor::PeriodSpend {
        sponsor::get_period(
            &env,
            &sponsor::SponsorKey::BeneficiarySpend(sponsor, beneficiary),
        )
    }
    // ------------------------------------------------------------- policy --
    //
    // The optional asset allowlist and governance layer: restricts which assets
    // may be streamed while guaranteeing existing streams remain withdrawable
    // and refundable (anti-brick). Features a two-step admin handoff, a timelock
    // on all allowlist mutations, and permissionless execution once matured.

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Initializes the policy module with `admin`. Callable once only; panics"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " if called again. Admin authorization is required."
    )]
    pub fn policy_init(env: Env, admin: Address) {
        policy::init(&env, &admin);
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Queues an allowlist mutation (adding or removing `asset`) with a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " timelock delay. Callable only by the current admin."
    )]
    pub fn policy_propose_asset(
        env: Env,
        asset: Address,
        allowed: bool,
    ) -> Result<(), StreamError> {
        policy::propose_asset(&env, asset, allowed)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Executes a queued asset allowlist change after the timelock has elapsed."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Callable by anyone: once a change has been vetted by the admin and the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " public timelock delay has expired, execution is permissionless so it"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cannot be stalled or held hostage by an absent admin."
    )]
    pub fn policy_execute_asset(env: Env, asset: Address) -> Result<(), StreamError> {
        policy::execute_asset(&env, asset)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposes a new admin for the two-step handoff (admin-only)."
    )]
    pub fn policy_propose_handoff(env: Env, new_admin: Address) -> Result<(), StreamError> {
        policy::propose_handoff(&env, new_admin)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Accepts the pending admin handoff. Callable only by the proposed new"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " admin, consuming their authorization and clearing the proposal."
    )]
    pub fn policy_accept_handoff(env: Env) -> Result<(), StreamError> {
        policy::accept_handoff(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancels a pending admin handoff (admin-only)."
    )]
    pub fn policy_cancel_handoff(env: Env) -> Result<(), StreamError> {
        policy::cancel_handoff(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the current policy admin, if initialized."
    )]
    pub fn policy_admin(env: Env) -> Option<Address> {
        policy::admin(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the pending policy admin nominee, if any."
    )]
    pub fn policy_pending_admin(env: Env) -> Option<Address> {
        policy::pending_admin(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the on-chain timelock delay in seconds."
    )]
    pub fn policy_timelock_delay(env: Env) -> u64 {
        policy::timelock_delay(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Sets the timelock delay in seconds (admin-only)."
    )]
    pub fn policy_set_timelock_delay(env: Env, delay: u64) -> Result<(), StreamError> {
        policy::set_timelock_delay(&env, delay)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only check whether `asset` is currently allowed for new streams."
    )]
    pub fn policy_is_asset_allowed(env: Env, asset: Address) -> bool {
        policy::is_asset_allowed(&env, &asset)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the queued allowlist change for `asset`, if any."
    )]
    pub fn policy_get_queued_asset(env: Env, asset: Address) -> Option<QueuedAssetChange> {
        policy::get_queued_asset(&env, &asset)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Sets governance policy floors and ceilings for streams of `token`, or global default if `token` is None."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " Governor-only.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Gated by the governance timelock once the signer set is bootstrapped: the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " action then arrives as `GovernanceAction::SetStreamPolicy` on an executed"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " proposal (see `governance.rs`).")]
    pub fn set_stream_policy(
        env: Env,
        caller: Address,
        token: Option<Address>,
        policy: StreamPolicy,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        policy::set_stream_policy(&env, token, policy)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Queries the effective stream policy for `token` (falling back to global policy if unset)."
    )]
    pub fn get_stream_policy(env: Env, token: Option<Address>) -> Option<StreamPolicy> {
        policy::get_stream_policy(&env, token)
    }

    // --------------------------------------------- upgrade & migration --

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns the current schema version of stored contract state."
    )]
    pub fn schema_version(env: Env) -> u32 {
        stream::schema_version(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns whether mutating contract operations are currently frozen."
    )]
    pub fn is_frozen(env: Env) -> bool {
        stream::is_frozen(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Sets the freeze state of the contract. Governor-only."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " When frozen, mutating stream entrypoints (create, withdraw, withdraw_max,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cancel, top_up) revert with [`StreamError::ContractFrozen`], but read views"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " remain accessible.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Freezing stays immediate even after governance is bootstrapped: a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " timelock that delays the break-glass is worse than no break-glass."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *Unfreezing* reopens the contract to activity, so it requires an executed"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " proposal.")]
    pub fn set_frozen(env: Env, caller: Address, frozen: bool) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        if !frozen {
            governance::require_direct_call(&env)?;
        }
        Self::apply_set_frozen(&env, &caller, frozen)
    }

    fn apply_set_frozen(env: &Env, actor: &Address, frozen: bool) -> Result<(), StreamError> {
        stream::set_frozen(env, frozen);

        ContractFrozenStateChanged {
            frozen,
            changed_by: actor.clone(),
        }
        .publish(env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposes a Wasm bytecode upgrade with an enforced timelock delay. Governor-only."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `delay_seconds` must be at least [`MIN_UPGRADE_DELAY_SECONDS`] (24 hours)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Overwrites any existing proposal."
    )]
    pub fn propose_upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
        delay_seconds: u64,
    ) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::apply_propose_upgrade(&env, &caller, new_wasm_hash, delay_seconds)
    }

    fn apply_propose_upgrade(
        env: &Env,
        actor: &Address,
        new_wasm_hash: BytesN<32>,
        delay_seconds: u64,
    ) -> Result<(), StreamError> {
        if delay_seconds < stream::MIN_UPGRADE_DELAY_SECONDS {
            return Err(surface::reject(Branch::UpgradeDelayTooShort));
        }
        let now = env.ledger().timestamp();
        let unlock_time = now
            .checked_add(delay_seconds)
            .ok_or(StreamError::MathOverflow)?;

        let pending = PendingUpgrade {
            new_wasm_hash: new_wasm_hash.clone(),
            unlock_time,
        };
        stream::set_pending_upgrade(env, &pending);

        UpgradeProposed {
            new_wasm_hash,
            unlock_time,
            proposer: actor.clone(),
        }
        .publish(env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Cancels a pending upgrade proposal. Governor-only."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reverts with [`StreamError::NoPendingUpgrade`] if no proposal is pending."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Like freezing, this is a risk-reducing action and so stays immediate: a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " maliciously proposed upgrade must be cancellable the second it is seen,"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " not two days later.")]
    pub fn cancel_upgrade(env: Env, caller: Address) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        let pending = stream::pending_upgrade(&env)
            .ok_or_else(|| surface::reject(Branch::CancelUpgradeNoPending))?;
        stream::remove_pending_upgrade(&env);

        UpgradeCancelled {
            new_wasm_hash: pending.new_wasm_hash,
            cancelled_by: caller,
        }
        .publish(&env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Executes a pending upgrade proposal once its timelock delay has elapsed. Governor-only."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Updates the contract executable via [`env.deployer().update_current_contract_wasm`]"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " and clears the pending upgrade.")]
    pub fn execute_upgrade(env: Env, caller: Address) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::apply_execute_upgrade(&env, &caller)
    }

    fn apply_execute_upgrade(env: &Env, actor: &Address) -> Result<(), StreamError> {
        let pending = stream::pending_upgrade(env)
            .ok_or_else(|| surface::reject(Branch::ExecuteUpgradeNoPending))?;
        let now = env.ledger().timestamp();
        if now < pending.unlock_time {
            return Err(surface::reject(Branch::TimelockNotExpired));
        }

        env.deployer()
            .update_current_contract(soroban_sdk::ContractExecutable::Wasm(
                pending.new_wasm_hash.clone(),
            ));
        stream::remove_pending_upgrade(env);

        ContractUpgraded {
            new_wasm_hash: pending.new_wasm_hash,
            executed_by: actor.clone(),
        }
        .publish(env);

        Ok(())
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only view of any pending upgrade proposal."
    )]
    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        stream::pending_upgrade(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Migrates a batch of streams from schema v1 to schema v2. Governor-only."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Requires the contract to be frozen ([`StreamError::ContractNotFrozen`])."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `count` is clamped to [`MAX_MIGRATION_BATCH_SIZE`] (50 streams per call)."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " If `start_id == 0`, migration resumes from `migration_cursor + 1`."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " When the cursor reaches `total_streams`, the schema version is bumped to v2."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Calling this after migration is complete reverts with [`StreamError::AlreadyMigrated`]."
    )]
    pub fn migrate_storage(
        env: Env,
        caller: Address,
        start_id: u64,
        count: u32,
    ) -> Result<MigrationStatus, StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::migrate_batch(env, start_id, count)
    }

    /// The migration itself, shared by the direct entry point and the governance
    /// dispatcher. Frozen-ness is a precondition of the *action*, not of the
    /// caller, so it lives here rather than in the wrapper.
    fn migrate_batch(env: Env, start_id: u64, count: u32) -> Result<MigrationStatus, StreamError> {
        if !stream::is_frozen(&env) {
            return Err(surface::reject(Branch::MigrationNotFrozen));
        }
        let current_version = stream::schema_version(&env);
        if current_version >= stream::TARGET_SCHEMA_VERSION {
            return Err(surface::reject(Branch::AlreadyMigrated));
        }

        let total = Self::total_streams(env.clone());
        let batch_size = count.clamp(1, stream::MAX_MIGRATION_BATCH_SIZE) as u64;

        if total == 0 {
            stream::set_schema_version(&env, stream::TARGET_SCHEMA_VERSION);
            stream::set_migration_cursor(&env, 0);

            StorageMigrated {
                from_version: current_version,
                to_version: stream::TARGET_SCHEMA_VERSION,
                start_id: 0,
                end_id: 0,
                is_complete: true,
            }
            .publish(&env);

            return Ok(MigrationStatus {
                current_version: stream::TARGET_SCHEMA_VERSION,
                target_version: stream::TARGET_SCHEMA_VERSION,
                cursor: 0,
                total_streams: 0,
                is_complete: true,
            });
        }

        let cursor = stream::migration_cursor(&env);
        let effective_start = if start_id == 0 {
            cursor.saturating_add(1)
        } else {
            start_id
        };
        let effective_start = effective_start.clamp(1, total);
        let end_id = (effective_start.saturating_add(batch_size).saturating_sub(1)).min(total);

        // Migrate each stream in the batch: read, backfill fields that were
        // added after the record was written, touch TTL, re-store.
        for id in effective_start..=end_id {
            if let Ok(mut s) = stream::get_stream(&env, id) {
                if s.use_oracle.is_none() {
                    s.use_oracle = Some(false);
                }
                stream::put_stream(&env, &s);
            }
        }

        let new_cursor = cursor.max(end_id);
        stream::set_migration_cursor(&env, new_cursor);
        let is_complete = new_cursor >= total;
        let new_version = if is_complete {
            stream::set_schema_version(&env, stream::TARGET_SCHEMA_VERSION);
            stream::TARGET_SCHEMA_VERSION
        } else {
            current_version
        };

        StorageMigrated {
            from_version: current_version,
            to_version: new_version,
            start_id: effective_start,
            end_id,
            is_complete,
        }
        .publish(&env);

        Ok(MigrationStatus {
            current_version: new_version,
            target_version: stream::TARGET_SCHEMA_VERSION,
            cursor: new_cursor,
            total_streams: total,
            is_complete,
        })
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Read-only snapshot of storage migration progress."
    )]
    pub fn migration_progress(env: Env) -> MigrationStatus {
        let current_version = stream::schema_version(&env);
        let cursor = stream::migration_cursor(&env);
        let total = Self::total_streams(env);
        let is_complete = current_version >= stream::TARGET_SCHEMA_VERSION;
        MigrationStatus {
            current_version,
            target_version: stream::TARGET_SCHEMA_VERSION,
            cursor,
            total_streams: total,
            is_complete,
        }
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The storage layout version of a single stream record."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `1` is the legacy untagged layout (a bare `Stream` map), `2` the"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " version-tagged [`VersionedStream`] every current write produces. Auditors"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " use this to answer \"what still needs moving?\" per stream without"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " decoding the record itself; see `scripts/migrate_audit.ts` for the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " off-chain walk.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Fails closed with [`StreamError::SchemaVersionUnsupported`] for a record"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " tagged with a layout this build does not understand, and with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::StreamNotFound`] when no record exists."
    )]
    pub fn stream_record_version(env: Env, stream_id: u64) -> Result<u32, StreamError> {
        stream::stream_record_version(&env, stream_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Re-encodes one stream record under [`CURRENT_STREAM_RECORD_VERSION`]."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Idempotent: running it twice is a no-op.** A record that already"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " carries the current layout is reported with `migrated == false` and is"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " not rewritten, so it emits no event and changes no storage byte. Repeat"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " calls are safe from any number of keepers racing on the same stream."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " **Permissionless**: unlike the governor-driven [`StreamingPayments::"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " migrate_storage`] batch, anyone may migrate a single record — it moves"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " no funds and touches no accounting field, only the encoding of a stream"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " whose decoded state is provably unchanged. It is also gas-bounded by"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " construction: exactly one stream record is read and (at most) one"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " rewritten per call, so callers never pay for somebody else's backlog."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Returns [`StreamError::StreamNotFound`] for an unknown id and"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::SchemaVersionUnsupported`] for a record this build cannot"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " decode (there is nothing to re-encode *from*, so refusing is the only"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " safe answer). Migration is refused while the contract is frozen, like"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " every other state-mutating entrypoint."
    )]
    pub fn migrate_stream_version(
        env: Env,
        stream_id: u64,
    ) -> Result<StreamVersionReport, StreamError> {
        Self::require_not_frozen(&env)?;
        let report = stream::migrate_stream_record(&env, stream_id)?;
        if report.migrated {
            #[cfg(test)]
            cei_trace::record("event StreamRecordMigrated");
            StreamRecordMigrated {
                stream_id,
                from_version: report.from_version,
                to_version: report.to_version,
            }
            .publish(&env);
        }
        Ok(report)
    }

    // ----------------------------------------------------------- oracle ----

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Configures the oracle publisher set, threshold, and staleness bound."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Authorized by the treasury governor."
    )]
    pub fn set_oracle_config(
        env: Env,
        caller: Address,
        publishers: Vec<Address>,
        threshold: u32,
        max_stale_seconds: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        treasury::require_governor(&env, &caller)?;
        governance::require_direct_call(&env)?;
        Self::apply_set_oracle_config(&env, publishers, threshold, max_stale_seconds)
    }

    fn apply_set_oracle_config(
        env: &Env,
        publishers: Vec<Address>,
        threshold: u32,
        max_stale_seconds: u64,
    ) -> Result<(), StreamError> {
        oracle::set_oracle_config(env, publishers, threshold, max_stale_seconds)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Records an authorized external time feed report."
    )]
    pub fn submit_oracle_time(
        env: Env,
        publisher: Address,
        timestamp: u64,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        oracle::submit_oracle_time(&env, publisher, timestamp)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Resolves reference timestamp for a given stream id and oracle flag."
    )]
    pub fn resolve_time(env: Env, stream_id: u64, use_oracle: bool) -> ResolvedTime {
        oracle::resolve_stream_time(&env, stream_id, use_oracle)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reads current oracle configuration."
    )]
    pub fn oracle_config(env: Env) -> Option<OracleConfig> {
        oracle::get_oracle_config(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reads latest report from a publisher."
    )]
    pub fn oracle_report(env: Env, publisher: Address) -> Option<OracleReport> {
        oracle::get_oracle_report(&env, publisher)
    }

    // -------------------------------------------------------- governance ---
    //
    // Issue #119: the two-key timelock that admin actions route through. The
    // design and the security argument live in `governance.rs`; these are the
    // surface.

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Establishes the governance signer set and its veto window. Governor-only,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " and one-time: after bootstrap the set can only change by executing a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `GovernanceAction::SetSigners` proposal, so no key can ever re-establish"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " governance over an existing one.")]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Until this is called every admin entry point behaves exactly as it did"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " before the timelock existed, which makes adoption an explicit, auditable"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " act rather than a side effect of a wasm upgrade."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reverts with [`StreamError::GovernanceDuplicateSigner`] when the set lists"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the same address twice and [`StreamError::GovernanceSignersNotDistinct`]"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " when it holds fewer than two distinct keys — the invariant is two"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " *independent* signatures, not two slots."
    )]
    pub fn governance_bootstrap(
        env: Env,
        caller: Address,
        signers: Vec<Address>,
        veto_window: u64,
    ) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        governance::bootstrap(&env, &caller, &signers, veto_window)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Proposes an admin action for the timelock. Signer-only; returns the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " proposal id.")]
    pub fn governance_propose(
        env: Env,
        caller: Address,
        action: GovernanceAction,
    ) -> Result<u64, StreamError> {
        governance::propose(&env, &caller, &action)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Adds the caller's signature to a proposal. Reverts with"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " [`StreamError::GovernanceDuplicateSignature`] if they already signed."
    )]
    pub fn governance_sign(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<u32, StreamError> {
        governance::sign(&env, &caller, proposal_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Vetoes a proposal while its window is open. One signer is enough: vetoing"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " removes risk, so it should never be the action that requires a quorum."
    )]
    pub fn governance_veto(env: Env, caller: Address, proposal_id: u64) -> Result<(), StreamError> {
        governance::veto(&env, &caller, proposal_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Applies a matured, multiply-signed proposal."
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = "")]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Permissionless on purpose: a proposal that only a particular keyholder"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " can submit is one that keyholder can suppress. `executor` is recorded in"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the audit trail but authorizes nothing — the authority is the two"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " signatures on the proposal.")]
    pub fn governance_execute(
        env: Env,
        executor: Address,
        proposal_id: u64,
    ) -> Result<(), StreamError> {
        let record = governance::ready(&env, proposal_id)?;
        // Effects before the action: the proposal is consumed first, so a
        // dispatch that fails partway rolls the flag back with it and a
        // successful one can never run twice.
        governance::mark_executed(&env, &record);
        // The proposer is always a signer, so they are the honest attribution
        // for the legacy events the action emits (`FeeWithdrawn.governor`,
        // `UpgradeProposed.proposer`, …). The full set of authorizing keys is on
        // the `GovernanceActionExecuted` event.
        let actor = record.proposed_by.clone();
        Self::apply_governance_action(&env, &actor, &record.action)?;
        governance::record_execution(&env, &record, &executor);
        Ok(())
    }

    /// Dispatches an executed proposal's action through the same helper the
    /// direct entry point uses, so the two paths cannot drift apart and the
    /// legacy audit trail is preserved unchanged.
    fn apply_governance_action(
        env: &Env,
        actor: &Address,
        action: &GovernanceAction,
    ) -> Result<(), StreamError> {
        match action {
            GovernanceAction::SetFeeBps(new_fee_bps) => Self::apply_set_fee_bps(env, *new_fee_bps),
            GovernanceAction::SetStreamPolicy(token, new_policy) => {
                policy::set_stream_policy(env, token.clone(), new_policy.clone())
            }
            GovernanceAction::SetFrozen(frozen) => Self::apply_set_frozen(env, actor, *frozen),
            GovernanceAction::WithdrawTreasury(token, recipient, amount) => {
                Self::apply_withdraw_treasury(env, actor, token.clone(), recipient.clone(), *amount)
            }
            GovernanceAction::NominateGovernor(next) => {
                Self::apply_nominate_governor(env, next.clone())
            }
            GovernanceAction::ProposeUpgrade(new_wasm_hash, delay_seconds) => {
                Self::apply_propose_upgrade(env, actor, new_wasm_hash.clone(), *delay_seconds)
            }
            GovernanceAction::ExecuteUpgrade => Self::apply_execute_upgrade(env, actor),
            GovernanceAction::MigrateStorage(start_id, count) => {
                Self::migrate_batch(env.clone(), *start_id, *count).map(|_| ())
            }
            GovernanceAction::SetOracleConfig(publishers, threshold, max_stale_seconds) => {
                Self::apply_set_oracle_config(
                    env,
                    publishers.clone(),
                    *threshold,
                    *max_stale_seconds,
                )
            }
            GovernanceAction::SetSigners(candidate) => {
                governance::apply_signer_set(env, candidate, actor)
            }
            GovernanceAction::SetVetoWindow(window) => {
                governance::apply_veto_window(env, *window, actor)
            }
        }
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Whether the timelock has taken over the admin entry points."
    )]
    pub fn governance_is_initialized(env: Env) -> bool {
        governance::is_initialized(&env)
    }

    #[cfg_attr(not(target_family = "wasm"), doc = " The current signer set.")]
    pub fn governance_signers(env: Env) -> Vec<Address> {
        governance::signers(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The configured veto window in seconds."
    )]
    pub fn governance_veto_window(env: Env) -> u64 {
        governance::veto_window(&env)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reads a proposal: its window, recorded signatures and terminal flags."
    )]
    pub fn governance_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        governance::proposal(&env, proposal_id)
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The next proposal id, for clients that want to follow the queue."
    )]
    pub fn governance_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&governance::GovernanceDataKey::ProposalCount)
            .unwrap_or(0)
    }
}
