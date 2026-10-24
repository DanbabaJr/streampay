//! Credential registry: persistent storage of P-256 public keys and used challenge nonces.

use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::PasskeyError;

/// Require user verification on every assertion.
pub const REGISTRATION_FLAGS_REQUIRE_UV: u32 = 0x01;

// TTL constants (mirrors streaming-payments contract).
const TTL_THRESHOLD: u32 = 200_000;
const TTL_EXTEND: u32 = 500_000;

/// A registered passkey credential for one Stellar address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credential {
    /// sha256 of the Relying Party ID string (e.g. `sha256("streampay.app")`).
    pub rp_id_hash: BytesN<32>,
    /// P-256 public key x-coordinate (32 bytes, big-endian).
    pub x: BytesN<32>,
    /// P-256 public key y-coordinate (32 bytes, big-endian).
    pub y: BytesN<32>,
    /// Registration flags bitmask (see `REGISTRATION_FLAGS_*` constants).
    pub flags: u32,
}

/// Storage keys for the registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryKey {
    /// Stored credential for an owner address.
    Credential(Address),
    /// Used challenge nonce (value is `true` when present).
    UsedChallenge(BytesN<32>),
}

/// Stores a credential and extends its TTL.
pub fn put_credential(env: &Env, owner: &Address, cred: &Credential) {
    let key = RegistryKey::Credential(owner.clone());
    env.storage().persistent().set(&key, cred);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

/// Loads a credential, returning `CredentialNotFound` if absent.
pub fn get_credential(env: &Env, owner: &Address) -> Result<Credential, PasskeyError> {
    let key = RegistryKey::Credential(owner.clone());
    let cred: Option<Credential> = env.storage().persistent().get(&key);
    if let Some(c) = cred {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        Ok(c)
    } else {
        Err(PasskeyError::CredentialNotFound)
    }
}

/// Removes a credential, returning `CredentialNotFound` if nothing was stored.
pub fn remove_credential(env: &Env, owner: &Address) -> Result<(), PasskeyError> {
    let key = RegistryKey::Credential(owner.clone());
    if !env.storage().persistent().has(&key) {
        return Err(PasskeyError::CredentialNotFound);
    }
    env.storage().persistent().remove(&key);
    Ok(())
}

/// Records a challenge as used. Returns `ChallengeAlreadyUsed` if it was
/// already recorded (replay prevention).
pub fn record_challenge(env: &Env, challenge: &BytesN<32>) -> Result<(), PasskeyError> {
    let key = RegistryKey::UsedChallenge(challenge.clone());
    if env.storage().persistent().has(&key) {
        return Err(PasskeyError::ChallengeAlreadyUsed);
    }
    // Store `true`; presence is what matters.
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    Ok(())
}

/// Returns `true` if the challenge has already been consumed.
pub fn is_challenge_used(env: &Env, challenge: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&RegistryKey::UsedChallenge(challenge.clone()))
}
