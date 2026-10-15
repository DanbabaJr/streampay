//! Test-only client for the streaming payments contract.
//!
//! `#[contractimpl]` generates an exported client only when the impl lives
//! outside the defining crate, so for in-crate unit tests we declare the
//! contract's interface as a trait and generate a client from it with
//! `#[contractclient]`. The client still targets the real contract address
//! (`Client::new(&env, &streaming_contract_address)`), so it drives the actual
//! implementation without building Wasm.
#![cfg(test)]

use soroban_sdk::{contractclient, Address, Env, Vec};

use crate::{Stream, StreamError};

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
    fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError>;
    fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn pause_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError>;
    fn resume_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError>;
    fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError>;
    fn available(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64>;
    fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64>;
}
