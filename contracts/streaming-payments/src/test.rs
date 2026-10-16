//! Unit and property tests for StreamPay.
//!
//! Covers every edge case from the spec: withdrawal before start, at/after
//! end, cancelling fully-withdrawn and not-yet-started streams, topping up an
//! ended stream, sequential partial withdrawals, checked math under extreme
//! values, zero-duration/zero-amount rejection, reentrancy safety via a
//! malicious token contract, event payloads, an exhaustive accrual property
//! test over the pure rate function, the per-address discovery indexes
//! (append order, pagination, clamping, terminal streams), and `withdraw_max`
//! semantics. Fixed-seed Proptest state-machine sequences exercise the funds
//! invariants across creates, top-ups, withdrawals, and cancellations.
#![cfg(test)]

// The crate is `no_std`, but the test build links std: the property-test
// model uses plain `Vec` and `format!`.
extern crate std;

use std::format;
use std::vec::Vec;

use proptest::{
    prelude::any,
    prop_assert, prop_assert_eq,
    test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestRunner},
};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event as _, IntoVal, MuxedAddress, String as SdkString,
};

use crate::stream::streamed_at;
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{StreamError, StreamInput, StreamStatus, StreamingPayments, MAX_DURATION_SECONDS};

// ---------------------------------------------------------------- fixtures --

pub(crate) const DAY: u64 = 24 * 60 * 60;
/// 1000 tokens with 7 decimals (default for SAC-issued assets in tests).
const DEPOSIT: i128 = 10_000_000_000;

pub(crate) struct Fixture {
    pub(crate) env: Env,
    pub(crate) token: Address,
    pub(crate) client: Client<'static>,
    pub(crate) sender: Address,
    pub(crate) recipient: Address,
    pub(crate) governor: Address,
}

impl Fixture {
    pub(crate) fn setup() -> Self {
        Self::setup_with_snapshot(true)
    }

    /// Like [`Fixture::setup`], but disables the SDK's test-snapshot capture.
    /// The error-surface matrix asserts through the branch trace, so a snapshot
    /// file per probe would be pure noise.
    pub(crate) fn setup_quiet() -> Self {
        Self::setup_with_snapshot(false)
    }

    fn setup_with_snapshot(capture_snapshots: bool) -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: capture_snapshots,
        });
        env.mock_all_auths();
        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = sac.address();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let governor = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&sender, &(2 * DEPOSIT));

        // The constructor binds the treasury governor at "deploy" time.
        let contract_id = env.register(StreamingPayments, (governor.clone(),));
        let client = Client::new(&env, &contract_id);

        // The sender pre-approves the streaming contract to pull tokens for
        // create_stream / top_up (real SAC allowances; mocked auth does not
        // waive allowance amounts).
        StellarAssetClient::new(&env, &token).approve(
            &sender,
            &contract_id,
            &(10 * DEPOSIT),
            &1_000_000u32, // within the test env's max entry TTL
        );

        Fixture {
            env,
            token,
            client,
            sender,
            recipient,
            governor,
        }
    }

    /// Creates a stream starting `start_in` seconds from now, lasting
    /// `duration` seconds, with the given deposit and cancelability.
    pub(crate) fn create_stream(
        &self,
        deposit: i128,
        start_in: u64,
        duration: u64,
        cancelable: bool,
    ) -> u64 {
        let now = self.env.ledger().timestamp();
        self.client.mock_all_auths().create_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &deposit,
            &(now + start_in),
            &(now + start_in + duration),
            &cancelable,
        )
    }

    pub(crate) fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }
}

// ------------------------------------------------------------ creation ------

#[test]
fn create_stream_pulls_deposit_and_stores_state() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let id = f.create_stream(DEPOSIT, DAY, 30 * DAY, true);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.id, id);
    assert_eq!(stream.sender, f.sender);
    assert_eq!(stream.recipient, f.recipient);
    assert_eq!(stream.token, f.token);
    assert_eq!(stream.deposit, DEPOSIT);
    assert_eq!(stream.withdrawn, 0);
    assert_eq!(stream.start_time, now + DAY);
    assert_eq!(stream.end_time, now + DAY + 30 * DAY);
    assert!(stream.cancelable);
    assert_eq!(stream.status, StreamStatus::Active);

    // Deposit was pulled from the sender into the contract.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );
}

#[test]
fn create_streams_creates_multiple_streams_and_pulls_funds_once() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let inputs = soroban_sdk::Vec::from_array(
        &f.env,
        [
            StreamInput {
                recipient: f.recipient.clone(),
                token: f.token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now,
                end_time: now + DAY,
                cancelable: true,
            },
            StreamInput {
                recipient: Address::generate(&f.env),
                token: f.token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now + DAY,
                end_time: now + 2 * DAY,
                cancelable: false,
            },
        ],
    );

    let ids = f.client.mock_all_auths().create_streams(&f.sender, &inputs);
    assert_eq!(ids.len(), 2);
    let batch_event = crate::StreamsCreated {
        sender: f.sender.clone(),
        stream_ids: ids.clone(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [batch_event.to_xdr(&f.env, &f.client.address)]
    );
    assert_eq!(ids.get(0), Some(1));
    assert_eq!(ids.get(1), Some(2));
    assert_eq!(
        f.client.mock_all_auths().get_stream(&1).deposit,
        DEPOSIT / 2
    );
    assert_eq!(
        f.client.mock_all_auths().get_stream(&2).deposit,
        DEPOSIT / 2
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .sender_streams(&f.sender, &0, &50)
            .len(),
        2
    );
}

#[test]
fn create_streams_groups_token_pulls_by_asset() {
    let f = Fixture::setup();
    let other_token = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    StellarAssetClient::new(&f.env, &other_token).mint(&f.sender, &DEPOSIT);
    StellarAssetClient::new(&f.env, &other_token).approve(
        &f.sender,
        &f.client.address,
        &DEPOSIT,
        &1_000_000u32,
    );
    let now = f.env.ledger().timestamp();
    let inputs = soroban_sdk::Vec::from_array(
        &f.env,
        [
            StreamInput {
                recipient: f.recipient.clone(),
                token: f.token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now,
                end_time: now + DAY,
                cancelable: true,
            },
            StreamInput {
                recipient: Address::generate(&f.env),
                token: other_token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now,
                end_time: now + DAY,
                cancelable: false,
            },
        ],
    );

    let ids = f.client.mock_all_auths().create_streams(&f.sender, &inputs);
    assert_eq!(ids.len(), 2);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT / 2
    );
    assert_eq!(
        TokenClient::new(&f.env, &other_token).balance(&f.client.address),
        DEPOSIT / 2
    );
}

#[test]
fn create_streams_charges_fees_for_each_stream() {
    let f = Fixture::setup();
    f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
    let now = f.env.ledger().timestamp();
    let inputs = soroban_sdk::Vec::from_array(
        &f.env,
        [
            StreamInput {
                recipient: f.recipient.clone(),
                token: f.token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now,
                end_time: now + DAY,
                cancelable: true,
            },
            StreamInput {
                recipient: Address::generate(&f.env),
                token: f.token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now,
                end_time: now + DAY,
                cancelable: false,
            },
        ],
    );

    let ids = f.client.mock_all_auths().create_streams(&f.sender, &inputs);
    assert_eq!(
        f.client.mock_all_auths().stream_fee(&ids.get(0).unwrap()),
        DEPOSIT / 200
    );
    assert_eq!(
        f.client.mock_all_auths().stream_fee(&ids.get(1).unwrap()),
        DEPOSIT / 200
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .treasury_status(&f.token)
            .charged_total,
        DEPOSIT / 100
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT + DEPOSIT / 100
    );
}

#[test]
fn create_streams_rejects_mixed_valid_invalid_batch_atomically() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let inputs = soroban_sdk::Vec::from_array(
        &f.env,
        [
            StreamInput {
                recipient: f.recipient.clone(),
                token: f.token.clone(),
                deposit_amount: DEPOSIT / 2,
                start_time: now,
                end_time: now + DAY,
                cancelable: true,
            },
            StreamInput {
                recipient: Address::generate(&f.env),
                token: f.token.clone(),
                deposit_amount: 0,
                start_time: now,
                end_time: now + DAY,
                cancelable: false,
            },
        ],
    );

    let err = f
        .client
        .mock_all_auths()
        .try_create_streams(&f.sender, &inputs)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ZeroAmount);
    assert_eq!(f.client.mock_all_auths().total_streams(), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
    assert!(f
        .client
        .mock_all_auths()
        .sender_streams(&f.sender, &0, &50)
        .is_empty());
}

#[test]
fn create_streams_accepts_empty_batch_without_creating_streams() {
    let f = Fixture::setup();
    let ids = f
        .client
        .mock_all_auths()
        .create_streams(&f.sender, &soroban_sdk::Vec::new(&f.env));
    assert!(ids.is_empty());
    assert_eq!(f.client.mock_all_auths().total_streams(), 0);
}

#[test]
fn create_streams_rejects_rate_math_overflow_atomically() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let inputs = soroban_sdk::Vec::from_array(
        &f.env,
        [StreamInput {
            recipient: f.recipient.clone(),
            token: f.token.clone(),
            deposit_amount: i128::MAX,
            start_time: now,
            end_time: now + 3,
            cancelable: false,
        }],
    );

    let err = f
        .client
        .mock_all_auths()
        .try_create_streams(&f.sender, &inputs)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MathOverflow);
    assert_eq!(f.client.mock_all_auths().total_streams(), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn create_stream_rejects_zero_and_negative_amounts() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    for deposit in [0i128, -1] {
        let err = f
            .client
            .mock_all_auths()
            .try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &deposit,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, StreamError::ZeroAmount);
    }
}

#[test]
fn create_stream_rejects_zero_duration() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + DAY), // end == start
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidTimeRange);
}

#[test]
fn create_stream_rejects_inverted_time_range() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + 2 * DAY),
            &(now + DAY), // end before start
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidTimeRange);
}

#[test]
fn create_stream_rejects_start_time_in_the_past() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    f.advance_time(DAY);
    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &now, // in the past relative to the new ledger time
            &(now + 2 * DAY),
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StartTimeInPast);
}

#[test]
fn create_stream_allows_start_time_exactly_now() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &now,
        &(now + DAY),
        &false,
    );
    assert_eq!(f.client.mock_all_auths().available(&id), 0);
}

#[test]
fn create_stream_rejects_duration_over_max() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    // 100 years + 1 second: rejected.
    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &now,
            &(now + MAX_DURATION_SECONDS + 1),
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DurationTooLong);

    // Exactly 100 years: accepted.
    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &now,
        &(now + MAX_DURATION_SECONDS),
        &false,
    );
    assert!(id >= 1);
}

#[test]
fn create_stream_stores_correct_duration() {
    // Kills mutant: lib.rs:92 (replace - with + in duration calculation)
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let start = now + DAY;
    let end = now + DAY + 10 * DAY;
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.start_time, start);
    assert_eq!(stream.end_time, end);
    // The duration should be end - start, not end + start
    assert_eq!(stream.duration(), end - start);
    assert_eq!(stream.duration(), 10 * DAY);
}

#[test]
fn create_stream_rejects_deposit_that_overflows_rate_math() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    // Worst-case product (deposit * duration) would exceed u128.
    let deposit = i128::MAX;
    let duration = 2 * 365 * DAY;
    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &deposit,
            &now,
            &(now + duration),
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MathOverflow);
}

#[test]
fn create_stream_accepts_exact_capacity_boundary() {
    // Kills mutant: stream.rs:109 (replace > with >= in validate_capacity)
    // The function uses > to reject when deposit exceeds capacity.
    // At the exact boundary (deposit == capacity), it should be accepted.
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    // Use a deposit that exactly equals u128::MAX / duration
    // but small enough to fit within the test allowance
    let duration = 1000u64;
    let deposit = (u128::MAX / (duration as u128)) as i128;

    // Increase allowance to handle the large deposit
    StellarAssetClient::new(&f.env, &f.token).approve(
        &f.sender,
        &f.client.address,
        &deposit,
        &1_000_000u32,
    );
    StellarAssetClient::new(&f.env, &f.token).mint(&f.sender, &deposit);

    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &deposit,
        &now,
        &(now + duration),
        &false,
    );
    assert!(id >= 1);
    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.deposit, deposit);
}

#[test]
fn create_stream_rejects_sender_without_balance_or_allowance() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    // A fresh sender with no tokens and no allowance cannot fund a stream.
    let broke = Address::generate(&f.env);
    assert!(f
        .client
        .mock_all_auths()
        .try_create_stream(
            &broke,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 2 * DAY),
            &false,
        )
        .is_err());
    // No stream leaked from the failed creation (ids start at 1).
    assert!(f.client.mock_all_auths().try_get_stream(&1).is_err());
}

// ------------------------------------------------- accrual & withdrawal -----

#[test]
fn withdraw_before_start_returns_zero_and_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 30 * DAY, false);

    assert_eq!(f.client.mock_all_auths().available(&id), 0);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &1000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::AmountExceedsAvailable);
}

#[test]
fn withdraw_at_exact_start_is_zero() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 30 * DAY, false);
    f.advance_time(DAY); // now == start_time; half-open [start, end) window
    assert_eq!(f.client.mock_all_auths().available(&id), 0);
}

#[test]
fn withdraw_accrues_linearly() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    f.advance_time(2 * DAY); // 1 day elapsed of 10
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT / 10);

    f.advance_time(4 * DAY); // 5 days elapsed
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT / 2);
}

#[test]
fn withdraw_exact_amount_at_end_drains_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    f.advance_time(11 * DAY); // past end
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT);

    f.client.mock_all_auths().withdraw(&id, &DEPOSIT);
    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.withdrawn, DEPOSIT);
    assert_eq!(stream.status, StreamStatus::Depleted);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn withdraw_after_end_allows_full_remaining_balance() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(100 * DAY); // way past end
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT);
}

#[test]
fn withdraw_reverts_if_amount_exceeds_available() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY); // one day accrued
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &(DEPOSIT / 10 + 1))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::AmountExceedsAvailable);
    // State unchanged after the failed withdrawal.
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT / 10);
}

#[test]
fn withdraw_rejects_zero_amount() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ZeroAmount);
}

#[test]
fn multiple_partial_withdrawals_in_sequence() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Elapsed 1 day: accrue 1/10, withdraw half of it.
    f.advance_time(2 * DAY);
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT / 10);
    let first = DEPOSIT / 20;
    f.client.mock_all_auths().withdraw(&id, &first);

    // Elapsed 2 days: streamed 2/10, available = 2/10 - 1/20 = 3/20.
    f.advance_time(DAY);
    let second = f.client.mock_all_auths().available(&id);
    assert_eq!(second, 3 * DEPOSIT / 20);
    f.client.mock_all_auths().withdraw(&id, &second);

    // Past the end: everything left is withdrawable in one go.
    f.advance_time(20 * DAY);
    let withdrawn_total = first + second;
    let rest = f.client.mock_all_auths().available(&id);
    assert_eq!(rest, DEPOSIT - withdrawn_total);
    f.client.mock_all_auths().withdraw(&id, &rest);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Depleted);
    // Every unit accounted for: recipient got everything, contract is empty.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn withdraw_fails_without_recipient_authorization() {
    // An attacker "signs" a withdraw call; the contract requires the stream
    // recipient's authorization, which was not granted.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);

    let attacker = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "withdraw",
            args: (id, 1_000i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_withdraw(&id, &1_000).is_err());
}

#[test]
fn withdraw_on_cancelled_stream_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    f.advance_time(2 * DAY);
    f.client.mock_all_auths().cancel_stream(&f.recipient, &id); // recipient cancels (cancelable)
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
    assert_eq!(f.client.mock_all_auths().available(&id), 0);
}

#[test]
fn withdraw_unknown_stream_reverts() {
    let f = Fixture::setup();
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&999, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotFound);
}

// ------------------------------------------------------------ cancellation --

#[test]
fn cancel_by_sender_refunds_remainder_and_pays_accrued() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY); // 2 days elapsed of 10

    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let accrued = DEPOSIT / 5;
    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn, accrued); // recipient payout recorded
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        accrued
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT - accrued // fixture headroom + refund
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn cancel_before_start_refunds_everything_to_sender() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    // No time passes: nothing accrued.
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT // headroom + full refund
    );
    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn, 0);
}

#[test]
fn cancel_after_end_pays_recipient_everything() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(50 * DAY); // fully accrued, never withdrawn
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT
    ); // headroom only
}

#[test]
fn cancel_fully_withdrawn_stream_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(20 * DAY);
    f.client.mock_all_auths().withdraw(&id, &DEPOSIT);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Depleted
    );

    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

#[test]
fn cancel_twice_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

#[test]
fn recipient_cannot_cancel_non_cancelable_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotCancellable);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Active
    );
}

#[test]
fn recipient_can_cancel_cancelable_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    f.advance_time(2 * DAY); // 1 day elapsed
    f.client.mock_all_auths().cancel_stream(&f.recipient, &id);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Cancelled
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT / 10
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT - DEPOSIT / 10 // headroom + refund
    );
}

#[test]
fn third_party_cannot_cancel_any_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true); // even if cancelable
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&Address::generate(&f.env), &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
}

#[test]
fn cancel_at_exact_start_pays_sender_everything() {
    // Cancelling at exactly start_time: accrued = 0, sender gets everything,
    // no zero-value transfers to the recipient.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(DAY); // now == start
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT // headroom + full refund
    );
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 0);
}

#[test]
fn elapsed_after_end_returns_full_duration() {
    // Kills mutant: stream.rs:97 (replace - with + in elapsed_seconds)
    // When now >= end_time, elapsed should be end_time - start_time, not end_time + start_time
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false); // starts now
    f.advance_time(20 * DAY); // well past end_time

    // At this point, the full duration should have elapsed
    // If the mutant changed - to +, elapsed would be wildly wrong
    let stream = f.client.mock_all_auths().get_stream(&id);
    let available = f.client.mock_all_auths().available(&id);
    assert_eq!(available, DEPOSIT); // full deposit available
    assert_eq!(stream.deposit, DEPOSIT);
}

#[test]
fn cancel_with_zero_recipient_amount_skips_transfer() {
    // Kills mutant: lib.rs:263 (replace > with >= in recipient_amount check)
    // Cancelling before start yields recipient_amount = 0, which should not trigger a transfer.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    // Cancel immediately (before start_time) - recipient gets 0
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn, 0);
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT // headroom + full refund
    );
}

#[test]
fn cancel_with_zero_sender_amount_skips_transfer() {
    // Kills mutant: lib.rs:270 (replace > with >= in sender_amount check)
    // Cancelling after end yields sender_amount = 0, which should not trigger a transfer.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(50 * DAY); // fully accrued
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn, DEPOSIT);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT // headroom only, no refund
    );
}

// ------------------------------------------------------------ top-up --------

#[test]
fn top_up_increases_deposit_and_accrual_pro_rata() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Elapsed 2 days: 2/10 accrued.
    f.advance_time(3 * DAY);
    assert_eq!(f.client.mock_all_auths().available(&id), DEPOSIT / 5);

    let top_up = DEPOSIT / 2;
    f.client.mock_all_auths().top_up(&id, &top_up);

    // Accrual stays linear over the original window; the deposit grew, so the
    // available amount jumps to 2/10 of the new deposit.
    let new_deposit = DEPOSIT + top_up;
    assert_eq!(
        f.client.mock_all_auths().available(&id),
        new_deposit * 2 / 10
    );

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.deposit, new_deposit);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        new_deposit
    );
}

#[test]
fn top_up_after_end_fully_withdrawable() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(20 * DAY);

    let extra = DEPOSIT / 2;
    f.client.mock_all_auths().top_up(&id, &extra);
    f.client.mock_all_auths().withdraw(&id, &(DEPOSIT + extra));
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT + extra
    );
}

#[test]
fn top_up_rejected_on_cancelled_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &1000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

#[test]
fn top_up_rejected_on_depleted_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(20 * DAY);
    f.client.mock_all_auths().withdraw(&id, &DEPOSIT);
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &1000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

#[test]
fn top_up_rejects_zero_amount() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ZeroAmount);
}

#[test]
fn top_up_rejects_amount_that_would_overflow_rate_math() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &i128::MAX)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MathOverflow);
    // Deposit unchanged.
    assert_eq!(f.client.mock_all_auths().get_stream(&id).deposit, DEPOSIT);
}

// ------------------------------------------------------------ reentrancy ----

/// A SEP-41 token whose `transfer` reenters the streaming contract to attempt
/// a second withdrawal while the first payout is in flight. Demonstrates that
/// effects-before-interactions (CEI) prevents double-spending.
#[contract]
struct MaliciousToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct Attack {
    target: Address,
    stream_id: u64,
    amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum MaliciousKey {
    Attack,
}

#[contractimpl]
impl MaliciousToken {
    pub fn mint(env: Env, _to: Address, _amount: i128) {
        // Balances are fictional; the point of this token is the reentry hook.
        let _ = env;
    }

    /// Arms the trap: the next `transfer` out of `target` (the streaming
    /// contract) reenters `target.withdraw(stream_id, amount)`.
    pub fn arm(env: Env, target: Address, stream_id: u64, amount: i128) {
        env.storage().temporary().set(
            &MaliciousKey::Attack,
            &Some(Attack {
                target,
                stream_id,
                amount,
            }),
        );
    }

    // --- SEP-41 TokenInterface surface (used by TokenClient) ---

    pub fn transfer(env: Env, from: Address, _to: MuxedAddress, _amount: i128) {
        let attack: Option<Attack> = env
            .storage()
            .temporary()
            .get(&MaliciousKey::Attack)
            .unwrap_or(None);
        if let Some(a) = attack {
            if a.target == from {
                // Disarm first, then reenter. The streaming contract has
                // already persisted the recipient's payout, so this inner
                // withdrawal must fail with AmountExceedsAvailable.
                env.storage().temporary().remove(&MaliciousKey::Attack);
                let inner = crate::test_client::StreamingPaymentsClient::new(&env, &a.target);
                let _ = inner.try_withdraw(&a.stream_id, &a.amount);
            }
        }
    }

    pub fn transfer_from(env: Env, _spender: Address, _from: Address, _to: Address, _amount: i128) {
        env.storage().temporary().remove(&MaliciousKey::Attack);
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Evil Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "EVIL")
    }
}

#[test]
fn reentrant_withdrawal_during_payout_cannot_double_spend() {
    let env = Env::default();
    env.mock_all_auths();

    let mal_id = env.register(MaliciousToken, ());
    let mal = MaliciousTokenClient::new(&env, &mal_id);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mal.mint(&sender, &DEPOSIT);

    let governor = Address::generate(&env);
    let contract_id = env.register(StreamingPayments, (governor,));
    let client = Client::new(&env, &contract_id);

    let now = env.ledger().timestamp();
    let id = client.create_stream(
        &sender,
        &recipient,
        &mal_id,
        &DEPOSIT,
        &(now + DAY),
        &(now + DAY + 10 * DAY),
        &false,
    );

    env.ledger().with_mut(|li| li.timestamp += 2 * DAY); // 1 day accrued

    // Arm the trap: while the streaming contract pays out, the token reenters
    // withdraw() trying to grab another full day.
    mal.arm(&contract_id, &id, &(DEPOSIT / 10));

    client.withdraw(&id, &(DEPOSIT / 10));

    // Exactly one day was paid out: the reentrant call saw the already-persisted
    // state and failed with AmountExceedsAvailable.
    let stream = client.get_stream(&id);
    assert_eq!(stream.withdrawn, DEPOSIT / 10);
    assert_eq!(stream.status, StreamStatus::Active);
}

// ------------------------------------------------- treasury reentrancy ----

/// A SEP-41 token whose `transfer` reenters `withdraw_treasury` while the
/// treasury payout is in flight: the accounting was already persisted (CEI),
/// so the inner call must fail with `InsufficientTreasuryBalance` and the
/// outer withdrawal pays exactly once.
#[contract]
struct ReentrantTreasuryToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct TreasuryAttack {
    target: Address,
    token: Address,
    governor: Address,
    amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum TreasuryAttackKey {
    Armed,
}

#[contractimpl]
impl ReentrantTreasuryToken {
    pub fn arm(env: Env, target: Address, token: Address, governor: Address, amount: i128) {
        env.storage().temporary().set(
            &TreasuryAttackKey::Armed,
            &Some(TreasuryAttack {
                target,
                token,
                governor,
                amount,
            }),
        );
    }

    // --- SEP-41 TokenInterface surface ---

    pub fn transfer(env: Env, from: Address, _to: MuxedAddress, _amount: i128) {
        let attack: Option<TreasuryAttack> = env
            .storage()
            .temporary()
            .get(&TreasuryAttackKey::Armed)
            .unwrap_or(None);
        if let Some(a) = attack {
            if a.target == from {
                // Disarm first, then reenter. The treasury accounting has
                // already been updated, so the inner withdrawal must fail.
                env.storage().temporary().remove(&TreasuryAttackKey::Armed);
                let inner = crate::test_client::StreamingPaymentsClient::new(&env, &a.target);
                let _ = inner.try_withdraw_treasury(&a.governor, &a.token, &a.governor, &a.amount);
            }
        }
    }

    pub fn transfer_from(env: Env, _spender: Address, _from: Address, _to: Address, _amount: i128) {
        env.storage().temporary().remove(&TreasuryAttackKey::Armed);
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Reentrant Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "REENT")
    }
}

#[test]
fn reentrant_treasury_withdrawal_cannot_double_spend() {
    let env = Env::default();
    env.mock_all_auths();

    let mal_id = env.register(ReentrantTreasuryToken, ());
    let mal = ReentrantTreasuryTokenClient::new(&env, &mal_id);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let governor = Address::generate(&env);

    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let client = Client::new(&env, &contract_id);

    // Fee on: 100 bps of DEPOSIT collected at creation.
    client.mock_all_auths().set_fee_bps(&governor, &100);
    let now = env.ledger().timestamp();
    let id = client.create_stream(
        &sender,
        &recipient,
        &mal_id,
        &DEPOSIT,
        &(now + DAY),
        &(now + DAY + 10 * DAY),
        &false,
    );
    let fee = DEPOSIT / 100;
    assert_eq!(client.stream_fee(&id), fee);
    assert_eq!(client.treasury_status(&mal_id).charged_total, fee);

    // Arm the trap: while the treasury payout transfers, the token reenters
    // withdraw_treasury trying to grab the same fee again.
    mal.arm(&contract_id, &mal_id, &governor, &fee);
    client.withdraw_treasury(&governor, &mal_id, &governor, &fee);

    // Exactly one withdrawal happened: the reentrant call saw the
    // already-persisted accounting and failed.
    let status = client.treasury_status(&mal_id);
    assert_eq!(status.withdrawn_total, fee);
    assert_eq!(status.collectible, 0);
}

// ------------------------------------------------------------ property test -

/// Property: `streamed_at` is bounded by [0, deposit], monotonic
/// non-decreasing in elapsed time, matches the exact floor ratio, and caps at
/// `deposit` beyond the window. Exhaustive over small (deposit, duration)
/// pairs and sampled elapsed points; extreme values handled without panic.
#[test]
fn property_accrual_is_monotonic_and_conservation_holds() {
    let deposits: [i128; 6] = [1, 7, 1_000, 123_456_789, i128::MAX / 4, i128::MAX];
    let durations: [u64; 6] = [1, 2, 3, 10, 1_000, u64::MAX / 8];

    for deposit in deposits {
        for duration in durations {
            // Streams that would overflow the rate product are rejected at
            // creation; the pure fn must report MathOverflow, never panic.
            if (deposit as u128).checked_mul(duration as u128).is_none() {
                assert_eq!(
                    streamed_at(deposit, duration, duration).unwrap_err(),
                    StreamError::MathOverflow
                );
                continue;
            }

            // Sampled elapsed points, ascending. Duplicates are fine: the
            // monotonic property uses a non-strict inequality.
            let mut points = [
                0u64,
                1,
                2,
                3,
                duration / 3,
                duration / 2,
                (duration * 2) / 3,
                duration.saturating_sub(1),
                duration,
            ];
            points.sort_unstable();

            let mut prev: i128 = 0;
            // Short windows (duration 1 or 2) never reach the larger fixed
            // samples; those would push the product past u128 for huge
            // deposits and the pure fn rightly reports MathOverflow.
            for elapsed in points.into_iter().filter(|&elapsed| elapsed <= duration) {
                let streamed = streamed_at(deposit, duration, elapsed).unwrap();
                // Bounds.
                assert!((0..=deposit).contains(&streamed));
                // Monotonic non-decreasing in elapsed.
                assert!(streamed >= prev, "accrual decreased at elapsed={elapsed}");
                // Floor semantics: exactly deposit * elapsed / duration,
                // capped at the deposit for elapsed beyond the window.
                let exact =
                    ((deposit as u128 * elapsed as u128) / duration as u128).min(deposit as u128);
                assert_eq!(streamed as u128, exact);
                prev = streamed;
            }
            // At and beyond full duration: capped at deposit. The beyond
            // sample is only asserted when its product fits — the pure fn
            // conservatively reports MathOverflow otherwise (unreachable for
            // real streams, whose capacity is validated at creation).
            assert_eq!(streamed_at(deposit, duration, duration).unwrap(), deposit);
            let beyond = duration.saturating_add(1_000_000);
            if (deposit as u128).checked_mul(beyond as u128).is_some() {
                assert_eq!(streamed_at(deposit, duration, beyond).unwrap(), deposit);
            }
        }
    }
}

/// Degenerate inputs to the pure rate function never panic.
#[test]
fn streamed_at_handles_degenerate_inputs() {
    assert_eq!(streamed_at(0, 10, 5).unwrap(), 0);
    assert_eq!(streamed_at(-5, 10, 5).unwrap(), 0);
    assert_eq!(streamed_at(100, 0, 5).unwrap(), 0);
    assert_eq!(streamed_at(100, 10, 0).unwrap(), 0);
    // i128::MAX deposit with duration 1: exact, no overflow.
    assert_eq!(streamed_at(i128::MAX, 1, 1).unwrap(), i128::MAX);
    // Overflow case: deposit * elapsed exceeds u128.
    assert_eq!(
        streamed_at(i128::MAX, 3, 3).unwrap_err(),
        StreamError::MathOverflow
    );
}

// ------------------------------------------------------------ events --------

#[test]
fn events_are_emitted_with_expected_payloads() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();

    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + DAY + 10 * DAY),
        &true,
    );

    let created = crate::StreamCreated {
        stream_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: now + DAY,
        end_time: now + DAY + 10 * DAY,
        cancelable: true,
    };

    // StreamCreated event, compared as full typed XDR (token-contract mint /
    // burn events are filtered out). Note: reading the event log drains it,
    // so each assertion covers only the events since the last read.
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [created.to_xdr(&f.env, &f.client.address)],
    );

    // Withdrawn event after a partial withdrawal.
    f.advance_time(3 * DAY); // 2 days elapsed of 10
    f.client.mock_all_auths().withdraw(&id, &1000);
    let withdrawn = crate::Withdrawn {
        stream_id: id,
        recipient: f.recipient.clone(),
        amount: 1000,
        withdrawn_total: 1000,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [withdrawn.to_xdr(&f.env, &f.client.address)],
    );

    // StreamCancelled event (by the recipient of a cancelable stream): the
    // recipient gets the unwithdrawn accrued part, the sender the remainder.
    let streamed = DEPOSIT / 5; // 2 days elapsed of 10
    f.client.mock_all_auths().cancel_stream(&f.recipient, &id);
    let cancelled = crate::StreamCancelled {
        stream_id: id,
        cancelled_by: f.recipient.clone(),
        recipient_amount: streamed - 1000,
        sender_amount: DEPOSIT - streamed,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [cancelled.to_xdr(&f.env, &f.client.address)],
    );
}

#[test]
fn top_up_event_emitted() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let now = f.env.ledger().timestamp();

    let created = crate::StreamCreated {
        stream_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: now + DAY,
        end_time: now + DAY + 10 * DAY,
        cancelable: false,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [created.to_xdr(&f.env, &f.client.address)],
    );

    f.client.mock_all_auths().top_up(&id, &1234);
    let topped_up = crate::StreamToppedUp {
        stream_id: id,
        sender: f.sender.clone(),
        amount: 1234,
        new_deposit: DEPOSIT + 1234,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [topped_up.to_xdr(&f.env, &f.client.address)],
    );
}

// --------------------------------------------------- address indexes -------

#[test]
fn create_stream_indexes_ids_for_sender_and_recipient() {
    let f = Fixture::setup();
    let id1 = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let id2 = f.create_stream(DEPOSIT / 2, 0, 5 * DAY, true);

    let expected = soroban_sdk::Vec::from_slice(&f.env, &[id1, id2]);
    assert_eq!(f.client.recipient_streams(&f.recipient, &0, &10), expected);
    assert_eq!(f.client.sender_streams(&f.sender, &0, &10), expected);
}

#[test]
fn stream_ids_are_unique_and_monotonic() {
    // Kills mutant: stream.rs:178 (replace next_stream_id with constant 1)
    // Stream IDs must be unique and monotonically increasing.
    let f = Fixture::setup();
    let id1 = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let id2 = f.create_stream(DEPOSIT / 2, 0, 5 * DAY, true);
    let id3 = f.create_stream(DEPOSIT / 4, 0, 3 * DAY, false);

    assert!(id1 >= 1);
    assert!(id2 > id1);
    assert!(id3 > id2);

    // Verify the streams have the expected IDs
    let s1 = f.client.mock_all_auths().get_stream(&id1);
    let s2 = f.client.mock_all_auths().get_stream(&id2);
    let s3 = f.client.mock_all_auths().get_stream(&id3);
    assert_eq!(s1.id, id1);
    assert_eq!(s2.id, id2);
    assert_eq!(s3.id, id3);
}

#[test]
fn streams_index_pagination_pages_in_creation_order() {
    let f = Fixture::setup();
    let mut ids = [0u64; 5];
    for (i, slot) in ids.iter_mut().enumerate() {
        *slot = f.create_stream(DEPOSIT / 10, i as u64, 10 * DAY, false);
    }
    let page = |offset: u32, limit: u32, expect: &[u64]| {
        assert_eq!(
            f.client.sender_streams(&f.sender, &offset, &limit),
            soroban_sdk::Vec::from_slice(&f.env, expect),
        );
    };

    page(0, 2, &ids[0..2]);
    page(2, 2, &ids[2..4]);
    page(4, 2, &ids[4..5]); // short final page
    page(0, 0, &[]); // zero limit: empty page, no error
    page(99, 2, &[]); // offset past the end
                      // Oversized limits clamp to MAX_PAGE_SIZE (only 5 exist, so len is 5).
    assert_eq!(f.client.sender_streams(&f.sender, &0, &u32::MAX).len(), 5);
}

#[test]
fn unrelated_address_has_empty_indexes() {
    let f = Fixture::setup();
    let _ = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let other = Address::generate(&f.env);
    assert!(f.client.recipient_streams(&other, &0, &50).is_empty());
    assert!(f.client.sender_streams(&other, &0, &50).is_empty());
}

#[test]
fn cancelled_streams_keep_their_indexed_ids() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    f.advance_time(DAY);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    // The index is keyed by creation, not lifecycle: the id stays listed and
    // the stream's own status field is the source of truth.
    assert_eq!(
        f.client.recipient_streams(&f.recipient, &0, &10),
        soroban_sdk::Vec::from_slice(&f.env, &[id]),
    );
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Cancelled);
}

// ------------------------------------------------------ withdraw_max ------

#[test]
fn withdraw_max_pays_everything_accrued() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false); // starts now
    f.advance_time(3 * DAY);

    let amount = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(amount, DEPOSIT * 3 / 10);

    let stream = f.client.get_stream(&id);
    assert_eq!(stream.withdrawn, amount);
    assert_eq!(stream.status, StreamStatus::Active);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        amount
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT - amount,
    );

    // Nothing accrued since the claim: an immediate second call reverts.
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NothingToWithdraw);
}

#[test]
fn withdraw_max_before_start_reverts_nothing_to_withdraw() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NothingToWithdraw);
}

#[test]
fn withdraw_max_after_end_drains_the_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.advance_time(5 * DAY); // past end_time

    let amount = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(amount, DEPOSIT);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Depleted,);
}

#[test]
fn withdraw_max_on_cancelled_stream_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    f.advance_time(DAY);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

#[test]
fn withdraw_max_unknown_stream_reverts() {
    let f = Fixture::setup();
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotFound);
}

#[test]
fn withdraw_max_requires_recipient_authorization() {
    // Same auth model as `withdraw`: an attacker signing the call does not
    // satisfy the recipient's required authorization.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(2 * DAY);

    let attacker = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "withdraw_max",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_withdraw_max(&id).is_err());
}

#[test]
fn withdraw_max_emits_withdrawn_event() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(DAY);

    // Drain the StreamCreated event so the assertion below covers only the
    // withdrawal (reading the event log drains it).
    let _ = f.env.events().all();

    let amount = f.client.mock_all_auths().withdraw_max(&id);
    let withdrawn = crate::Withdrawn {
        stream_id: id,
        recipient: f.recipient.clone(),
        amount,
        withdrawn_total: amount,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [withdrawn.to_xdr(&f.env, &f.client.address)],
    );
}

// ------------------------------------------------------------ treasury ------

/// Sets the fee rate as the fixture's governor (auth is mocked).
fn set_fee(f: &Fixture, bps: u32) {
    f.client.mock_all_auths().set_fee_bps(&f.governor, &bps);
}

/// Pages `verify_treasury` from id 1 until `done`, asserting contiguous,
/// terminating pagination, and returns the summed per-stream fees — the
/// number that must equal `treasury_status(token).charged_total`.
fn scan_all_fees(client: &Client<'_>, token: &Address) -> i128 {
    let mut total: i128 = 0;
    let mut start: u64 = 1;
    let mut pages = 0;
    loop {
        let scan = client.verify_treasury(token, &start, &50);
        assert_eq!(scan.start_id, start.max(1));
        assert_eq!(scan.token, *token);
        total += scan.fees_in_range;
        pages += 1;
        assert!(pages <= 4_096, "fee scan did not terminate");
        if scan.done {
            break;
        }
        assert!(scan.next_start > start, "fee scan made no progress");
        start = scan.next_start;
    }
    total
}

#[test]
fn constructor_binds_governor_and_defaults_fees_off() {
    let f = Fixture::setup();
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.token, f.token);
    assert_eq!(status.governor, f.governor);
    assert_eq!(status.pending_governor, None::<Address>);
    assert_eq!(status.fee_bps, 0);
    assert_eq!(status.max_fee_bps, crate::MAX_FEE_BPS);
    assert_eq!(status.charged_total, 0);
    assert_eq!(status.withdrawn_total, 0);
    assert_eq!(status.collectible, 0);
    assert_eq!(f.client.total_streams(), 0);
}

#[test]
fn fee_disabled_streams_behave_exactly_like_v0_3() {
    // fee_bps == 0: no extra pull, no fee storage, no FeeCharged event —
    // the full backward-compatible path.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Only StreamCreated was emitted — no FeeCharged for a zero fee.
    let created = crate::StreamCreated {
        stream_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: f.env.ledger().timestamp() + DAY,
        end_time: f.env.ledger().timestamp() + DAY + 10 * DAY,
        cancelable: false,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [created.to_xdr(&f.env, &f.client.address)],
    );

    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );
    assert_eq!(f.client.stream_fee(&id), 0);
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.charged_total, 0);
}

#[test]
fn fee_charged_at_creation_accrual_math_unaffected() {
    let f = Fixture::setup();
    set_fee(&f, 100); // 1 %
    let fee = DEPOSIT / 100;

    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Sender paid deposit + fee in one pull; the contract holds both.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT - fee
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT + fee
    );

    // The stream's deposit — and therefore every accrual computation —
    // never sees the fee.
    let s = f.client.get_stream(&id);
    assert_eq!(s.deposit, DEPOSIT);
    f.advance_time(3 * DAY); // 2 days elapsed of 10
    assert_eq!(f.client.available(&id), DEPOSIT / 5);

    // Stored accounting agrees.
    assert_eq!(f.client.stream_fee(&id), fee);
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.charged_total, fee);
    assert_eq!(status.collectible, fee);
    assert_eq!(f.client.total_streams(), 1);
}

#[test]
fn set_fee_bps_applies_to_new_streams_only() {
    let f = Fixture::setup();
    // Headroom for two deposit-pulls, one of them fee-bearing.
    StellarAssetClient::new(&f.env, &f.token).mint(&f.sender, &(2 * DEPOSIT));
    let id_before = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    set_fee(&f, 100);
    let id_after = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Fees are a property of the deposit boundary a stream actually crossed:
    // the pre-existing stream is untouched.
    assert_eq!(f.client.stream_fee(&id_before), 0);
    assert_eq!(f.client.stream_fee(&id_after), DEPOSIT / 100);
    assert_eq!(
        f.client.treasury_status(&f.token).charged_total,
        DEPOSIT / 100
    );
}

#[test]
fn top_ups_are_fee_free() {
    let f = Fixture::setup();
    // Headroom for the deposit + fee pull plus the top-up pull.
    StellarAssetClient::new(&f.env, &f.token).mint(&f.sender, &DEPOSIT);
    set_fee(&f, 100);
    let fee = DEPOSIT / 100;
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    f.client.mock_all_auths().top_up(&id, &DEPOSIT);

    // The fee is charged once, at creation: top-ups pull face value only.
    assert_eq!(f.client.treasury_status(&f.token).charged_total, fee);
    assert_eq!(f.client.stream_fee(&id), fee); // unchanged
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        2 * DEPOSIT + fee
    );
}

#[test]
fn fee_floors_to_zero_for_dusty_deposits() {
    let f = Fixture::setup();
    set_fee(&f, 1); // 1 bp
    let now = f.env.ledger().timestamp();
    let deposit = 9_999i128; // 1 bp of 9_999 floors to 0 whole units

    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &deposit,
        &(now + DAY),
        &(now + DAY + DAY),
        &false,
    );

    // Only StreamCreated was emitted — a fee flooring to zero is no fee.
    let created = crate::StreamCreated {
        stream_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit,
        start_time: now + DAY,
        end_time: now + DAY + DAY,
        cancelable: false,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [created.to_xdr(&f.env, &f.client.address)],
    );

    // A fee that floors to zero charges nothing, stores nothing, emits nothing.
    assert_eq!(f.client.stream_fee(&id), 0);
    assert_eq!(f.client.treasury_status(&f.token).charged_total, 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT - deposit
    );
}

#[test]
fn set_fee_bps_enforces_cap_and_governance() {
    let f = Fixture::setup();
    // Exactly at the cap: accepted.
    f.client
        .mock_all_auths()
        .set_fee_bps(&f.governor, &crate::MAX_FEE_BPS);
    assert_eq!(
        f.client.treasury_status(&f.token).fee_bps,
        crate::MAX_FEE_BPS
    );

    // One basis point above the protocol cap: rejected, state unchanged.
    let err = f
        .client
        .mock_all_auths()
        .try_set_fee_bps(&f.governor, &(crate::MAX_FEE_BPS + 1))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::FeeRateTooHigh);
    assert_eq!(
        f.client.treasury_status(&f.token).fee_bps,
        crate::MAX_FEE_BPS
    );

    // A non-governor cannot touch the rate, even below the cap.
    let stranger = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_set_fee_bps(&stranger, &10)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);
    assert_eq!(
        f.client.treasury_status(&f.token).fee_bps,
        crate::MAX_FEE_BPS
    );
}

#[test]
fn withdraw_treasury_pays_out_and_tracks_totals() {
    let f = Fixture::setup();
    set_fee(&f, 100);
    let fee = DEPOSIT / 100;
    let _ = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let vault = Address::generate(&f.env);
    let half = fee / 2;

    f.client
        .mock_all_auths()
        .withdraw_treasury(&f.governor, &f.token, &vault, &half);

    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&vault), half);
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.charged_total, fee);
    assert_eq!(status.withdrawn_total, half);
    assert_eq!(status.collectible, fee - half);

    // The rest drains cleanly, then not a unit more.
    f.client
        .mock_all_auths()
        .withdraw_treasury(&f.governor, &f.token, &vault, &(fee - half));
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_treasury(&f.governor, &f.token, &vault, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InsufficientTreasuryBalance);
    // Stream funds are untouched by the treasury drain.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );
}

#[test]
fn withdraw_treasury_rejects_zero_and_non_governor() {
    let f = Fixture::setup();
    set_fee(&f, 100);
    let _ = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_treasury(&f.governor, &f.token, &f.governor, &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ZeroAmount);

    let stranger = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_treasury(&stranger, &f.token, &stranger, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);

    // An attacker "signing" the call still fails the governor identity check.
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "withdraw_treasury",
            args: (stranger.clone(), f.token.clone(), stranger.clone(), 1i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_withdraw_treasury(&stranger, &f.token, &stranger, &1)
        .is_err());
}

#[test]
fn fully_withdrawn_stream_leaves_only_fees_in_contract() {
    let f = Fixture::setup();
    set_fee(&f, 100);
    let fee = DEPOSIT / 100;
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(20 * DAY);

    f.client.mock_all_auths().withdraw_max(&id); // pays the full deposit

    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Depleted);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT
    );
    // Every deposit unit went to the recipient; the contract now holds
    // exactly the fees.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        fee
    );

    let vault = Address::generate(&f.env);
    f.client
        .mock_all_auths()
        .withdraw_treasury(&f.governor, &f.token, &vault, &fee);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn cancel_refunds_ignore_fees_decision_table() {
    // Decision table (docs/ARCHITECTURE.md §11):
    //   cancel before start → sender ← full deposit (fee not refunded)
    //   cancel mid-stream   → recipient ← accrued, sender ← deposit − accrued
    //   cancel after end    → recipient ← full deposit
    // In every row the fee stays collected; the split legs never change.
    let f = Fixture::setup();
    set_fee(&f, 100);
    let fee = DEPOSIT / 100;

    // Row 1: cancel before start.
    let id1 = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id1);
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT - fee // headroom + full refund, minus the fee paid
    );

    // Row 2: cancel mid-stream (4 of 10 days elapsed → 2/5 accrued).
    let id2 = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(4 * DAY);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id2);
    let accrued = DEPOSIT * 2 / 5;
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        accrued
    );
    // headroom − two (deposit + fee) pulls + the unaccrued refund
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT - 2 * fee - accrued
    );

    // Row 3: cancel after end.
    let id3 = f.create_stream(DEPOSIT, 0, 5 * DAY, false);
    f.advance_time(10 * DAY);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id3);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        accrued + DEPOSIT
    );

    // All streams terminal: the contract holds exactly the three fees, and
    // the treasury accounting says the same.
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.charged_total, 3 * fee);
    assert_eq!(status.collectible, 3 * fee);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        3 * fee
    );
}

#[test]
fn fee_events_are_emitted_with_expected_payloads() {
    let f = Fixture::setup();
    set_fee(&f, 50);
    let now = f.env.ledger().timestamp();
    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + DAY + 10 * DAY),
        &true,
    );
    let fee = DEPOSIT * 50 / 10_000;

    // StreamCreated then FeeCharged, in that order, typed as full XDR.
    let created = crate::StreamCreated {
        stream_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: now + DAY,
        end_time: now + DAY + 10 * DAY,
        cancelable: true,
    };
    let charged = crate::FeeCharged {
        stream_id: id,
        token: f.token.clone(),
        payer: f.sender.clone(),
        amount: fee,
        fee_bps: 50,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [
            created.to_xdr(&f.env, &f.client.address),
            charged.to_xdr(&f.env, &f.client.address),
        ],
    );

    // FeeWithdrawn after a treasury withdrawal (event log drains on read).
    f.client
        .mock_all_auths()
        .withdraw_treasury(&f.governor, &f.token, &f.governor, &fee);
    let withdrawn = crate::FeeWithdrawn {
        token: f.token.clone(),
        governor: f.governor.clone(),
        recipient: f.governor.clone(),
        amount: fee,
        withdrawn_total: fee,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [withdrawn.to_xdr(&f.env, &f.client.address)],
    );
}

#[test]
fn governor_rotation_is_two_step() {
    let f = Fixture::setup();
    let next = Address::generate(&f.env);

    // A stranger cannot nominate.
    let stranger = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_nominate_governor(&stranger, &next)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);

    // Accepting before any nomination reverts.
    let err = f
        .client
        .mock_all_auths()
        .try_accept_governor(&next)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingGovernor);

    // The governor nominates; only the nominee can accept.
    f.client
        .mock_all_auths()
        .nominate_governor(&f.governor, &next);
    assert_eq!(
        f.client.treasury_status(&f.token).pending_governor,
        Some(next.clone())
    );
    let other = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_governor(&other)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);

    // Acceptance moves the powers.
    f.client.mock_all_auths().accept_governor(&next);
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.governor, next.clone());
    assert_eq!(status.pending_governor, None::<Address>);

    let err = f
        .client
        .mock_all_auths()
        .try_set_fee_bps(&f.governor, &10)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);
    f.client.mock_all_auths().set_fee_bps(&next, &10);
    assert_eq!(f.client.treasury_status(&f.token).fee_bps, 10);

    // The nomination is consumed: a second accept reverts.
    let err = f
        .client
        .mock_all_auths()
        .try_accept_governor(&next)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingGovernor);
}

#[test]
fn stream_fee_rejects_unknown_stream() {
    let f = Fixture::setup();
    let err = f
        .client
        .mock_all_auths()
        .try_stream_fee(&999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotFound);
}

#[test]
fn verify_treasury_scans_reconcile_across_tokens() {
    let f = Fixture::setup();
    // A second token, funded and approved like the first.
    let sac2 = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env));
    let token2 = sac2.address();
    StellarAssetClient::new(&f.env, &token2).mint(&f.sender, &(2 * DEPOSIT));
    StellarAssetClient::new(&f.env, &token2).approve(
        &f.sender,
        &f.client.address,
        &(10 * DEPOSIT),
        &1_000_000u32,
    );

    set_fee(&f, 100);
    let now = f.env.ledger().timestamp();
    let id1 = f.create_stream(DEPOSIT, DAY, 10 * DAY, false); // token 1, fee
    let id2 = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &token2,
        &DEPOSIT,
        &(now + DAY),
        &(now + DAY + DAY),
        &false,
    ); // token 2, fee
    set_fee(&f, 0);
    let id3 = f.create_stream(DEPOSIT / 2, DAY, 10 * DAY, false); // token 1, no fee

    assert_eq!(f.client.stream_fee(&id1), DEPOSIT / 100);
    assert_eq!(f.client.stream_fee(&id2), DEPOSIT / 100);
    assert_eq!(f.client.stream_fee(&id3), 0);
    assert_eq!(f.client.total_streams(), 3);

    // Scans are per-token: token 1's scan skips token 2's fee entry even
    // though the ids interleave.
    assert_eq!(scan_all_fees(&f.client, &f.token), DEPOSIT / 100);
    assert_eq!(scan_all_fees(&f.client, &token2), DEPOSIT / 100);
    assert_eq!(
        f.client.treasury_status(&f.token).charged_total,
        DEPOSIT / 100
    );
    assert_eq!(
        f.client.treasury_status(&token2).charged_total,
        DEPOSIT / 100
    );

    // Requested windows clamp to the id space; scans past the end are empty
    // and done.
    let scan = f.client.verify_treasury(&f.token, &1, &u32::MAX);
    assert_eq!(scan.scanned_count, 3);
    assert!(scan.done);
    let scan = f.client.verify_treasury(&f.token, &99, &10);
    assert_eq!(scan.scanned_count, 0);
    assert_eq!(scan.fees_in_range, 0);
    assert!(scan.done);

    // An unknown token scans to all zeros (nothing was ever charged in it).
    let stranger_token = Address::generate(&f.env);
    assert_eq!(scan_all_fees(&f.client, &stranger_token), 0);
}

/// Deterministic xorshift64* so property runs are reproducible from their
/// seeds; failures name the seed and step.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
}

#[derive(Clone, Debug)]
struct StateMachineStream {
    deposit: i128,
    withdrawn: i128,
    start: u64,
    end: u64,
    cancelable: bool,
    status: StreamStatus,
}

impl StateMachineStream {
    fn accrued(&self, now: u64) -> i128 {
        let duration = self.end - self.start;
        let elapsed = now.clamp(self.start, self.end) - self.start;
        (self.deposit as u128 * elapsed as u128 / duration as u128) as i128
    }
}

/// Stateful tests use proptest rather than the pure-function fuzz target:
/// shrinking reduces a failing operation sequence, while fixed seeds make
/// failures repeatable without relying on libFuzzer's separate harness.
#[test]
fn property_random_state_machine_sequences_preserve_fund_invariants() {
    const SEEDS: [u64; 3] = [0x51A7_E001, 0x51A7_E002, 0x51A7_E003];
    const CASES_PER_SEED: u32 = 16;

    let sequence = proptest::collection::vec(any::<(u8, u16, u16)>(), 1..65);
    for seed in SEEDS {
        let mut runner = TestRunner::new(ProptestConfig {
            cases: CASES_PER_SEED,
            rng_seed: RngSeed::Fixed(seed),
            ..ProptestConfig::default()
        });
        if let Err(error) = runner.run(&sequence, |steps| run_state_machine_sequence(seed, &steps))
        {
            panic!("state-machine property failed with seed {seed:#x}: {error}");
        }
    }
}

fn run_state_machine_sequence(seed: u64, steps: &[(u8, u16, u16)]) -> Result<(), TestCaseError> {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();

    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let governor = Address::generate(&env);
    let contract_id = env.register(StreamingPayments, (governor,));
    let client = Client::new(&env, &contract_id);

    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000_000i128);
    StellarAssetClient::new(&env, &token).approve(
        &sender,
        &contract_id,
        &1_000_000_000i128,
        &1_000_000u32,
    );

    let mut streams = Vec::<StateMachineStream>::new();
    for (step_index, &(operation, first, second)) in steps.iter().enumerate() {
        let context =
            format!("seed {seed:#x}, step {step_index}, input {operation}/{first}/{second}");
        match operation % 5 {
            0 => {
                let now = env.ledger().timestamp();
                let start = now + (first as u64 % 4);
                let duration = 1 + (second as u64 % 100);
                let deposit = 1 + (first as i128 % 20_000) * 257 + second as i128 % 257;
                let cancelable = operation & 0x80 != 0;
                let id = client.mock_all_auths().create_stream(
                    &sender,
                    &recipient,
                    &token,
                    &deposit,
                    &start,
                    &(start + duration),
                    &cancelable,
                );
                prop_assert_eq!(id as usize, streams.len() + 1, "{}: stream id", context);
                streams.push(StateMachineStream {
                    deposit,
                    withdrawn: 0,
                    start,
                    end: start + duration,
                    cancelable,
                    status: StreamStatus::Active,
                });
            }
            1 => {
                env.ledger()
                    .with_mut(|ledger| ledger.timestamp += 1 + first as u64 % 80);
            }
            2 if !streams.is_empty() => {
                let index = first as usize % streams.len();
                let id = index as u64 + 1;
                if streams[index].status == StreamStatus::Cancelled {
                    let error = client
                        .mock_all_auths()
                        .try_withdraw(&id, &1)
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(error, StreamError::StreamNotActive, "{}", context);
                    let error = client
                        .mock_all_auths()
                        .try_withdraw_max(&id)
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(error, StreamError::StreamNotActive, "{}", context);
                } else if streams[index].status == StreamStatus::Depleted {
                    let error = client
                        .mock_all_auths()
                        .try_withdraw(&id, &1)
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(error, StreamError::StreamNotActive, "{}", context);
                } else {
                    let available =
                        streams[index].accrued(env.ledger().timestamp()) - streams[index].withdrawn;
                    if available > 0 && second & 1 == 0 {
                        let amount = 1 + second as i128 % available;
                        client.mock_all_auths().withdraw(&id, &amount);
                        streams[index].withdrawn += amount;
                    } else if available > 0 {
                        let paid = client.mock_all_auths().withdraw_max(&id);
                        prop_assert_eq!(paid, available, "{}: withdraw_max amount", context);
                        streams[index].withdrawn += paid;
                    } else {
                        let error = client
                            .mock_all_auths()
                            .try_withdraw_max(&id)
                            .unwrap_err()
                            .unwrap();
                        prop_assert_eq!(error, StreamError::NothingToWithdraw, "{}", context);
                    }
                    if streams[index].withdrawn == streams[index].deposit {
                        streams[index].status = StreamStatus::Depleted;
                    }
                }
            }
            3 if !streams.is_empty() => {
                let index = first as usize % streams.len();
                let id = index as u64 + 1;
                if streams[index].status == StreamStatus::Active {
                    let amount = 1 + second as i128;
                    client.mock_all_auths().top_up(&id, &amount);
                    streams[index].deposit += amount;
                } else {
                    let error = client
                        .mock_all_auths()
                        .try_top_up(&id, &(1 + second as i128))
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(error, StreamError::StreamNotActive, "{}", context);
                }
            }
            4 if !streams.is_empty() => {
                let index = first as usize % streams.len();
                let id = index as u64 + 1;
                if streams[index].status == StreamStatus::Active {
                    let caller = if streams[index].cancelable && second & 1 != 0 {
                        &recipient
                    } else {
                        &sender
                    };
                    client.mock_all_auths().cancel_stream(caller, &id);
                    streams[index].withdrawn +=
                        streams[index].accrued(env.ledger().timestamp()) - streams[index].withdrawn;
                    streams[index].status = StreamStatus::Cancelled;

                    let error = client
                        .mock_all_auths()
                        .try_withdraw(&id, &1)
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(
                        error,
                        StreamError::StreamNotActive,
                        "{}: cancelled withdrawal",
                        context
                    );
                    let error = client
                        .mock_all_auths()
                        .try_withdraw_max(&id)
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(
                        error,
                        StreamError::StreamNotActive,
                        "{}: cancelled withdraw_max",
                        context
                    );
                    let error = client
                        .mock_all_auths()
                        .try_top_up(&id, &1)
                        .unwrap_err()
                        .unwrap();
                    prop_assert_eq!(
                        error,
                        StreamError::StreamNotActive,
                        "{}: cancelled top-up",
                        context
                    );
                }
            }
            _ => {}
        }

        let now = env.ledger().timestamp();
        let mut remaining = 0i128;
        let mut total_withdrawn = 0i128;
        let mut total_accrued = 0i128;
        for (index, expected) in streams.iter().enumerate() {
            let id = index as u64 + 1;
            let actual = client.mock_all_auths().get_stream(&id);
            prop_assert_eq!(
                actual.deposit,
                expected.deposit,
                "{}: stream {} deposit",
                context,
                id
            );
            prop_assert_eq!(
                actual.withdrawn,
                expected.withdrawn,
                "{}: stream {} withdrawn",
                context,
                id
            );
            prop_assert_eq!(
                actual.status,
                expected.status,
                "{}: stream {} status",
                context,
                id
            );

            let accrued = expected.accrued(now);
            prop_assert!(
                actual.withdrawn <= accrued,
                "{}: stream {} withdrew {} but accrued only {}",
                context,
                id,
                actual.withdrawn,
                accrued
            );
            total_withdrawn += actual.withdrawn;
            total_accrued += accrued;
            if expected.status == StreamStatus::Active {
                remaining += expected.deposit - expected.withdrawn;
                prop_assert_eq!(
                    client.mock_all_auths().available(&id),
                    accrued - expected.withdrawn,
                    "{}: stream {} available",
                    context,
                    id
                );
            } else if expected.status == StreamStatus::Cancelled {
                prop_assert_eq!(client.mock_all_auths().available(&id), 0, "{}", context);
            }
        }
        prop_assert!(
            total_withdrawn <= total_accrued,
            "{}: recipient withdrew {} but accrued only {}",
            context,
            total_withdrawn,
            total_accrued
        );
        prop_assert_eq!(
            TokenClient::new(&env, &token).balance(&contract_id),
            remaining,
            "{}: contract balance must equal remaining escrow",
            context
        );
    }
    Ok(())
}

/// Off-chain mirror of one stream for the property model. Accrual is
/// duplicated here (floor ratio over the half-open window) on purpose: the
/// model must not import the contract's own accounting helpers.
#[derive(Clone, Debug)]
struct PStream {
    token_idx: usize,
    deposit: i128,
    withdrawn: i128,
    fee: i128,
    start: u64,
    end: u64,
    cancelable: bool,
    live: bool,
}

impl PStream {
    fn available(&self, now: u64) -> i128 {
        if !self.live {
            return 0;
        }
        let duration = self.end - self.start;
        let elapsed = now.clamp(self.start, self.end) - self.start;
        let streamed = (self.deposit as u128 * elapsed as u128 / duration as u128) as i128;
        streamed - self.withdrawn
    }
}

/// Property: across random activity sequences (creates, withdrawals,
/// over-withdraw attempts, cancels, top-ups, fee reconfigurations, treasury
/// drains), after every single step
///   1. `treasury_status` equals the model ledger per token,
///   2. the paged `verify_treasury` scan sums exactly to `charged_total`
///      (the verifier always agrees), and
///   3. the contract's token balance equals outstanding stream funds plus
///      the collectible fees — fee funds and stream funds never mix.
#[test]
fn property_random_activity_sequences_keep_the_verifier_in_agreement() {
    for seed in [0x5EED_C0DE_0001, 0x5EED_C0DE_0002, 0x5EED_C0DE_0003] {
        run_fee_property(seed, 120);
    }
}

fn run_fee_property(seed: u64, steps: usize) {
    let env = Env::default();
    env.mock_all_auths();

    let sacs: [Address; 2] = [
        env.register_stellar_asset_contract_v2(Address::generate(&env))
            .address(),
        env.register_stellar_asset_contract_v2(Address::generate(&env))
            .address(),
    ];
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let governor = Address::generate(&env);
    let vault = Address::generate(&env);

    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let client = Client::new(&env, &contract_id);
    for token in &sacs {
        StellarAssetClient::new(&env, token).mint(&sender, &1_000_000_000_000i128);
        StellarAssetClient::new(&env, token).approve(
            &sender,
            &contract_id,
            &(i128::MAX / 2),
            &1_000_000u32,
        );
    }

    let mut rng = Rng(seed | 1);
    let mut streams: Vec<PStream> = Vec::new();
    let mut charged = [0i128; 2];
    let mut twithdrawn = [0i128; 2];
    let mut fee_bps: u32 = 0;

    for step in 0..steps {
        let ctx = format!("seed {seed:#x} step {step}");
        match rng.below(8) {
            0 => {
                // create a stream
                let ti = rng.below(2) as usize;
                let deposit = 1 + rng.below(1_000_000) as i128;
                let duration = 1 + rng.below(200);
                let start_in = rng.below(3);
                let cancelable = rng.below(2) == 0;
                let now = env.ledger().timestamp();
                let fee = crate::treasury::fee_amount(deposit, fee_bps).unwrap();
                let id = client.mock_all_auths().create_stream(
                    &sender,
                    &recipient,
                    &sacs[ti],
                    &deposit,
                    &(now + start_in),
                    &(now + start_in + duration),
                    &cancelable,
                );
                assert_eq!(id as usize, streams.len() + 1, "{ctx}: id sequence");
                charged[ti] += fee;
                streams.push(PStream {
                    token_idx: ti,
                    deposit,
                    withdrawn: 0,
                    fee,
                    start: now + start_in,
                    end: now + start_in + duration,
                    cancelable,
                    live: true,
                });
            }
            1 => {
                // advance time
                env.ledger()
                    .with_mut(|li| li.timestamp += 1 + rng.below(50));
            }
            2 => {
                // withdraw / withdraw_max / over-withdraw attempt
                if streams.is_empty() {
                    continue;
                }
                let idx = rng.below(streams.len() as u64) as usize;
                if !streams[idx].live {
                    continue;
                }
                let id = (idx as u64) + 1;
                let now = env.ledger().timestamp();
                let avail = streams[idx].available(now);
                match rng.below(4) {
                    0 if avail > 0 => {
                        client.mock_all_auths().withdraw(&id, &avail);
                        streams[idx].withdrawn += avail;
                    }
                    1 if avail > 0 => {
                        let amount = 1 + rng.below(avail as u64) as i128;
                        client.mock_all_auths().withdraw(&id, &amount);
                        streams[idx].withdrawn += amount;
                    }
                    2 => {
                        // Over-withdrawal must always revert, leaving state intact.
                        let err = client
                            .mock_all_auths()
                            .try_withdraw(&id, &(avail + 1))
                            .unwrap_err()
                            .unwrap();
                        assert_eq!(
                            err,
                            StreamError::AmountExceedsAvailable,
                            "{ctx}: over-withdraw"
                        );
                    }
                    _ => {
                        if avail > 0 {
                            let paid = client.mock_all_auths().withdraw_max(&id);
                            assert_eq!(paid, avail, "{ctx}: withdraw_max pays available");
                            streams[idx].withdrawn += paid;
                        } else {
                            let err = client
                                .mock_all_auths()
                                .try_withdraw_max(&id)
                                .unwrap_err()
                                .unwrap();
                            assert_eq!(err, StreamError::NothingToWithdraw, "{ctx}");
                        }
                    }
                }
                if streams[idx].withdrawn == streams[idx].deposit {
                    streams[idx].live = false;
                }
            }
            3 => {
                // cancel (sender)
                if streams.is_empty() {
                    continue;
                }
                let idx = rng.below(streams.len() as u64) as usize;
                if !streams[idx].live {
                    continue;
                }
                let id = (idx as u64) + 1;
                let now = env.ledger().timestamp();
                let avail = streams[idx].available(now);
                client.mock_all_auths().cancel_stream(&sender, &id);
                streams[idx].withdrawn += avail;
                streams[idx].live = false;
            }
            4 => {
                // top up
                if streams.is_empty() {
                    continue;
                }
                let idx = rng.below(streams.len() as u64) as usize;
                if !streams[idx].live {
                    continue;
                }
                let amount = 1 + rng.below(10_000) as i128;
                client.mock_all_auths().top_up(&((idx as u64) + 1), &amount);
                streams[idx].deposit += amount;
            }
            5 => {
                // reconfigure the fee rate
                fee_bps = rng.below(crate::MAX_FEE_BPS as u64 + 1) as u32;
                client.mock_all_auths().set_fee_bps(&governor, &fee_bps);
            }
            6 => {
                // treasury withdrawal (valid drain, exact drain, or a
                // guaranteed-to-fail attempt)
                let ti = rng.below(2) as usize;
                let collectible = charged[ti] - twithdrawn[ti];
                match rng.below(3) {
                    0 if collectible > 0 => {
                        let amount = 1 + rng.below(collectible as u64) as i128;
                        client
                            .mock_all_auths()
                            .withdraw_treasury(&governor, &sacs[ti], &vault, &amount);
                        twithdrawn[ti] += amount;
                    }
                    1 => {
                        let amount = if collectible == 0 {
                            0
                        } else {
                            collectible + 1 + rng.below(1_000) as i128
                        };
                        let expected = if amount == 0 {
                            StreamError::ZeroAmount
                        } else {
                            StreamError::InsufficientTreasuryBalance
                        };
                        let err = client
                            .mock_all_auths()
                            .try_withdraw_treasury(&governor, &sacs[ti], &vault, &amount)
                            .unwrap_err()
                            .unwrap();
                        assert_eq!(err, expected, "{ctx}: treasury overdraw guard");
                    }
                    _ => {
                        if collectible > 0 {
                            client.mock_all_auths().withdraw_treasury(
                                &governor,
                                &sacs[ti],
                                &vault,
                                &collectible,
                            );
                            twithdrawn[ti] += collectible;
                        }
                    }
                }
            }
            _ => {
                // cancel by the recipient (only on cancelable streams)
                if streams.is_empty() {
                    continue;
                }
                let idx = rng.below(streams.len() as u64) as usize;
                if !streams[idx].live || !streams[idx].cancelable {
                    continue;
                }
                let id = (idx as u64) + 1;
                let now = env.ledger().timestamp();
                let avail = streams[idx].available(now);
                client.mock_all_auths().cancel_stream(&recipient, &id);
                streams[idx].withdrawn += avail;
                streams[idx].live = false;
            }
        }

        // --- invariants, after every step ---
        assert_eq!(
            client.total_streams() as usize,
            streams.len(),
            "{ctx}: total_streams"
        );

        for (i, s) in streams.iter().enumerate() {
            assert_eq!(
                client.stream_fee(&((i as u64) + 1)),
                s.fee,
                "{ctx}: per-stream fee {}",
                i + 1
            );
        }

        for ti in 0..2 {
            let status = client.treasury_status(&sacs[ti]);
            assert_eq!(status.fee_bps, fee_bps, "{ctx}: fee_bps");
            assert_eq!(status.charged_total, charged[ti], "{ctx}: charged");
            assert_eq!(status.withdrawn_total, twithdrawn[ti], "{ctx}: withdrawn");
            assert_eq!(
                status.collectible,
                charged[ti] - twithdrawn[ti],
                "{ctx}: collectible"
            );

            // The verifier always agrees.
            let scanned = scan_all_fees(&client, &sacs[ti]);
            assert_eq!(
                scanned, charged[ti],
                "{ctx}: verifier disagrees for token {ti}"
            );

            // Conservation: the contract holds exactly what it owes —
            // outstanding stream funds + collectible fees.
            let outstanding: i128 = streams
                .iter()
                .filter(|s| s.token_idx == ti && s.live)
                .map(|s| s.deposit - s.withdrawn)
                .sum();
            assert_eq!(
                TokenClient::new(&env, &sacs[ti]).balance(&contract_id),
                outstanding + charged[ti] - twithdrawn[ti],
                "{ctx}: balance conservation for token {ti}"
            );
        }
    }
}

// ----------------------------------------- non-native (token) assets ------
//
// Tokenized assets (USDC-style) are a first-class path, not an incidental
// one: every money movement is exercised against a *registered* Stellar Asset
// Contract (the fixture's token is one, registered via
// `register_stellar_asset_contract_v2`), and each token-side failure must
// surface as its own `StreamError` code (18–22) — never the token's own error
// number, which lives in the same `Error(Contract, #N)` namespace.

/// Full lifecycle on a registered Stellar Asset Contract: create → top-up →
/// withdraw → withdraw_max → cancel, asserting token balances at every step
/// and that the total minted supply is conserved (contract holds exactly
/// `deposit − withdrawn` at all times).
#[test]
fn full_lifecycle_on_registered_stellar_asset() {
    let f = Fixture::setup(); // registers a SAC and funds the sender
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);

    // --- create: deposit pulled from the sender into the contract ---
    assert_eq!(f.client.get_stream(&id).token, f.token);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT // 2 * DEPOSIT minted − DEPOSIT pulled
    );

    // --- top-up after 2 days of the 10-day window ---
    f.advance_time(3 * DAY);
    f.client.mock_all_auths().top_up(&id, &(DEPOSIT / 2));
    let deposit = DEPOSIT + DEPOSIT / 2; // 1.5 ×
    assert_eq!(f.client.get_stream(&id).deposit, deposit);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        deposit
    );
    assert_eq!(f.client.available(&id), deposit * 2 / 10); // 0.3 ×

    // --- partial withdraw of accrued funds ---
    let first = DEPOSIT / 10;
    f.client.mock_all_auths().withdraw(&id, &first);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        first
    );

    // --- withdraw_max drains everything accrued so far ---
    f.advance_time(2 * DAY); // 4 of 10 days elapsed
    let accrued = deposit * 4 / 10;
    assert_eq!(f.client.available(&id), accrued - first);
    let paid = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(paid, accrued - first);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        accrued
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        deposit - accrued
    );

    // --- cancel splits the remainder across both legs (both > 0) ---
    f.advance_time(3 * DAY); // 7 of 10 days elapsed
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let streamed = deposit * 7 / 10; // 1.05 ×
    let stream = f.client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    // Recipient leg: accrued-but-unwithdrawn = streamed − withdrawn.
    // Sender leg: deposit − streamed. Recorded `withdrawn` = everything the
    // recipient has ever received.
    assert_eq!(stream.withdrawn, streamed);

    let token = TokenClient::new(&f.env, &f.token);
    assert_eq!(token.balance(&f.recipient), streamed);
    // Sender: un-deposited headroom (2× minted − 1.5× deposited) + refund
    // (deposit − streamed) — i.e. exactly `2 × DEPOSIT − streamed`.
    assert_eq!(token.balance(&f.sender), 2 * DEPOSIT - streamed);
    assert_eq!(token.balance(&f.client.address), 0);
    // Conservation: every unit of the 2 × minted supply is accounted for.
    assert_eq!(
        token.balance(&f.recipient) + token.balance(&f.sender) + token.balance(&f.client.address),
        2 * DEPOSIT
    );
}

/// A registered asset with balance but no allowance: the failed pull is
/// reported as `DepositTransferFailed` (not the SAC's own error code), and
/// nothing is persisted — not even a consumed stream id or an event.
#[test]
fn create_stream_without_allowance_reports_deposit_transfer_failed() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let sender = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&sender, &DEPOSIT);
    // …but `approve` was never called for this sender.

    let try_create = |sender: &Address| {
        f.client.mock_all_auths().try_create_stream(
            sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 11 * DAY),
            &false,
        )
    };

    let err = try_create(&sender).unwrap_err().unwrap();
    assert_eq!(err, StreamError::DepositTransferFailed);
    // No stream, no event, no consumed id — the failed pull rolled back.
    assert!(f.client.mock_all_auths().try_get_stream(&1).is_err());
    assert!(f
        .env
        .events()
        .all()
        .filter_by_contract(&f.client.address)
        .events()
        .is_empty());

    // Once approved, the very same call succeeds and hands out id 1.
    StellarAssetClient::new(&f.env, &f.token).approve(
        &sender,
        &f.client.address,
        &DEPOSIT,
        &1_000_000u32,
    );
    assert_eq!(try_create(&sender).unwrap().unwrap(), 1);
}

/// Allowance but no balance is a token-side failure too: same distinct code.
#[test]
fn create_stream_without_balance_reports_deposit_transfer_failed() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let broke = Address::generate(&f.env); // no tokens, but a full allowance
    StellarAssetClient::new(&f.env, &f.token).approve(
        &broke,
        &f.client.address,
        &DEPOSIT,
        &1_000_000u32,
    );

    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &broke,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 11 * DAY),
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DepositTransferFailed);
    assert!(f.client.mock_all_auths().try_get_stream(&1).is_err());
}

/// A top-up the sender's balance cannot cover fails with its own code and
/// leaves `deposit` and the contract's balance untouched; a retry within the
/// balance then succeeds.
#[test]
fn top_up_beyond_balance_reports_top_up_transfer_failed() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false); // sender keeps DEPOSIT

    // Allowance (10 × DEPOSIT) still covers it — this fails on balance only.
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &(2 * DEPOSIT))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::TopUpTransferFailed);
    assert_eq!(f.client.get_stream(&id).deposit, DEPOSIT);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );

    // Recovery: a top-up the balance can cover succeeds.
    f.client.mock_all_auths().top_up(&id, &DEPOSIT);
    assert_eq!(f.client.get_stream(&id).deposit, 2 * DEPOSIT);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        2 * DEPOSIT
    );
}

// ------------------------------------------------ refusing transfers ------

/// A token that refuses `transfer` (payouts) and/or `transfer_from` (pulls) on
/// demand — the moral equivalent of a frozen/blacklisted asset, and the
/// "token that refuses transfers" the non-native path must handle.
///
/// Its error code deliberately collides with `StreamError::NothingToWithdraw`
/// (13): if a raw token error ever leaked through StreamPay, these tests would
/// observe `#13` ("nothing to withdraw") instead of the dedicated code — the
/// exact misdiagnosis distinct codes exist to prevent.
#[contract]
pub(crate) struct RefusingToken;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub(crate) enum TokenRefuseError {
    /// Deliberately equals `StreamError::NothingToWithdraw` (13).
    Refused = 13,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum RefusingKey {
    RefusePush,
    RefusePull,
}

#[contractimpl]
impl RefusingToken {
    /// Refuses outgoing payouts (`transfer`), incoming pulls
    /// (`transfer_from`), both, or neither.
    pub fn set_refuse(env: Env, push: bool, pull: bool) {
        env.storage()
            .temporary()
            .set(&RefusingKey::RefusePush, &push);
        env.storage()
            .temporary()
            .set(&RefusingKey::RefusePull, &pull);
    }

    fn refuses(env: &Env, key: &RefusingKey) -> bool {
        env.storage().temporary().get(key).unwrap_or(false)
    }

    pub fn transfer(
        env: Env,
        _from: Address,
        _to: MuxedAddress,
        _amount: i128,
    ) -> Result<(), TokenRefuseError> {
        if Self::refuses(&env, &RefusingKey::RefusePush) {
            return Err(TokenRefuseError::Refused);
        }
        Ok(())
    }

    pub fn transfer_from(
        env: Env,
        _spender: Address,
        _from: Address,
        _to: Address,
        _amount: i128,
    ) -> Result<(), TokenRefuseError> {
        if Self::refuses(&env, &RefusingKey::RefusePull) {
            return Err(TokenRefuseError::Refused);
        }
        Ok(())
    }

    // --- read-only SEP-41 surface. Balances are fictional: these tests
    // assert StreamPay's own state, and real balance conservation is covered
    // by the Stellar Asset Contract tests above. ---
    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _live_until_ledger: u32,
    ) {
    }

    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }

    pub fn burn(_env: Env, _from: Address, _amount: i128) {}

    pub fn burn_from(_env: Env, _spender: Address, _from: Address, _amount: i128) {}

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "Refusing Token")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "REFUSE")
    }
}

/// Test driver for streams funded by the [`RefusingToken`]. Shared with the
/// error-surface matrix (`error_surface_test.rs`), whose probes need a token
/// that refuses a specific leg.
pub(crate) struct RefusingFixture {
    pub(crate) env: Env,
    pub(crate) client: Client<'static>,
    pub(crate) token: Address,
    pub(crate) token_client: RefusingTokenClient<'static>,
    pub(crate) sender: Address,
    pub(crate) recipient: Address,
    pub(crate) governor: Address,
}

impl RefusingFixture {
    pub(crate) fn setup() -> Self {
        Self::setup_with_snapshot(true)
    }

    /// Like [`RefusingFixture::setup`], but disables the SDK's test-snapshot
    /// capture: the error-surface matrix asserts through the branch trace, so a
    /// snapshot file per probe would be pure noise.
    pub(crate) fn setup_quiet() -> Self {
        Self::setup_with_snapshot(false)
    }

    fn setup_with_snapshot(capture_snapshots: bool) -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: capture_snapshots,
        });
        env.mock_all_auths();
        let token = env.register(RefusingToken, ());
        let token_client = RefusingTokenClient::new(&env, &token);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let governor = Address::generate(&env);
        // The constructor binds the treasury governor at "deploy" time.
        let contract_id = env.register(StreamingPayments, (governor.clone(),));
        let client = Client::new(&env, &contract_id);
        RefusingFixture {
            env,
            client,
            token,
            token_client,
            sender,
            recipient,
            governor,
        }
    }

    pub(crate) fn create(&self, deposit: i128, start_in: u64, duration: u64) -> u64 {
        let now = self.env.ledger().timestamp();
        self.client.mock_all_auths().create_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &deposit,
            &(now + start_in),
            &(now + start_in + duration),
            &true,
        )
    }

    pub(crate) fn refuse(&self, push: bool, pull: bool) {
        self.token_client.set_refuse(&push, &pull);
    }

    pub(crate) fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }
}

/// Creating a stream on an asset that refuses the pull fails with
/// `DepositTransferFailed`, consumes no id, and emits nothing — then works
/// (still at id 1) once the asset accepts transfers again.
#[test]
fn create_stream_against_refusing_token_reports_deposit_transfer_failed() {
    let f = RefusingFixture::setup();
    f.refuse(false, true); // refuses incoming pulls
    let now = f.env.ledger().timestamp();

    let try_create = || {
        f.client.mock_all_auths().try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 11 * DAY),
            &true,
        )
    };

    let err = try_create().unwrap_err().unwrap();
    // The token's own error is `Refused = 13` (NothingToWithdraw): seeing
    // StreamPay's #18 proves the raw token code did not leak.
    assert_eq!(err, StreamError::DepositTransferFailed);
    assert!(f.client.mock_all_auths().try_get_stream(&1).is_err());
    assert!(f
        .env
        .events()
        .all()
        .filter_by_contract(&f.client.address)
        .events()
        .is_empty());

    f.refuse(false, false);
    assert_eq!(try_create().unwrap().unwrap(), 1); // id counter never advanced
}

/// A top-up refused by the asset fails with `TopUpTransferFailed` and keeps
/// `deposit` untouched; re-enabling transfers lets the same top-up through.
#[test]
fn top_up_against_refusing_token_reports_top_up_transfer_failed() {
    let f = RefusingFixture::setup();
    let id = f.create(DEPOSIT, DAY, 10 * DAY);

    f.refuse(false, true); // stops accepting incoming transfers
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &(DEPOSIT / 2))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::TopUpTransferFailed);
    assert_eq!(f.client.get_stream(&id).deposit, DEPOSIT);

    f.refuse(false, false);
    f.client.mock_all_auths().top_up(&id, &(DEPOSIT / 2));
    assert_eq!(f.client.get_stream(&id).deposit, DEPOSIT + DEPOSIT / 2);
}

/// A payout refused by the asset fails with `RecipientPayoutFailed` and rolls
/// back *all* effects: `withdrawn`, status, accrual, and the event log. Both
/// withdrawal paths hit it; a re-enabled asset pays the full amount.
#[test]
fn withdraw_against_refusing_token_reports_recipient_payout_failed() {
    let f = RefusingFixture::setup();
    let id = f.create(DEPOSIT, 0, 10 * DAY); // starts now
    f.advance_time(DAY); // 1/10 accrued
    let _ = f.env.events().all(); // drain StreamCreated

    f.refuse(true, false); // asset stops paying out
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &(DEPOSIT / 10))
        .unwrap_err()
        .unwrap();
    // Token's own code is 13 (NothingToWithdraw) — StreamPay reports 20.
    assert_eq!(err, StreamError::RecipientPayoutFailed);

    // Effects written before the transfer were rolled back with it…
    let stream = f.client.get_stream(&id);
    assert_eq!(stream.withdrawn, 0);
    assert_eq!(stream.status, StreamStatus::Active);
    assert_eq!(f.client.available(&id), DEPOSIT / 10);
    // …and the failed attempt emitted no event.
    assert!(f
        .env
        .events()
        .all()
        .filter_by_contract(&f.client.address)
        .events()
        .is_empty());

    // withdraw_max hits the same wall with the same code, equally atomic.
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::RecipientPayoutFailed);
    assert_eq!(f.client.get_stream(&id).withdrawn, 0);

    // Re-enabling the asset lets the claim through, in full.
    f.refuse(false, false);
    assert_eq!(f.client.mock_all_auths().withdraw_max(&id), DEPOSIT / 10);
    assert_eq!(f.client.get_stream(&id).withdrawn, DEPOSIT / 10);
}

/// Cancellation reports *which* leg the asset refused — the recipient's
/// accrued share or the sender's refund — and rolls the whole cancellation
/// back so the stream stays `Active` with `withdrawn` restored.
#[test]
fn cancel_against_refusing_token_reports_the_failing_leg() {
    let f = RefusingFixture::setup();
    f.refuse(true, false); // asset pays out nothing

    // Accrued > 0 → the recipient leg runs first and fails.
    let id = f.create(DEPOSIT, DAY, 10 * DAY);
    f.advance_time(2 * DAY); // 1 of 10 days elapsed
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::RecipientPayoutFailed);
    let stream = f.client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Active); // cancellation undone
    assert_eq!(stream.withdrawn, 0);

    // Nothing accrued → the recipient leg is skipped, the refund leg fails.
    let not_started = f.create(DEPOSIT, DAY, 10 * DAY);
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &not_started)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::SenderRefundFailed);
    assert_eq!(
        f.client.get_stream(&not_started).status,
        StreamStatus::Active
    );

    // Re-enabled asset: both streams cancel normally afterwards.
    f.refuse(false, false);
    f.client
        .mock_all_auths()
        .cancel_stream(&f.sender, &not_started);
    assert_eq!(
        f.client.get_stream(&not_started).status,
        StreamStatus::Cancelled
    );
    assert_eq!(f.client.get_stream(&not_started).withdrawn, 0); // nothing accrued
}

/// A token that returns a non-`void` value from its transfer functions: not
/// SEP-41 shaped. The failed return-value conversion must be reported as a
/// transfer failure — not a panic and not a raw host error.
#[contract]
struct NonCompliantToken;

#[contractimpl]
impl NonCompliantToken {
    pub fn transfer(_env: Env, _from: Address, _to: MuxedAddress, _amount: i128) -> bool {
        true
    }

    pub fn transfer_from(
        _env: Env,
        _spender: Address,
        _from: Address,
        _to: Address,
        _amount: i128,
    ) -> bool {
        true
    }
}

#[test]
fn non_sep41_token_return_reports_transfer_failure() {
    let env = Env::default();
    env.mock_all_auths();
    let token = env.register(NonCompliantToken, ());
    let contract_id = env.register(StreamingPayments, (Address::generate(&env),));
    let client = Client::new(&env, &contract_id);
    let now = env.ledger().timestamp();

    let err = client
        .mock_all_auths()
        .try_create_stream(
            &Address::generate(&env),
            &Address::generate(&env),
            &token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 11 * DAY),
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DepositTransferFailed);
}
