#![no_std]

//! # StreamPay Passkey Signer
//!
//! On-chain WebAuthn / CBOR assertion verification for Soroban smart accounts,
//! enabling non-custodial stream recipients without a browser-extension wallet
//! to claim funds from a phone using device-bound passkeys.
//!
//! ## Architecture overview
//!
//! ```text
//! recipient phone                    Stellar network
//! ──────────────                     ────────────────
//! WebAuthn credentials.get()  ──►  passkey-signer contract
//!   (assertion produced)             • verify CBOR clientDataJSON
//!                                    • recover sha256(authData ‖ hash(clientData))
//!                                    • check P-256 / secp256r1 signature
//!                                    • if valid → record claim-key nonce
//!   ◄── success tx                   streaming-payments contract
//!                                    • withdraw_max(stream_id)
//! ```
//!
//! ## Contract entry points
//!
//! | Entry point | Who calls | What it does |
//! |---|---|---|
//! | `register`  | recipient | Binds a P-256 public key (x, y) to the caller's Stellar address |
//! | `deregister` | recipient | Removes the bound credential |
//! | `get_credential` | anyone | Returns the bound P-256 key for an address (read) |
//! | `verify_and_record` | anyone (relayer / recipient) | Verifies a WebAuthn assertion and records a single-use nonce to gate a downstream call |
//! | `is_nonce_used` | anyone | Checks whether a challenge nonce has been consumed |
//!
//! ## Security notes — attestation vs assertion
//!
//! ### Attestation (registration)
//!
//! Attestation happens when the user creates the credential (i.e. during
//! `navigator.credentials.create()`). It proves the authenticator model and
//! that the credential was generated in the expected security boundary (e.g.
//! a FIDO2-certified hardware enclave). **This contract intentionally does not
//! verify attestation.** Reasons:
//!
//! - Attestation certificates are only meaningful if the relying party
//!   maintains a MDS3 root of trust database — not practical on-chain.
//! - "None" attestation (the browser default) provides no authenticator
//!   attestation at all; verifying it would add no security.
//! - What matters for asset security is **assertion** (see below).
//!
//! For a production deployment a relying-party server SHOULD verify
//! attestation off-chain before recording the credential here; the on-chain
//! contract is the assertion gatekeeper only.
//!
//! ### Assertion (authentication)
//!
//! Every `verify_and_record` call performs a full WebAuthn Level 3 assertion
//! verification:
//!
//! 1. **`clientDataJSON` shape check** — must contain `"type":"webauthn.get"`,
//!    the expected `challenge` (base64url of the Soroban challenge bytes), and
//!    the registered `origin`.
//! 2. **`rpIdHash` check** — `authData[0..32]` must equal `sha256(rpId)` where
//!    `rpId` is stored at registration time.
//! 3. **`userPresence` flag** — bit 0 of `authData[32]` must be set; without
//!    physical presence the gesture is meaningless.
//! 4. **Signature verification** — `sha256(authData ‖ sha256(clientDataJSON))`
//!    is verified against the stored P-256 public key.
//! 5. **Challenge nonce replay prevention** — the challenge bytes are recorded
//!    as "used" in persistent storage. A second assertion with the same
//!    challenge reverts with `ChallengeAlreadyUsed`.
//!
//! ### What a relying party can verify on-chain
//!
//! An on-chain verifier can prove:
//! - The assertion was produced by an authenticator that holds the private key
//!   corresponding to the registered P-256 `(x, y)` coordinate pair.
//! - The `rpId` matches the registered one (prevents cross-origin replay).
//! - The challenge was not previously presented (prevents replay).
//! - A user-presence gesture occurred.
//!
//! An on-chain verifier **cannot** prove:
//! - Which specific device or security level produced the credential.
//! - That user verification (PIN / biometric) was performed (the UP flag is
//!   checked; the UV flag check is opt-in at registration time).
//! - That the credential has not been exported or cloned (platform
//!   authenticators are supposed to be device-bound, but this cannot be
//!   verified without attestation).

#[cfg(test)]
extern crate std;

mod cbor;
mod crypto;
mod errors;
mod registry;
#[cfg(test)]
mod tests;

use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env};

pub use errors::PasskeyError;
pub use registry::{Credential, REGISTRATION_FLAGS_REQUIRE_UV};

/// The passkey signer contract.
#[contract]
pub struct PasskeySigner;

#[contractimpl]
impl PasskeySigner {
    /// Registers a P-256 public key for `owner`.
    ///
    /// Stores `(x, y)` as the owner's WebAuthn credential together with the
    /// `rp_id_hash` (sha256 of the Relying Party ID, e.g. `sha256("streampay.app")`)
    /// and the registration `flags` bitmask.
    ///
    /// Registration flags (combine with OR):
    /// - bit 0 (`REGISTRATION_FLAGS_REQUIRE_UV = 1`): require user-verification
    ///   (UV bit set in `authData`) on every assertion.
    ///
    /// # Security notes
    ///
    /// - The caller must `require_auth()` (their Stellar signature authorises
    ///   the binding).
    /// - `rp_id_hash` must be the sha256 of a hostname your relying-party
    ///   server controls; using an attacker-controlled origin lets them replay
    ///   assertions from a different site.
    /// - `x` and `y` are 32-byte big-endian field elements for the P-256 curve.
    ///   No point-on-curve check is performed here (gas cost); a relying-party
    ///   server SHOULD verify the point before submitting the registration.
    pub fn register(
        env: Env,
        owner: Address,
        rp_id_hash: BytesN<32>,
        x: BytesN<32>,
        y: BytesN<32>,
        flags: u32,
    ) -> Result<(), PasskeyError> {
        owner.require_auth();
        registry::put_credential(
            &env,
            &owner,
            &Credential {
                rp_id_hash,
                x,
                y,
                flags,
            },
        );
        Ok(())
    }

    /// Removes the registered credential for `owner`.
    ///
    /// The owner must authorise the removal. After deregistration any pending
    /// `verify_and_record` calls for that owner will fail with
    /// `CredentialNotFound`.
    pub fn deregister(env: Env, owner: Address) -> Result<(), PasskeyError> {
        owner.require_auth();
        registry::remove_credential(&env, &owner)?;
        Ok(())
    }

    /// Returns the stored credential for `owner`, or `CredentialNotFound`.
    pub fn get_credential(env: Env, owner: Address) -> Result<Credential, PasskeyError> {
        registry::get_credential(&env, &owner)
    }

    /// Verifies a WebAuthn Level 3 assertion and records the challenge nonce
    /// as consumed so it cannot be replayed.
    ///
    /// # Parameters
    ///
    /// - `owner` — the Stellar address whose registered credential is checked.
    /// - `auth_data` — raw `authenticatorData` bytes from the assertion
    ///   response (minimum 37 bytes: 32 rpIdHash + 1 flags + 4 signCount).
    /// - `client_data_json` — raw `clientDataJSON` bytes (UTF-8 JSON).
    /// - `challenge` — the 32-byte challenge that was embedded in
    ///   `clientDataJSON` as a base64url-encoded value. The relying party
    ///   generates this before calling `navigator.credentials.get()`.
    /// - `sig_r`, `sig_s` — the P-256 ECDSA signature components (32 bytes
    ///   each, big-endian).
    ///
    /// # Verification steps
    ///
    /// 1. Load the registered credential for `owner`.
    /// 2. Verify `auth_data[0..32] == rp_id_hash`.
    /// 3. Check user-presence flag (`authData[32] & 0x01 != 0`).
    /// 4. If `REGISTRATION_FLAGS_REQUIRE_UV` is set, also check UV flag.
    /// 5. Parse `clientDataJSON` (minimal CBOR-like JSON subset) and verify
    ///    `type == "webauthn.get"` and `challenge == base64url(challenge_bytes)`.
    /// 6. Compute `signed_data = sha256(auth_data ‖ sha256(client_data_json))`.
    /// 7. Verify P-256 ECDSA signature `(r, s)` over `signed_data` against `(x, y)`.
    /// 8. Record the challenge nonce as used (replay prevention).
    pub fn verify_and_record(
        env: Env,
        owner: Address,
        auth_data: Bytes,
        client_data_json: Bytes,
        challenge: BytesN<32>,
        sig_r: BytesN<32>,
        sig_s: BytesN<32>,
    ) -> Result<(), PasskeyError> {
        // Step 1: load credential.
        let cred = registry::get_credential(&env, &owner)?;

        // Step 2–4: verify authData.
        crypto::verify_auth_data(&env, &auth_data, &cred.rp_id_hash, cred.flags)?;

        // Step 5: verify clientDataJSON fields.
        cbor::verify_client_data_json(&env, &client_data_json, &challenge)?;

        // Step 6–7: verify P-256 ECDSA signature.
        crypto::verify_p256_assertion(
            &env,
            &auth_data,
            &client_data_json,
            &cred.x,
            &cred.y,
            &sig_r,
            &sig_s,
        )?;

        // Step 8: record nonce to prevent replay.
        registry::record_challenge(&env, &challenge)?;

        Ok(())
    }

    /// Returns `true` if the given challenge has already been consumed by a
    /// successful `verify_and_record` call.
    pub fn is_nonce_used(env: Env, challenge: BytesN<32>) -> bool {
        registry::is_challenge_used(&env, &challenge)
    }
}
