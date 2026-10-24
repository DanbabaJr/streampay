//! Events emitted by StreamPay.
//!
//! Per-stream events are keyed by `stream_id`; `StreamsCreated` is keyed by
//! sender and carries the batch ids. Non-topic fields are event data.

use soroban_sdk::{contractevent, Address, BytesN, String, Vec};

use crate::stream::OwnershipRole;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a new stream is created and its deposit pulled in."
)]
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

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted once after an atomic batch creates its streams."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamsCreated {
    #[topic]
    pub sender: Address,
    pub stream_ids: Vec<u64>,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the recipient withdraws accrued funds."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total withdrawn from the stream after this withdrawal."
    )]
    pub withdrawn_total: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a stream is cancelled. The recipient's accrued balance and"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the sender's refund are both paid atomically in the same transaction."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelled {
    #[topic]
    pub stream_id: u64,
    pub cancelled_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Amount paid out to the recipient at cancellation."
    )]
    pub recipient_amount: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Amount refunded to the sender at cancellation."
    )]
    pub sender_amount: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the sender adds funds to an existing stream."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamToppedUp {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub amount: i128,
    #[cfg_attr(not(target_family = "wasm"), doc = " Stream deposit after the top-up.")]
    pub new_deposit: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a party attaches a hash-linked metadata attestation to a"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " stream. Append-only: this event is the durable record that"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `attester` claimed `content_hash` (tagged `tag`) at `timestamp`."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataAttached {
    #[topic]
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Position of the attestation in the stream's append-only list."
    )]
    pub index: u32,
    pub attester: Address,
    pub content_hash: BytesN<32>,
    pub tag: String,
    pub timestamp: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a sender pre-authorizes a future (optionally recurring)"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " stream creation and escrows the deposit plus keeper fee budget."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamScheduled {
    #[topic]
    pub intent_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Deposit escrowed for *each* occurrence."
    )]
    pub deposit: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Scheduled start of the first occurrence (later occurrences are shifted"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " by `interval`).")]
    pub start_time: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Scheduled end of the first occurrence."
    )]
    pub end_time: u64,
    pub cancelable: bool,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Seconds between occurrence starts; `0` for a one-shot intent."
    )]
    pub interval: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total number of streams this intent will create."
    )]
    pub occurrences: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Keeper fee escrowed for *each* occurrence."
    )]
    pub fee_budget: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Earliest time the first occurrence may be executed."
    )]
    pub execute_after: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " After this time no occurrence may be executed; the escrow is reclaimable."
    )]
    pub expires_at: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a keeper executes one occurrence of a scheduled intent,"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " creating the stream and paying itself the escrowed per-occurrence fee."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledStreamExecuted {
    #[topic]
    pub intent_id: u64,
    pub keeper: Address,
    #[cfg_attr(not(target_family = "wasm"), doc = " The newly created stream id.")]
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Zero-based index of the occurrence just executed."
    )]
    pub occurrence_index: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Occurrences still outstanding after this execution."
    )]
    pub occurrences_remaining: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Fee paid to the keeper for this execution."
    )]
    pub fee_paid: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a sender cancels a not-yet-executable intent and is refunded"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the escrow for all outstanding occurrences."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledIntentCancelled {
    #[topic]
    pub intent_id: u64,
    pub sender: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total refunded (deposit + fee budget for every outstanding occurrence)."
    )]
    pub refund: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when an intent passed `expires_at` with occurrences outstanding and"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " its escrow was returned to the sender."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledIntentExpired {
    #[topic]
    pub intent_id: u64,
    pub sender: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total refunded for the outstanding occurrences."
    )]
    pub refund: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted exactly once per funded stream that owes a protocol fee, in the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " same transaction as (and immediately after) `StreamCreated`. Keyed by"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `stream_id` so fee history is auditable per stream; the stream's stored"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " fee (`stream_fee` read) and the token's `treasury_status` totals must"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " always reconcile with the sum of these events — that reconciliation is"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the treasury invariant, checkable by anyone via `verify_treasury` and"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " `scripts/verify-fees.ts`.")]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeCharged {
    #[topic]
    pub stream_id: u64,
    pub token: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sender who paid the fee on top of the deposit."
    )]
    pub payer: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Fee amount in smallest token units (deposit * fee_bps / 10_000, floored)."
    )]
    pub amount: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The fee rate in basis points that produced this amount."
    )]
    pub fee_bps: u32,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the treasury governor withdraws accumulated protocol fees for"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " one token. Keyed by `token` (treasury accounting is per token);"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `withdrawn_total` carries the cumulative withdrawn amount so event"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " consumers can reconcile against `treasury_status` without reading state."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeWithdrawn {
    #[topic]
    pub token: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The governor who authorized the withdrawal."
    )]
    pub governor: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Where the withdrawn fees were sent."
    )]
    pub recipient: Address,
    pub amount: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total fees withdrawn for this token after this withdrawal."
    )]
    pub withdrawn_total: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the recipient raises a dispute, freezing the stream's"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " cancel/top-up mutations until resolution or expiry. The bond (stream"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " token, held by the contract) accompanies the flag."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRaised {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Bond pulled into the contract for the duration of the dispute."
    )]
    pub bond: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " First ledger timestamp at which the dispute can be expired."
    )]
    pub expires_at: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the sender resolves an open dispute. `accept = true`"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " refunds the bond to the recipient and unwinds the stream pro-rata"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " (a `StreamCancelled` event accompanies it); `accept = false` treats the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " dispute as bad-faith and slashes the bond to the sender, resuming the"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " stream normally.")]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Whether the sender accepted the dispute as legitimate."
    )]
    pub accept: bool,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The bond at stake (paid to the recipient on accept, slashed to the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " sender otherwise).")]
    pub bond: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a dispute's timelock expires without a verdict: the stream"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " resumes and the bond is split, `sender_share` rounding up."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeExpired {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub bond: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Half of the bond (rounded up) paid to the sender as compensation for"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " the frozen window.")]
    pub sender_share: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The remainder of the bond refunded to the recipient."
    )]
    pub recipient_share: i128,
}
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a sponsor registers (or reconfigures) a gas-sponsorship"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " budget. Keyed by the sponsor address; the `registered` symbol lets indexers"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " separate budget setup from sponsored claims."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SponsorRegistered {
    #[topic]
    pub sponsor: Address,
    #[topic]
    pub kind: soroban_sdk::Symbol,
    pub token: Address,
    pub per_period_limit: i128,
    pub per_beneficiary_limit: i128,
    pub window_seconds: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a sponsor pauses or resumes its budget."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SponsorActiveSet {
    #[topic]
    pub sponsor: Address,
    #[topic]
    pub kind: soroban_sdk::Symbol,
    pub active: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a beneficiary binds an ed25519 consent key, and again whenever"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " they rotate it. Keyed by the beneficiary address."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BeneficiaryEnrolled {
    #[topic]
    pub beneficiary: Address,
    #[topic]
    pub kind: soroban_sdk::Symbol,
    pub public_key: BytesN<32>,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a sponsor rotates its authorized operator (relayer) key. The"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " previous operator key stops validating relay signatures immediately."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorKeyRotated {
    #[topic]
    pub sponsor: Address,
    #[topic]
    pub kind: soroban_sdk::Symbol,
    pub new_operator_key: BytesN<32>,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a claim is sponsored and paid out: the operator relayed the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " beneficiary's withdrawal and the sponsor's budget absorbed the gas. The"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " payout still flows from the stream, exactly as in an unsponsored withdraw."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SponsorClaim {
    #[topic]
    pub sponsor: Address,
    #[topic]
    pub kind: soroban_sdk::Symbol,
    #[topic]
    pub stream_id: u64,
    pub beneficiary: Address,
    pub amount: i128,
    pub nonce: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the policy module is initialized with its initial admin."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyInitialized {
    pub admin: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when an asset allowlist mutation is proposed and queued under timelock."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyAssetQueued {
    #[topic]
    pub asset: Address,
    pub allowed: bool,
    pub executable_after: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a queued asset allowlist change is executed after timelock expiry."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyAssetExecuted {
    #[topic]
    pub asset: Address,
    pub allowed: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the admin proposes a new admin in step 1 of the two-step handoff."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyHandoffProposed {
    #[topic]
    pub current_admin: Address,
    pub proposed_admin: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the proposed admin accepts the handoff in step 2."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyHandoffAccepted {
    #[topic]
    pub new_admin: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a pending admin handoff is cancelled by the current admin."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyHandoffCancelled {
    #[topic]
    pub proposed_admin: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a contract upgrade is proposed with a timelock delay."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposed {
    #[topic]
    pub new_wasm_hash: BytesN<32>,
    pub unlock_time: u64,
    pub proposer: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a pending contract upgrade is cancelled by the governor."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeCancelled {
    #[topic]
    pub new_wasm_hash: BytesN<32>,
    pub cancelled_by: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a contract upgrade is executed after its timelock has elapsed."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUpgraded {
    #[topic]
    pub new_wasm_hash: BytesN<32>,
    pub executed_by: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the contract freeze state is toggled by the governor."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractFrozenStateChanged {
    #[topic]
    pub frozen: bool,
    pub changed_by: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a batch of streams is migrated to a new storage schema version."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageMigrated {
    #[topic]
    pub from_version: u32,
    #[topic]
    pub to_version: u32,
    pub start_id: u64,
    pub end_id: u64,
    pub is_complete: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a stream policy floor/ceiling configuration is updated."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamPolicySet {
    pub token: Option<Address>,
    pub old_policy: Option<crate::policy::StreamPolicy>,
    pub new_policy: crate::policy::StreamPolicy,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the oracle configuration is updated by governance."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfigUpdated {
    pub threshold: u32,
    pub max_stale_seconds: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when an authorized oracle publisher reports a reference timestamp."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleTimeReported {
    #[topic]
    pub publisher: Address,
    pub reported_time: u64,
    pub ledger_time: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when oracle time resolution falls back to native ledger time due to"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " stale feed, insufficient reports, or unconfigured registry."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleStaleFallback {
    #[topic]
    pub stream_id: u64,
    pub ledger_time: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a current sender or recipient proposes handing their role to a"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " new address. The handoff takes effect only when the target accepts."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipProposed {
    #[topic]
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The current role holder (must be the stream's sender or recipient)."
    )]
    pub current_owner: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Address that must accept before the role moves."
    )]
    pub new_owner: Address,
    pub role: OwnershipRole,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the proposal is stale."
    )]
    pub expires_at: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a proposed ownership handoff is accepted by its target. The"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " stream's accounting fields (`deposit`, `withdrawn`, time window) are"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " unchanged; only the role address moves."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipAccepted {
    #[topic]
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The role holder before the transfer."
    )]
    pub previous_owner: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The new role holder (the accepting address)."
    )]
    pub new_owner: Address,
    pub role: OwnershipRole,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the sender or recipient proposes a new streaming rate. The"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " change takes effect only when the counterparty accepts, and only from the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " moment of acceptance: nothing accrues differently before it, and the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `RateChangeAccepted` event that follows carries the settled amounts."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateChangeProposed {
    #[topic]
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The proposing party (the stream's sender or recipient)."
    )]
    pub proposed_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The party whose acceptance the change requires."
    )]
    pub counterparty: Address,
    pub amount_per_second: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the proposal is stale."
    )]
    pub expires_at: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a pending rate change is accepted and its rebalancing settles."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The four amounts are the whole funds-bug audit trail for one change, and"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " they are exact by construction: `reserved_at_new_rate` is an integer product"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " (`new_amount_per_second * window length`) and `deposit` is"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `owed_at_change + reserved_at_new_rate`. `adjustment` is the signed"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " difference against the deposit before the change — positive means the sender"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " topped up that amount, negative means the sender was refunded its absolute"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " value, zero means the old reserve still covered the new rate exactly."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateChangeAccepted {
    #[topic]
    pub stream_id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The accepting counterparty (the address that authorized the change)."
    )]
    pub accepted_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Rate in effect from `effective_from` (inclusive) to the stream's"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `end_time`; the rate the proposal committed to."
    )]
    pub new_amount_per_second: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " First timestamp accrued at the new rate."
    )]
    pub effective_from: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Accrued at `effective_from` under the previous schedule. The change"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " cannot alter this amount — that is the property the segment split keeps."
    )]
    pub owed_at_change: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Reserved for `[effective_from, end_time)` at the new rate."
    )]
    pub reserved_at_new_rate: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Funds moved to settle the change (see the struct docs)."
    )]
    pub adjustment: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Stream deposit after the adjustment; equals"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `owed_at_change + reserved_at_new_rate`."
    )]
    pub deposit: i128,
}

// --------------------------------------------------------------- governance --
//
// The lifecycle of a timelocked admin action (issue #119). These events wrap the
// action's own legacy event rather than replacing it: `FeeWithdrawn`,
// `UpgradeProposed` and friends still fire from the same helper they always
// fired from, so an indexer built before the timelock keeps reading the same
// trail and simply gains the proposal id alongside it.

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when the signer set is established or rotated, and when the veto"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " window changes. The set is emitted in full because \"which keys govern this"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " contract\" is only auditable from the transcript, not from a delta."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceSignersSet {
    #[topic]
    pub set_by: Address,
    pub signers: Vec<Address>,
    pub veto_window: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a signer proposes an admin action. `executable_at` is the end of"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the veto window: from that timestamp the proposal is executable by anyone and"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " is never voided by time.")]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceActionProposed {
    #[topic]
    pub proposal_id: u64,
    pub proposed_by: Address,
    pub executable_at: u64,
    pub action: crate::governance::GovernanceAction,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted for each distinct signature. A second signature from an address that"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " already signed is refused before this event can fire, so `signature_count`"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " here is always a count of distinct keys."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceActionSigned {
    #[topic]
    pub proposal_id: u64,
    pub signer: Address,
    pub signature_count: u32,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a signer vetoes a proposal inside its veto window."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceActionVetoed {
    #[topic]
    pub proposal_id: u64,
    pub vetoed_by: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Emitted when a matured, multiply-signed proposal is applied. `executed_by` is"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " whoever submitted the transaction — execution is permissionless — while"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `signers` names the keys that actually authorized it."
)]
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceActionExecuted {
    #[topic]
    pub proposal_id: u64,
    pub action: crate::governance::GovernanceAction,
    pub signers: Vec<Address>,
    pub executed_by: Address,
}
