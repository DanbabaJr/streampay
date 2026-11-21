//! Fuzz target for the passkey-signer clientDataJSON and authenticatorData
//! parsers. Feeds arbitrary bytes to both paths and asserts no panic — every
//! rejection must be a typed PasskeyError.
//!
//! Run locally:
//!
//! ```sh
//! cargo +nightly install cargo-fuzz   # once
//! cd fuzz
//! cargo fuzz run passkey_cbor -- -max_total_time=60
//! ```

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{Bytes, BytesN, Env};
use streampay_passkey::fuzz_helpers;

fuzz_target!(|input: (Vec<u8>, Vec<u8>, [u8; 32])| {
    let (auth_bytes, cdj_bytes, challenge_arr) = input;

    let env = Env::default();

    let auth_data = Bytes::from_slice(&env, &auth_bytes);
    let cdj = Bytes::from_slice(&env, &cdj_bytes);
    let challenge: BytesN<32> = BytesN::from_array(&env, &challenge_arr);
    let rp_id_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);

    // Both calls must return Ok or a typed error — never panic.
    let _ = fuzz_helpers::verify_auth_data(&env, &auth_data, &rp_id_hash, 0);
    let _ = fuzz_helpers::verify_client_data_json(&env, &cdj, &challenge);
});
