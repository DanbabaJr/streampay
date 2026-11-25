//! Tests for #564 (Receivables financing), #565 (Conditional streams),
//! #566 (Stream templates), and #567 (Integrator callback hooks).
#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Symbol, Vec,
};

use crate::test::Fixture;
use crate::{
    ConditionPredicate, ConditionStatus, HookEventClass, HookFailurePolicy, StreamError,
    StreamTemplate,
};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

// =========================================================================
// Issue #564: Receivables financing tests
// =========================================================================

#[test]
fn test_draw_advance_and_repay_intercept() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let lender = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&lender, &DEPOSIT);

    // Initial balances
    let token = TokenClient::new(&f.env, &f.token);
    let initial_recipient_balance = token.balance(&f.recipient);
    let initial_lender_balance = token.balance(&lender);

    // Recipient draws advance: 2_000_000_000 with 50% repayment interception
    let advance_amount = 2_000_000_000i128;
    f.client.mock_all_auths().draw_advance(
        &id,
        &lender,
        &advance_amount,
        &5_000, // 50%
    );

    // Verify recipient received principal and lender funded it
    assert_eq!(
        token.balance(&f.recipient),
        initial_recipient_balance + advance_amount
    );
    assert_eq!(
        token.balance(&lender),
        initial_lender_balance - advance_amount
    );

    // Advance record exists
    let adv = f.client.get_advance(&id).expect("advance must exist");
    assert_eq!(adv.stream_id, id);
    assert_eq!(adv.lender, lender);
    assert_eq!(adv.principal, advance_amount);
    let total_owed = adv.total_owed;
    assert!(total_owed >= advance_amount);

    // Advance time to 5 days (halfway through the stream)
    f.advance_time(5 * DAY);

    // Recipient withdraws: repayment is intercepted
    let pre_withdraw_lender_balance = token.balance(&lender);
    let pre_withdraw_recipient_balance = token.balance(&f.recipient);

    let withdraw_amount = 2_000_000_000i128;
    f.client.mock_all_auths().withdraw(&id, &withdraw_amount);

    // 50% went to lender, 50% went to recipient
    let expected_repayment = withdraw_amount / 2;
    assert_eq!(
        token.balance(&lender),
        pre_withdraw_lender_balance + expected_repayment
    );
    assert_eq!(
        token.balance(&f.recipient),
        pre_withdraw_recipient_balance + (withdraw_amount - expected_repayment)
    );

    // Check updated advance record
    let adv_updated = f.client.get_advance(&id).expect("advance still active");
    assert_eq!(adv_updated.repaid, expected_repayment);

    // Direct repayment of remaining balance
    let remaining_owed = adv_updated.total_owed - adv_updated.repaid;
    StellarAssetClient::new(&f.env, &f.token).mint(&f.recipient, &remaining_owed);
    f.client
        .mock_all_auths()
        .repay_advance(&f.recipient, &id, &remaining_owed);

    // Advance should be fully settled and cleared
    assert!(f.client.get_advance(&id).is_none());
}

#[test]
fn test_advance_value_conservation_and_liquidation_on_cancel() {
    let f = Fixture::setup_quiet();
    // Cancellable stream
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let lender = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&lender, &DEPOSIT);

    // Draw advance
    let advance_amount = 2_000_000_000i128;
    f.client
        .mock_all_auths()
        .draw_advance(&id, &lender, &advance_amount, &5_000);

    // Advance 3 days: some accrual has happened
    f.advance_time(3 * DAY);

    let token = TokenClient::new(&f.env, &f.token);
    let pre_cancel_sender_balance = token.balance(&f.sender);
    let pre_cancel_lender_balance = token.balance(&lender);

    // Cancel stream
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    // After cancellation, advance is liquidated and removed
    assert!(f.client.get_advance(&id).is_none());

    // Sender receives the unaccrued refund
    let post_cancel_sender_balance = token.balance(&f.sender);
    assert!(post_cancel_sender_balance > pre_cancel_sender_balance);

    // Lender was partially or fully repaid from accrued value during liquidation
    let post_cancel_lender_balance = token.balance(&lender);
    assert!(post_cancel_lender_balance > pre_cancel_lender_balance);

    // Total tokens conserved: contract held DEPOSIT, now distributed between sender, recipient, lender
    let contract_balance = token.balance(&f.client.address);
    assert_eq!(contract_balance, 0);
}

// =========================================================================
// Issue #565: Conditional streams tests
// =========================================================================

#[test]
fn test_conditional_stream_quorum_and_release() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let pub1 = Address::generate(&f.env);
    let pub2 = Address::generate(&f.env);
    let pub3 = Address::generate(&f.env);

    let mut publishers = Vec::new(&f.env);
    publishers.push_back(pub1.clone());
    publishers.push_back(pub2.clone());
    publishers.push_back(pub3.clone());

    let now = f.env.ledger().timestamp();
    let timeout = now + 5 * DAY;

    // Register release condition requiring 2 of 3 publishers
    let cond_id = f.client.mock_all_auths().register_condition(
        &f.sender,
        &id,
        &ConditionPredicate::Boolean(true),
        &publishers,
        &2, // threshold: 2
        &timeout,
    );
    assert_eq!(cond_id, 1);

    // Condition should be Pending and stream release-gated
    assert!(f.client.is_release_gated(&id));
    let cond = f.client.get_condition(&id).expect("condition exists");
    assert_eq!(cond.status, ConditionStatus::Pending);

    // Advance time so accrual occurs
    f.advance_time(2 * DAY);

    // Withdrawal while condition is pending must fail with ConditionNotMet
    let res = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &crate::MIN_CLAIM_AMOUNT);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::ConditionNotMet);

    // Publisher 1 attests
    f.client
        .mock_all_auths()
        .attest_condition(&pub1, &id, &ConditionPredicate::Boolean(true));

    // 1 of 2 attestations: still release-gated
    assert!(f.client.is_release_gated(&id));

    // Publisher 2 attests: quorum met!
    f.client
        .mock_all_auths()
        .attest_condition(&pub2, &id, &ConditionPredicate::Boolean(true));

    // Condition status is now Met
    assert!(!f.client.is_release_gated(&id));
    let cond_met = f.client.get_condition(&id).expect("condition exists");
    assert_eq!(cond_met.status, ConditionStatus::Met);

    // Withdrawal now succeeds!
    let withdraw_res = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &crate::MIN_CLAIM_AMOUNT);
    assert!(withdraw_res.is_ok());
}

#[test]
fn test_conditional_stream_conservative_stale_fallback() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let pub1 = Address::generate(&f.env);
    let mut publishers = Vec::new(&f.env);
    publishers.push_back(pub1.clone());

    let now = f.env.ledger().timestamp();
    let timeout = now + 2 * DAY;

    // Register condition
    f.client.mock_all_auths().register_condition(
        &f.sender,
        &id,
        &ConditionPredicate::Boolean(true),
        &publishers,
        &1,
        &timeout,
    );

    // Advance time PAST timeout without attestation
    f.advance_time(3 * DAY);

    // Conservative fallback: release is held, never auto-released
    assert!(f.client.is_release_gated(&id));
    let res = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &crate::MIN_CLAIM_AMOUNT);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::ConditionNotMet);

    // Late attestation fails with ConditionExpired
    let attest_res = f.client.mock_all_auths().try_attest_condition(
        &pub1,
        &id,
        &ConditionPredicate::Boolean(true),
    );
    assert_eq!(
        attest_res.unwrap_err().unwrap(),
        StreamError::ConditionExpired
    );
}

// =========================================================================
// Issue #566: Stream template factory tests
// =========================================================================

#[test]
fn test_template_versioning_and_instantiation() {
    let f = Fixture::setup_quiet();

    let template_v1 = StreamTemplate {
        id: 1,
        version: 1,
        token: f.token.clone(),
        duration: 30 * DAY,
        cancelable: true,
        use_oracle: false,
        min_deposit: 1_000_000_000,
        max_deposit: 50_000_000_000,
        created_at: 0,
    };

    // Governor approves template version 1
    f.client
        .mock_all_auths()
        .approve_template(&f.governor, &1, &1, &template_v1);

    // Retrieve approved template
    let stored = f.client.get_template(&1, &1).expect("template v1 stored");
    assert_eq!(stored.duration, 30 * DAY);
    assert_eq!(stored.version, 1);

    // Duplicate version 1 approval fails
    let dup_res = f
        .client
        .mock_all_auths()
        .try_approve_template(&f.governor, &1, &1, &template_v1);
    assert_eq!(
        dup_res.unwrap_err().unwrap(),
        StreamError::TemplateAlreadyApproved
    );

    // Out-of-sequence version 3 fails
    let v3 = StreamTemplate {
        version: 3,
        ..template_v1.clone()
    };
    let mis_res = f
        .client
        .mock_all_auths()
        .try_approve_template(&f.governor, &1, &3, &v3);
    assert_eq!(
        mis_res.unwrap_err().unwrap(),
        StreamError::TemplateVersionMismatch
    );

    // Governor approves version 2
    let mut template_v2 = template_v1.clone();
    template_v2.version = 2;
    template_v2.duration = 60 * DAY;
    f.client
        .mock_all_auths()
        .approve_template(&f.governor, &1, &2, &template_v2);

    // Mint tokens for sender
    let deposit = 10_000_000_000i128;
    StellarAssetClient::new(&f.env, &f.token).mint(&f.sender, &deposit);

    // Instantiate stream from template v2
    let now = f.env.ledger().timestamp();
    let stream_id = f.client.mock_all_auths().instantiate_template(
        &1,
        &2,
        &f.sender,
        &f.recipient,
        &deposit,
        &now,
    );

    // Verify stream was created
    let stream = f.client.get_stream(&stream_id);
    assert_eq!(stream.deposit, deposit);
    assert_eq!(stream.recipient, f.recipient);
    assert_eq!(stream.sender, f.sender);

    // Verify lineage record
    let lineage = f
        .client
        .get_stream_lineage(&stream_id)
        .expect("lineage exists");
    assert_eq!(lineage.template_id, 1);
    assert_eq!(lineage.version, 2);
}

// =========================================================================
// Issue #567: Integrator callback hooks tests
// =========================================================================

#[test]
fn test_hook_registration_and_revocation() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let callback_contract = Address::generate(&f.env);
    let selector = Symbol::new(&f.env, "on_withdraw");

    // Register hook
    f.client.mock_all_auths().register_hook(
        &f.sender,
        &id,
        &HookEventClass::Withdraw,
        &callback_contract,
        &selector,
        &HookFailurePolicy::EmitAndContinue,
    );

    // Hook exists
    let hook = f
        .client
        .get_hook(&id, &HookEventClass::Withdraw)
        .expect("hook exists");
    assert_eq!(hook.callback_contract, callback_contract);
    assert_eq!(hook.selector, selector);

    // Duplicate registration for same event class fails
    let dup_res = f.client.mock_all_auths().try_register_hook(
        &f.sender,
        &id,
        &HookEventClass::Withdraw,
        &callback_contract,
        &selector,
        &HookFailurePolicy::EmitAndContinue,
    );
    assert_eq!(
        dup_res.unwrap_err().unwrap(),
        StreamError::HookAlreadyRegistered
    );

    // Unregister hook
    f.client
        .mock_all_auths()
        .unregister_hook(&f.sender, &id, &HookEventClass::Withdraw);

    // Hook is gone
    assert!(f.client.get_hook(&id, &HookEventClass::Withdraw).is_none());

    // Unregistering again fails with HookNotFound
    let not_found =
        f.client
            .mock_all_auths()
            .try_unregister_hook(&f.sender, &id, &HookEventClass::Withdraw);
    assert_eq!(not_found.unwrap_err().unwrap(), StreamError::HookNotFound);
}

#[test]
fn test_hook_failure_policies() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let non_existent_contract = Address::generate(&f.env);
    let selector = Symbol::new(&f.env, "notify");

    // Register with EmitAndContinue
    f.client.mock_all_auths().register_hook(
        &f.sender,
        &id,
        &HookEventClass::Withdraw,
        &non_existent_contract,
        &selector,
        &HookFailurePolicy::EmitAndContinue,
    );

    f.advance_time(2 * DAY);

    // Withdraw succeeds despite failing callback because policy is EmitAndContinue
    let ok_res = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &crate::MIN_CLAIM_AMOUNT);
    assert!(ok_res.is_ok());

    // Unregister and re-register with Revert policy
    f.client
        .mock_all_auths()
        .unregister_hook(&f.sender, &id, &HookEventClass::Withdraw);

    f.client.mock_all_auths().register_hook(
        &f.sender,
        &id,
        &HookEventClass::Withdraw,
        &non_existent_contract,
        &selector,
        &HookFailurePolicy::Revert,
    );

    // Withdraw now reverts with HookExecutionFailed
    let fail_res = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &crate::MIN_CLAIM_AMOUNT);
    assert_eq!(
        fail_res.unwrap_err().unwrap(),
        StreamError::HookExecutionFailed
    );
}
