//! Unit tests for Issue #65 (Privacy Commit-Reveal Claims) and Issue #56 (Session Keys).
#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    token::Client as TokenClient,
    Address, BytesN,
};

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
    f.client
        .mock_all_auths()
        .commit_claim(&id, &f.recipient, &commitment_hash, &safety_deposit, &reveal_deadline);

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

    f.client
        .mock_all_auths()
        .commit_claim(&id, &f.recipient, &commitment_hash, &0i128, &reveal_deadline);

    // Wrong salt should fail (hash mismatch => not found)
    let wrong_salt = BytesN::from_array(&f.env, &[2u8; 32]);
    let res = f
        .client
        .mock_all_auths()
        .try_reveal_claim(&id, &f.recipient, &claim_amount, &wrong_salt);
    assert!(res.is_err());

    // Wrong amount should fail
    let res2 = f
        .client
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

    f.client
        .mock_all_auths()
        .commit_claim(&id, &f.recipient, &commitment_hash, &0i128, &reveal_deadline);

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

    f.client
        .mock_all_auths()
        .commit_claim(&id, &f.recipient, &commitment_hash, &deposit, &reveal_deadline);

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

    f.client
        .mock_all_auths()
        .commit_claim(&id, &f.recipient, &commitment_hash, &0i128, &reveal_deadline);

    let dup = f
        .client
        .mock_all_auths()
        .try_commit_claim(&id, &f.recipient, &commitment_hash, &0i128, &reveal_deadline);
    assert!(dup.is_err());
}

// =========================================================================
// Issue #56: Session Keys for Automated Recurring Withdrawals
// =========================================================================

#[test]
fn test_authorize_agent_and_delegated_withdrawal_happy_path() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Accrue 3 days of streaming
    f.advance_time(3 * DAY);

    let agent = Address::generate(&f.env);
    let max_per_period = 2_000_000_000i128;
    let period_seconds = DAY;
    let expires_at = f.ledger_time() + 5 * DAY;

    // Recipient authorizes agent
    f.client
        .mock_all_auths()
        .authorize_agent(&f.recipient, &agent, &id, &max_per_period, &period_seconds, &expires_at);

    let policy = f
        .client
        .get_session_policy(&agent, &id)
        .expect("policy should exist");
    assert_eq!(policy.recipient, f.recipient);
    assert_eq!(policy.agent, agent);
    assert_eq!(policy.max_per_period, max_per_period);
    assert_eq!(policy.spent_current_period, 0);
    assert!(!policy.revoked);

    // Agent executes delegated withdrawal within cap
    let token = TokenClient::new(&f.env, &f.token);
    let bal_before = token.balance(&f.recipient);

    let withdraw_amt = 800_000_000i128;
    f.client
        .mock_all_auths()
        .withdraw_delegated(&agent, &id, &withdraw_amt);

    let bal_after = token.balance(&f.recipient);
    assert_eq!(bal_after, bal_before + withdraw_amt);

    let updated_policy = f
        .client
        .get_session_policy(&agent, &id)
        .expect("policy should exist");
    assert_eq!(updated_policy.spent_current_period, withdraw_amt);
}

#[test]
fn test_delegated_withdrawal_enforces_spend_cap() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY);

    let agent = Address::generate(&f.env);
    let max_per_period = 1_000_000_000i128;
    let period_seconds = DAY;
    let expires_at = f.ledger_time() + 5 * DAY;

    f.client
        .mock_all_auths()
        .authorize_agent(&f.recipient, &agent, &id, &max_per_period, &period_seconds, &expires_at);

    // First withdrawal uses 800M of 1000M cap
    f.client
        .mock_all_auths()
        .withdraw_delegated(&agent, &id, &800_000_000i128);

    // Second withdrawal of 300M exceeds remaining 200M cap -> fails
    let res = f
        .client
        .mock_all_auths()
        .try_withdraw_delegated(&agent, &id, &300_000_000i128);
    assert!(res.is_err());
}

#[test]
fn test_delegated_withdrawal_period_resets_spent() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY);

    let agent = Address::generate(&f.env);
    let max_per_period = 1_000_000_000i128;
    let period_seconds = DAY;
    let expires_at = f.ledger_time() + 5 * DAY;

    f.client
        .mock_all_auths()
        .authorize_agent(&f.recipient, &agent, &id, &max_per_period, &period_seconds, &expires_at);

    // Exhaust cap
    f.client
        .mock_all_auths()
        .withdraw_delegated(&agent, &id, &max_per_period);

    // Advance to next period
    f.advance_time(period_seconds + 1);

    // Now agent can withdraw again up to cap
    let res = f
        .client
        .mock_all_auths()
        .try_withdraw_delegated(&agent, &id, &500_000_000i128);
    assert!(res.is_ok());

    let policy = f.client.get_session_policy(&agent, &id).unwrap();
    assert_eq!(policy.spent_current_period, 500_000_000i128);
}

#[test]
fn test_revoke_agent_immediately_blocks_withdrawals() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY);

    let agent = Address::generate(&f.env);
    let max_per_period = 1_000_000_000i128;
    let period_seconds = DAY;
    let expires_at = f.ledger_time() + 5 * DAY;

    f.client
        .mock_all_auths()
        .authorize_agent(&f.recipient, &agent, &id, &max_per_period, &period_seconds, &expires_at);

    // Recipient revokes agent
    f.client
        .mock_all_auths()
        .revoke_agent(&f.recipient, &agent, &id);

    let policy = f.client.get_session_policy(&agent, &id).unwrap();
    assert!(policy.revoked);

    // Agent attempt to withdraw fails
    let res = f
        .client
        .mock_all_auths()
        .try_withdraw_delegated(&agent, &id, &100_000_000i128);
    assert!(res.is_err());
}

#[test]
fn test_delegated_withdrawal_fails_after_expiry() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY);

    let agent = Address::generate(&f.env);
    let max_per_period = 1_000_000_000i128;
    let period_seconds = DAY;
    let expires_at = f.ledger_time() + 100;

    f.client
        .mock_all_auths()
        .authorize_agent(&f.recipient, &agent, &id, &max_per_period, &period_seconds, &expires_at);

    // Advance past expiry
    f.advance_time(101);

    let res = f
        .client
        .mock_all_auths()
        .try_withdraw_delegated(&agent, &id, &100_000_000i128);
    assert!(res.is_err());
}
