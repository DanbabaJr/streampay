//! Test-only client for the streaming payments contract.
//!
//! `#[contractimpl]` generates an exported client only when the impl lives
//! outside the defining crate, so for in-crate unit tests we declare the
//! contract's interface as a trait and generate a client from it with
//! `#[contractclient]`. The client still targets the real contract address
//! (`Client::new(&env, &streaming_contract_address)`), so it drives the actual
//! implementation without building Wasm.
#![cfg(any(test, feature = "testutils"))]

use soroban_sdk::{contractclient, Address, BytesN, Env, Vec};

use crate::{
    BatchEntry, Dispute, FeeScan, GovernanceAction, MigrationStatus, PendingOwnership,
    PendingRateChange, PendingUpgrade, PeriodSpend, Proposal, RateSegment, ScheduledIntent,
    SponsorConfig, Stream, StreamError, StreamInput, StreamPolicy, TreasuryStatus,
};

/// Interface of the StreamPay streaming-payments contract.
#[contractclient(name = "StreamingPaymentsClient")]
#[allow(dead_code)] // generated client methods are used selectively per test
pub trait StreamingPaymentsApi {
    #[allow(clippy::too_many_arguments)] // mirrors the contract's 8-arg create_stream
    fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> Result<u64, StreamError>;
    #[allow(clippy::too_many_arguments)]
    fn create_stream_with_oracle(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        use_oracle: bool,
    ) -> Result<u64, StreamError>;
    fn create_streams(
        env: Env,
        sender: Address,
        inputs: Vec<StreamInput>,
    ) -> Result<Vec<u64>, StreamError>;
    fn create_streams_batch(
        env: Env,
        entries: Vec<BatchEntry>,
    ) -> Result<Vec<Result<u64, StreamError>>, StreamError>;

    fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError>;
    fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn raise_dispute(env: Env, stream_id: u64) -> Result<Dispute, StreamError>;
    fn resolve_dispute(
        env: Env,
        caller: Address,
        stream_id: u64,
        accept: bool,
    ) -> Result<(), StreamError>;
    fn expire_dispute(env: Env, stream_id: u64) -> Result<(), StreamError>;
    fn propose_ownership_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
        new_owner: Address,
    ) -> Result<(), StreamError>;
    fn accept_ownership_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
    ) -> Result<(), StreamError>;
    fn cancel_ownership_transfer(
        env: Env,
        caller: Address,
        stream_id: u64,
    ) -> Result<(), StreamError>;
    fn pending_ownership_transfer(env: Env, stream_id: u64) -> Option<PendingOwnership>;
    fn propose_rate_change(
        env: Env,
        caller: Address,
        stream_id: u64,
        amount_per_second: i128,
    ) -> Result<(), StreamError>;
    fn accept_rate_change(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError>;
    fn cancel_rate_change(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError>;
    fn pending_rate_change(env: Env, stream_id: u64) -> Option<PendingRateChange>;
    fn rate_segments(env: Env, stream_id: u64) -> Vec<RateSegment>;
    fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError>;
    fn get_dispute(env: Env, stream_id: u64) -> Result<Dispute, StreamError>;
    fn required_dispute_bond(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn available(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64>;
    fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64>;
    // ---------------------------------------------------------- treasury surface

    // --- scheduled intents ---
    #[allow(clippy::too_many_arguments)] // mirrors the contract's scheduling surface
    fn schedule_stream(
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
    ) -> Result<u64, StreamError>;
    fn execute_scheduled(env: Env, intent_id: u64, keeper: Address) -> Result<u64, StreamError>;
    fn cancel_scheduled(env: Env, sender: Address, intent_id: u64) -> Result<(), StreamError>;
    fn reclaim_expired(env: Env, intent_id: u64) -> Result<(), StreamError>;
    fn get_intent(env: Env, intent_id: u64) -> Result<ScheduledIntent, StreamError>;
    fn sender_intents(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64>;

    // --- treasury ---
    fn set_fee_bps(env: Env, caller: Address, new_fee_bps: u32) -> Result<(), StreamError>;
    fn nominate_governor(
        env: Env,
        caller: Address,
        new_governor: Address,
    ) -> Result<(), StreamError>;
    fn accept_governor(env: Env, caller: Address) -> Result<(), StreamError>;
    fn withdraw_treasury(
        env: Env,
        caller: Address,
        token: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), StreamError>;
    fn treasury_status(env: Env, token: Address) -> TreasuryStatus;
    fn stream_fee(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn verify_treasury(env: Env, token: Address, start_id: u64, count: u32) -> FeeScan;
    fn total_streams(env: Env) -> u64;

    // ------------------------------------------------------- sponsorship surface
    #[allow(clippy::too_many_arguments)] // mirrors the contract's 6-arg register_sponsor
    fn register_sponsor(
        env: Env,
        sponsor: Address,
        token: Address,
        per_period_limit: i128,
        per_beneficiary_limit: i128,
        window_seconds: u64,
        operator_key: BytesN<32>,
    ) -> Result<(), StreamError>;
    fn set_sponsor_active(env: Env, sponsor: Address, active: bool) -> Result<(), StreamError>;
    fn rotate_operator_key(
        env: Env,
        sponsor: Address,
        new_operator_key: BytesN<32>,
    ) -> Result<(), StreamError>;
    fn enroll_beneficiary(
        env: Env,
        beneficiary: Address,
        public_key: BytesN<32>,
    ) -> Result<(), StreamError>;
    #[allow(clippy::too_many_arguments)] // mirrors the contract's 8-arg sponsored_withdraw
    fn sponsored_withdraw(
        env: Env,
        sponsor: Address,
        beneficiary: Address,
        stream_id: u64,
        amount: i128,
        nonce: u64,
        deadline: u64,
        operator_sig: BytesN<64>,
        beneficiary_sig: BytesN<64>,
    ) -> Result<(), StreamError>;
    fn get_sponsor(env: Env, sponsor: Address) -> Option<SponsorConfig>;
    fn get_beneficiary_public_key(env: Env, beneficiary: Address) -> Option<BytesN<32>>;
    fn sponsor_period_spend(env: Env, sponsor: Address) -> PeriodSpend;
    fn beneficiary_spend(env: Env, sponsor: Address, beneficiary: Address) -> PeriodSpend;
    fn policy_init(env: Env, admin: Address);
    fn policy_propose_asset(env: Env, asset: Address, allowed: bool) -> Result<(), StreamError>;
    fn policy_execute_asset(env: Env, asset: Address) -> Result<(), StreamError>;
    fn policy_propose_handoff(env: Env, new_admin: Address) -> Result<(), StreamError>;
    fn policy_accept_handoff(env: Env) -> Result<(), StreamError>;
    fn policy_cancel_handoff(env: Env) -> Result<(), StreamError>;
    fn policy_admin(env: Env) -> Option<Address>;
    fn policy_pending_admin(env: Env) -> Option<Address>;
    fn policy_timelock_delay(env: Env) -> u64;
    fn policy_set_timelock_delay(env: Env, delay: u64) -> Result<(), StreamError>;
    fn policy_is_asset_allowed(env: Env, asset: Address) -> bool;
    fn policy_get_queued_asset(env: Env, asset: Address) -> Option<crate::QueuedAssetChange>;
    fn set_stream_policy(
        env: Env,
        caller: Address,
        token: Option<Address>,
        policy: StreamPolicy,
    ) -> Result<(), StreamError>;
    fn get_stream_policy(env: Env, token: Option<Address>) -> Option<StreamPolicy>;
    fn schema_version(env: Env) -> u32;
    fn is_frozen(env: Env) -> bool;
    fn set_frozen(env: Env, caller: Address, frozen: bool) -> Result<(), StreamError>;
    fn propose_upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
        delay_seconds: u64,
    ) -> Result<(), StreamError>;
    fn cancel_upgrade(env: Env, caller: Address) -> Result<(), StreamError>;
    fn execute_upgrade(env: Env, caller: Address) -> Result<(), StreamError>;
    fn pending_upgrade(env: Env) -> Option<PendingUpgrade>;
    fn migrate_storage(
        env: Env,
        caller: Address,
        start_id: u64,
        count: u32,
    ) -> Result<MigrationStatus, StreamError>;
    fn migration_progress(env: Env) -> MigrationStatus;
    fn set_oracle_config(
        env: Env,
        caller: Address,
        publishers: Vec<Address>,
        threshold: u32,
        max_stale_seconds: u64,
    ) -> Result<(), StreamError>;
    fn submit_oracle_time(env: Env, publisher: Address, timestamp: u64) -> Result<(), StreamError>;
    fn resolve_time(env: Env, stream_id: u64, use_oracle: bool) -> crate::ResolvedTime;
    fn oracle_config(env: Env) -> Option<crate::OracleConfig>;
    fn oracle_report(env: Env, publisher: Address) -> Option<crate::OracleReport>;

    // ------------------------------------------------------- governance surface
    fn governance_bootstrap(
        env: Env,
        caller: Address,
        signers: Vec<Address>,
        veto_window: u64,
    ) -> Result<(), StreamError>;
    fn governance_propose(
        env: Env,
        caller: Address,
        action: GovernanceAction,
    ) -> Result<u64, StreamError>;
    fn governance_sign(env: Env, caller: Address, proposal_id: u64) -> Result<u32, StreamError>;
    fn governance_veto(env: Env, caller: Address, proposal_id: u64) -> Result<(), StreamError>;
    fn governance_execute(env: Env, executor: Address, proposal_id: u64)
        -> Result<(), StreamError>;
    fn governance_is_initialized(env: Env) -> bool;
    fn governance_signers(env: Env) -> Vec<Address>;
    fn governance_veto_window(env: Env) -> u64;
    fn governance_proposal(env: Env, proposal_id: u64) -> Option<Proposal>;
    fn governance_proposal_count(env: Env) -> u64;
}
