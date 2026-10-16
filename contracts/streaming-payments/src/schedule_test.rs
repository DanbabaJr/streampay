//! Tests for the scheduled-intent (keeper-executable) subsystem.
//!
//! Covers the full lifecycle — scheduling, escrow accounting, permissionless
//! execution, per-occurrence timing, recurrence windows, cancellation, expiry
//! reclamation, and the security-critical paths called out in the issue:
//! **double-execution races** and **expired-auth replay**, plus the defensive
//! params-commitment integrity check.
#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event as _, Vec,
};

use crate::stream::DataKey;
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{
    IntentStatus, ScheduledIntent, StreamError, StreamStatus, StreamingPayments, MAX_OCCURRENCES,
};

// ---------------------------------------------------------------- fixtures --

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;
const FEE: i128 = 1_000_000;

struct Fixture {
    env: Env,
    token: Address,
    client: Client<'static>,
    sender: Address,
    recipient: Address,
    keeper: Address,
}

impl Fixture {
    fn setup() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = sac.address();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let keeper = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&sender, &(1_000 * DEPOSIT));

        let governor = Address::generate(&env);
        let contract_id = env.register(StreamingPayments, (governor,));
        let client = Client::new(&env, &contract_id);
        StellarAssetClient::new(&env, &token).approve(
            &sender,
            &contract_id,
            &(10_000 * DEPOSIT),
            &1_000_000u32,
        );

        Fixture {
            env,
            token,
            client,
            sender,
            recipient,
            keeper,
        }
    }

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn contract_balance(&self) -> i128 {
        self.balance(&self.client.address)
    }

    /// Schedules a one-shot intent with `execute_after = now`, `start_time =
    /// now + start_in`, and a generous expiry.
    #[allow(clippy::too_many_arguments)]
    fn schedule_one_shot(&self, deposit: i128, start_in: u64, duration: u64, fee: i128) -> u64 {
        let now = self.now();
        self.client.mock_all_auths().schedule_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &deposit,
            &(now + start_in),
            &(now + start_in + duration),
            &false,
            &0,
            &1,
            &fee,
            &now,
            &(now + 365 * DAY),
        )
    }
}

// ------------------------------------------------------------ scheduling ----

#[test]
fn schedule_escrows_and_stores_intent() {
    let f = Fixture::setup();
    let now = f.now();
    let sender_before = f.balance(&f.sender);

    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &true,
        &0,
        &1,
        &FEE,
        &now,
        &(now + 30 * DAY),
    );

    let intent = f.client.get_intent(&id);
    assert_eq!(intent.id, id);
    assert_eq!(intent.sender, f.sender);
    assert_eq!(intent.recipient, f.recipient);
    assert_eq!(intent.token, f.token);
    assert_eq!(intent.deposit, DEPOSIT);
    assert_eq!(intent.start_time, now + DAY);
    assert_eq!(intent.end_time, now + 11 * DAY);
    assert!(intent.cancelable);
    assert_eq!(intent.interval, 0);
    assert_eq!(intent.occurrences_total, 1);
    assert_eq!(intent.occurrences_remaining, 1);
    assert_eq!(intent.fee_budget, FEE);
    assert_eq!(intent.execute_after, now);
    assert_eq!(intent.expires_at, now + 30 * DAY);
    assert_eq!(intent.status, IntentStatus::Pending);

    // The params commitment matches the immutable parameters.
    assert_eq!(
        intent.params_hash,
        crate::schedule::params_hash(
            &f.env,
            &f.sender,
            &f.recipient,
            &f.token,
            DEPOSIT,
            now + DAY,
            now + 11 * DAY,
            true,
            0,
            1,
            FEE,
            now,
            now + 30 * DAY,
        ),
    );

    // Full escrow (deposit + fee) moved into the contract.
    assert_eq!(f.balance(&f.sender), sender_before - (DEPOSIT + FEE));
    assert_eq!(f.contract_balance(), DEPOSIT + FEE);

    // Intent is indexed under its sender.
    assert_eq!(
        f.client.sender_intents(&f.sender, &0, &10),
        Vec::from_slice(&f.env, &[id]),
    );
}

#[test]
fn schedule_rejects_zero_and_negative_amounts() {
    let f = Fixture::setup();
    let now = f.now();
    for deposit in [0i128, -1] {
        let err = f
            .client
            .mock_all_auths()
            .try_schedule_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &deposit,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
                &0,
                &1,
                &FEE,
                &now,
                &(now + 30 * DAY),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, StreamError::ZeroAmount);
    }

    // A negative keeper fee budget is a parameter error.
    let err = f
        .client
        .mock_all_auths()
        .try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 2 * DAY),
            &false,
            &0,
            &1,
            &-1,
            &now,
            &(now + 30 * DAY),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidScheduleParameters);
}

#[test]
fn schedule_rejects_invalid_time_range() {
    let f = Fixture::setup();
    let now = f.now();
    let schedule = |start: u64, end: u64| {
        f.client.mock_all_auths().try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &start,
            &end,
            &false,
            &0,
            &1,
            &FEE,
            &now,
            &(now + 30 * DAY),
        )
    };

    // end == start
    assert_eq!(
        schedule(now + DAY, now + DAY).unwrap_err().unwrap(),
        StreamError::InvalidTimeRange,
    );
    // duration over the maximum
    assert_eq!(
        schedule(now + DAY, now + DAY + crate::MAX_DURATION_SECONDS + 1)
            .unwrap_err()
            .unwrap(),
        StreamError::DurationTooLong,
    );
}

#[test]
fn schedule_rejects_deposit_that_overflows_rate_math() {
    let f = Fixture::setup();
    let now = f.now();
    let err = f
        .client
        .mock_all_auths()
        .try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &i128::MAX,
            &(now + DAY),
            &(now + DAY + 2 * 365 * DAY),
            &false,
            &0,
            &1,
            &FEE,
            &now,
            &(now + 30 * DAY),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MathOverflow);
}

#[test]
fn schedule_rejects_inconsistent_occurrence_interval() {
    let f = Fixture::setup();
    let now = f.now();
    let schedule = |interval: u64, occurrences: u32| {
        f.client.mock_all_auths().try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 2 * DAY),
            &false,
            &interval,
            &occurrences,
            &FEE,
            &now,
            &(now + 30 * DAY),
        )
    };

    assert_eq!(
        schedule(0, 0).unwrap_err().unwrap(),
        StreamError::InvalidScheduleParameters
    );
    assert_eq!(
        schedule(0, MAX_OCCURRENCES + 1).unwrap_err().unwrap(),
        StreamError::InvalidScheduleParameters
    );
    // One-shot with a non-zero interval.
    assert_eq!(
        schedule(DAY, 1).unwrap_err().unwrap(),
        StreamError::InvalidScheduleParameters
    );
    // Recurring with a zero interval.
    assert_eq!(
        schedule(0, 3).unwrap_err().unwrap(),
        StreamError::InvalidScheduleParameters
    );
}

#[test]
fn schedule_rejects_past_start() {
    let f = Fixture::setup();
    let now = f.now();
    let err = f
        .client
        .mock_all_auths()
        .try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &now, // not strictly in the future
            &(now + DAY),
            &false,
            &0,
            &1,
            &FEE,
            &now,
            &(now + 30 * DAY),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StartTimeInPast);
}

#[test]
fn schedule_rejects_bad_execution_window() {
    let f = Fixture::setup();
    f.advance(DAY);
    let now = f.now();
    let schedule = |execute_after: u64, expires_at: u64| {
        f.client.mock_all_auths().try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 2 * DAY),
            &false,
            &0,
            &1,
            &FEE,
            &execute_after,
            &expires_at,
        )
    };

    // execute_after before now
    assert_eq!(
        schedule(now - 1, now + 30 * DAY).unwrap_err().unwrap(),
        StreamError::InvalidScheduleParameters
    );
    // execute_after after start_time
    assert_eq!(
        schedule(now + 2 * DAY, now + 30 * DAY)
            .unwrap_err()
            .unwrap(),
        StreamError::InvalidScheduleParameters
    );
    // expires_at not after execute_after
    assert_eq!(
        schedule(now, now).unwrap_err().unwrap(),
        StreamError::InvalidScheduleParameters
    );
}

#[test]
fn schedule_rejects_recurrence_window_overflow() {
    let f = Fixture::setup();
    let now = f.now();
    let err = f
        .client
        .mock_all_auths()
        .try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 2 * DAY),
            &false,
            &u64::MAX, // interval * (occurrences - 1) overflows
            &2,
            &FEE,
            &now,
            &(now + 30 * DAY),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidScheduleParameters);
}

#[test]
fn schedule_rejects_escrow_overflow() {
    let f = Fixture::setup();
    let now = f.now();
    // deposit + fee overflows i128; duration 1 keeps the rate product in range.
    let err = f
        .client
        .mock_all_auths()
        .try_schedule_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &i128::MAX,
            &(now + DAY),
            &(now + DAY + 1),
            &false,
            &0,
            &1,
            &1,
            &now,
            &(now + 30 * DAY),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MathOverflow);
}

#[test]
fn get_intent_unknown_reverts() {
    let f = Fixture::setup();
    let err = f.client.try_get_intent(&999).unwrap_err().unwrap();
    assert_eq!(err, StreamError::IntentNotFound);
}

// ------------------------------------------------------------- execution ----

#[test]
fn execute_before_due_reverts() {
    let f = Fixture::setup();
    let now = f.now();
    // Executable only after now + DAY.
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 5 * DAY),
        &(now + 15 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &(now + DAY),
        &(now + 30 * DAY),
    );
    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&id, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotYetExecutable);
}

#[test]
fn execute_creates_stream_and_pays_keeper() {
    let f = Fixture::setup();
    let now = f.now();
    let expected_fee_recipient_before = f.balance(&f.keeper);
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);

    let stream_id = f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);
    // `events().all()` reports the last invocation's events, so snapshot it
    // before any further client calls.
    let events = f.env.events().all();

    let stream = f.client.get_stream(&stream_id);
    assert_eq!(stream.sender, f.sender);
    assert_eq!(stream.recipient, f.recipient);
    assert_eq!(stream.deposit, DEPOSIT);
    assert_eq!(stream.start_time, now + DAY);
    assert_eq!(stream.end_time, now + 11 * DAY);
    assert_eq!(stream.status, StreamStatus::Active);

    // Intent advanced to terminal (one-shot) and the keeper was paid.
    let intent = f.client.get_intent(&id);
    assert_eq!(intent.status, IntentStatus::Executed);
    assert_eq!(intent.occurrences_remaining, 0);
    assert_eq!(f.balance(&f.keeper) - expected_fee_recipient_before, FEE);
    // Deposit is now locked as stream balance; only the fee left the contract.
    assert_eq!(f.contract_balance(), DEPOSIT);

    // Execution creates the stream (emitting `StreamCreated`) and then emits
    // `ScheduledStreamExecuted`, in that order.
    let created = crate::StreamCreated {
        stream_id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: now + DAY,
        end_time: now + 11 * DAY,
        cancelable: false,
    };
    let executed = crate::ScheduledStreamExecuted {
        intent_id: id,
        keeper: f.keeper.clone(),
        stream_id,
        occurrence_index: 0,
        occurrences_remaining: 0,
        fee_paid: FEE,
    };
    assert_eq!(
        events.filter_by_contract(&f.client.address),
        [
            created.to_xdr(&f.env, &f.client.address),
            executed.to_xdr(&f.env, &f.client.address),
        ],
    );
}

#[test]
fn execute_twice_reverts_double_execution_race() {
    let f = Fixture::setup();
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);
    f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);

    // A second keeper (or the same one) racing the same intent reverts: the
    // occurrence is already materialized.
    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&id, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotPending);

    // Exactly one stream exists.
    assert_eq!(f.client.sender_streams(&f.sender, &0, &10).len(), 1);
}

#[test]
fn execute_expired_intent_reverts_expired_auth_replay() {
    let f = Fixture::setup();
    let now = f.now();
    // Window: [now, now + DAY). Expires before it can be executed.
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 5 * DAY),
        &(now + 15 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &now,
        &(now + DAY),
    );

    f.advance(DAY); // now == expires_at -> no execution allowed
    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&id, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentExpired);

    // The stale authorization cannot be replayed and no stream was created.
    assert!(f.client.sender_streams(&f.sender, &0, &10).is_empty());
}

#[test]
fn execute_late_backfills_accrual() {
    let f = Fixture::setup();
    let now = f.now();
    // Executable immediately, stream starts in 1 day.
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);

    f.advance(3 * DAY); // 2 days past the scheduled start
    let stream_id = f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);

    let stream = f.client.get_stream(&stream_id);
    assert_eq!(stream.start_time, now + DAY); // window preserved, not shifted
                                              // 2 of 10 days elapsed -> 1/5 accrued immediately on creation.
    assert_eq!(f.client.available(&stream_id), DEPOSIT / 5);
}

#[test]
fn execute_with_zero_fee_still_creates_stream() {
    let f = Fixture::setup();
    let keeper_before = f.balance(&f.keeper);
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, 0);
    let stream_id = f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);
    assert_eq!(f.client.get_stream(&stream_id).deposit, DEPOSIT);
    assert_eq!(f.balance(&f.keeper), keeper_before);
}

#[test]
fn execute_requires_keeper_authorization() {
    let f = Fixture::setup();
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);

    // No authorization granted: the keeper's required auth is unsatisfied.
    f.env.mock_auths(&[]);
    assert!(f.client.try_execute_scheduled(&id, &f.keeper).is_err());
}

#[test]
fn execute_permissionless_any_keeper_may_claim() {
    let f = Fixture::setup();
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);
    let rival = Address::generate(&f.env);
    let before = f.balance(&rival);
    f.client.mock_all_auths().execute_scheduled(&id, &rival);
    assert_eq!(f.balance(&rival) - before, FEE);
}

#[test]
fn execute_unknown_intent_reverts() {
    let f = Fixture::setup();
    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&999, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotFound);
}

#[test]
fn execute_rejects_tampered_intent_params() {
    let f = Fixture::setup();
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);

    // Simulate storage corruption: change the deposit without updating the
    // commitment. The defensive integrity check must reject execution.
    let contract = f.client.address.clone();
    f.env.as_contract(&contract, || {
        let mut intent: ScheduledIntent = f
            .env
            .storage()
            .persistent()
            .get(&DataKey::Intent(id))
            .unwrap();
        intent.deposit += 1;
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Intent(id), &intent);
    });

    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&id, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentParamsMismatch);
}

// ------------------------------------------------------------ recurrence ----

#[test]
fn recurring_executes_each_occurrence_with_shifted_windows() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &DAY,
        &3,
        &FEE,
        &now,
        &(now + 100 * DAY),
    );

    let keeper_before = f.balance(&f.keeper);
    let mut stream_ids = [0u64; 3];
    for (i, slot) in stream_ids.iter_mut().enumerate() {
        if i > 0 {
            f.advance(DAY); // reach the next occurrence's due time
        }
        *slot = f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);
        let stream = f.client.get_stream(slot);
        let shift = i as u64 * DAY;
        assert_eq!(stream.start_time, now + DAY + shift);
        assert_eq!(stream.end_time, now + 11 * DAY + shift);
    }

    let intent = f.client.get_intent(&id);
    assert_eq!(intent.status, IntentStatus::Executed);
    assert_eq!(intent.occurrences_remaining, 0);
    assert_eq!(f.balance(&f.keeper) - keeper_before, 3 * FEE);
    // All three deposits remain locked as stream balances.
    assert_eq!(f.contract_balance(), 3 * DEPOSIT);
}

#[test]
fn recurring_enforces_per_occurrence_due_time() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &DAY,
        &2,
        &FEE,
        &now,
        &(now + 100 * DAY),
    );

    f.client.mock_all_auths().execute_scheduled(&id, &f.keeper); // occurrence 0
                                                                 // Occurrence 1 is not due for another day.
    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&id, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotYetExecutable);
}

#[test]
fn recurring_allows_catch_up_after_missed_occurrences() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &DAY,
        &3,
        &FEE,
        &now,
        &(now + 100 * DAY),
    );

    // Run far past every occurrence's due time, then catch up in one go.
    f.advance(50 * DAY);
    for _ in 0..3 {
        f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);
    }
    assert_eq!(f.client.get_intent(&id).status, IntentStatus::Executed);
    assert_eq!(f.client.sender_streams(&f.sender, &0, &10).len(), 3);
}

#[test]
fn recurring_reclaim_refunds_only_outstanding_occurrences() {
    let f = Fixture::setup();
    let now = f.now();
    let sender_before = f.balance(&f.sender);
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &DAY,
        &3,
        &FEE,
        &now,
        &(now + 10 * DAY),
    );
    assert_eq!(f.balance(&f.sender), sender_before - 3 * (DEPOSIT + FEE));

    // Execute exactly one occurrence, then let the rest expire.
    f.client.mock_all_auths().execute_scheduled(&id, &f.keeper);
    f.advance(20 * DAY);

    f.client.reclaim_expired(&id); // permissionless: no auth needed
    let intent = f.client.get_intent(&id);
    assert_eq!(intent.status, IntentStatus::Expired);
    assert_eq!(intent.occurrences_remaining, 2);

    // Refund is the two outstanding occurrences' escrow; the executed one's
    // deposit stays locked in its stream. Net cost to the sender is one
    // occurrence's deposit + fee.
    assert_eq!(f.balance(&f.sender), sender_before - (DEPOSIT + FEE));
    assert_eq!(f.contract_balance(), DEPOSIT);
}

// ------------------------------------------------------------ cancel --------

#[test]
fn cancel_before_window_refunds_and_blocks_execution() {
    let f = Fixture::setup();
    let now = f.now();
    let sender_before = f.balance(&f.sender);
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 5 * DAY),
        &(now + 15 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &(now + DAY), // window opens tomorrow
        &(now + 30 * DAY),
    );
    assert_eq!(f.balance(&f.sender), sender_before - (DEPOSIT + FEE));

    f.client.mock_all_auths().cancel_scheduled(&f.sender, &id);
    let events = f.env.events().all();

    let intent = f.client.get_intent(&id);
    assert_eq!(intent.status, IntentStatus::Cancelled);
    assert_eq!(f.balance(&f.sender), sender_before);
    assert_eq!(f.contract_balance(), 0);

    let cancelled = crate::ScheduledIntentCancelled {
        intent_id: id,
        sender: f.sender.clone(),
        refund: DEPOSIT + FEE,
    };
    assert_eq!(
        events.filter_by_contract(&f.client.address),
        [cancelled.to_xdr(&f.env, &f.client.address)],
    );

    // A cancelled intent cannot be executed.
    let err = f
        .client
        .mock_all_auths()
        .try_execute_scheduled(&id, &f.keeper)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotPending);
}

#[test]
fn cancel_after_window_opens_reverts() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 5 * DAY),
        &(now + 15 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &(now + DAY),
        &(now + 30 * DAY),
    );
    f.advance(DAY); // now == execute_after
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_scheduled(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotCancellable);
}

#[test]
fn cancel_after_expiry_reverts() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 5 * DAY),
        &(now + 15 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &(now + DAY),
        &(now + 2 * DAY),
    );
    f.advance(5 * DAY); // past expiry
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_scheduled(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentExpired);
}

#[test]
fn cancel_requires_sender() {
    let f = Fixture::setup();
    let id = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);
    let attacker = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_scheduled(&attacker, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
}

#[test]
fn cancel_unknown_intent_reverts() {
    let f = Fixture::setup();
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_scheduled(&f.sender, &999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::IntentNotFound);
}

// ------------------------------------------------------------ reclaim -------

#[test]
fn reclaim_before_expiry_reverts() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &now,
        &(now + 10 * DAY),
    );
    let err = f.client.try_reclaim_expired(&id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::IntentNotExpired);
}

#[test]
fn reclaim_after_expiry_refunds_sender_permissionlessly() {
    let f = Fixture::setup();
    let now = f.now();
    let sender_before = f.balance(&f.sender);
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &now,
        &(now + 5 * DAY),
    );

    f.advance(5 * DAY);
    f.client.reclaim_expired(&id);
    let events = f.env.events().all();

    assert_eq!(f.client.get_intent(&id).status, IntentStatus::Expired);
    assert_eq!(f.balance(&f.sender), sender_before);
    assert_eq!(f.contract_balance(), 0);

    let expired = crate::ScheduledIntentExpired {
        intent_id: id,
        sender: f.sender.clone(),
        refund: DEPOSIT + FEE,
    };
    assert_eq!(
        events.filter_by_contract(&f.client.address),
        [expired.to_xdr(&f.env, &f.client.address)],
    );
}

#[test]
fn reclaim_twice_reverts() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &0,
        &1,
        &FEE,
        &now,
        &(now + 5 * DAY),
    );
    f.advance(5 * DAY);
    f.client.reclaim_expired(&id);
    let err = f.client.try_reclaim_expired(&id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::IntentNotPending);
}

#[test]
fn reclaim_unknown_intent_reverts() {
    let f = Fixture::setup();
    let err = f.client.try_reclaim_expired(&999).unwrap_err().unwrap();
    assert_eq!(err, StreamError::IntentNotFound);
}

// ------------------------------------------------------------ index ---------

#[test]
fn sender_intents_paginate_and_clamp() {
    let f = Fixture::setup();
    let mut ids = [0u64; 5];
    for slot in ids.iter_mut() {
        *slot = f.schedule_one_shot(DEPOSIT, DAY, 10 * DAY, FEE);
    }
    assert_eq!(
        f.client.sender_intents(&f.sender, &0, &2),
        Vec::from_slice(&f.env, &ids[0..2]),
    );
    assert_eq!(
        f.client.sender_intents(&f.sender, &2, &2),
        Vec::from_slice(&f.env, &ids[2..4]),
    );
    assert_eq!(
        f.client.sender_intents(&f.sender, &4, &2),
        Vec::from_slice(&f.env, &ids[4..5]),
    );
    assert!(f.client.sender_intents(&f.sender, &99, &2).is_empty());
    assert_eq!(f.client.sender_intents(&f.sender, &0, &u32::MAX).len(), 5);

    let other = Address::generate(&f.env);
    assert!(f.client.sender_intents(&other, &0, &50).is_empty());
}

#[test]
fn schedule_emits_expected_event() {
    let f = Fixture::setup();
    let now = f.now();
    let id = f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 11 * DAY),
        &false,
        &DAY,
        &3,
        &FEE,
        &now,
        &(now + 100 * DAY),
    );
    let scheduled = crate::StreamScheduled {
        intent_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: now + DAY,
        end_time: now + 11 * DAY,
        cancelable: false,
        interval: DAY,
        occurrences: 3,
        fee_budget: FEE,
        execute_after: now,
        expires_at: now + 100 * DAY,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [scheduled.to_xdr(&f.env, &f.client.address)],
    );
}
