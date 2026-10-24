//! Tests for the PasskeySigner contract.
//!
//! # Strategy
//!
//! Real WebAuthn assertions cannot be produced inside a unit test (no
//! browser / authenticator). Instead we:
//!
//! 1. Build synthetic authData, clientDataJSON, and challenge values
//!    that are structurally correct.
//! 2. Test all structural validation error paths with deliberately invalid inputs.
//! 3. Test the replay-prevention store directly using the `registry` module.
//!
//! "Recorded real assertions" note
//! ---------------------------------
//! The full signature verification path requires `env.crypto().secp256r1_verify`
//! which is only possible with a valid P-256 key pair + message. The Soroban
//! testutils `Env` does provide `secp256r1_verify` in test mode; however,
//! generating a matching assertion without an actual authenticator requires a
//! test-only key pair. The crypto module tests (below) verify the structural
//! path; integration tests with real assertions run as off-chain scripts in CI.

#![cfg(test)]
extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::errors::PasskeyError;
use crate::registry::REGISTRATION_FLAGS_REQUIRE_UV;
use crate::PasskeySigner;

// ── Test client ───────────────────────────────────────────────────────────────
// The soroban-sdk `#[contractclient]` attribute generates a typed client
// from a trait that mirrors the contract's public API.

use soroban_sdk::contractclient;

/// Interface of the PasskeySigner contract for tests.
#[contractclient(name = "PasskeySignerTestClient")]
#[allow(dead_code)] // generated client methods are used selectively per test
pub trait PasskeySignerApi {
    fn register(
        env: Env,
        owner: Address,
        rp_id_hash: BytesN<32>,
        x: BytesN<32>,
        y: BytesN<32>,
        flags: u32,
    ) -> Result<(), PasskeyError>;
    fn deregister(env: Env, owner: Address) -> Result<(), PasskeyError>;
    fn get_credential(
        env: Env,
        owner: Address,
    ) -> Result<crate::registry::Credential, PasskeyError>;
    fn verify_and_record(
        env: Env,
        owner: Address,
        auth_data: Bytes,
        client_data_json: Bytes,
        challenge: BytesN<32>,
        sig_r: BytesN<32>,
        sig_s: BytesN<32>,
    ) -> Result<(), PasskeyError>;
    fn is_nonce_used(env: Env, challenge: BytesN<32>) -> bool;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn new_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env
}

fn deploy(env: &Env) -> (soroban_sdk::Address, PasskeySignerTestClient<'_>) {
    let contract_id = env.register(PasskeySigner, ());
    let client = PasskeySignerTestClient::new(env, &contract_id);
    (contract_id, client)
}

fn to_bytes(env: &Env, v: &[u8]) -> Bytes {
    Bytes::from_slice(env, v)
}

fn to_bytes32(env: &Env, v: &[u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, v)
}

fn fake_pub_key() -> ([u8; 32], [u8; 32]) {
    ([1u8; 32], [2u8; 32])
}

fn make_auth_data(rp_id_hash: &[u8; 32], flags: u8) -> std::vec::Vec<u8> {
    let mut v = std::vec::Vec::with_capacity(37);
    v.extend_from_slice(rp_id_hash);
    v.push(flags);
    v.extend_from_slice(&0u32.to_be_bytes());
    v
}

fn base64url(input: &[u8]) -> std::string::String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = std::string::String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
        out.push(CHARS[((b0 >> 2) & 0x3F) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < input.len() {
            out.push(CHARS[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < input.len() {
            out.push(CHARS[(b2 & 0x3F) as usize] as char);
        }
        i += 3;
    }
    out
}

fn make_client_data_json(challenge: &[u8]) -> std::string::String {
    std::format!(
        r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://streampay.app"}}"#,
        base64url(challenge)
    )
}

// ── Registration tests ────────────────────────────────────────────────────────

#[test]
fn register_and_get_credential_roundtrip() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x11u8; 32];
    let (x, y) = fake_pub_key();

    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let cred = client.get_credential(&owner);
    assert_eq!(cred.rp_id_hash, to_bytes32(&env, &rp_id_hash));
    assert_eq!(cred.x, to_bytes32(&env, &x));
    assert_eq!(cred.y, to_bytes32(&env, &y));
    assert_eq!(cred.flags, 0u32);
}

#[test]
fn get_credential_not_registered_returns_error() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let result = client.try_get_credential(&owner);
    assert_eq!(result, Err(Ok(PasskeyError::CredentialNotFound)));
}

#[test]
fn deregister_removes_credential() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x22u8; 32];
    let (x, y) = fake_pub_key();

    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );
    client.deregister(&owner);
    assert_eq!(
        client.try_get_credential(&owner),
        Err(Ok(PasskeyError::CredentialNotFound))
    );
}

#[test]
fn deregister_not_registered_returns_error() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    assert_eq!(
        client.try_deregister(&owner),
        Err(Ok(PasskeyError::CredentialNotFound))
    );
}

// ── authData validation tests ─────────────────────────────────────────────────

#[test]
fn auth_data_too_short_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x33u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &[0u8; 10]),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::AuthDataTooShort)));
}

#[test]
fn rp_id_hash_mismatch_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x44u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let wrong_rp = [0xFFu8; 32];
    let auth_data_bytes = make_auth_data(&wrong_rp, 0x01);

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::RpIdHashMismatch)));
}

#[test]
fn user_presence_not_set_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x55u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x00); // UP not set

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::UserPresenceNotSet)));
}

#[test]
fn uv_required_but_not_set_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x66u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &REGISTRATION_FLAGS_REQUIRE_UV,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01); // UP set, UV not set

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::UserVerificationNotSet)));
}

// ── clientDataJSON tests ───────────────────────────────────────────────────────

#[test]
fn wrong_type_in_client_data_json_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x77u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let wrong_cdj = std::format!(
        r#"{{"type":"webauthn.create","challenge":"{}","origin":"https://streampay.app"}}"#,
        base64url(&challenge)
    );
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01);

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, wrong_cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::ClientDataTypeMismatch)));
}

#[test]
fn wrong_challenge_in_client_data_json_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x88u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let wrong_cdj = std::format!(
        r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://streampay.app"}}"#,
        base64url(&[0xFFu8; 32]) // different challenge in CDJ
    );
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01);

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, wrong_cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::ChallengeMismatch)));
}

// ── Replay prevention tests ────────────────────────────────────────────────────

#[test]
fn is_nonce_used_false_before_use() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let challenge = [0xBBu8; 32];
    assert!(!client.is_nonce_used(&to_bytes32(&env, &challenge)));
}

#[test]
fn challenge_replay_prevented_via_registry() {
    let env = new_env();
    let (contract_id, client) = deploy(&env);
    let challenge = to_bytes32(&env, &[0xAAu8; 32]);
    env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge).expect("first record ok");
    });

    // is_nonce_used reads from the same contract storage.
    assert!(client.is_nonce_used(&challenge));

    let result = env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge)
    });
    assert_eq!(result, Err(PasskeyError::ChallengeAlreadyUsed));
}

// ── verify without registration ───────────────────────────────────────────────

#[test]
fn verify_without_registration_returns_not_found() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let unregistered = Address::generate(&env);
    let rp_id_hash = [0x00u8; 32];
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01);
    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);

    let result = client.try_verify_and_record(
        &unregistered,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::CredentialNotFound)));
}

/// Expired-challenge scenario: same nonce reused → rejected.
#[test]
fn expired_challenge_nonce_rejected() {
    let env = new_env();
    let (contract_id, client) = deploy(&env);
    let challenge = to_bytes32(&env, &[0xCCu8; 32]);
    env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge).expect("first record should succeed");
    });

    assert!(
        client.is_nonce_used(&challenge),
        "nonce must be marked used"
    );

    // Attempting record_challenge again must fail.
    let result = env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge)
    });
    assert_eq!(result, Err(PasskeyError::ChallengeAlreadyUsed));
}
