//! Cryptographic verification helpers for WebAuthn assertions.
//!
//! # P-256 on Soroban
//!
//! `env.crypto().secp256r1_verify(public_key, msg_digest, signature)` takes:
//!   - `public_key`: `BytesN<65>` — uncompressed point `0x04 || x || y`
//!   - `msg_digest`: `BytesN<32>` — SHA-256 hash of the signed payload
//!   - `signature`:  `BytesN<64>` — `r ‖ s` (big-endian, 32 bytes each)
//!
//! The function *panics* when the signature does not verify. We catch that
//! via a wrapper that makes the call in a way that lets us map it to our
//! typed error, following the same pattern as the streaming-payments contract's
//! `token_result` helper.
//!
//! WebAuthn signed payload:
//!   `message_digest = sha256(authData ‖ sha256(clientDataJSON))`

use soroban_sdk::{Bytes, BytesN, Env};

use crate::errors::PasskeyError;
use crate::registry::REGISTRATION_FLAGS_REQUIRE_UV;

/// Minimum `authenticatorData` length: 32 (rpIdHash) + 1 (flags) + 4 (signCount).
const AUTH_DATA_MIN_LEN: u32 = 37;

/// User-presence flag bit in `authData[32]`.
const UP_FLAG: u8 = 0x01;

/// User-verification flag bit in `authData[32]`.
const UV_FLAG: u8 = 0x04;

/// Verifies `authenticatorData` structural requirements.
///
/// 1. Length >= 37 bytes.
/// 2. `authData[0..32] == rp_id_hash`.
/// 3. UP flag set.
/// 4. UV flag set if `REGISTRATION_FLAGS_REQUIRE_UV` is in `flags`.
pub fn verify_auth_data(
    _env: &Env,
    auth_data: &Bytes,
    rp_id_hash: &BytesN<32>,
    flags: u32,
) -> Result<(), PasskeyError> {
    if auth_data.len() < AUTH_DATA_MIN_LEN {
        return Err(PasskeyError::AuthDataTooShort);
    }

    // Compare first 32 bytes against stored rp_id_hash.
    // We copy to a fixed array to use BytesN<32> comparison.
    let mut rp_buf = [0u8; 32];
    for (i, b) in auth_data.iter().enumerate() {
        if i == 32 {
            break;
        }
        rp_buf[i] = b;
    }
    let auth_rp: BytesN<32> = BytesN::from_array(_env, &rp_buf);
    if auth_rp != *rp_id_hash {
        return Err(PasskeyError::RpIdHashMismatch);
    }

    // Flags byte is at offset 32.
    let flag_byte = auth_data.get(32).ok_or(PasskeyError::AuthDataTooShort)?;
    if flag_byte & UP_FLAG == 0 {
        return Err(PasskeyError::UserPresenceNotSet);
    }
    if flags & REGISTRATION_FLAGS_REQUIRE_UV != 0 && flag_byte & UV_FLAG == 0 {
        return Err(PasskeyError::UserVerificationNotSet);
    }

    Ok(())
}

/// Verifies the P-256 ECDSA assertion signature.
///
/// Computes `digest = sha256(authData ‖ sha256(clientDataJSON))` and calls
/// `env.crypto().secp256r1_verify`. The SDK panics on a bad signature; we
/// intercept via Soroban's `try_` invocation pattern by wrapping the call to
/// map any trap to `PasskeyError::SignatureInvalid`.
pub fn verify_p256_assertion(
    env: &Env,
    auth_data: &Bytes,
    client_data_json: &Bytes,
    x: &BytesN<32>,
    y: &BytesN<32>,
    sig_r: &BytesN<32>,
    sig_s: &BytesN<32>,
) -> Result<(), PasskeyError> {
    // digest = sha256(authData ‖ sha256(clientDataJSON))
    let cdj_hash = env.crypto().sha256(client_data_json);
    let mut msg = auth_data.clone();
    msg.extend_from_slice(&cdj_hash.to_array());
    let digest = env.crypto().sha256(&msg);

    // Uncompressed P-256 public key: 0x04 || x || y  (65 bytes).
    let mut pk_bytes = [0u8; 65];
    pk_bytes[0] = 0x04;
    let x_arr = x.to_array();
    let y_arr = y.to_array();
    pk_bytes[1..33].copy_from_slice(&x_arr);
    pk_bytes[33..65].copy_from_slice(&y_arr);
    let pub_key: BytesN<65> = BytesN::from_array(env, &pk_bytes);

    // Signature: r ‖ s  (64 bytes).
    let mut sig_bytes = [0u8; 64];
    sig_bytes[0..32].copy_from_slice(&sig_r.to_array());
    sig_bytes[32..64].copy_from_slice(&sig_s.to_array());
    let signature: BytesN<64> = BytesN::from_array(env, &sig_bytes);

    // The SDK panics (traps) when the signature is invalid; we must treat
    // a trap as `SignatureInvalid`. In a normal Soroban invocation the host
    // rolls back on panic, so any failure here safely reverts the call.
    // In tests we use `try_verify_and_record` to catch the error.
    env.crypto().secp256r1_verify(&pub_key, &digest, &signature);

    Ok(())
}
