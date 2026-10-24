//! Error types for the StreamPay passkey signer contract.

use soroban_sdk::contracterror;

/// Errors returned by the passkey signer contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PasskeyError {
    /// No credential is registered for this address.
    CredentialNotFound = 1,
    /// A credential is already registered; call `deregister` first.
    CredentialAlreadyRegistered = 2,
    /// `authenticatorData` is shorter than the required 37 bytes.
    AuthDataTooShort = 3,
    /// `authData[0..32]` does not match the registered `rp_id_hash`.
    RpIdHashMismatch = 4,
    /// User-presence bit (bit 0 of `authData[32]`) is not set.
    UserPresenceNotSet = 5,
    /// User-verification bit (bit 2 of `authData[32]`) is not set, but the
    /// credential was registered with `REGISTRATION_FLAGS_REQUIRE_UV`.
    UserVerificationNotSet = 6,
    /// `clientDataJSON` is not valid UTF-8 or JSON.
    ClientDataJsonInvalid = 7,
    /// `clientDataJSON.type` is not `"webauthn.get"`.
    ClientDataTypeMismatch = 8,
    /// `clientDataJSON.challenge` does not match the supplied `challenge` bytes.
    ChallengeMismatch = 9,
    /// P-256 signature verification failed.
    SignatureInvalid = 10,
    /// This challenge has already been used; replay prevented.
    ChallengeAlreadyUsed = 11,
}
