//! Tests for the gas-sponsorship surface (`sponsor.rs`).
//!
//! The sponsored-claim path is exercised with *real* ed25519 signatures:
//! these tests sign the same canonical digest the contract reconstructs (via
//! the production [`sponsor::message`] / [`sponsor::signature_digest`]), using
//! `ed25519-dalek` as an out-of-band signer — exactly what a production
//! operator and an enrolled beneficiary run off-chain.
#![cfg(test)]

extern crate std;

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{token::Client as TokenClient, Address, BytesN, Env, Event as _, String};

use crate::sponsor;
use crate::test::Fixture;
use crate::{StreamError, StreamStatus};
use ed25519_dalek::{Signer, SigningKey};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

/// An out-of-band ed25519 signer: secret key to sign claims, public key to
/// register/enroll.
struct TestSigner {
    secret: SigningKey,
    public_key: BytesN<32>,
}

fn test_signer(env: &Env, seed: u8) -> TestSigner {
    let secret = SigningKey::from_bytes(&[seed; 32]);
    TestSigner {
        public_key: BytesN::from_array(env, &secret.verifying_key().to_bytes()),
        secret,
    }
}

/// The contract verifies over the 32-byte SHA-256 digest, so the digest bytes
/// are the signing message.
fn sign_digest(env: &Env, signer: &TestSigner, digest: &BytesN<32>) -> BytesN<64> {
    BytesN::from_array(env, &signer.secret.sign(&digest.to_array()).to_bytes())
}

/// Nested result shape the generated client produces for a
/// `Result<(), StreamError>` entry point.
type RelayResult =
    Result<Result<(), soroban_sdk::ConversionError>, Result<StreamError, soroban_sdk::InvokeError>>;

/// Relays a claim for `f.recipient`, signed by both the sponsor operator and
/// the beneficiary consent key.
#[allow(clippy::too_many_arguments)] // mirrors the relay surface
fn relay_claim(
    f: &Fixture,
    sponsor_addr: &Address,
    op: &TestSigner,
    ben: &TestSigner,
    id: u64,
    amount: i128,
    nonce: u64,
    deadline: u64,
) -> RelayResult {
    let parts = sponsor::message(
        &f.env,
        &f.client.address,
        sponsor_addr,
        &f.recipient,
        &f.token,
        id,
        amount,
        nonce,
        deadline,
    );
    let digest = sponsor::signature_digest(&f.env, &parts);
    f.client.mock_all_auths().try_sponsored_withdraw(
        sponsor_addr,
        &f.recipient,
        &id,
        &amount,
        &nonce,
        &deadline,
        &sign_digest(&f.env, op, &digest),
        &sign_digest(&f.env, ben, &digest),
    )
}

/// Unwraps a relay result into the contract-level rejection.
fn relay_rejection(res: RelayResult) -> StreamError {
    res.expect_err("expected sponsored_withdraw to be rejected")
        .unwrap()
}

/// Registers an active sponsor with `op` as its authorized operator.
fn register_op(
    f: &Fixture,
    sponsor_addr: &Address,
    op: &TestSigner,
    per_period: i128,
    per_beneficiary: i128,
    window: u64,
) {
    f.client.mock_all_auths().register_sponsor(
        sponsor_addr,
        &f.token,
        &per_period,
        &per_beneficiary,
        &window,
        &op.public_key,
    );
}

/// A stream accrued to exactly one day's payout (`DEPOSIT / 10`).
fn accrued_stream(f: &Fixture) -> u64 {
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY); // one full day elapsed since start
    id
}

#[test]
fn sponsored_claim_with_valid_signatures_pays_out_and_books_budget() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    register_op(&f, &sponsor_addr, &op, DEPOSIT, DEPOSIT, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = accrued_stream(&f);
    let amount = DEPOSIT / 10;
    let deadline = f.env.ledger().timestamp() + DAY;

    let res = relay_claim(&f, &sponsor_addr, &op, &ben, id, amount, 1, deadline);

    // `events().all()` covers only the last invocation, so grab the claim
    // event before any further contract calls.
    let claim_events = f.env.events().all().filter_by_contract(&f.client.address);

    assert!(matches!(res, Ok(Ok(()))));

    // Stream state: paid out, still Active.
    let s = f.client.get_stream(&id);
    assert_eq!(s.withdrawn, amount);
    assert_eq!(s.status, StreamStatus::Active);

    // Budget ledger records the spend for both the sponsor and the beneficiary.
    assert_eq!(f.client.sponsor_period_spend(&sponsor_addr).spend, amount);
    assert_eq!(
        f.client
            .beneficiary_spend(&sponsor_addr, &f.recipient)
            .spend,
        amount
    );

    // The payout actually reached the recipient.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        amount
    );

    // Exactly one SponsorClaim event with the canonical payload.
    let claim = crate::SponsorClaim {
        sponsor: sponsor_addr.clone(),
        kind: soroban_sdk::Symbol::new(&f.env, "claim"),
        stream_id: id,
        beneficiary: f.recipient.clone(),
        amount,
        nonce: 1,
    };
    assert_eq!(claim_events, [claim.to_xdr(&f.env, &f.client.address)],);
}

#[test]
fn replayed_nonce_is_rejected_and_cannot_double_spend() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    register_op(&f, &sponsor_addr, &op, DEPOSIT, DEPOSIT, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = accrued_stream(&f);
    let amount = DEPOSIT / 10;
    let deadline = f.env.ledger().timestamp() + DAY;

    let first = relay_claim(&f, &sponsor_addr, &op, &ben, id, amount / 2, 7, deadline);
    assert!(matches!(first, Ok(Ok(()))));

    // Identical relay (same nonce) — a network-level replay attempt.
    let replay = relay_claim(&f, &sponsor_addr, &op, &ben, id, amount / 2, 7, deadline);
    assert_eq!(relay_rejection(replay), StreamError::ClaimNonceReplay);

    // Nothing double-spent.
    assert_eq!(f.client.get_stream(&id).withdrawn, amount / 2);
    assert_eq!(
        f.client.sponsor_period_spend(&sponsor_addr).spend,
        amount / 2
    );
}

#[test]
fn budget_exhaustion_mid_relay_rejects_the_second_claim_until_window_rolls() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    let day = DEPOSIT / 10;
    // Period cap covers exactly one claim of `day`.
    register_op(&f, &sponsor_addr, &op, day, day * 10, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(6 * DAY); // five days accrued
    let deadline = f.env.ledger().timestamp() + DAY;

    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op, &ben, id, day, 1, deadline),
        Ok(Ok(()))
    ));

    // Budget is now exhausted mid-relay: any further claim exceeds it, even
    // though the stream has plenty accrued.
    let res = relay_claim(&f, &sponsor_addr, &op, &ben, id, day / 2, 2, deadline);
    assert_eq!(relay_rejection(res), StreamError::SponsorBudgetExceeded);
    assert_eq!(f.client.get_stream(&id).withdrawn, day);
    assert_eq!(f.client.sponsor_period_spend(&sponsor_addr).spend, day);

    // Once the window elapses, the budget resets and relaying resumes.
    f.advance_time(DAY + 1);
    let new_deadline = f.env.ledger().timestamp() + DAY;
    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op, &ben, id, day / 2, 3, new_deadline),
        Ok(Ok(()))
    ));
    assert_eq!(f.client.sponsor_period_spend(&sponsor_addr).spend, day / 2);
    assert_eq!(f.client.get_stream(&id).withdrawn, day + day / 2);
}

#[test]
fn beneficiary_cap_rejects_within_the_sponsor_window() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    let day = DEPOSIT / 10;
    // Sponsor-wide budget is ample; this beneficiary is capped at `day / 2`.
    register_op(&f, &sponsor_addr, &op, day * 10, day / 2, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(6 * DAY);
    let deadline = f.env.ledger().timestamp() + DAY;

    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op, &ben, id, day / 2, 1, deadline),
        Ok(Ok(()))
    ));
    let res = relay_claim(&f, &sponsor_addr, &op, &ben, id, 1, 2, deadline);
    assert_eq!(relay_rejection(res), StreamError::BeneficiaryBudgetExceeded);
    assert_eq!(f.client.get_stream(&id).withdrawn, day / 2);
}

#[test]
fn rotating_the_operator_key_voids_old_relay_signatures() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op1 = test_signer(&f.env, 11);
    let op2 = test_signer(&f.env, 12);
    let ben = test_signer(&f.env, 22);
    register_op(&f, &sponsor_addr, &op1, DEPOSIT, DEPOSIT, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = accrued_stream(&f);
    let amount = DEPOSIT / 10;
    let deadline = f.env.ledger().timestamp() + 2 * DAY;

    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op1, &ben, id, amount / 2, 1, deadline),
        Ok(Ok(()))
    ));

    // Compromise response: rotate the authorized operator key immediately.
    f.client
        .mock_all_auths()
        .rotate_operator_key(&sponsor_addr, &op2.public_key);

    // A claim still signed by the OLD operator key traps (signature
    // verification fails against the rotated key) with no state effects.
    let stale = relay_claim(&f, &sponsor_addr, &op1, &ben, id, amount / 2, 2, deadline);
    assert!(
        matches!(stale, Err(Err(_))),
        "old-key relay must trap, got {stale:?}"
    );
    assert_eq!(f.client.get_stream(&id).withdrawn, amount / 2);

    // The NEW key relays successfully.
    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op2, &ben, id, amount / 2, 3, deadline),
        Ok(Ok(()))
    ));
    assert_eq!(f.client.get_stream(&id).withdrawn, amount);
}

#[test]
fn invalid_signature_traps_without_burning_the_nonce() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    register_op(&f, &sponsor_addr, &op, DEPOSIT, DEPOSIT, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = accrued_stream(&f);
    let amount = DEPOSIT / 10;
    let deadline = f.env.ledger().timestamp() + DAY;

    let parts = sponsor::message(
        &f.env,
        &f.client.address,
        &sponsor_addr,
        &f.recipient,
        &f.token,
        id,
        amount,
        4,
        deadline,
    );
    let digest = sponsor::signature_digest(&f.env, &parts);
    let forged = BytesN::from_array(&f.env, &[0u8; 64]);
    let res = f.client.mock_all_auths().try_sponsored_withdraw(
        &sponsor_addr,
        &f.recipient,
        &id,
        &amount,
        &4,
        &deadline,
        &forged,
        &sign_digest(&f.env, &ben, &digest),
    );
    assert!(
        matches!(res, Err(Err(_))),
        "forged operator signature must trap, got {res:?}"
    );

    // The trap rolled every effect back: the nonce is still unspent and the
    // identical, correctly-signed claim succeeds afterwards.
    assert_eq!(f.client.get_stream(&id).withdrawn, 0);
    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op, &ben, id, amount, 4, deadline),
        Ok(Ok(()))
    ));
    assert_eq!(f.client.get_stream(&id).withdrawn, amount);
}

#[test]
fn paused_sponsor_blocks_relay_until_resumed() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    register_op(&f, &sponsor_addr, &op, DEPOSIT, DEPOSIT, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = accrued_stream(&f);
    let amount = DEPOSIT / 10;
    let deadline = f.env.ledger().timestamp() + 2 * DAY;

    f.client
        .mock_all_auths()
        .set_sponsor_active(&sponsor_addr, &false);
    let res = relay_claim(&f, &sponsor_addr, &op, &ben, id, amount, 1, deadline);
    assert_eq!(relay_rejection(res), StreamError::SponsorInactive);

    f.client
        .mock_all_auths()
        .set_sponsor_active(&sponsor_addr, &true);
    assert!(matches!(
        relay_claim(&f, &sponsor_addr, &op, &ben, id, amount, 2, deadline),
        Ok(Ok(()))
    ));
}

#[test]
fn sponsoring_someone_who_is_not_the_recipient_is_rejected() {
    let f = Fixture::setup();
    let sponsor_addr = Address::generate(&f.env);
    let stranger = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 33);
    register_op(&f, &sponsor_addr, &op, DEPOSIT, DEPOSIT, DAY);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&stranger, &ben.public_key);
    let id = accrued_stream(&f);

    // The stranger is enrolled and the sponsor active, but the stream pays
    // `f.recipient` — relaying for anyone else must not be accepted. The
    // check fires before signature verification, so dummy sigs are fine.
    let sig = BytesN::from_array(&f.env, &[0u8; 64]);
    let res = f.client.mock_all_auths().try_sponsored_withdraw(
        &sponsor_addr,
        &stranger,
        &id,
        &(DEPOSIT / 10),
        &1,
        &(f.env.ledger().timestamp() + DAY),
        &sig,
        &sig,
    );
    assert_eq!(
        res.expect_err("expected rejection").unwrap(),
        StreamError::StreamNotActive
    );
}

/// Cross-language parity pin for the signed relay payload.
///
/// `frontend/lib/sponsor.ts` rebuilds this exact message in JavaScript and
/// hashes it with `sha256`; both sides hardcode this vector, so a change to the
/// field order, field types, or domain tag breaks `cargo test` *and* the
/// frontend test instead of silently invalidating sponsors' signatures.
#[test]
fn canonical_relay_message_has_a_frozen_wire_form() {
    use soroban_sdk::xdr::ToXdr;
    let env = Env::default();
    env.mock_all_auths();
    let addr = |s: &str| Address::from_string(&String::from_str(&env, s));

    let parts = sponsor::message(
        &env,
        &addr("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4"),
        &addr("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM"),
        &addr("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4"),
        &addr("CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL"),
        42,
        1_000_000_000,
        7,
        1_800_000_000,
    );

    assert_eq!(
        hex_bytes(&parts.clone().to_xdr(&env)),
        "000000100000000100000009\
         0000000e0000001f53747265616d5061792f73706f6e736f7265642d77697468647261772f7631\
         000000000e00000038434141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414d445234\
         0000000e00000038434141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414f4c5a4d\
         0000000e000000384341414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414149544134\
         0000000e0000003843424550444e5659585147574235595542584b4a57594a41374f58545a57354c464c4e4f354a52524745365a3643354f53555a504343454c\
         00000005000000000000002a\
         0000000a0000000000000000000000003b9aca00\
         000000050000000000000007\
         00000005000000006b49d200"
    );

    let digest = sponsor::signature_digest(&env, &parts);
    assert_eq!(
        hex_bytes(&digest.into()),
        "e2c974bef0af32c95b39bd02965fe636cbed3e8397af2158e9c534560f2de186"
    );
}

fn hex_bytes(b: &soroban_sdk::Bytes) -> std::string::String {
    let mut s = std::string::String::new();
    for i in 0..b.len() {
        s.push_str(&std::format!("{:02x}", b.get(i).unwrap()));
    }
    s
}
