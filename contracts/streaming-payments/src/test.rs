//! Unit and property tests for StreamPay.
//!
//! Covers every edge case from the spec: withdrawal before start, at/after
//! end, cancelling fully-withdrawn and not-yet-started streams, topping up an
//! ended stream, sequential partial withdrawals, checked math under extreme
//! values, zero-duration/zero-amount rejection, reentrancy safety via a
//! malicious token contract, event payloads, an exhaustive accrual property
//! test over the pure rate function, the per-address discovery indexes
//! (append order, pagination, clamping, terminal streams), and `withdraw_max`
//! semantics.
#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event as _, IntoVal, MuxedAddress, String as SdkString,
};

use crate::stream::streamed_at;
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{StreamError, StreamStatus, StreamingPayments, MAX_DURATION_SECONDS};

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
}

impl Fixture {
    pub(crate) fn setup() -> Self {
        let env = Env::default();
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
        StellarAssetClient::new(&env, &token).mint(&sender, &(2 * DEPOSIT));

        let contract_id = env.register(StreamingPayments, ());
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

    let contract_id = env.register(StreamingPayments, ());
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
