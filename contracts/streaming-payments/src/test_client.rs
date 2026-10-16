//! Test-only client for the streaming payments contract.
//!
//! `#[contractimpl]` generates an exported client only when the impl lives
//! outside the defining crate, so for in-crate unit tests we declare the
//! contract's interface as a trait and generate a client from it with
//! `#[contractclient]`. The client still targets the real contract address
//! (`Client::new(&env, &streaming_contract_address)`), so it drives the actual
//! implementation without building Wasm.
#![cfg(test)]

use soroban_sdk::{contractclient, Address, BytesN, Env, String, Vec};

use crate::{
    Attestation, AttestationRef, FeeScan, Stream, StreamError, StreamInput, TreasuryStatus,
};
use crate::{FeeScan, ScheduledIntent, Stream, StreamError, StreamInput, TreasuryStatus};

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
    fn create_streams(
        env: Env,
        sender: Address,
        inputs: Vec<StreamInput>,
    ) -> Result<Vec<u64>, StreamError>;
    fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError>;
    fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError>;
    fn available(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64>;
    fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64>;
    fn attach_metadata(
        env: Env,
        attester: Address,
        stream_id: u64,
        content_hash: BytesN<32>,
        tag: String,
    ) -> Result<u32, StreamError>;
    fn stream_attestations(env: Env, stream_id: u64, offset: u32, limit: u32) -> Vec<Attestation>;
    fn attestation_count(env: Env, stream_id: u64) -> u32;
    fn party_attestations(env: Env, party: Address, offset: u32, limit: u32)
        -> Vec<AttestationRef>;

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
}
