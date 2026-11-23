//! Unit tests for Issue #65 (Privacy Commit-Reveal Claims).
#![cfg(test)]

extern crate std;

use soroban_sdk::{token::Client as TokenClient, BytesN};

use crate::privacy_claims::compute_commitment_hash;
use crate::test::Fixture;

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

// =========================================================================
// Issue #65: Privacy Commit-Reveal Claims
// =========================================================================

#[test]
fn test_commit_and_reveal_claim_happy_path() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Accrue 2 days of streaming
    f.advance_time(2 * DAY);

    let claim_amount = 1_000_000_000i128;
    let salt = BytesN::from_array(&f.env, &[7u8; 32]);
    let commitment_hash = compute_commitment_hash(&f.env, id, &f.recipient, claim_amount, &salt);

    let reveal_deadline = f.ledger_time() + DAY;
    let safety_deposit = 50_000_000i128;

    // 1. Commit claim
    f.client.mock_all_auths().commit_claim(
        &id,
        &f.recipient,
        &commitment_hash,
        &safety_deposit,
        &reveal_deadline,
    );

    // Commitment is tracked
    let record = f
        .client
        .get_claim_commitment(&commitment_hash)
        .expect("commitment should exist");
    assert_eq!(record.stream_id, id);
    assert_eq!(record.recipient, f.recipient);
    assert_eq!(record.deposit, safety_deposit);
    assert_eq!(record.reveal_deadline, reveal_deadline);
    assert!(!record.revealed);

    // Initial recipient balance
    let token = TokenClient::new(&f.env, &f.token);
    let bal_before = token.balance(&f.recipient);

    // 2. Reveal claim
    f.client
        .mock_all_auths()
        .reveal_claim(&id, &f.recipient, &claim_amount, &salt);

    // Verify status updated and payout delivered
    let updated = f
        .client
        .get_claim_commitment(&commitment_hash)
        .expect("commitment should exist");
    assert!(updated.revealed);

    let bal_after = token.balance(&f.recipient);
    assert_eq!(bal_after, bal_before + claim_amount);
}

#[test]
fn test_reveal_claim_fails_with_wrong_salt_or_amount() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);

    let claim_amount = 1_000_000_000i128;
    let salt = BytesN::from_array(&f.env, &[1u8; 32]);
    let commitment_hash = compute_commitment_hash(&f.env, id, &f.recipient, claim_amount, &salt);
    let reveal_deadline = f.ledger_time() + DAY;

    f.client.mock_all_auths().commit_claim(
        &id,
        &f.recipient,
        &commitment_hash,
        &0i128,
        &reveal_deadline,
    );

    // Wrong salt should fail (hash mismatch => not found)
    let wrong_salt = BytesN::from_array(&f.env, &[2u8; 32]);
    let res =
        f.client
            .mock_all_auths()
            .try_reveal_claim(&id, &f.recipient, &claim_amount, &wrong_salt);
    assert!(res.is_err());

    // Wrong amount should fail
    let res2 =
        f.client
            .mock_all_auths()
            .try_reveal_claim(&id, &f.recipient, &(claim_amount + 1), &salt);
    assert!(res2.is_err());
}

#[test]
fn test_reveal_claim_fails_after_deadline() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);

    let claim_amount = 1_000_000_000i128;
    let salt = BytesN::from_array(&f.env, &[3u8; 32]);
    let commitment_hash = compute_commitment_hash(&f.env, id, &f.recipient, claim_amount, &salt);
    let reveal_deadline = f.ledger_time() + 100;

    f.client.mock_all_auths().commit_claim(
        &id,
        &f.recipient,
        &commitment_hash,
        &0i128,
        &reveal_deadline,
    );

    // Advance past deadline
    f.advance_time(101);

    let res = f
        .client
        .mock_all_auths()
        .try_reveal_claim(&id, &f.recipient, &claim_amount, &salt);
    assert!(res.is_err());
}

#[test]
fn test_expire_reveal_safety_valve() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);

    let claim_amount = 500_000_000i128;
    let salt = BytesN::from_array(&f.env, &[4u8; 32]);
    let commitment_hash = compute_commitment_hash(&f.env, id, &f.recipient, claim_amount, &salt);
    let reveal_deadline = f.ledger_time() + 200;
    let deposit = 25_000_000i128;

    f.client.mock_all_auths().commit_claim(
        &id,
        &f.recipient,
        &commitment_hash,
        &deposit,
        &reveal_deadline,
    );

    // Calling before deadline fails
    let early = f
        .client
        .mock_all_auths()
        .try_expire_reveal(&id, &commitment_hash, &f.sender);
    assert!(early.is_err());

    // Advance past deadline
    f.advance_time(201);

    // Sender reclaims expired deposit
    let refunded = f
        .client
        .mock_all_auths()
        .expire_reveal(&id, &commitment_hash, &f.sender);
    assert_eq!(refunded, deposit);

    // Commitment is cleaned up
    assert!(f.client.get_claim_commitment(&commitment_hash).is_none());
}

#[test]
fn test_duplicate_commitment_rejected() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);

    let claim_amount = 500_000_000i128;
    let salt = BytesN::from_array(&f.env, &[5u8; 32]);
    let commitment_hash = compute_commitment_hash(&f.env, id, &f.recipient, claim_amount, &salt);
    let reveal_deadline = f.ledger_time() + 500;

    f.client.mock_all_auths().commit_claim(
        &id,
        &f.recipient,
        &commitment_hash,
        &0i128,
        &reveal_deadline,
    );

    let dup = f.client.mock_all_auths().try_commit_claim(
        &id,
        &f.recipient,
        &commitment_hash,
        &0i128,
        &reveal_deadline,
    );
    assert!(dup.is_err());
}
