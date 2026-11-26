//! Tests for dust protection and the permissionless sweeper (#78).
//!
//! Three groups:
//!
//! * the economic floors (`MIN_STREAM_DEPOSIT` on every creation path,
//!   `MIN_CLAIM_AMOUNT` on mid-stream single claims, and the floor lifting once
//!   accrual stops);
//! * the sweep happy paths (`Depleted`, `Cancelled`, cancelled-while-paused),
//!   including exactly what is deleted, what is kept and what is pruned;
//! * the adversarial sweep matrix: every state that still carries a claim on a
//!   stream must refuse the sweep and leave every byte of the stream in place.
#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::{Client as TokenClient, StellarAssetClient},
    xdr::ToXdr,
    Address, Event as _, Symbol, Vec,
};

use crate::dispute::{self, Dispute, DisputeKey};
use crate::stream::{BatchEntry, DataKey, VersionedStream};
use crate::test::Fixture;
use crate::{
    ConditionPredicate, HookEventClass, HookFailurePolicy, StreamError, StreamInput, StreamStatus,
    StreamSwept, MIN_CLAIM_AMOUNT, MIN_STREAM_DEPOSIT, SWEEP_GRACE_SECONDS,
};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

// ---------------------------------------------------------------- helpers

fn has_persistent(f: &Fixture, key: &DataKey) -> bool {
    f.env
        .as_contract(&f.client.address, || f.env.storage().persistent().has(key))
}

fn has_dispute_key(f: &Fixture, key: &DisputeKey) -> bool {
    f.env
        .as_contract(&f.client.address, || f.env.storage().persistent().has(key))
}

fn contract_balance(f: &Fixture) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(&f.client.address)
}

/// A one-day stream starting now, drained to `Depleted` at its end.
fn depleted_stream(f: &Fixture) -> u64 {
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.advance_time(DAY);
    f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Depleted);
    id
}

/// A one-day stream starting now, cancelled halfway through.
fn cancelled_stream(f: &Fixture) -> u64 {
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.advance_time(DAY / 2);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Cancelled);
    id
}

/// Moves the clock to the first second at which `id` may be swept.
fn to_sweep_time(f: &Fixture, id: u64) {
    let end = f.client.get_stream(&id).end_time;
    f.set_ledger_time(end + SWEEP_GRACE_SECONDS);
}

/// Asserts the sweep of `id` is refused with `expected` and that it left the
/// stream record, the indexes and the contract's balance exactly as they were.
fn assert_sweep_refused(f: &Fixture, id: u64, expected: StreamError) {
    let before = f.client.get_stream(&id);
    let balance = contract_balance(f);
    assert!(!f.client.is_sweepable(&id));
    let err = f
        .client
        .try_sweep_stream(&id)
        .expect_err("sweep must be refused")
        .expect("contract error");
    assert_eq!(err, expected);
    assert_eq!(f.client.get_stream(&id), before);
    assert!(f
        .client
        .sender_streams(&before.sender, &0, &100)
        .contains(id));
    assert!(f
        .client
        .recipient_streams(&before.recipient, &0, &100)
        .contains(id));
    assert_eq!(contract_balance(f), balance);
}

fn register_hook(f: &Fixture, id: u64, class: HookEventClass) {
    f.client.mock_all_auths().register_hook(
        &f.sender,
        &id,
        &class,
        &Address::generate(&f.env),
        &Symbol::new(&f.env, "on_evt"),
        &HookFailurePolicy::EmitAndContinue,
    );
}

// ------------------------------------------------------- constants & sizes

#[test]
fn floors_are_ordered_and_match_the_documented_values() {
    // docs/DUST_ECONOMICS.md justifies these exact numbers; changing one is a
    // public-interface change that must update the doc.
    assert_eq!(MIN_CLAIM_AMOUNT, 1_000_000);
    assert_eq!(MIN_STREAM_DEPOSIT, 10_000_000);
    assert_eq!(MIN_STREAM_DEPOSIT, 10 * MIN_CLAIM_AMOUNT);
    assert_eq!(SWEEP_GRACE_SECONDS, 2_592_000);
}

#[test]
fn per_stream_entry_sizes_stay_within_the_documented_estimate() {
    // The rent figures in docs/DUST_ECONOMICS.md assume a stream record value
    // of at most 512 bytes of XDR and a fee record of at most 128 bytes.
    let f = Fixture::setup_quiet();
    f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let (stream_len, fee_len) = f.env.as_contract(&f.client.address, || {
        let storage = f.env.storage().persistent();
        let stream: VersionedStream = storage.get(&DataKey::Stream(id)).unwrap();
        let fee: crate::treasury::StreamFeeRecord = storage.get(&DataKey::StreamFee(id)).unwrap();
        (stream.to_xdr(&f.env).len(), fee.to_xdr(&f.env).len())
    });
    std::println!("stream record XDR bytes: {stream_len}; fee record XDR bytes: {fee_len}");
    assert!(
        stream_len <= 512,
        "stream record grew to {stream_len} bytes"
    );
    assert!(fee_len <= 128, "fee record grew to {fee_len} bytes");
}

// ------------------------------------------------------------- deposit floor

#[test]
fn create_stream_rejects_a_deposit_one_below_the_floor_and_accepts_the_floor() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &(MIN_STREAM_DEPOSIT - 1),
        &now,
        &(now + DAY),
        &false,
    );
    assert_eq!(res.unwrap_err().unwrap(), StreamError::DepositBelowMinimum);
    assert_eq!(contract_balance(&f), 0);

    let id = f.create_stream(MIN_STREAM_DEPOSIT, 0, DAY, false);
    assert_eq!(f.client.get_stream(&id).deposit, MIN_STREAM_DEPOSIT);
}

#[test]
fn non_positive_deposits_keep_their_original_error() {
    // The floor is checked after the sign check, so a zero deposit still
    // reports the pre-#78 error and existing clients see no change.
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &0,
        &now,
        &(now + DAY),
        &false,
    );
    assert_ne!(res.unwrap_err().unwrap(), StreamError::DepositBelowMinimum);
}

#[test]
fn create_streams_rejects_a_sub_floor_entry_atomically() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let input = |deposit: i128| StreamInput {
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit_amount: deposit,
        start_time: now,
        end_time: now + DAY,
        cancelable: false,
    };
    let inputs = Vec::from_array(&f.env, [input(DEPOSIT / 2), input(MIN_STREAM_DEPOSIT - 1)]);
    let res = f
        .client
        .mock_all_auths()
        .try_create_streams(&f.sender, &inputs);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::DepositBelowMinimum);
    assert_eq!(contract_balance(&f), 0);
    assert!(f.client.sender_streams(&f.sender, &0, &10).is_empty());
}

#[test]
fn create_streams_batch_reports_the_floor_per_entry() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let entry = |deposit: i128| BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit,
        start_time: now,
        end_time: now + DAY,
        cancelable: false,
    };
    let entries = Vec::from_array(&f.env, [entry(MIN_STREAM_DEPOSIT - 1), entry(DEPOSIT / 2)]);
    let results = f.client.mock_all_auths().create_streams_batch(&entries);
    assert_eq!(results.get(0), Some(Err(StreamError::DepositBelowMinimum)));
    assert!(matches!(results.get(1), Some(Ok(_))));
}

#[test]
fn schedule_stream_rejects_a_sub_floor_occurrence() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let res = f.client.mock_all_auths().try_schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &(MIN_STREAM_DEPOSIT - 1),
        &(now + 2 * DAY),
        &(now + 3 * DAY),
        &false,
        &0,
        &1,
        &0,
        &(now + DAY),
        &(now + 2 * DAY),
    );
    assert_eq!(res.unwrap_err().unwrap(), StreamError::DepositBelowMinimum);
}

// --------------------------------------------------------------- claim floor

#[test]
fn mid_stream_withdraw_below_the_floor_is_refused_and_the_floor_itself_pays() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(DAY);
    let res = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &(MIN_CLAIM_AMOUNT - 1));
    assert_eq!(res.unwrap_err().unwrap(), StreamError::ClaimBelowMinimum);
    assert_eq!(f.client.get_stream(&id).withdrawn, 0);

    f.client.mock_all_auths().withdraw(&id, &MIN_CLAIM_AMOUNT);
    assert_eq!(f.client.get_stream(&id).withdrawn, MIN_CLAIM_AMOUNT);
}

#[test]
fn mid_stream_withdraw_max_below_the_floor_is_refused_until_enough_accrues() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    // ~11_574 base units accrue per second.
    f.advance_time(1);
    let res = f.client.mock_all_auths().try_withdraw_max(&id);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::ClaimBelowMinimum);

    f.advance_time(100);
    let paid = f.client.mock_all_auths().withdraw_max(&id);
    assert!(paid >= MIN_CLAIM_AMOUNT);
}

#[test]
fn withdraw_max_with_nothing_accrued_keeps_its_original_error() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, DAY, false);
    let res = f.client.mock_all_auths().try_withdraw_max(&id);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::NothingToWithdraw);
}

#[test]
fn claim_floor_lifts_once_the_window_has_ended() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, false);
    f.advance_time(DAY);
    f.client.mock_all_auths().withdraw(&id, &1);
    f.client.mock_all_auths().withdraw(&id, &(DEPOSIT - 6));
    // A 5-unit tail is claimable in full: nothing is ever stranded.
    assert_eq!(f.client.mock_all_auths().withdraw_max(&id), 5);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Depleted);
}

#[test]
fn claim_floor_lifts_while_the_stream_is_paused() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(1);
    f.client.mock_all_auths().pause_stream(&f.sender, &id);
    // Accrual is frozen, so waiting would never grow the balance: the floor
    // must not apply.
    let paid = f.client.mock_all_auths().withdraw_max(&id);
    assert!(paid > 0 && paid < MIN_CLAIM_AMOUNT);

    f.client.mock_all_auths().resume_stream(&f.sender, &id);
    f.advance_time(1);
    let res = f.client.mock_all_auths().try_withdraw(&id, &1);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::ClaimBelowMinimum);
}

#[test]
fn batched_claims_are_exempt_from_the_single_claim_floor() {
    // withdraw_many amortizes one transaction fee across many streams, so the
    // per-call floor does not apply to it (see docs/DUST_ECONOMICS.md).
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(1);
    let ids = Vec::from_array(&f.env, [id]);
    f.client
        .mock_all_auths()
        .withdraw_many(&f.recipient, &ids, &true);
    let withdrawn = f.client.get_stream(&id).withdrawn;
    assert!(withdrawn > 0 && withdrawn < MIN_CLAIM_AMOUNT);
}

// ------------------------------------------------------- sweep: happy paths

#[test]
fn sweep_removes_a_depleted_stream_and_keeps_the_fee_record() {
    let f = Fixture::setup_quiet();
    f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
    let id = depleted_stream(&f);
    assert!(has_persistent(&f, &DataKey::StreamFee(id)));
    to_sweep_time(&f, id);
    assert!(f.client.is_sweepable(&id));

    let balance = contract_balance(&f);
    let sender_balance = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    // No authorization is mocked: anyone may sweep.
    let removed = f.client.sweep_stream(&id);
    assert_eq!(removed, 1);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [StreamSwept {
            stream_id: id,
            refund_target: f.sender.clone(),
            depleted: true,
            entries_removed: 1,
        }
        .to_xdr(&f.env, &f.client.address)]
    );

    assert_eq!(
        f.client.try_get_stream(&id).unwrap_err().unwrap(),
        StreamError::StreamNotFound
    );
    assert!(!has_persistent(&f, &DataKey::Stream(id)));
    assert!(has_persistent(&f, &DataKey::StreamFee(id)));
    assert!(!f.client.sender_streams(&f.sender, &0, &10).contains(id));
    assert!(!f
        .client
        .recipient_streams(&f.recipient, &0, &10)
        .contains(id));
    // No tokens move.
    assert_eq!(contract_balance(&f), balance);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        sender_balance
    );
}

#[test]
fn sweep_removes_a_cancelled_stream_and_records_the_refund_target() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    let target = Address::generate(&f.env);
    f.client
        .mock_all_auths()
        .set_refund_target(&f.sender, &id, &target);
    f.advance_time(DAY / 2);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(contract_balance(&f), 0);
    assert!(has_persistent(&f, &DataKey::RefundTarget(id)));

    to_sweep_time(&f, id);
    let removed = f.client.sweep_stream(&id);
    assert_eq!(removed, 2);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [StreamSwept {
            stream_id: id,
            refund_target: target,
            depleted: false,
            entries_removed: 2,
        }
        .to_xdr(&f.env, &f.client.address)]
    );
    assert!(!has_persistent(&f, &DataKey::Stream(id)));
    assert!(!has_persistent(&f, &DataKey::RefundTarget(id)));
}

#[test]
fn sweep_accepts_a_stream_cancelled_while_paused_and_drops_the_stale_marker() {
    // resume_stream refuses a non-Active stream, so this pause marker can
    // never be cleared any other way; it must not block the sweep forever.
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.advance_time(DAY / 4);
    f.client.mock_all_auths().pause_stream(&f.sender, &id);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert!(has_persistent(&f, &DataKey::StreamPause(id)));
    assert_eq!(contract_balance(&f), 0);

    to_sweep_time(&f, id);
    assert_eq!(f.client.sweep_stream(&id), 2);
    assert!(!has_persistent(&f, &DataKey::StreamPause(id)));
}

#[test]
fn sweep_removes_settled_side_records() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, DAY, true);

    // A met release condition with one attestation.
    let publisher = Address::generate(&f.env);
    let publishers = Vec::from_array(&f.env, [publisher.clone()]);
    let now = f.env.ledger().timestamp();
    f.client.mock_all_auths().register_condition(
        &f.sender,
        &id,
        &ConditionPredicate::Boolean(true),
        &publishers,
        &1,
        &(now + DAY),
    );
    f.client
        .mock_all_auths()
        .attest_condition(&publisher, &id, &ConditionPredicate::Boolean(true));
    assert!(!f.client.is_release_gated(&id));

    // A dispute round that expired (leaves the round counter behind).
    f.raise_dispute(id);
    f.advance_time(crate::DISPUTE_TIMEOUT_SECONDS);
    f.client.expire_dispute(&id);
    assert!(has_dispute_key(&f, &DisputeKey::Count(id)));

    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    to_sweep_time(&f, id);
    // Stream, DisputeKey::Count, StreamCondition, one attestation.
    assert_eq!(f.client.sweep_stream(&id), 4);
    assert!(!has_persistent(&f, &DataKey::StreamCondition(id)));
    assert!(!has_persistent(
        &f,
        &DataKey::ConditionAttestation(id, publisher)
    ));
    assert!(!has_dispute_key(&f, &DisputeKey::Count(id)));
}

#[test]
fn sweep_leaves_sibling_streams_of_the_same_parties_untouched() {
    let f = Fixture::setup_quiet();
    let live = f.create_stream(DEPOSIT / 2, 0, 400 * DAY, false);
    let done = f.create_stream(DEPOSIT / 2, 0, DAY, true);
    f.advance_time(DAY / 2);
    f.client.mock_all_auths().cancel_stream(&f.sender, &done);
    let live_before = f.client.get_stream(&live);
    let balance = contract_balance(&f);
    assert!(balance > 0);

    to_sweep_time(&f, done);
    f.client.sweep_stream(&done);

    assert_eq!(f.client.get_stream(&live), live_before);
    assert_eq!(contract_balance(&f), balance);
    assert_eq!(
        f.client.sender_streams(&f.sender, &0, &10),
        Vec::from_array(&f.env, [live])
    );
    assert_eq!(
        f.client.recipient_streams(&f.recipient, &0, &10),
        Vec::from_array(&f.env, [live])
    );
    // The live stream still pays out normally.
    f.client.mock_all_auths().withdraw_max(&live);
    assert!(f.client.get_stream(&live).withdrawn > 0);
}

// -------------------------------------------------- sweep: adversarial matrix

#[test]
fn sweep_never_touches_an_active_stream_at_any_time() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, DAY, true);
    // Before start, mid-window, at end, at end + grace, and far beyond: an
    // Active stream (here: ended but never fully claimed) is never sweepable.
    for t in [
        0,
        DAY + DAY / 2,
        2 * DAY,
        2 * DAY + SWEEP_GRACE_SECONDS,
        2 * DAY + 100 * SWEEP_GRACE_SECONDS,
    ] {
        f.set_ledger_time(t);
        assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
    }
    // Partly claimed after the end: still Active, still holds tokens.
    f.client.mock_all_auths().withdraw(&id, &(DEPOSIT - 1));
    assert_eq!(contract_balance(&f), 1);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_a_paused_active_stream() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.advance_time(DAY / 2);
    f.client.mock_all_auths().pause_stream(&f.sender, &id);
    f.advance_time(DAY + SWEEP_GRACE_SECONDS);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_respects_the_grace_period_to_the_second() {
    let f = Fixture::setup_quiet();
    let id = depleted_stream(&f);
    let end = f.client.get_stream(&id).end_time;
    for t in [
        end,
        end + SWEEP_GRACE_SECONDS / 2,
        end + SWEEP_GRACE_SECONDS - 1,
    ] {
        f.set_ledger_time(t);
        assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
    }
    f.set_ledger_time(end + SWEEP_GRACE_SECONDS);
    assert!(f.client.is_sweepable(&id));
    f.client.sweep_stream(&id);
}

#[test]
fn sweep_grace_runs_from_end_time_even_for_an_early_cancel() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 60 * DAY, true);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    // 30 days after the cancel, but still inside the original window.
    f.advance_time(SWEEP_GRACE_SECONDS);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_an_open_dispute() {
    let f = Fixture::setup_quiet();
    let id = cancelled_stream(&f);
    // No public flow reaches a terminal stream with an open dispute
    // (cancel_stream refuses while one is open), so plant one directly: the
    // predicate must hold even if a future flow makes it reachable.
    f.env.as_contract(&f.client.address, || {
        dispute::put_dispute(
            &f.env,
            &Dispute {
                stream_id: id,
                raised_by: f.recipient.clone(),
                bond: 1,
                started_at: 0,
                expires_at: u64::MAX,
            },
        );
    });
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_a_pending_ownership_proposal() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.client.mock_all_auths().propose_ownership_transfer(
        &f.recipient,
        &id,
        &Address::generate(&f.env),
    );
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_a_pending_rate_change() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &(DEPOSIT / (2 * DAY as i128)));
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_a_pending_sender_transfer() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.client.mock_all_auths().propose_sender_transfer(
        &f.sender,
        &id,
        &Address::generate(&f.env),
        &0,
        &false,
    );
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_an_outstanding_advance() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, DAY, true);
    let lender = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&lender, &DEPOSIT);
    f.client
        .mock_all_auths()
        .draw_advance(&id, &lender, &(DEPOSIT / 10), &5_000);
    // Cancelling before start pays the recipient nothing, so nothing is
    // intercepted for the lender and the advance stays outstanding.
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let advance = f.client.get_advance(&id).unwrap();
    assert!(advance.repaid < advance.total_owed);
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_an_unmet_release_condition() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    let publishers = Vec::from_array(&f.env, [Address::generate(&f.env)]);
    let now = f.env.ledger().timestamp();
    f.client.mock_all_auths().register_condition(
        &f.sender,
        &id,
        &ConditionPredicate::Boolean(true),
        &publishers,
        &1,
        &(now + DAY),
    );
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert!(f.client.is_release_gated(&id));
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_a_registered_hook_of_every_class() {
    for class in [
        HookEventClass::Withdraw,
        HookEventClass::Cancel,
        HookEventClass::Complete,
    ] {
        let f = Fixture::setup_quiet();
        let id = cancelled_stream(&f);
        register_hook(&f, id, class);
        to_sweep_time(&f, id);
        assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);

        // Unregistering the hook is all it takes to qualify.
        f.client
            .mock_all_auths()
            .unregister_hook(&f.sender, &id, &class);
        assert!(f.client.is_sweepable(&id));
    }
}

#[test]
fn sweep_refuses_a_held_reentrancy_lock() {
    let f = Fixture::setup_quiet();
    let id = depleted_stream(&f);
    f.env.as_contract(&f.client.address, || {
        crate::hooks::set_stream_locked(&f.env, id, true);
    });
    to_sweep_time(&f, id);
    assert_sweep_refused(&f, id, StreamError::StreamNotSweepable);
}

#[test]
fn sweep_refuses_while_the_contract_is_frozen() {
    let f = Fixture::setup_quiet();
    let id = depleted_stream(&f);
    to_sweep_time(&f, id);
    f.client.mock_all_auths().set_frozen(&f.governor, &true);
    let err = f.client.try_sweep_stream(&id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::ContractFrozen);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Depleted);
}

#[test]
fn sweep_of_an_unknown_or_already_swept_stream_is_not_found() {
    let f = Fixture::setup_quiet();
    assert!(!f.client.is_sweepable(&42));
    assert_eq!(
        f.client.try_sweep_stream(&42).unwrap_err().unwrap(),
        StreamError::StreamNotFound
    );

    let id = depleted_stream(&f);
    to_sweep_time(&f, id);
    f.client.sweep_stream(&id);
    assert!(!f.client.is_sweepable(&id));
    assert_eq!(
        f.client.try_sweep_stream(&id).unwrap_err().unwrap(),
        StreamError::StreamNotFound
    );
}

#[test]
fn swept_ids_are_never_reissued() {
    let f = Fixture::setup_quiet();
    let id = depleted_stream(&f);
    to_sweep_time(&f, id);
    f.client.sweep_stream(&id);
    let next = f.create_stream(DEPOSIT, 0, DAY, false);
    assert!(next > id);
}
