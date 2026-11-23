#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, Vec,
};

use crate::batch_amend::{
    self, AmendmentRecord, BatchAmendmentItem, MAX_AMENDMENTS,
};
use crate::insurance::{
    self, ClaimStatus, InsuranceConfig, DEFAULT_CLAIM_TIMELOCK_SECONDS,
    DEFAULT_MAX_PAYOUT_PER_INCIDENT,
};
use crate::sender_policy::SenderPolicy;
use crate::test::Fixture;
use crate::voting_power;
use crate::StreamError;

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

// =========================================================================
// 1. Issue #570: Multi-party batch amendments with threshold consent
// =========================================================================

#[test]
fn test_batch_amendment_success_with_threshold_and_recipient_consent() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let stream_id1 = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let stream_id2 = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let mut items = Vec::new(&f.env);
    items.push_back(BatchAmendmentItem {
        stream_id: stream_id1,
        new_rate: 200,
        new_end_time: now + 8 * DAY,
    });
    items.push_back(BatchAmendmentItem {
        stream_id: stream_id2,
        new_rate: 300,
        new_end_time: now + 9 * DAY,
    });

    let batch_id = f
        .client
        .mock_all_auths()
        .propose_batch_amendment(&f.sender, &items, &1, &(now + 2 * DAY));

    // Recipient consents to the batch
    f.client
        .mock_all_auths()
        .consent_batch_amendment(&f.recipient, &batch_id);

    // Apply batch atomically
    f.client
        .mock_all_auths()
        .apply_batch_amendment(&f.sender, &batch_id);

    let log1 = f.client.get_amendment_log(&stream_id1);
    assert_eq!(log1.len(), 1);
    assert_eq!(log1.get(0).unwrap().new_rate, 200);

    let log2 = f.client.get_amendment_log(&stream_id2);
    assert_eq!(log2.len(), 1);
    assert_eq!(log2.get(0).unwrap().new_rate, 300);
}

#[test]
fn test_batch_amendment_aborts_without_recipient_consent() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let stream_id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let mut items = Vec::new(&f.env);
    items.push_back(BatchAmendmentItem {
        stream_id,
        new_rate: 250,
        new_end_time: now + 8 * DAY,
    });

    let batch_id = f
        .client
        .mock_all_auths()
        .propose_batch_amendment(&f.sender, &items, &1, &(now + 2 * DAY));

    // Attempting to apply before recipient consents must fail with zero state change
    let res = f
        .client
        .mock_all_auths()
        .try_apply_batch_amendment(&f.sender, &batch_id);
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::BatchAmendmentRecipientNotConsented
    );

    let log = f.client.get_amendment_log(&stream_id);
    assert_eq!(log.len(), 0);
}

#[test]
fn test_batch_amendment_aborts_if_stream_paused() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let stream_id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Pause the stream
    f.client.mock_all_auths().pause_stream(&f.sender, &stream_id);

    let mut items = Vec::new(&f.env);
    items.push_back(BatchAmendmentItem {
        stream_id,
        new_rate: 250,
        new_end_time: now + 8 * DAY,
    });

    // Proposing on paused stream fails
    let res = f
        .client
        .mock_all_auths()
        .try_propose_batch_amendment(&f.sender, &items, &1, &(now + 2 * DAY));
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::BatchAmendmentStreamPaused
    );
}

#[test]
fn test_batch_amendment_respects_max_amendments() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let stream_id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Fill amendment log to MAX_AMENDMENTS (20)
    let mut log = Vec::new(&f.env);
    for _ in 0..MAX_AMENDMENTS {
        log.push_back(AmendmentRecord {
            old_rate: 10,
            new_rate: 20,
            old_end_time: 100,
            new_end_time: 200,
            effective_timestamp: now,
        });
    }
    f.env.as_contract(&f.client.address, || {
        batch_amend::put_amendment_log(&f.env, stream_id, &log);
    });

    let mut items = Vec::new(&f.env);
    items.push_back(BatchAmendmentItem {
        stream_id,
        new_rate: 500,
        new_end_time: now + 8 * DAY,
    });

    let res = f
        .client
        .mock_all_auths()
        .try_propose_batch_amendment(&f.sender, &items, &1, &(now + 2 * DAY));
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::BatchAmendmentTooManyAmendments
    );
}

#[test]
fn test_batch_amendment_threshold_multisig() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let stream_id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let mut items = Vec::new(&f.env);
    items.push_back(BatchAmendmentItem {
        stream_id,
        new_rate: 200,
        new_end_time: now + 8 * DAY,
    });

    // Requires 2 signers (e.g. M-of-N threshold multisig)
    let batch_id = f
        .client
        .mock_all_auths()
        .propose_batch_amendment(&f.sender, &items, &2, &(now + 2 * DAY));

    f.client
        .mock_all_auths()
        .consent_batch_amendment(&f.recipient, &batch_id);

    // Apply with only 1 signer fails threshold
    let res = f
        .client
        .mock_all_auths()
        .try_apply_batch_amendment(&f.sender, &batch_id);
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::BatchAmendmentThresholdNotMet
    );

    // Co-signer adds consent
    let co_signer = Address::generate(&f.env);
    f.client
        .mock_all_auths()
        .consent_batch_amendment(&co_signer, &batch_id);

    // Now threshold of 2 is met, apply succeeds
    f.client
        .mock_all_auths()
        .apply_batch_amendment(&f.sender, &batch_id);
    let log = f.client.get_amendment_log(&stream_id);
    assert_eq!(log.len(), 1);
}

// =========================================================================
// 2. Issue #571: Time-weighted governance voting power from stream history
// =========================================================================

#[test]
fn test_create_and_immediate_cancel_churn_yields_zero_voting_power() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Cancel before streaming starts: 0 value settled
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    // Participant earned 0 voting power
    let power = f.client.get_voting_power(&f.recipient);
    assert_eq!(power, 0);

    // Cannot cast vote with 0 power
    let res = f
        .client
        .mock_all_auths()
        .try_cast_community_vote(&f.recipient, &1, &true);
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::VotingPowerInsufficient
    );
}

#[test]
fn test_settled_stream_accrues_time_weighted_power_and_decays() {
    let f = Fixture::setup_quiet();
    let participant = Address::generate(&f.env);
    let now = f.env.ledger().timestamp();

    // Record settled stream: 10,000 tokens over 30 days
    f.env.as_contract(&f.client.address, || {
        voting_power::record_stream_settlement(
            &f.env,
            &participant,
            1,
            10_000_000_000,
            30 * DAY,
            now,
        );
    });

    let initial_power = f.client.get_voting_power(&participant);
    assert!(initial_power > 0);

    // Advance time by 90 days: power must decay deterministically
    f.advance_time(90 * DAY);
    let decayed_power = f.client.get_voting_power(&participant);
    assert!(decayed_power < initial_power);

    // Cast vote on proposal
    let power_voted = f
        .client
        .mock_all_auths()
        .cast_community_vote(&participant, &100, &true);
    assert_eq!(power_voted, decayed_power);

    // Tally recorded correctly
    let tally = f.client.get_community_proposal_tally(&100).unwrap();
    assert_eq!(tally.for_power, decayed_power);
    assert_eq!(tally.against_power, 0);

    // Double voting rejected
    let res = f
        .client
        .mock_all_auths()
        .try_cast_community_vote(&participant, &100, &false);
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::VotingPowerAlreadyVoted
    );
}

#[test]
fn test_voting_power_respects_governance_caps() {
    let f = Fixture::setup_quiet();
    let participant = Address::generate(&f.env);
    let now = f.env.ledger().timestamp();

    // Whales cannot exceed max participant power cap
    f.env.as_contract(&f.client.address, || {
        voting_power::record_stream_settlement(
            &f.env,
            &participant,
            1,
            1_000_000_000_000_000,
            1000 * DAY,
            now,
        );
    });

    let power = f.client.get_voting_power(&participant);
    let caps = f.env.as_contract(&f.client.address, || {
        voting_power::get_caps(&f.env)
    });
    assert!(power <= caps.max_participant_power);
}

// =========================================================================
// 3. Issue #572: Vault insurance pool for stream default risk
// =========================================================================

#[test]
fn test_insurance_fee_routing_and_solvency_invariant() {
    let f = Fixture::setup_quiet();

    // Configure insurance fee slice: 2000 bps (20%)
    f.client.mock_all_auths().set_insurance_config(
        &f.governor,
        &InsuranceConfig {
            fee_slice_bps: 2000,
            max_payout_per_incident: DEFAULT_MAX_PAYOUT_PER_INCIDENT,
            max_payout_per_epoch: 500_000_000_000,
            epoch_duration_seconds: 30 * DAY,
            claim_timelock_seconds: DEFAULT_CLAIM_TIMELOCK_SECONDS,
        },
    );

    // Route a fee slice into insurance pool
    let total_fee = 10_000_000;
    let treasury_remains = f.env.as_contract(&f.client.address, || {
        insurance::route_fee_slice(&f.env, &f.token, total_fee)
    });
    assert_eq!(treasury_remains, 8_000_000); // 80% to treasury

    let pool = f.client.get_insurance_pool(&f.token).unwrap();
    assert_eq!(pool.balance, 2_000_000); // 20% to insurance pool
    assert_eq!(pool.total_premiums, 2_000_000);
}

#[test]
fn test_insurance_claim_flow_timelock_approval_and_payout() {
    let f = Fixture::setup_quiet();
    let _now = f.env.ledger().timestamp();

    // Configure insurance fee slice: 2000 bps (20%)
    f.client.mock_all_auths().set_insurance_config(
        &f.governor,
        &InsuranceConfig {
            fee_slice_bps: 2000,
            max_payout_per_incident: DEFAULT_MAX_PAYOUT_PER_INCIDENT,
            max_payout_per_epoch: 500_000_000_000,
            epoch_duration_seconds: 30 * DAY,
            claim_timelock_seconds: DEFAULT_CLAIM_TIMELOCK_SECONDS,
        },
    );

    // Create stream and let it expire/default
    let stream_id = f.create_stream(DEPOSIT, 0, DAY, false);
    f.advance_time(2 * DAY);

    // Seed insurance pool balance and mint tokens to contract
    StellarAssetClient::new(&f.env, &f.token).mint(&f.client.address, &50_000_000_000);
    f.env.as_contract(&f.client.address, || {
        insurance::route_fee_slice(&f.env, &f.token, 50_000_000_000);
    });

    // Recipient files claim
    let claim_id = f
        .client
        .mock_all_auths()
        .file_insurance_claim(&f.recipient, &stream_id, &1_000_000);

    let claim = f.client.get_insurance_claim(&claim_id).unwrap();
    assert_eq!(claim.status, ClaimStatus::Pending);

    // Approval before timelock elapses fails
    let early_approval = f
        .client
        .mock_all_auths()
        .try_approve_insurance_claim(&f.governor, &claim_id);
    assert_eq!(
        early_approval.unwrap_err().unwrap(),
        StreamError::InsuranceClaimTimelockNotElapsed
    );

    // Mature timelock
    f.advance_time(DEFAULT_CLAIM_TIMELOCK_SECONDS + 1);

    // Governor approves claim
    f.client
        .mock_all_auths()
        .approve_insurance_claim(&f.governor, &claim_id);
    let approved_claim = f.client.get_insurance_claim(&claim_id).unwrap();
    assert_eq!(approved_claim.status, ClaimStatus::Approved);

    // Payout claim
    f.client
        .mock_all_auths()
        .payout_insurance_claim(&claim_id);
    let paid_claim = f.client.get_insurance_claim(&claim_id).unwrap();
    assert_eq!(paid_claim.status, ClaimStatus::Paid);
}

#[test]
fn test_insurance_claim_solvency_check_prevents_drain() {
    let f = Fixture::setup_quiet();

    // Configure insurance fee slice: 2000 bps (20%)
    f.client.mock_all_auths().set_insurance_config(
        &f.governor,
        &InsuranceConfig {
            fee_slice_bps: 2000,
            max_payout_per_incident: DEFAULT_MAX_PAYOUT_PER_INCIDENT,
            max_payout_per_epoch: 500_000_000_000,
            epoch_duration_seconds: 30 * DAY,
            claim_timelock_seconds: DEFAULT_CLAIM_TIMELOCK_SECONDS,
        },
    );

    let stream_id = f.create_stream(DEPOSIT, 0, DAY, false);
    f.advance_time(2 * DAY);

    // Only 500 in pool
    f.env.as_contract(&f.client.address, || {
        insurance::route_fee_slice(&f.env, &f.token, 2_500); // 20% = 500
    });

    let claim_id = f
        .client
        .mock_all_auths()
        .file_insurance_claim(&f.recipient, &stream_id, &1_000); // claims 1000

    f.advance_time(DEFAULT_CLAIM_TIMELOCK_SECONDS + 1);
    f.client
        .mock_all_auths()
        .approve_insurance_claim(&f.governor, &claim_id);

    // Pool liabilities (1000) > assets (500) -> must revert with InsurancePoolInsolvent
    let res = f
        .client
        .mock_all_auths()
        .try_payout_insurance_claim(&claim_id);
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::InsurancePoolInsolvent
    );
}

// =========================================================================
// 4. Issue #573: Smart-wallet sender spending policies
// =========================================================================

#[test]
fn test_sender_policy_bounds_enforced_at_creation() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();

    // Set spending policy with max deposit = 500
    f.client.mock_all_auths().set_sender_policy(
        &f.sender,
        &SenderPolicy {
            version: 1,
            allowed_tokens: None,
            max_deposit_per_stream: Some(500),
            max_rate_per_second: None,
            max_duration_seconds: None,
            max_outflow_per_epoch: None,
            epoch_duration_seconds: 0,
            current_epoch_outflow: 0,
            epoch_start_time: 0,
            recipient_whitelist: None,
            max_per_recipient_cap: None,
        },
    );

    // Attempting to create stream with deposit = 1000 violates policy
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1_000,
        &(now + DAY),
        &(now + 2 * DAY),
        &false,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::SenderPolicyViolated
    );

    // Creating stream within bounds succeeds
    let ok = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &400,
        &(now + DAY),
        &(now + 2 * DAY),
        &false,
    );
    assert!(ok > 0);
}

#[test]
fn test_sender_policy_token_allowlist_enforced() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let other_token = Address::generate(&f.env);

    let mut allowed = Vec::new(&f.env);
    allowed.push_back(f.token.clone());

    // Only f.token is allowed by sender policy
    f.client.mock_all_auths().set_sender_policy(
        &f.sender,
        &SenderPolicy {
            version: 1,
            allowed_tokens: Some(allowed),
            max_deposit_per_stream: None,
            max_rate_per_second: None,
            max_duration_seconds: None,
            max_outflow_per_epoch: None,
            epoch_duration_seconds: 0,
            current_epoch_outflow: 0,
            epoch_start_time: 0,
            recipient_whitelist: None,
            max_per_recipient_cap: None,
        },
    );

    // Creating stream with other_token is rejected
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &other_token,
        &100,
        &(now + DAY),
        &(now + 2 * DAY),
        &false,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::SenderPolicyViolated
    );
}

#[test]
fn test_sender_policy_recipient_whitelist_enforced() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let stranger = Address::generate(&f.env);

    let mut whitelist = Vec::new(&f.env);
    whitelist.push_back(f.recipient.clone());

    f.client.mock_all_auths().set_sender_policy(
        &f.sender,
        &SenderPolicy {
            version: 1,
            allowed_tokens: None,
            max_deposit_per_stream: None,
            max_rate_per_second: None,
            max_duration_seconds: None,
            max_outflow_per_epoch: None,
            epoch_duration_seconds: 0,
            current_epoch_outflow: 0,
            epoch_start_time: 0,
            recipient_whitelist: Some(whitelist),
            max_per_recipient_cap: None,
        },
    );

    // Stream to stranger is rejected
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &stranger,
        &f.token,
        &100,
        &(now + DAY),
        &(now + 2 * DAY),
        &false,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::SenderPolicyViolated
    );
}

#[test]
fn test_sender_policy_revocation() {
    let f = Fixture::setup_quiet();

    f.client.mock_all_auths().set_sender_policy(
        &f.sender,
        &SenderPolicy {
            version: 1,
            allowed_tokens: None,
            max_deposit_per_stream: Some(100),
            max_rate_per_second: None,
            max_duration_seconds: None,
            max_outflow_per_epoch: None,
            epoch_duration_seconds: 0,
            current_epoch_outflow: 0,
            epoch_start_time: 0,
            recipient_whitelist: None,
            max_per_recipient_cap: None,
        },
    );

    let pol = f.client.get_sender_policy(&f.sender);
    assert!(pol.is_some());

    // Revoke policy
    f.client.mock_all_auths().revoke_sender_policy(&f.sender);

    let pol_after = f.client.get_sender_policy(&f.sender);
    assert!(pol_after.is_none());
}
