//! Unit and property tests for StreamPay.
//!
//! Covers every edge case from the spec: withdrawal before start, at/after
//! end, cancelling fully-withdrawn and not-yet-started streams, topping up an
//! ended stream, sequential partial withdrawals, checked math under extreme
//! values, zero-duration/zero-amount rejection, reentrancy safety via a
//! malicious token contract, event payloads, an exhaustive accrual property
//! test over the pure rate function, the per-address discovery indexes
//! (append order, pagination, clamping, terminal streams), and `withdraw_max`
//! semantics. A dedicated section pins the withdraw/cancel race semantics
//! (same-ledger ordering, losing-call error codes). Fixed-seed Proptest
//! state-machine sequences exercise the funds invariants across creates,
//! top-ups, withdrawals, and cancellations.
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

use crate::stream::{
    available_amount_at_segments, cancel_amounts_at_segments, streamed_amount_at,
    streamed_amount_at_segments, streamed_at, RateSegment,
};
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{
    bond_shares, required_bond, OwnershipRole, PendingRateChange, RateChangeAccepted,
    RateChangeProposed, Stream, StreamError, StreamInput, StreamStatus, StreamingPayments,
    INITIAL_SCHEMA_VERSION, MAX_DURATION_SECONDS, MAX_RATE_SEGMENTS, MIN_UPGRADE_DELAY_SECONDS,
    OWNERSHIP_PROPOSAL_TTL_SECONDS, RATE_PROPOSAL_TTL_SECONDS, TARGET_SCHEMA_VERSION,
};

// ---------------------------------------------------------------- fixtures --

const DAY: u64 = 24 * 60 * 60;
/// 1000 tokens with 7 decimals (default for SAC-issued assets in tests).
const DEPOSIT: i128 = 10_000_000_000;

/// A minimal but valid contract wasm. The upgrade tests upload it so that a
/// proposed `new_wasm_hash` really resolves in the test environment.
#[rustfmt::skip]
pub(crate) const UPGRADE_WASM: &[u8] = &[
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x1b, 0x05, 0x60,
    0x03, 0x7e, 0x7e, 0x7e, 0x01, 0x7e, 0x60, 0x02, 0x7e, 0x7e, 0x01, 0x7e,
    0x60, 0x02, 0x7f, 0x7e, 0x00, 0x60, 0x01, 0x7e, 0x01, 0x7e, 0x60, 0x00,
    0x00, 0x02, 0x19, 0x04, 0x01, 0x6c, 0x01, 0x5f, 0x00, 0x00, 0x01, 0x6c,
    0x01, 0x30, 0x00, 0x01, 0x01, 0x6c, 0x01, 0x31, 0x00, 0x01, 0x01, 0x6c,
    0x01, 0x32, 0x00, 0x01, 0x03, 0x06, 0x05, 0x01, 0x02, 0x03, 0x03, 0x04,
    0x05, 0x03, 0x01, 0x00, 0x10, 0x06, 0x19, 0x03, 0x7f, 0x01, 0x41, 0x80,
    0x80, 0xc0, 0x00, 0x0b, 0x7f, 0x00, 0x41, 0x80, 0x80, 0xc0, 0x00, 0x0b,
    0x7f, 0x00, 0x41, 0x80, 0x80, 0xc0, 0x00, 0x0b, 0x07, 0x3b, 0x07, 0x06,
    0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x03, 0x70, 0x75, 0x74,
    0x00, 0x04, 0x03, 0x67, 0x65, 0x74, 0x00, 0x06, 0x03, 0x64, 0x65, 0x6c,
    0x00, 0x07, 0x01, 0x5f, 0x00, 0x08, 0x0a, 0x5f, 0x5f, 0x64, 0x61, 0x74,
    0x61, 0x5f, 0x65, 0x6e, 0x64, 0x03, 0x01, 0x0b, 0x5f, 0x5f, 0x68, 0x65,
    0x61, 0x70, 0x5f, 0x62, 0x61, 0x73, 0x65, 0x03, 0x02, 0x0a, 0xd5, 0x02,
    0x05, 0x66, 0x01, 0x01, 0x7f, 0x23, 0x80, 0x80, 0x80, 0x80, 0x00, 0x41,
    0x20, 0x6b, 0x22, 0x02, 0x24, 0x80, 0x80, 0x80, 0x80, 0x00, 0x20, 0x02,
    0x41, 0x10, 0x6a, 0x20, 0x00, 0x10, 0x85, 0x80, 0x80, 0x80, 0x00, 0x02,
    0x40, 0x20, 0x02, 0x29, 0x03, 0x10, 0xa7, 0x0d, 0x00, 0x20, 0x02, 0x29,
    0x03, 0x18, 0x21, 0x00, 0x20, 0x02, 0x20, 0x01, 0x10, 0x85, 0x80, 0x80,
    0x80, 0x00, 0x20, 0x02, 0x29, 0x03, 0x00, 0xa7, 0x0d, 0x00, 0x20, 0x00,
    0x20, 0x02, 0x29, 0x03, 0x08, 0x42, 0x01, 0x10, 0x80, 0x80, 0x80, 0x80,
    0x00, 0x1a, 0x20, 0x02, 0x41, 0x20, 0x6a, 0x24, 0x80, 0x80, 0x80, 0x80,
    0x00, 0x42, 0x02, 0x0f, 0x0b, 0x00, 0x00, 0x0b, 0x24, 0x01, 0x01, 0x7f,
    0x20, 0x00, 0x20, 0x01, 0x37, 0x03, 0x08, 0x20, 0x00, 0x20, 0x01, 0xa7,
    0x41, 0xff, 0x01, 0x71, 0x22, 0x02, 0x41, 0x0e, 0x47, 0x20, 0x02, 0x41,
    0xca, 0x00, 0x47, 0x71, 0xad, 0x37, 0x03, 0x00, 0x0b, 0x7b, 0x02, 0x01,
    0x7f, 0x01, 0x7e, 0x23, 0x80, 0x80, 0x80, 0x80, 0x00, 0x41, 0x20, 0x6b,
    0x22, 0x01, 0x24, 0x80, 0x80, 0x80, 0x80, 0x00, 0x20, 0x01, 0x41, 0x10,
    0x6a, 0x20, 0x00, 0x10, 0x85, 0x80, 0x80, 0x80, 0x00, 0x02, 0x40, 0x20,
    0x01, 0x29, 0x03, 0x10, 0xa7, 0x0d, 0x00, 0x42, 0x02, 0x21, 0x00, 0x02,
    0x40, 0x20, 0x01, 0x29, 0x03, 0x18, 0x22, 0x02, 0x42, 0x01, 0x10, 0x81,
    0x80, 0x80, 0x80, 0x00, 0x42, 0x01, 0x52, 0x0d, 0x00, 0x20, 0x01, 0x20,
    0x02, 0x42, 0x01, 0x10, 0x82, 0x80, 0x80, 0x80, 0x00, 0x10, 0x85, 0x80,
    0x80, 0x80, 0x00, 0x20, 0x01, 0x29, 0x03, 0x00, 0xa7, 0x0d, 0x01, 0x20,
    0x01, 0x29, 0x03, 0x08, 0x21, 0x00, 0x0b, 0x20, 0x01, 0x41, 0x20, 0x6a,
    0x24, 0x80, 0x80, 0x80, 0x80, 0x00, 0x20, 0x00, 0x0f, 0x0b, 0x00, 0x00,
    0x0b, 0x48, 0x01, 0x01, 0x7f, 0x23, 0x80, 0x80, 0x80, 0x80, 0x00, 0x41,
    0x10, 0x6b, 0x22, 0x01, 0x24, 0x80, 0x80, 0x80, 0x80, 0x00, 0x20, 0x01,
    0x20, 0x00, 0x10, 0x85, 0x80, 0x80, 0x80, 0x00, 0x02, 0x40, 0x20, 0x01,
    0x29, 0x03, 0x00, 0xa7, 0x45, 0x0d, 0x00, 0x00, 0x00, 0x0b, 0x20, 0x01,
    0x29, 0x03, 0x08, 0x42, 0x01, 0x10, 0x83, 0x80, 0x80, 0x80, 0x00, 0x1a,
    0x20, 0x01, 0x41, 0x10, 0x6a, 0x24, 0x80, 0x80, 0x80, 0x80, 0x00, 0x42,
    0x02, 0x0b, 0x02, 0x00, 0x0b, 0x00, 0x9f, 0x01, 0x0e, 0x63, 0x6f, 0x6e,
    0x74, 0x72, 0x61, 0x63, 0x74, 0x73, 0x70, 0x65, 0x63, 0x76, 0x30, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x70,
    0x75, 0x74, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x03, 0x6b, 0x65, 0x79, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x76, 0x61, 0x6c, 0x00, 0x00,
    0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x67, 0x65, 0x74, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x6b,
    0x65, 0x79, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x00, 0x03, 0xe8, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x64, 0x65, 0x6c, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x6b,
    0x65, 0x79, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x1e, 0x11, 0x63, 0x6f, 0x6e, 0x74, 0x72, 0x61, 0x63, 0x74, 0x65, 0x6e,
    0x76, 0x6d, 0x65, 0x74, 0x61, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x77, 0x0e, 0x63, 0x6f,
    0x6e, 0x74, 0x72, 0x61, 0x63, 0x74, 0x6d, 0x65, 0x74, 0x61, 0x76, 0x30,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x72, 0x73, 0x76, 0x65,
    0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x31, 0x2e, 0x38, 0x31,
    0x2e, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08,
    0x72, 0x73, 0x73, 0x64, 0x6b, 0x76, 0x65, 0x72, 0x00, 0x00, 0x00, 0x35,
    0x32, 0x32, 0x2e, 0x30, 0x2e, 0x32, 0x23, 0x64, 0x66, 0x65, 0x38, 0x39,
    0x39, 0x62, 0x63, 0x31, 0x32, 0x63, 0x32, 0x32, 0x39, 0x37, 0x35, 0x35,
    0x31, 0x30, 0x36, 0x33, 0x65, 0x33, 0x30, 0x31, 0x35, 0x31, 0x66, 0x66,
    0x36, 0x35, 0x34, 0x66, 0x39, 0x37, 0x62, 0x38, 0x32, 0x65, 0x38, 0x2d,
    0x64, 0x69, 0x72, 0x74, 0x79, 0x00, 0x00, 0x00,
];

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
        self.create_stream_with_oracle(deposit, start_in, duration, cancelable, false)
    }

    pub(crate) fn create_stream_with_oracle(
        &self,
        deposit: i128,
        start_in: u64,
        duration: u64,
        cancelable: bool,
        use_oracle: bool,
    ) -> u64 {
        let now = self.env.ledger().timestamp();
        self.client.mock_all_auths().create_stream_with_oracle(
            &self.sender,
            &self.recipient,
            &self.token,
            &deposit,
            &(now + start_in),
            &(now + start_in + duration),
            &cancelable,
            &use_oracle,
        )
    }

    pub(crate) fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    /// Creates an address funded with `DEPOSIT` and pre-approved as a payer.
    pub(crate) fn fund_payer(&self) -> Address {
        let payer = Address::generate(&self.env);
        let sac = StellarAssetClient::new(&self.env, &self.token);
        sac.mint(&payer, &DEPOSIT);
        sac.approve(&payer, &self.client.address, &(10 * DEPOSIT), &1_000_000u32);
        payer
    }
}

#[test]
fn withdraw_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.advance_time(DAY);

    crate::cei_trace::begin();
    f.client.mock_all_auths().withdraw(&id, &DEPOSIT);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/withdraw.txt").trim_end()
    );
}

#[test]
fn withdraw_max_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.advance_time(DAY);

    crate::cei_trace::begin();
    f.client.mock_all_auths().withdraw_max(&id);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/withdraw_max.txt").trim_end()
    );
}

#[test]
fn cancel_stream_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, true);
    f.advance_time(DAY);

    crate::cei_trace::begin();
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/cancel_stream.txt").trim_end()
    );
}

#[test]
fn withdraw_treasury_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
    f.create_stream(DEPOSIT, 0, DAY, true);
    let fee = DEPOSIT / 100;

    crate::cei_trace::begin();
    f.client
        .mock_all_auths()
        .withdraw_treasury(&f.governor, &f.token, &f.recipient, &fee);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/withdraw_treasury.txt").trim_end()
    );
}

#[test]
fn frozen_withdrawal_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    f.client.mock_all_auths().set_frozen(&f.governor, &true);

    crate::cei_trace::begin();
    assert!(f.client.mock_all_auths().try_withdraw(&id, &1).is_err());
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/withdraw_frozen.txt").trim_end()
    );
}

#[test]
fn top_up_then_withdraw_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, DAY, true);
    let top_up = DEPOSIT / 10;

    crate::cei_trace::begin();
    f.client.mock_all_auths().top_up(&id, &top_up);
    f.advance_time(DAY);
    f.client.mock_all_auths().withdraw(&id, &(DEPOSIT + top_up));
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/top_up_then_withdraw.txt").trim_end()
    );
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

// ------------------------------------- withdraw/cancel race semantics -------
//
// Pinned semantics for the withdraw (recipient) / cancel_stream (sender)
// race. Each invocation runs to completion (CEI) before the next begins, even
// within a single ledger: last write wins in execution order, the losing call
// observes the post-write state, and the loser's error is always
// StreamNotActive (code 5) — no dedicated race code exists. Race table:
// docs/ARCHITECTURE.md §6.1; rustdoc on `withdraw` / `cancel_stream`.

#[test]
fn race_withdraw_then_cancel_splits_only_the_remainder() {
    // Partial withdraw first: the cancel pays the recipient the rest of the
    // accrued balance and refunds the sender the unaccrued remainder.
    // Conservation: the recipient ends with exactly `streamed` at cancel
    // time, regardless of how many withdrawals preceded the cancel.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY); // 2 of 10 days elapsed → streamed = DEPOSIT / 5

    let accrued = DEPOSIT / 5;
    let first = DEPOSIT / 10; // partial withdrawal
    f.client.mock_all_auths().withdraw(&id, &first);

    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    // The cancel recorded only the *remaining* accrued amount.
    assert_eq!(stream.withdrawn, accrued);
    // Recipient total = first + (accrued - first) = accrued.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        accrued
    );
    // Sender = unspent headroom (DEPOSIT) + refund (DEPOSIT - accrued).
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT + (DEPOSIT - accrued)
    );
    // Contract empty: nothing lost, nothing double-paid by the overlap.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
    assert_eq!(f.client.mock_all_auths().available(&id), 0);
}

#[test]
fn race_withdraw_max_then_cancel_reverts_stream_not_active() {
    // Full withdrawal first (drains to Depleted): the cancel loses the race
    // and reverts with StreamNotActive (#5); nothing else moves.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(20 * DAY); // fully accrued
    f.client.mock_all_auths().withdraw_max(&id);

    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
    assert_eq!(err.code(), 5);

    // State and balances unchanged by the losing call.
    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Depleted);
    assert_eq!(stream.withdrawn, DEPOSIT);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT // headroom only; the losing cancel refunded nothing
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn race_cancel_then_withdraw_reverts_stream_not_active() {
    // Cancel first: the withdraw loses the race and reverts with
    // StreamNotActive (#5), leaving the cancelled balances untouched.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY); // 2 of 10 days elapsed
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &(DEPOSIT / 10))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
    assert_eq!(err.code(), 5);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn, DEPOSIT / 5); // cancel payout only
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT / 5
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        2 * DEPOSIT - DEPOSIT / 5 // headroom + refund
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

#[test]
fn race_cancel_then_withdraw_max_reverts_stream_not_active() {
    // `withdraw_max` loses the same race as `withdraw`: same code, same
    // rollback guarantee.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
    assert_eq!(err.code(), 5);
    assert_eq!(f.client.mock_all_auths().available(&id), 0);
}

#[test]
fn race_same_ledger_timestamp_cancel_wins() {
    // Both calls land at the same ledger timestamp with no time advance in
    // between: execution order alone decides. The cancel executes first, so
    // the withdraw observes Cancelled and reverts — the race is strictly
    // serial, never interleaved.
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY);
    let t = f.env.ledger().timestamp();

    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
    assert_eq!(err.code(), 5);
    assert_eq!(f.env.ledger().timestamp(), t); // same ledger: no time passed
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        DEPOSIT / 5
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
// ------------------------------------------------------------ disputes ------

/// Base dispute bond for `DEPOSIT`: 5% (the first round; later rounds scale
/// linearly with the stream's dispute count).
const BOND: i128 = DEPOSIT / 20;
const DISPUTE_TIMEOUT: u64 = crate::DISPUTE_TIMEOUT_SECONDS;

impl Fixture {
    /// Gives the recipient `amount` tokens and approves the contract to pull
    /// it: dispute bonds are pulled with `transfer_from`, exactly like
    /// `create_stream` pulls the deposit from the sender.
    pub(crate) fn fund_recipient(&self, amount: i128) {
        let sac = StellarAssetClient::new(&self.env, &self.token);
        sac.mint(&self.recipient, &amount);
        sac.approve(
            &self.recipient,
            &self.client.address,
            &amount,
            &1_000_000u32,
        );
    }

    /// Funds the bond and raises a dispute on `id`, returning the recorded
    /// dispute.
    pub(crate) fn raise_dispute(&self, id: u64) -> crate::Dispute {
        let bond = self.client.required_dispute_bond(&id);
        self.fund_recipient(bond);
        self.client.mock_all_auths().raise_dispute(&id)
    }

    fn contract_balance(&self) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(&self.client.address)
    }

    fn recipient_balance(&self) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(&self.recipient)
    }

    fn sender_balance(&self) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(&self.sender)
    }
}

#[test]
fn dispute_raise_pulls_bond_and_stores_state() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // The view agrees with the on-chain bond actually posted.
    assert_eq!(f.client.required_dispute_bond(&id), BOND);

    let d = f.raise_dispute(id);
    assert_eq!(d.stream_id, id);
    assert_eq!(d.raised_by, f.recipient);
    assert_eq!(d.bond, BOND);
    assert_eq!(d.started_at, now);
    assert_eq!(d.expires_at, now + DISPUTE_TIMEOUT);
    assert_eq!(f.client.get_dispute(&id), d);

    // Bond moved from the recipient into the contract, on top of the deposit.
    assert_eq!(f.recipient_balance(), 0);
    assert_eq!(f.contract_balance(), DEPOSIT + BOND);
}

#[test]
fn dispute_freezes_cancel_and_top_up() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let d = f.raise_dispute(id);
    assert_eq!(d.bond, BOND);

    // Neither the sender nor the recipient can cancel while disputed.
    for caller in [&f.sender, &f.recipient] {
        let err = f
            .client
            .mock_all_auths()
            .try_cancel_stream(caller, &id)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, StreamError::DisputeActive);
    }
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &1000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DisputeActive);
}

#[test]
fn dispute_keeps_accrual_and_withdrawals_alive() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(2 * DAY);
    f.raise_dispute(id);

    // Time keeps streaming while the dispute is open.
    f.advance_time(DAY);
    assert_eq!(f.client.available(&id), DEPOSIT * 3 / 10);

    // The recipient can still claim what they earned during the dispute.
    f.client.mock_all_auths().withdraw(&id, &1000);
    let rest = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(f.recipient_balance(), 1000 + rest);
    assert_eq!(rest, DEPOSIT * 3 / 10 - 1000);
}

#[test]
fn dispute_raise_requires_recipient_authorization() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let attacker = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "raise_dispute",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_raise_dispute(&id).is_err());
}

#[test]
fn dispute_raise_rejections() {
    let f = Fixture::setup();

    let err = f
        .client
        .mock_all_auths()
        .try_raise_dispute(&999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotFound);

    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let d = f.raise_dispute(id);
    assert_eq!(d.bond, BOND);

    // One open dispute at a time.
    let err = f
        .client
        .mock_all_auths()
        .try_raise_dispute(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DisputeActive);

    // Terminal streams cannot be disputed.
    let ended = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    f.advance_time(20 * DAY);
    f.client.mock_all_auths().withdraw(&ended, &DEPOSIT);
    let err = f
        .client
        .mock_all_auths()
        .try_raise_dispute(&ended)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

/// Property: every state-mutating entrypoint (`create_stream`, `create_streams`,
/// `withdraw`, `withdraw_max`, `top_up`, `cancel_stream`, `withdraw_treasury`)
/// strictly preserves value conservation:
///   1. For every stream: deposit == withdrawn + available_recipient + refundable_sender.
///   2. For each token: token_balance(contract) == sum(active_escrows) + treasury_fees_retained.
#[test]
fn property_value_conservation_across_all_state_mutating_entrypoints() {
    for seed in [0xC011_5EED_0001, 0xC011_5EED_0002, 0xC011_5EED_0003] {
        run_value_conservation_property(seed, 100);
    }
}

fn run_value_conservation_property(seed: u64, steps: usize) {
    let env = Env::default();
    env.mock_all_auths();

    // Multi-token: Native XLM SAC and issued asset SAC
    let token_native = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_sac = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let tokens = [token_native, token_sac];

    let sender = Address::generate(&env);
    let recipients = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let governor = Address::generate(&env);
    let vault = Address::generate(&env);

    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let client = Client::new(&env, &contract_id);

    for token in &tokens {
        StellarAssetClient::new(&env, token).mint(&sender, &1_000_000_000_000_000i128);
        StellarAssetClient::new(&env, token).approve(
            &sender,
            &contract_id,
            &(i128::MAX / 2),
            &1_000_000u32,
        );
    }

    let mut rng = Rng(seed | 1);
    let mut stream_ids: Vec<u64> = Vec::new();

    for step in 0..steps {
        let ctx = format!("conservation seed {seed:#x} step {step}");
        match rng.below(9) {
            0 => {
                // 1. create_stream
                let ti = rng.below(2) as usize;
                let ri = rng.below(3) as usize;
                let deposit = 100 + rng.below(1_000_000) as i128;
                let duration = 10 + rng.below(500);
                let start_in = rng.below(10);
                let cancelable = rng.below(2) == 0;
                let now = env.ledger().timestamp();
                let id = client.mock_all_auths().create_stream(
                    &sender,
                    &recipients[ri],
                    &tokens[ti],
                    &deposit,
                    &(now + start_in),
                    &(now + start_in + duration),
                    &cancelable,
                );
                stream_ids.push(id);
            }
            1 => {
                // 2. create_streams (atomic batch)
                let count = 1 + rng.below(3) as usize;
                let mut inputs = soroban_sdk::Vec::new(&env);
                let now = env.ledger().timestamp();
                for _ in 0..count {
                    let ti = rng.below(2) as usize;
                    let ri = rng.below(3) as usize;
                    let deposit = 100 + rng.below(500_000) as i128;
                    let duration = 10 + rng.below(300);
                    let start_in = rng.below(5);
                    let cancelable = rng.below(2) == 0;
                    inputs.push_back(StreamInput {
                        recipient: recipients[ri].clone(),
                        token: tokens[ti].clone(),
                        deposit_amount: deposit,
                        start_time: now + start_in,
                        end_time: now + start_in + duration,
                        cancelable,
                    });
                }
                let ids = client.mock_all_auths().create_streams(&sender, &inputs);
                for id in ids.iter() {
                    stream_ids.push(id);
                }
            }
            2 => {
                // advance time
                env.ledger()
                    .with_mut(|li| li.timestamp += 1 + rng.below(60));
            }
            3 => {
                // 3. withdraw (partial or available)
                if !stream_ids.is_empty() {
                    let id = stream_ids[rng.below(stream_ids.len() as u64) as usize];
                    let stream = client.get_stream(&id);
                    if stream.status == StreamStatus::Active {
                        let avail = client.available(&id);
                        if avail > 0 {
                            let withdraw_amt = 1 + rng.below(avail as u64) as i128;
                            client.mock_all_auths().withdraw(&id, &withdraw_amt);
                        }
                    }
                }
            }
            4 => {
                // 4. withdraw_max
                if !stream_ids.is_empty() {
                    let id = stream_ids[rng.below(stream_ids.len() as u64) as usize];
                    let stream = client.get_stream(&id);
                    if stream.status == StreamStatus::Active {
                        let avail = client.available(&id);
                        if avail > 0 {
                            let paid = client.mock_all_auths().withdraw_max(&id);
                            assert_eq!(paid, avail, "{ctx}: withdraw_max mismatch");
                        }
                    }
                }
            }
            5 => {
                // 5. top_up
                if !stream_ids.is_empty() {
                    let id = stream_ids[rng.below(stream_ids.len() as u64) as usize];
                    let stream = client.get_stream(&id);
                    if stream.status == StreamStatus::Active {
                        let add = 1 + rng.below(100_000) as i128;
                        client.mock_all_auths().top_up(&id, &add);
                    }
                }
            }
            6 => {
                // 6. cancel_stream (by sender or recipient if cancelable)
                if !stream_ids.is_empty() {
                    let id = stream_ids[rng.below(stream_ids.len() as u64) as usize];
                    let stream = client.get_stream(&id);
                    if stream.status == StreamStatus::Active {
                        let by_recipient = rng.below(2) == 0;
                        if by_recipient && stream.cancelable {
                            client
                                .mock_all_auths()
                                .cancel_stream(&stream.recipient, &id);
                        } else if !by_recipient {
                            client.mock_all_auths().cancel_stream(&stream.sender, &id);
                        }
                    }
                }
            }
            7 => {
                // 7. withdraw_treasury
                let ti = rng.below(2) as usize;
                let status = client.treasury_status(&tokens[ti]);
                if status.collectible > 0 {
                    let amount = 1 + rng.below(status.collectible as u64) as i128;
                    client.mock_all_auths().withdraw_treasury(
                        &governor,
                        &tokens[ti],
                        &vault,
                        &amount,
                    );
                }
            }
            _ => {
                // fee bps reconfiguration
                let fee_bps = rng.below(crate::MAX_FEE_BPS as u64 + 1) as u32;
                client.mock_all_auths().set_fee_bps(&governor, &fee_bps);
            }
        }

        // --- Value Conservation Checks after every single mutation ---
        // 1. Per-stream invariant: deposit == withdrawn + available + refundable
        for &id in &stream_ids {
            let stream = client.get_stream(&id);
            if stream.status == StreamStatus::Active {
                let avail = client.available(&id);
                assert!(avail >= 0, "{ctx}: stream {id} available negative");
                assert!(
                    stream.withdrawn + avail <= stream.deposit,
                    "{ctx}: stream {id} payout exceeds deposit"
                );
                let refundable = stream.deposit - (stream.withdrawn + avail);
                assert!(refundable >= 0, "{ctx}: stream {id} refundable negative");
                assert_eq!(
                    stream.deposit,
                    stream.withdrawn + avail + refundable,
                    "{ctx}: stream {id} conservation invariant failed"
                );
            }
        }

        // 2. Contract-wide balance cross-check:
        // token_balance(contract) == sum(active_stream_escrows) + treasury_fees_retained
        for (ti, token) in tokens.iter().enumerate() {
            let status = client.treasury_status(token);
            let retained = status.charged_total - status.withdrawn_total;
            assert_eq!(
                status.collectible, retained,
                "{ctx}: treasury collectible mismatch for token {ti}"
            );

            let mut active_escrows: i128 = 0;
            for &id in &stream_ids {
                let stream = client.get_stream(&id);
                if stream.status == StreamStatus::Active && stream.token == *token {
                    active_escrows += stream.deposit - stream.withdrawn;
                }
            }

            let contract_balance = TokenClient::new(&env, token).balance(&contract_id);
            assert_eq!(
                contract_balance,
                active_escrows + retained,
                "{ctx}: contract balance conservation failed for token {ti}"
            );
        }
    }
}
// ------------------------------------------------------------ policy tests --

#[test]
fn policy_uninitialized_allows_any_asset_without_regression() {
    let f = Fixture::setup();
    // In an uninitialized policy state, admin and pending admin are None.
    assert_eq!(f.client.policy_admin(), None);
    assert_eq!(f.client.policy_pending_admin(), None);
    assert!(f.client.policy_is_asset_allowed(&f.token));

    // Creating streams works exactly as before.
    let now = f.env.ledger().timestamp();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let s = f.client.get_stream(&id);
    assert_eq!(s.id, id);
    assert_eq!(s.start_time, now + DAY);
}

#[test]
fn policy_init_sets_admin_and_timelock_delay() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);

    assert_eq!(f.client.policy_admin(), Some(admin));
    assert_eq!(f.client.policy_pending_admin(), None);
    assert_eq!(
        f.client.policy_timelock_delay(),
        crate::policy::DEFAULT_TIMELOCK_DELAY
    );
}

#[test]
#[should_panic(expected = "policy already initialized")]
fn policy_double_init_panics() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);
    let other = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&other);
}

#[test]
fn policy_anti_brick_invariant_allows_withdraw_and_refund_after_asset_removed() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);

    // 1. Create a stream with asset f.token while it is allowed.
    let now = f.env.ledger().timestamp();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);

    // 2. Admin proposes removing f.token from the allowlist.
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &false);
    let delay = f.client.policy_timelock_delay();
    f.advance_time(delay);

    // 3. Permissionlessly execute the queued removal.
    f.client.mock_all_auths().policy_execute_asset(&f.token);
    assert!(!f.client.policy_is_asset_allowed(&f.token));

    // 4. Verify new streams with f.token are rejected (single and batch).
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 2 * DAY),
        &(now + 5 * DAY),
        &true,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyAssetNotAllowed
    );

    let batch_input = crate::StreamInput {
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit_amount: DEPOSIT,
        start_time: now + 2 * DAY,
        end_time: now + 5 * DAY,
        cancelable: true,
    };
    let mut inputs = soroban_sdk::Vec::new(&f.env);
    inputs.push_back(batch_input);
    let batch_res = f
        .client
        .mock_all_auths()
        .try_create_streams(&f.sender, &inputs);
    assert_eq!(
        batch_res.unwrap_err().unwrap(),
        StreamError::PolicyAssetNotAllowed
    );

    // 5. Anti-brick invariant: existing stream remains fully withdrawable!
    f.advance_time(2 * DAY); // now into the stream window
    let avail = f.client.mock_all_auths().available(&id);
    assert!(avail > 0);
    f.client.mock_all_auths().withdraw(&id, &(avail / 2));
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        avail / 2
    );

    // 6. Anti-brick invariant: existing stream remains fully refundable (cancelable)!
    let recipient_before = TokenClient::new(&f.env, &f.token).balance(&f.recipient);
    let sender_before = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    // Both recipient and sender received their fair pro-rata split!
    assert!(TokenClient::new(&f.env, &f.token).balance(&f.recipient) > recipient_before);
    assert!(TokenClient::new(&f.env, &f.token).balance(&f.sender) > sender_before);
}

#[test]
fn policy_timelock_enforcement_and_bypass_attempt() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);

    // Queue change: remove f.token.
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &false);
    let delay = f.client.policy_timelock_delay();

    // 1. Attempt to execute before timelock elapses -> fails with PolicyTimelockNotElapsed.
    f.advance_time(delay - 10);
    let err = f
        .client
        .mock_all_auths()
        .try_policy_execute_asset(&f.token)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::PolicyTimelockNotElapsed);

    // 2. Timelock bypass attempt: executing an asset with no queued proposal -> fails with PolicyNoQueuedChange.
    let other_asset = Address::generate(&f.env);
    let err_no_change = f
        .client
        .mock_all_auths()
        .try_policy_execute_asset(&other_asset)
        .unwrap_err()
        .unwrap();
    assert_eq!(err_no_change, StreamError::PolicyNoQueuedChange);

    // 3. Advance the remaining 10 seconds to satisfy the timelock.
    f.advance_time(10);
    // Callable by anyone (permissionless).
    f.client.mock_all_auths().policy_execute_asset(&f.token);
    assert!(!f.client.policy_is_asset_allowed(&f.token));
}

#[test]
fn policy_two_step_handoff_and_cancel() {
    let f = Fixture::setup();
    let admin1 = Address::generate(&f.env);
    let admin2 = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin1);

    // Step 1: Admin1 proposes Admin2.
    f.client.mock_all_auths().policy_propose_handoff(&admin2);
    assert_eq!(f.client.policy_pending_admin(), Some(admin2.clone()));

    // Admin1 cancels handoff.
    f.client.mock_all_auths().policy_cancel_handoff();
    assert_eq!(f.client.policy_pending_admin(), None);

    // Admin1 proposes Admin2 again.
    f.client.mock_all_auths().policy_propose_handoff(&admin2);

    // Step 2: Admin2 accepts handoff.
    f.client.mock_all_auths().policy_accept_handoff();
    assert_eq!(f.client.policy_admin(), Some(admin2.clone()));
    assert_eq!(f.client.policy_pending_admin(), None);

    // Admin2 can now propose changes.
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &false);
    assert!(f.client.policy_get_queued_asset(&f.token).is_some());
}

#[test]
fn policy_handoff_rejection_when_no_handoff_pending() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);

    // No handoff pending: accept and cancel revert with PolicyNoPendingHandoff.
    let err_accept = f
        .client
        .mock_all_auths()
        .try_policy_accept_handoff()
        .unwrap_err()
        .unwrap();
    assert_eq!(err_accept, StreamError::PolicyNoPendingHandoff);

    let err_cancel = f
        .client
        .mock_all_auths()
        .try_policy_cancel_handoff()
        .unwrap_err()
        .unwrap();
    assert_eq!(err_cancel, StreamError::PolicyNoPendingHandoff);
}

#[test]
fn policy_handoff_mid_timelock_execution() {
    let f = Fixture::setup();
    let admin1 = Address::generate(&f.env);
    let admin2 = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin1);

    // Propose handoff and queue asset change in parallel.
    f.client.mock_all_auths().policy_propose_handoff(&admin2);
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &false);

    // Complete handoff before timelock matures.
    f.client.mock_all_auths().policy_accept_handoff();
    assert_eq!(f.client.policy_admin(), Some(admin2));

    // Advance time past delay.
    let delay = f.client.policy_timelock_delay();
    f.advance_time(delay);

    // The queued change is still valid and executable permissionlessly.
    f.client.mock_all_auths().policy_execute_asset(&f.token);
    assert!(!f.client.policy_is_asset_allowed(&f.token));
}

#[test]
fn policy_configurable_timelock_delay() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);

    // Admin updates delay to 86_400 (1 day).
    f.client.mock_all_auths().policy_set_timelock_delay(&86_400);
    assert_eq!(f.client.policy_timelock_delay(), 86_400);

    // Queue change: should mature after 86_400 seconds.
    let now = f.env.ledger().timestamp();
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &false);
    let queued = f.client.policy_get_queued_asset(&f.token).unwrap();
    assert_eq!(queued.executable_after, now + 86_400);
}

#[test]
fn policy_auth_enforcement_panics_without_correct_auth() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    let stranger = Address::generate(&f.env);

    // 1. policy_init requires admin's authorization.
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_init",
            args: (admin.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_policy_init(&admin).is_err());

    // Initialize with actual admin auth.
    f.env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_init",
            args: (admin.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    f.client.policy_init(&admin);

    // 2. policy_propose_asset requires admin auth.
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_propose_asset",
            args: (f.token.clone(), false).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_policy_propose_asset(&f.token, &false).is_err());

    // 3. policy_propose_handoff requires admin auth.
    let new_admin = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_propose_handoff",
            args: (new_admin.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_policy_propose_handoff(&new_admin).is_err());

    // Propose new_admin with valid admin auth.
    f.env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_propose_handoff",
            args: (new_admin.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    f.client.policy_propose_handoff(&new_admin);

    // 4. policy_accept_handoff requires proposed admin (new_admin) auth.
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_accept_handoff",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_policy_accept_handoff().is_err());

    // 5. policy_cancel_handoff requires current admin auth.
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_cancel_handoff",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_policy_cancel_handoff().is_err());

    // 6. policy_set_timelock_delay requires current admin auth.
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "policy_set_timelock_delay",
            args: (100u64,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_policy_set_timelock_delay(&100).is_err());
}

#[test]
fn policy_entrypoints_reject_when_uninitialized() {
    let f = Fixture::setup();
    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client
            .mock_all_auths()
            .try_policy_propose_asset(&f.token, &false)
            .unwrap_err()
            .unwrap(),
        StreamError::PolicyNotInitialized
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_policy_execute_asset(&f.token)
            .unwrap_err()
            .unwrap(),
        StreamError::PolicyNotInitialized
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_policy_propose_handoff(&stranger)
            .unwrap_err()
            .unwrap(),
        StreamError::PolicyNotInitialized
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_policy_accept_handoff()
            .unwrap_err()
            .unwrap(),
        StreamError::PolicyNotInitialized
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_policy_cancel_handoff()
            .unwrap_err()
            .unwrap(),
        StreamError::PolicyNotInitialized
    );
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_policy_set_timelock_delay(&3600)
            .unwrap_err()
            .unwrap(),
        StreamError::PolicyNotInitialized
    );
}

#[test]
fn policy_re_allow_previously_removed_asset() {
    let f = Fixture::setup();
    let admin = Address::generate(&f.env);
    f.client.mock_all_auths().policy_init(&admin);
    f.client.mock_all_auths().policy_set_timelock_delay(&0);

    // 1. Remove asset
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &false);
    f.client.mock_all_auths().policy_execute_asset(&f.token);
    assert!(!f.client.policy_is_asset_allowed(&f.token));

    // 2. Re-allow asset
    f.client
        .mock_all_auths()
        .policy_propose_asset(&f.token, &true);
    f.client.mock_all_auths().policy_execute_asset(&f.token);
    assert!(f.client.policy_is_asset_allowed(&f.token));

    // 3. New stream succeeds now
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    assert_eq!(f.client.get_stream(&id).id, id);
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

#[test]
fn dispute_resolve_reject_slashes_bond_and_resumes_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);

    // Only the sender resolves; the recipient calling it is rejected.
    let err = f
        .client
        .mock_all_auths()
        .try_resolve_dispute(&f.recipient, &id, &false)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);

    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);

    // The bond compensates the sender; the stream keeps running.
    assert_eq!(f.sender_balance(), DEPOSIT + BOND);
    assert_eq!(f.recipient_balance(), 0);
    assert_eq!(f.contract_balance(), DEPOSIT);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Active,
    );
    let err = f
        .client
        .mock_all_auths()
        .try_get_dispute(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DisputeNotFound);

    // Mutations are live again.
    f.client.mock_all_auths().top_up(&id, &1000);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
}

#[test]
fn dispute_resolve_accept_refunds_bond_and_unwinds_stream() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(3 * DAY);
    f.raise_dispute(id);

    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &true);

    // Recipient: bond back + everything accrued. Sender: the unaccrued
    // remainder. Contract holds nothing.
    let accrued = DEPOSIT * 3 / 10;
    assert_eq!(f.recipient_balance(), BOND + accrued);
    assert_eq!(f.sender_balance(), DEPOSIT + (DEPOSIT - accrued));
    assert_eq!(f.contract_balance(), 0);

    let stream = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn, accrued);
}

#[test]
fn dispute_expire_requires_full_timelock_then_splits_bond() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);

    // One second shy of the timelock: nobody can expire it yet.
    f.advance_time(DISPUTE_TIMEOUT - 1);
    let err = f
        .client
        .mock_all_auths()
        .try_expire_dispute(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::DisputeNotExpired);

    // At `expires_at` exactly, anyone can.
    f.advance_time(1);
    f.client.mock_all_auths().expire_dispute(&id);

    assert_eq!(f.sender_balance(), DEPOSIT + BOND / 2);
    assert_eq!(f.recipient_balance(), BOND / 2);
    assert_eq!(f.contract_balance(), DEPOSIT);

    // The stream resumed normally.
    f.client.mock_all_auths().top_up(&id, &1000);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
}

#[test]
fn serial_disputes_escalate_the_bond_and_the_attacker_cost() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let mut sender_gains = 0i128;
    let mut posted = [0i128; 3];
    for round in 1..=3i128 {
        // The required bond scales linearly with the dispute count: the
        // same recipient griefing week after week pays more each time.
        let required = BOND * round;
        assert_eq!(f.client.required_dispute_bond(&id), required);
        let d = f.raise_dispute(id);
        assert_eq!(d.bond, required);
        posted[(round - 1) as usize] = required;

        // Frozen the whole window, every round.
        let err = f
            .client
            .mock_all_auths()
            .try_top_up(&id, &1000)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, StreamError::DisputeActive);

        // The passive sender lets it expire: the attacker loses half the
        // (escalating) bond per blocked week.
        f.advance_time(DISPUTE_TIMEOUT);
        f.client.mock_all_auths().expire_dispute(&id);
        sender_gains += (required + 1) / 2;
        assert_eq!(f.sender_balance(), DEPOSIT + sender_gains);
    }
    assert_eq!(posted, [BOND, 2 * BOND, 3 * BOND]);

    // Cumulative attacker loss over three griefing weeks: Σ ceil(n·BOND/2),
    // against a stream that only pays out 100% of DEPOSIT over its window.
    let attacker_loss = (BOND + 1) / 2 + BOND + (3 * BOND + 1) / 2;
    assert_eq!(attacker_loss, 3 * BOND);
    assert_eq!(f.recipient_balance(), 6 * BOND - attacker_loss);
    assert_eq!(f.contract_balance(), DEPOSIT);
}

#[test]
fn dispute_expired_after_recipient_drained_stream_in_dispute() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.raise_dispute(id);

    // The stream completes *during* the dispute and the recipient withdraws
    // everything — the dispute entry and bond survive independently.
    f.advance_time(3 * DAY);
    let paid = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(paid, DEPOSIT);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Depleted,
    );
    assert_eq!(f.contract_balance(), BOND);

    f.advance_time(DISPUTE_TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);
    assert_eq!(f.sender_balance(), DEPOSIT + BOND / 2);
    assert_eq!(f.recipient_balance(), DEPOSIT + BOND / 2);
    assert_eq!(f.contract_balance(), 0);
}

#[test]
fn dispute_accept_on_stream_depleted_during_dispute_only_refunds_bond() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.raise_dispute(id);
    f.advance_time(3 * DAY);
    f.client.mock_all_auths().withdraw_max(&id);

    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &true);

    // Bond back to the recipient; the depleted stream is left as-is (no
    // cancel split, no `StreamCancelled` event).
    assert_eq!(f.recipient_balance(), DEPOSIT + BOND);
    assert_eq!(f.sender_balance(), DEPOSIT);
    assert_eq!(f.contract_balance(), 0);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Depleted,
    );
}

#[test]
fn dispute_events_are_emitted_with_expected_payloads() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    // Drain StreamCreated.
    let _ = f.env.events().all();

    let d = f.raise_dispute(id);
    let raised = crate::DisputeRaised {
        stream_id: id,
        recipient: f.recipient.clone(),
        bond: BOND,
        expires_at: d.expires_at,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [raised.to_xdr(&f.env, &f.client.address)],
    );

    let resolved = crate::DisputeResolved {
        stream_id: id,
        sender: f.sender.clone(),
        accept: false,
        bond: BOND,
    };
    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [resolved.to_xdr(&f.env, &f.client.address)],
    );

    let d2 = f.raise_dispute(id);
    assert_eq!(d2.bond, 2 * BOND);
    let expired = crate::DisputeExpired {
        stream_id: id,
        recipient: f.recipient.clone(),
        bond: 2 * BOND,
        sender_share: BOND,
        recipient_share: BOND,
    };
    f.advance_time(3 * DISPUTE_TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [expired.to_xdr(&f.env, &f.client.address)],
    );
}

#[test]
fn dispute_resolve_accept_emits_cancelled_then_resolved() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(2 * DAY);
    f.raise_dispute(id);
    let _ = f.env.events().all(); // drain through DisputeRaised

    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &true);

    let accrued = DEPOSIT * 2 / 10;
    let cancelled = crate::StreamCancelled {
        stream_id: id,
        cancelled_by: f.sender.clone(),
        recipient_amount: accrued,
        sender_amount: DEPOSIT - accrued,
    };
    let resolved = crate::DisputeResolved {
        stream_id: id,
        sender: f.sender.clone(),
        accept: true,
        bond: BOND,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [
            cancelled.to_xdr(&f.env, &f.client.address),
            resolved.to_xdr(&f.env, &f.client.address),
        ],
    );
}

// ------------------------------------------------- dispute math (pure) ----

#[test]
fn required_bond_is_escalating_floored_and_checked() {
    // 5% of the deposit, scaled by the dispute round.
    assert_eq!(required_bond(20_000, 0).unwrap(), 1_000);
    assert_eq!(required_bond(20_000, 2).unwrap(), 3_000);
    // Floored at one token unit — disputes on dust streams are never free.
    assert_eq!(required_bond(7, 0).unwrap(), 1);
    assert_eq!(required_bond(0, 0).unwrap(), 1);
    // Monotonic in both inputs.
    let mut prev = 0;
    for n in 0..16 {
        let b = required_bond(123_456_789, n).unwrap();
        assert!(b > prev);
        prev = b;
    }
    // Overflow is reported, never panicked.
    assert_eq!(
        required_bond(i128::MAX, 0).unwrap_err(),
        StreamError::MathOverflow
    );
}

#[test]
fn bond_shares_always_sum_to_the_bond_and_favor_the_sender() {
    for bond in [1i128, 2, 3, 999, 1_000_000, i128::MAX] {
        let (sender, recipient) = bond_shares(bond);
        assert_eq!(sender + recipient, bond);
        assert!(sender >= recipient);
        assert!(sender - recipient <= 1);
    }
}

#[test]
fn raise_dispute_reports_bond_overflow_without_touching_state() {
    let f = Fixture::setup();
    // A deposit just past the `u128::MAX / BPS` boundary: `create_stream`
    // admits it (duration 1 keeps the accrual product in range), but the
    // bond computation must error, never panic, and pull nothing in.
    let big = (u128::MAX / crate::DISPUTE_BOND_BPS + 1) as i128;
    let now = f.env.ledger().timestamp();
    let sac = StellarAssetClient::new(&f.env, &f.token);
    sac.mint(&f.sender, &big);
    sac.approve(&f.sender, &f.client.address, &big, &1_000_000u32);
    let id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &big,
        &now,
        &(now + 1),
        &false,
    );
    let err = f
        .client
        .mock_all_auths()
        .try_raise_dispute(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::MathOverflow);
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_get_dispute(&id)
            .unwrap_err()
            .unwrap(),
        StreamError::DisputeNotFound,
    );
}

// --------------------------------------------------- bond invariant -------

/// Tiny deterministic PRNG (xorshift64) so the invariant scenario below is
/// reproducible — and snapshot-stable.
struct BondRng(u64);
impl BondRng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Invariant (extends the fuzz oracle to the dispute bonds): after *every*
/// random operation, the contract's token balance must equal
/// `sum(deposit - withdrawn)` over all streams **plus the sum of the
/// outstanding dispute bonds**.
#[test]
fn property_contract_balance_equals_locks_plus_outstanding_bonds() {
    let f = Fixture::setup();
    let mut rng = BondRng(0x9E37_79B9_7F4A_7C15);

    let mut ids = [0u64; 4];
    for (i, slot) in ids.iter_mut().enumerate() {
        *slot = f.create_stream(DEPOSIT / 2, i as u64, 30 * DAY, true);
    }

    // Per-stream model of the bonds the contract should be holding.
    struct Open {
        bond: i128,
        expires_at: u64,
    }
    let mut open: [Option<Open>; 4] = Default::default();

    for step in 0..60 {
        let k = rng.below(4) as usize;
        let id = ids[k];
        match rng.below(7) {
            0 => {
                let _ = f
                    .client
                    .mock_all_auths()
                    .try_withdraw(&id, &(step as i128 + 1));
            }
            1 => {
                let _ = f.client.mock_all_auths().try_withdraw_max(&id);
            }
            2 => {
                let _ = f.client.mock_all_auths().try_top_up(&id, &1000);
            }
            3 => {
                if let Ok(Ok(r)) = f.client.try_required_dispute_bond(&id) {
                    // Fund exactly this round's bond (approve overwrites).
                    f.fund_recipient(r);
                    if let Ok(Ok(d)) = f.client.mock_all_auths().try_raise_dispute(&id) {
                        open[k] = Some(Open {
                            bond: d.bond,
                            expires_at: d.expires_at,
                        });
                    }
                }
            }
            4 => {
                if open[k].is_some() {
                    let accept = rng.below(2) == 0;
                    if f.client
                        .mock_all_auths()
                        .try_resolve_dispute(&f.sender, &id, &accept)
                        .is_ok()
                    {
                        open[k] = None;
                    }
                }
            }
            5 => {
                if open[k]
                    .as_ref()
                    .is_some_and(|o| f.env.ledger().timestamp() >= o.expires_at)
                    && f.client.mock_all_auths().try_expire_dispute(&id).is_ok()
                {
                    open[k] = None;
                }
            }
            _ => {
                // Random walk through the clock: small ticks, occasionally a
                // full dispute window so expiry paths actually get hit.
                let jump = if rng.below(3) == 0 {
                    DISPUTE_TIMEOUT
                } else {
                    6 * 60 * 60
                };
                f.advance_time(jump);
            }
        }

        // The invariant, recomputed from on-chain state + the bond model.
        // Cancelled streams hold nothing: their cancel split paid the
        // sender the unaccrued remainder already, so only Active/Depleted
        // streams still lock `deposit - withdrawn`.
        let mut expected_locks = 0i128;
        for (i, slot) in ids.iter().enumerate() {
            let s = f.client.get_stream(slot);
            if s.status != StreamStatus::Cancelled {
                expected_locks += s.deposit - s.withdrawn;
            }
            if let Some(o) = &open[i] {
                let d = f.client.get_dispute(slot);
                assert_eq!(d.bond, o.bond, "stale bond model at step {step}");
                expected_locks += o.bond;
            } else {
                assert!(
                    f.client.try_get_dispute(slot).is_err(),
                    "phantom dispute at step {step}"
                );
            }
        }
        assert_eq!(
            f.contract_balance(),
            expected_locks,
            "lock invariant broken at step {step}"
        );
    }
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
// ------------------------------------------------------------- batch creation -

#[test]
fn create_streams_batch_success() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let recipient2 = Address::generate(&f.env);

    let mut entries = soroban_sdk::Vec::new(&f.env);
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: 1_000_000,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: true,
    });
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: recipient2.clone(),
        token: f.token.clone(),
        deposit: 2_000_000,
        start_time: now + 2 * DAY,
        end_time: now + 20 * DAY,
        cancelable: false,
    });

    let results = f.client.mock_all_auths().create_streams_batch(&entries);

    assert_eq!(results.len(), 2);
    let id1 = results.get(0).unwrap().unwrap();
    let id2 = results.get(1).unwrap().unwrap();

    let s1 = f.client.get_stream(&id1);
    assert_eq!(s1.sender, f.sender);
    assert_eq!(s1.recipient, f.recipient);
    assert_eq!(s1.deposit, 1_000_000);
    assert!(s1.cancelable);

    let s2 = f.client.get_stream(&id2);
    assert_eq!(s2.sender, f.sender);
    assert_eq!(s2.recipient, recipient2);
    assert_eq!(s2.deposit, 2_000_000);
    assert!(!s2.cancelable);
}

#[test]
fn create_streams_batch_per_entry_isolation() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let recipient2 = Address::generate(&f.env);
    let recipient3 = Address::generate(&f.env);

    let mut entries = soroban_sdk::Vec::new(&f.env);
    // Entry 0: Valid
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: 1_000_000,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: true,
    });
    // Entry 1: Invalid (non-positive deposit)
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: recipient2.clone(),
        token: f.token.clone(),
        deposit: 0,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: false,
    });
    // Entry 2: Valid
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: recipient3.clone(),
        token: f.token.clone(),
        deposit: 2_000_000,
        start_time: now + 2 * DAY,
        end_time: now + 20 * DAY,
        cancelable: true,
    });

    let results = f.client.mock_all_auths().create_streams_batch(&entries);

    assert_eq!(results.len(), 3);
    assert!(results.get(0).unwrap().is_ok());
    assert_eq!(
        results.get(1).unwrap().unwrap_err(),
        StreamError::ZeroAmount
    );
    assert!(results.get(2).unwrap().is_ok());

    let id1 = results.get(0).unwrap().unwrap();
    let id3 = results.get(2).unwrap().unwrap();

    let s1 = f.client.get_stream(&id1);
    assert_eq!(s1.deposit, 1_000_000);
    let s3 = f.client.get_stream(&id3);
    assert_eq!(s3.deposit, 2_000_000);
}

#[test]
fn create_streams_batch_multi_token() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
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

    let mut entries = soroban_sdk::Vec::new(&f.env);
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: 1_000_000,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: true,
    });
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: token2.clone(),
        deposit: 2_000_000,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: true,
    });

    let results = f.client.mock_all_auths().create_streams_batch(&entries);

    assert_eq!(results.len(), 2);
    let id1 = results.get(0).unwrap().unwrap();
    let id2 = results.get(1).unwrap().unwrap();

    let s1 = f.client.get_stream(&id1);
    assert_eq!(s1.token, f.token);
    assert_eq!(s1.deposit, 1_000_000);

    let s2 = f.client.get_stream(&id2);
    assert_eq!(s2.token, token2);
    assert_eq!(s2.deposit, 2_000_000);
}

#[test]
fn create_streams_batch_empty_and_too_large_revert() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();

    // Empty batch rejects
    let empty_entries = soroban_sdk::Vec::new(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_create_streams_batch(&empty_entries)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::BatchEmpty);

    // Too large batch rejects
    let mut big_entries = soroban_sdk::Vec::new(&f.env);
    for _ in 0..=(crate::stream::MAX_BATCH) {
        big_entries.push_back(crate::stream::BatchEntry {
            sender: f.sender.clone(),
            recipient: f.recipient.clone(),
            token: f.token.clone(),
            deposit: 1_000,
            start_time: now + DAY,
            end_time: now + 2 * DAY,
            cancelable: false,
        });
    }
    let err = f
        .client
        .mock_all_auths()
        .try_create_streams_batch(&big_entries)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::BatchTooLarge);
}

#[test]
fn create_streams_batch_transfer_failure_isolation() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let broke = Address::generate(&f.env);

    let mut entries = soroban_sdk::Vec::new(&f.env);
    // Entry 0: Funded sender
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: 1_000_000,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: true,
    });
    // Entry 1: Broke sender with no balance or allowance
    entries.push_back(crate::stream::BatchEntry {
        sender: broke.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: 1_000_000,
        start_time: now + DAY,
        end_time: now + 10 * DAY,
        cancelable: false,
    });
    // Entry 2: Funded sender
    entries.push_back(crate::stream::BatchEntry {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: 2_000_000,
        start_time: now + 2 * DAY,
        end_time: now + 20 * DAY,
        cancelable: true,
    });

    let results = f.client.mock_all_auths().create_streams_batch(&entries);

    assert_eq!(results.len(), 3);
    assert!(results.get(0).unwrap().is_ok());
    assert_eq!(
        results.get(1).unwrap().unwrap_err(),
        StreamError::AmountExceedsAvailable
    );
    assert!(results.get(2).unwrap().is_ok());

    let id0 = results.get(0).unwrap().unwrap();
    let id2 = results.get(2).unwrap().unwrap();

    let s0 = f.client.get_stream(&id0);
    assert_eq!(s0.deposit, 1_000_000);
    let s2 = f.client.get_stream(&id2);
    assert_eq!(s2.deposit, 2_000_000);
}

#[test]
fn measure_batch_instruction_costs() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();

    for size in [1, 5, 10, 20, 25] {
        f.env.cost_estimate().budget().reset_unlimited();
        let mut entries = soroban_sdk::Vec::new(&f.env);
        for i in 0..size {
            let recipient = Address::generate(&f.env);
            entries.push_back(crate::stream::BatchEntry {
                sender: f.sender.clone(),
                recipient,
                token: f.token.clone(),
                deposit: 1_000_000 + i as i128,
                start_time: now + DAY,
                end_time: now + 10 * DAY,
                cancelable: true,
            });
        }
        f.client.mock_all_auths().create_streams_batch(&entries);
        let cpu = f.env.cost_estimate().budget().cpu_instruction_cost();
        let mem = f.env.cost_estimate().budget().memory_bytes_cost();
        std::println!("BATCH_MEASUREMENT: size={} cpu={} mem={}", size, cpu, mem);
    }
}

#[test]
fn hot_path_footprint_harness() {
    // Budgets are measured values plus ~1% headroom, not aspirational numbers.
    // Rate renegotiation (#54) keeps its schedule under its own storage key, so
    // every accrual path pays one extra persistent lookup even for a stream that
    // never renegotiated. The cheaper alternative, a "has a schedule" flag,
    // would mean a new `Stream` field: a layout change for every stored stream.
    // See docs/FOOTPRINT.md.
    let f = Fixture::setup();
    let duration = 30 * DAY;

    // 1. create_stream
    f.env.cost_estimate().budget().reset_unlimited();
    let id = f.create_stream(DEPOSIT, DAY, duration, true);
    let cpu_create = f.env.cost_estimate().budget().cpu_instruction_cost();
    assert!(
        cpu_create <= 560_000,
        "create_stream exceeded budget: {}",
        cpu_create
    );

    // 2. withdraw
    f.advance_time(DAY + 5 * DAY);
    f.env.cost_estimate().budget().reset_unlimited();
    f.client.mock_all_auths().withdraw(&id, &(DEPOSIT / 10));
    let cpu_withdraw = f.env.cost_estimate().budget().cpu_instruction_cost();
    assert!(
        cpu_withdraw <= 370_000,
        "withdraw exceeded budget: {}",
        cpu_withdraw
    );

    // 3. cancel_stream
    f.advance_time(5 * DAY);
    f.env.cost_estimate().budget().reset_unlimited();
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    let cpu_cancel = f.env.cost_estimate().budget().cpu_instruction_cost();
    assert!(
        // 540k pre-dispute; the freeze check adds one dispute-key storage lookup.
        // The merged rate-renegotiation code path adds another ~3K of hot-path
        // instructions through shared validation helpers.
        cpu_cancel <= 570_000,
        "cancel_stream exceeded budget: {}",
        cpu_cancel
    );

    // 4. withdraw_max on a fresh stream
    let id2 = f.create_stream(DEPOSIT, DAY, duration, true);
    f.advance_time(DAY + duration);
    f.env.cost_estimate().budget().reset_unlimited();
    f.client.mock_all_auths().withdraw_max(&id2);
    let cpu_withdraw_max = f.env.cost_estimate().budget().cpu_instruction_cost();
    assert!(
        cpu_withdraw_max <= 375_000,
        "withdraw_max exceeded budget: {}",
        cpu_withdraw_max
    );

    // 5. withdraw on a renegotiated stream: the price of reading one accepted
    //    window instead of the single-window formula.
    StellarAssetClient::new(&f.env, &f.token).mint(&f.sender, &DEPOSIT);
    let id3 = f.create_stream(DEPOSIT, 0, duration, true);
    f.advance_time(5 * DAY);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id3, &1_000);
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id3);
    f.env.cost_estimate().budget().reset_unlimited();
    f.client.mock_all_auths().withdraw(&id3, &(DEPOSIT / 100));
    let cpu_scheduled_withdraw = f.env.cost_estimate().budget().cpu_instruction_cost();
    assert!(
        cpu_scheduled_withdraw <= 415_000,
        "withdraw on a scheduled stream exceeded budget: {}",
        cpu_scheduled_withdraw
    );
}

// ------------------------------------------------ upgrade & migration tests --

#[test]
fn freeze_and_unfreeze_governor_controls_and_mutation_gates() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();
    let stranger = Address::generate(&f.env);

    // Initial state: not frozen, schema version 1.
    assert!(!f.client.is_frozen());
    assert_eq!(f.client.schema_version(), INITIAL_SCHEMA_VERSION);

    // Create an active stream before freezing.
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Active);

    // Stranger cannot freeze.
    let res = f.client.mock_all_auths().try_set_frozen(&stranger, &true);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::NotGovernor);

    // Governor freezes the contract.
    f.client.mock_all_auths().set_frozen(&f.governor, &true);
    assert!(f.client.is_frozen());

    // Advance time into the stream window so funds accrue.
    f.advance_time(5 * DAY);

    // All mutating entrypoints revert with ContractFrozen:
    // 1. create_stream
    let err = f
        .client
        .mock_all_auths()
        .try_create_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &DEPOSIT,
            &(now + 6 * DAY),
            &(now + 16 * DAY),
            &false,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);

    // 2. withdraw
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &100)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);

    // 3. withdraw_max
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw_max(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);

    // 4. cancel_stream
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);

    // 5. top_up
    let err = f
        .client
        .mock_all_auths()
        .try_top_up(&id, &DEPOSIT)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);

    // All read-only views remain completely functional while frozen:
    let s = f.client.get_stream(&id);
    assert_eq!(s.id, id);
    let avail = f.client.available(&id);
    assert!(avail > 0);
    assert_eq!(f.client.recipient_streams(&f.recipient, &0, &10).len(), 1);
    assert_eq!(f.client.sender_streams(&f.sender, &0, &10).len(), 1);
    assert_eq!(f.client.total_streams(), 1);
    assert_eq!(f.client.schema_version(), INITIAL_SCHEMA_VERSION);
    let status = f.client.treasury_status(&f.token);
    assert_eq!(status.governor, f.governor);
    let progress = f.client.migration_progress();
    assert_eq!(progress.current_version, INITIAL_SCHEMA_VERSION);
    assert!(!progress.is_complete);

    // Stranger cannot unfreeze.
    let res = f.client.mock_all_auths().try_set_frozen(&stranger, &false);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::NotGovernor);

    // Governor unfreezes the contract.
    f.client.mock_all_auths().set_frozen(&f.governor, &false);
    assert!(!f.client.is_frozen());

    // Mutations succeed again after unfreeze.
    let withdrawn = f.client.mock_all_auths().withdraw_max(&id);
    assert!(withdrawn > 0);
    assert_eq!(f.client.get_stream(&id).withdrawn, withdrawn);
}

#[test]
fn upgrade_timelock_proposal_cancellation_and_execution() {
    let f = Fixture::setup();
    let stranger = Address::generate(&f.env);
    let wasm_hash = f.env.deployer().upload_contract_wasm(UPGRADE_WASM);

    assert_eq!(f.client.pending_upgrade(), None);

    // Non-governor cannot propose upgrade.
    let err = f
        .client
        .mock_all_auths()
        .try_propose_upgrade(&stranger, &wasm_hash, &MIN_UPGRADE_DELAY_SECONDS)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);

    // Proposed delay below MIN_UPGRADE_DELAY_SECONDS is rejected.
    let err = f
        .client
        .mock_all_auths()
        .try_propose_upgrade(&f.governor, &wasm_hash, &(MIN_UPGRADE_DELAY_SECONDS - 1))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::UpgradeDelayTooShort);

    // Governor proposes upgrade with valid timelock delay.
    let now = f.env.ledger().timestamp();
    f.client
        .mock_all_auths()
        .propose_upgrade(&f.governor, &wasm_hash, &MIN_UPGRADE_DELAY_SECONDS);

    let pending = f
        .client
        .pending_upgrade()
        .expect("pending upgrade expected");
    assert_eq!(pending.new_wasm_hash, wasm_hash);
    assert_eq!(pending.unlock_time, now + MIN_UPGRADE_DELAY_SECONDS);

    // Non-governor cannot cancel or execute upgrade.
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_upgrade(&stranger)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);
    let err = f
        .client
        .mock_all_auths()
        .try_execute_upgrade(&stranger)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);

    // Governor cannot execute before timelock expires.
    f.advance_time(MIN_UPGRADE_DELAY_SECONDS - 10);
    let err = f
        .client
        .mock_all_auths()
        .try_execute_upgrade(&f.governor)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::TimelockNotExpired);

    // Governor can cancel the upgrade.
    f.client.mock_all_auths().cancel_upgrade(&f.governor);
    assert_eq!(f.client.pending_upgrade(), None);

    // Cannot execute after cancellation.
    let err = f
        .client
        .mock_all_auths()
        .try_execute_upgrade(&f.governor)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingUpgrade);

    // Cannot cancel when nothing is pending.
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_upgrade(&f.governor)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingUpgrade);

    // Propose again and execute after timelock expires.
    f.client
        .mock_all_auths()
        .propose_upgrade(&f.governor, &wasm_hash, &MIN_UPGRADE_DELAY_SECONDS);
    f.advance_time(MIN_UPGRADE_DELAY_SECONDS + 1);

    f.client.mock_all_auths().execute_upgrade(&f.governor);
}

#[test]
fn storage_migration_lifecycle_and_invariants() {
    let f = Fixture::setup();
    let stranger = Address::generate(&f.env);

    // Non-governor cannot migrate.
    let err = f
        .client
        .mock_all_auths()
        .try_migrate_storage(&stranger, &0, &50)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);

    // Migration rejected when contract is not frozen.
    let err = f
        .client
        .mock_all_auths()
        .try_migrate_storage(&f.governor, &0, &50)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractNotFrozen);

    // Freeze contract for migration.
    f.client.mock_all_auths().set_frozen(&f.governor, &true);

    // Empty contract migration completes immediately and sets schema to TARGET_SCHEMA_VERSION.
    let status = f
        .client
        .mock_all_auths()
        .migrate_storage(&f.governor, &0, &50);
    assert_eq!(status.current_version, TARGET_SCHEMA_VERSION);
    assert_eq!(status.target_version, TARGET_SCHEMA_VERSION);
    assert_eq!(status.cursor, 0);
    assert_eq!(status.total_streams, 0);
    assert!(status.is_complete);
    assert_eq!(f.client.schema_version(), TARGET_SCHEMA_VERSION);

    // Calling migrate_storage when already migrated fails with AlreadyMigrated.
    let err = f
        .client
        .mock_all_auths()
        .try_migrate_storage(&f.governor, &0, &50)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::AlreadyMigrated);
}

#[test]
fn storage_migration_over_1000_synthetic_streams() {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();

    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();
    let sender = Address::generate(&env);
    let recipient_base = Address::generate(&env);
    let governor = Address::generate(&env);

    const NUM_STREAMS: usize = 1_000;
    const STREAM_DEPOSIT: i128 = 100_000;
    let total_mint = (NUM_STREAMS as i128) * STREAM_DEPOSIT * 2;
    StellarAssetClient::new(&env, &token).mint(&sender, &total_mint);

    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let client = Client::new(&env, &contract_id);

    StellarAssetClient::new(&env, &token).approve(
        &sender,
        &contract_id,
        &total_mint,
        &1_000_000u32,
    );

    let base_time = env.ledger().timestamp();

    // Create 1,000 synthetic streams with diverse parameters and states:
    // Some will remain Active, some partially withdrawn, some fully depleted, some cancelled.
    for i in 1..=NUM_STREAMS {
        let cancelable = (i % 2) == 0;
        let duration = (10 + (i as u64 % 100)) * DAY;
        let start_time = base_time + (i as u64 % 5) * DAY;
        let end_time = start_time + duration;
        let deposit = STREAM_DEPOSIT + (i as i128 * 10);

        let id = client.mock_all_auths().create_stream(
            &sender,
            &recipient_base,
            &token,
            &deposit,
            &start_time,
            &end_time,
            &cancelable,
        );
        assert_eq!(id, i as u64);
    }

    assert_eq!(client.total_streams(), NUM_STREAMS as u64);

    // Advance time so some streams accrue funds.
    env.ledger().with_mut(|li| li.timestamp += 15 * DAY);

    // Mutate state of selected streams to exercise all lifecycle statuses before migration:
    // Streams 1..=100: withdraw some accrued funds.
    for i in 1..=100 {
        let avail = client.available(&(i as u64));
        if avail > 10 {
            client.mock_all_auths().withdraw(&(i as u64), &(avail / 2));
        }
    }
    // Streams 101..=150: cancel stream.
    for i in 101..=150 {
        let s = client.get_stream(&(i as u64));
        if s.cancelable {
            client.mock_all_auths().cancel_stream(&sender, &(i as u64));
        }
    }
    // Advance time past end for streams 151..=200 and withdraw all to mark Depleted.
    env.ledger().with_mut(|li| li.timestamp += 200 * DAY);
    for i in 151..=200 {
        let _ = client.mock_all_auths().try_withdraw_max(&(i as u64));
    }

    // --- SNAPSHOT PHASE: Snapshot all 1,000 streams ---
    #[derive(Clone, Debug, Eq, PartialEq)]
    struct Snapshot {
        id: u64,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit: i128,
        withdrawn: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        status: StreamStatus,
        available: i128,
    }

    let mut snapshots = std::vec::Vec::with_capacity(NUM_STREAMS);
    for i in 1..=NUM_STREAMS {
        let id = i as u64;
        let s = client.get_stream(&id);
        let avail = client.available(&id);
        snapshots.push(Snapshot {
            id: s.id,
            sender: s.sender,
            recipient: s.recipient,
            token: s.token,
            deposit: s.deposit,
            withdrawn: s.withdrawn,
            start_time: s.start_time,
            end_time: s.end_time,
            cancelable: s.cancelable,
            status: s.status,
            available: avail,
        });
    }

    // --- MIGRATION PHASE ---
    // 1. Freeze contract
    client.mock_all_auths().set_frozen(&governor, &true);
    assert!(client.is_frozen());
    assert_eq!(client.schema_version(), INITIAL_SCHEMA_VERSION);

    // 2. Perform resumable, batch migration in increments of 50
    // Test mid-write interruption: migrate first 300 streams (6 batches of 50).
    for _ in 0..6 {
        let progress = client.mock_all_auths().migrate_storage(&governor, &0, &50);
        assert!(!progress.is_complete);
        assert_eq!(progress.current_version, INITIAL_SCHEMA_VERSION);
    }
    assert_eq!(client.migration_progress().cursor, 300);

    // Test idempotency: re-run migration explicitly on streams 1..=50
    let idempotent_res = client.mock_all_auths().migrate_storage(&governor, &1, &50);
    assert_eq!(idempotent_res.cursor, 300); // Cursor does not regress!
    assert!(!idempotent_res.is_complete);

    // Resume from cursor to completion (remaining 700 streams: 14 batches of 50).
    let mut finished = false;
    while !finished {
        let p = client.mock_all_auths().migrate_storage(&governor, &0, &50);
        finished = p.is_complete;
    }

    // Verify migration completion state.
    let final_progress = client.migration_progress();
    assert!(final_progress.is_complete);
    assert_eq!(final_progress.current_version, TARGET_SCHEMA_VERSION);
    assert_eq!(final_progress.target_version, TARGET_SCHEMA_VERSION);
    assert_eq!(final_progress.cursor, NUM_STREAMS as u64);
    assert_eq!(client.schema_version(), TARGET_SCHEMA_VERSION);

    // Attempting further migration returns AlreadyMigrated.
    let err = client
        .mock_all_auths()
        .try_migrate_storage(&governor, &0, &50)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::AlreadyMigrated);

    // --- VERIFICATION PHASE: Assert 100% data preservation across all 1,000 streams ---
    for expected in &snapshots {
        let actual = client.get_stream(&expected.id);
        let actual_avail = client.available(&expected.id);

        assert_eq!(actual.id, expected.id, "Stream {} id mismatch", expected.id);
        assert_eq!(
            actual.sender, expected.sender,
            "Stream {} sender mismatch",
            expected.id
        );
        assert_eq!(
            actual.recipient, expected.recipient,
            "Stream {} recipient mismatch",
            expected.id
        );
        assert_eq!(
            actual.token, expected.token,
            "Stream {} token mismatch",
            expected.id
        );
        assert_eq!(
            actual.deposit, expected.deposit,
            "Stream {} deposit mismatch",
            expected.id
        );
        assert_eq!(
            actual.withdrawn, expected.withdrawn,
            "Stream {} withdrawn mismatch",
            expected.id
        );
        assert_eq!(
            actual.start_time, expected.start_time,
            "Stream {} start_time mismatch",
            expected.id
        );
        assert_eq!(
            actual.end_time, expected.end_time,
            "Stream {} end_time mismatch",
            expected.id
        );
        assert_eq!(
            actual.cancelable, expected.cancelable,
            "Stream {} cancelable mismatch",
            expected.id
        );
        assert_eq!(
            actual.status, expected.status,
            "Stream {} status mismatch",
            expected.id
        );
        assert_eq!(
            actual_avail, expected.available,
            "Stream {} available mismatch",
            expected.id
        );
    }

    // 3. Unfreeze contract and verify subsequent mutations on migrated streams
    client.mock_all_auths().set_frozen(&governor, &false);
    assert!(!client.is_frozen());

    // Top up an active stream post-migration (e.g. stream 500)
    let s500_before = client.get_stream(&500);
    client.mock_all_auths().top_up(&500, &10_000);
    let s500_after = client.get_stream(&500);
    assert_eq!(s500_after.deposit, s500_before.deposit + 10_000);

    // Create a new stream post-migration (stream 1001)
    let new_now = env.ledger().timestamp();
    let new_id = client.mock_all_auths().create_stream(
        &sender,
        &recipient_base,
        &token,
        &STREAM_DEPOSIT,
        &new_now,
        &(new_now + 10 * DAY),
        &true,
    );
    assert_eq!(new_id, 1001);
    assert_eq!(client.total_streams(), 1001);
}

// ------------------------------------ stream policy floors (#203) ---------

#[test]
fn test_stream_policy_governance_and_resolution() {
    let f = Fixture::setup();
    let stranger = Address::generate(&f.env);

    // 1. Non-governor cannot set stream policy
    let policy = crate::StreamPolicy {
        min_deposit: 100,
        min_duration: 60,
        max_duration: 86400,
        min_rate: 1,
        max_rate: 1000,
    };
    let res = f
        .client
        .mock_all_auths()
        .try_set_stream_policy(&stranger, &None, &policy);
    assert_eq!(res.unwrap_err().unwrap(), StreamError::NotGovernor);

    // 2. Governor sets global stream policy
    f.client
        .mock_all_auths()
        .set_stream_policy(&f.governor, &None, &policy);
    assert_eq!(f.client.get_stream_policy(&None), Some(policy.clone()));

    // When querying for an unconfigured token, falls back to global policy
    let token2 = Address::generate(&f.env);
    assert_eq!(
        f.client.get_stream_policy(&Some(token2.clone())),
        Some(policy.clone())
    );

    // 3. Governor sets token-specific policy
    let token_policy = crate::StreamPolicy {
        min_deposit: 500,
        min_duration: 120,
        max_duration: 43200,
        min_rate: 2,
        max_rate: 500,
    };
    f.client
        .mock_all_auths()
        .set_stream_policy(&f.governor, &Some(token2.clone()), &token_policy);
    assert_eq!(
        f.client.get_stream_policy(&Some(token2)),
        Some(token_policy)
    );
    // Other token still gets global policy
    assert_eq!(f.client.get_stream_policy(&Some(f.token)), Some(policy));
}

#[test]
fn test_stream_policy_creation_enforcement() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();

    let policy = crate::StreamPolicy {
        min_deposit: 1_000,
        min_duration: DAY,
        max_duration: 10 * DAY,
        min_rate: 1,
        max_rate: 10_000,
    };
    f.client
        .mock_all_auths()
        .set_stream_policy(&f.governor, &Some(f.token.clone()), &policy);

    // 1. Deposit below floor
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &500,
        &(now + DAY),
        &(now + 3 * DAY),
        &true,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyDepositBelowFloor
    );

    // 2. Duration below floor
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &5_000,
        &(now + DAY),
        &(now + DAY + 3600), // 1 hour < 1 day
        &true,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyDurationBelowFloor
    );

    // 3. Duration above ceiling
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &5_000,
        &(now + DAY),
        &(now + 20 * DAY), // 19 days > 10 days
        &true,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyDurationAboveCeiling
    );

    // 4. Rate below floor (deposit / duration < min_rate)
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1_000, // rate = 1000 / 86400 = 0 < 1
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
    );
    assert_eq!(res.unwrap_err().unwrap(), StreamError::PolicyRateBelowFloor);

    // 5. Rate above ceiling (deposit / duration > max_rate)
    let tight_rate_policy = crate::StreamPolicy {
        min_deposit: 1_000,
        min_duration: DAY,
        max_duration: 10 * DAY,
        min_rate: 0,
        max_rate: 10,
    };
    f.client.mock_all_auths().set_stream_policy(
        &f.governor,
        &Some(f.token.clone()),
        &tight_rate_policy,
    );
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &10_000_000, // rate = 10_000_000 / 86400 = 115 > 10
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyRateAboveCeiling
    );

    // 6. Valid stream succeeds
    let valid_id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &86_400, // rate = 86400 / 86400 = 1 <= 10
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
    );
    assert!(valid_id > 0);
}

#[test]
fn test_stream_policy_grandfathering_matrix() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();

    // 1. Create a stream under initial lenient policy
    let initial_policy = crate::StreamPolicy {
        min_deposit: 1_000,
        min_duration: DAY,
        max_duration: 5 * DAY,
        min_rate: 0,
        max_rate: 100,
    };
    f.client.mock_all_auths().set_stream_policy(
        &f.governor,
        &Some(f.token.clone()),
        &initial_policy,
    );

    let stream_id = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &86_400, // 1 token/sec over 1 day
        &(now + DAY),
        &(now + 2 * DAY), // duration = 1 DAY
        &true,
    );
    assert_eq!(f.client.get_stream(&stream_id).id, stream_id);

    // 2. Tighten policy: increase min_duration to 30 days and cap max_rate to 2
    let tightened_policy = crate::StreamPolicy {
        min_deposit: 5_000,
        min_duration: 30 * DAY, // Stream's 1-day duration violates this now!
        max_duration: 60 * DAY,
        min_rate: 0,
        max_rate: 2, // 2 tokens/sec
    };
    f.client.mock_all_auths().set_stream_policy(
        &f.governor,
        &Some(f.token.clone()),
        &tightened_policy,
    );

    // Grandfathering check A: Existing stream duration is grandfathered on top-up!
    // If top-up checked duration, it would fail with PolicyDurationBelowFloor.
    // Top up with valid rate: +86,400 -> total deposit = 172,800 over 86,400s -> rate = 2 <= max_rate(2)
    f.client.mock_all_auths().top_up(&stream_id, &86_400);
    assert_eq!(f.client.get_stream(&stream_id).deposit, 172_800);

    // Grandfathering check B: If top-up pushes rate above max_rate ceiling, it violates policy
    // Adding +86,400 again -> total deposit = 259,200 -> rate = 3 > max_rate(2)
    let res = f.client.mock_all_auths().try_top_up(&stream_id, &86_400);
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyRateAboveCeiling
    );

    // Grandfathering check C: Cancellation always succeeds regardless of policy (Anti-brick invariant)
    f.advance_time(2 * DAY); // reach after start
    let cancel_res = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &stream_id);
    assert!(cancel_res.is_ok());
    assert_eq!(
        f.client.get_stream(&stream_id).status,
        crate::StreamStatus::Cancelled
    );
}

#[test]
fn test_stream_policy_multi_token_boundaries() {
    let f = Fixture::setup();
    let now = f.env.ledger().timestamp();

    // Register a second token (e.g. issued token)
    let sac2 = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env));
    let token2 = sac2.address();
    StellarAssetClient::new(&f.env, &token2).mint(&f.sender, &DEPOSIT);
    TokenClient::new(&f.env, &token2).mock_all_auths().approve(
        &f.sender,
        &f.client.address,
        &DEPOSIT,
        &200,
    );

    // Set Global policy: min_deposit = 10_000
    f.client.mock_all_auths().set_stream_policy(
        &f.governor,
        &None,
        &crate::StreamPolicy {
            min_deposit: 10_000,
            min_duration: 0,
            max_duration: 0,
            min_rate: 0,
            max_rate: 0,
        },
    );

    // Set Token1 specific policy: min_deposit = 500
    f.client.mock_all_auths().set_stream_policy(
        &f.governor,
        &Some(f.token.clone()),
        &crate::StreamPolicy {
            min_deposit: 500,
            min_duration: 0,
            max_duration: 0,
            min_rate: 0,
            max_rate: 0,
        },
    );

    // Token1 allows deposit of 1000 (> 500)
    let id1 = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1_000,
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
    );
    assert!(id1 > 0);

    // Token2 falls back to global policy (min_deposit = 10_000)
    // Deposit of 1000 is rejected on Token2
    let res = f.client.mock_all_auths().try_create_stream(
        &f.sender,
        &f.recipient,
        &token2,
        &1_000,
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        StreamError::PolicyDepositBelowFloor
    );

    // Token2 allows deposit of 10_000
    let id2 = f.client.mock_all_auths().create_stream(
        &f.sender,
        &f.recipient,
        &token2,
        &10_000,
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
    );
    assert!(id2 > 0);
}

// ----------------------------------------------------------- oracle tests ----

#[test]
fn oracle_basic_flow_and_staleness_fallback() {
    let f = Fixture::setup();
    let mut publishers = soroban_sdk::Vec::new(&f.env);
    let p1 = soroban_sdk::Address::generate(&f.env);
    let p2 = soroban_sdk::Address::generate(&f.env);
    publishers.push_back(p1.clone());
    publishers.push_back(p2.clone());

    let max_stale = 3600; // 1 hour
    f.client.mock_all_auths().set_oracle_config(
        &f.governor,
        &publishers,
        &2, // 2-of-2
        &max_stale,
    );

    let now = f.env.ledger().timestamp();
    let id = f.create_stream_with_oracle(DEPOSIT, 0, 10 * DAY, false, true);

    // Initial resolution with no reports -> fallback to ledger time
    let res = f.client.mock_all_auths().resolve_time(&id, &true);
    assert_eq!(res.timestamp, now);
    assert!(!res.is_oracle);

    // Publishers submit fresh timestamps
    f.client
        .mock_all_auths()
        .submit_oracle_time(&p1, &(now + 100));
    f.client
        .mock_all_auths()
        .submit_oracle_time(&p2, &(now + 120));

    // Now quorum of 2 is met -> resolved timestamp is median (120)
    let res = f.client.mock_all_auths().resolve_time(&id, &true);
    assert_eq!(res.timestamp, now + 120);
    assert!(res.is_oracle);

    // Advance ledger time beyond max_stale
    f.advance_time(max_stale + 10);
    let new_ledger_time = f.env.ledger().timestamp();

    // Now reports are stale -> fallback to new ledger time!
    let res2 = f.client.mock_all_auths().resolve_time(&id, &true);
    assert_eq!(res2.timestamp, new_ledger_time);
    assert!(!res2.is_oracle);

    // Recipient can still withdraw smoothly using fallback ledger time
    let avail = f.client.mock_all_auths().available(&id);
    assert!(avail > 0);
    f.client.mock_all_auths().withdraw(&id, &avail);
}

#[test]
fn oracle_publisher_rotation() {
    let f = Fixture::setup();
    let mut pub_v1 = soroban_sdk::Vec::new(&f.env);
    let p1 = soroban_sdk::Address::generate(&f.env);
    pub_v1.push_back(p1.clone());

    f.client
        .mock_all_auths()
        .set_oracle_config(&f.governor, &pub_v1, &1, &3600);

    let now = f.env.ledger().timestamp();
    f.client
        .mock_all_auths()
        .submit_oracle_time(&p1, &(now + 50));

    // Rotate publishers to set v2 (p2, p3 with threshold 2)
    let mut pub_v2 = soroban_sdk::Vec::new(&f.env);
    let p2 = soroban_sdk::Address::generate(&f.env);
    let p3 = soroban_sdk::Address::generate(&f.env);
    pub_v2.push_back(p2.clone());
    pub_v2.push_back(p3.clone());

    f.client
        .mock_all_auths()
        .set_oracle_config(&f.governor, &pub_v2, &2, &3600);

    // Old publisher p1 can no longer submit
    let err = f
        .client
        .mock_all_auths()
        .try_submit_oracle_time(&p1, &(now + 60))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotOraclePublisher);

    // New publishers submit
    f.client
        .mock_all_auths()
        .submit_oracle_time(&p2, &(now + 200));
    f.client
        .mock_all_auths()
        .submit_oracle_time(&p3, &(now + 210));

    let cfg = f.client.mock_all_auths().oracle_config().unwrap();
    assert_eq!(cfg.publishers.len(), 2);
    assert_eq!(cfg.threshold, 2);
}

#[test]
fn oracle_manipulation_attempt_by_single_rogue_publisher_under_2_of_3() {
    let f = Fixture::setup();
    let mut publishers = soroban_sdk::Vec::new(&f.env);
    let honest1 = soroban_sdk::Address::generate(&f.env);
    let honest2 = soroban_sdk::Address::generate(&f.env);
    let rogue = soroban_sdk::Address::generate(&f.env);
    publishers.push_back(honest1.clone());
    publishers.push_back(honest2.clone());
    publishers.push_back(rogue.clone());

    let max_stale = 3600;
    f.client.mock_all_auths().set_oracle_config(
        &f.governor,
        &publishers,
        &2, // 2-of-3 threshold
        &max_stale,
    );

    let now = f.env.ledger().timestamp();
    let id = f.create_stream_with_oracle(DEPOSIT, 0, 10 * DAY, false, true);

    // 1. Rogue publisher submits first, attempting to report a fraudulent high timestamp
    f.client
        .mock_all_auths()
        .submit_oracle_time(&rogue, &(now + max_stale));

    // Under 2-of-3, rogue's lone submission does NOT reach threshold (1 < 2)
    // Resolution must safely fallback to ledger time
    let res1 = f.client.mock_all_auths().resolve_time(&id, &true);
    assert_eq!(res1.timestamp, now);
    assert!(!res1.is_oracle);

    // 2. Honest publisher 1 reports accurate reference time (e.g. now + 10)
    f.client
        .mock_all_auths()
        .submit_oracle_time(&honest1, &(now + 10));

    // 3. Honest publisher 2 reports accurate reference time (now + 12)
    f.client
        .mock_all_auths()
        .submit_oracle_time(&honest2, &(now + 12));

    // Now all 3 reported:
    // Sorted times: [now + 10, now + 12, now + 3600]
    // Median (index 3/2 = 1) is now + 12! The rogue outlier is completely eliminated by the quorum median!
    let res2 = f.client.mock_all_auths().resolve_time(&id, &true);
    assert!(res2.is_oracle);
    assert_eq!(res2.timestamp, now + 12);
}

#[test]
fn oracle_config_change_under_active_stream() {
    // Tests that threshold and publisher changes mid-stream cannot brick existing streams.
    // If quorum is altered or disrupted, the stream gracefully falls back to ledger time.
    let f = Fixture::setup();
    let mut pub_v1 = soroban_sdk::Vec::new(&f.env);
    let p1 = soroban_sdk::Address::generate(&f.env);
    pub_v1.push_back(p1.clone());

    f.client
        .mock_all_auths()
        .set_oracle_config(&f.governor, &pub_v1, &1, &3600);

    let now = f.env.ledger().timestamp();
    let id = f.create_stream_with_oracle(DEPOSIT, 0, 10 * DAY, false, true);

    f.client
        .mock_all_auths()
        .submit_oracle_time(&p1, &(now + 200));

    // Stream resolves to oracle clock
    let res1 = f.client.mock_all_auths().resolve_time(&id, &true);
    assert!(res1.is_oracle);
    assert_eq!(res1.timestamp, now + 200);

    // Governor updates config: raises threshold to 2-of-2 without adding p2 yet
    let p2 = soroban_sdk::Address::generate(&f.env);
    let mut pub_v2 = soroban_sdk::Vec::new(&f.env);
    pub_v2.push_back(p1.clone());
    pub_v2.push_back(p2.clone());
    f.client
        .mock_all_auths()
        .set_oracle_config(&f.governor, &pub_v2, &2, &3600);

    // Only p1 has reported; threshold is now 2. Quorum is unmet.
    // Stream does NOT fail or brick: it seamlessly falls back to ledger time!
    let res2 = f.client.mock_all_auths().resolve_time(&id, &true);
    assert!(!res2.is_oracle);
    assert_eq!(res2.timestamp, now);

    // Withdrawal and settlement continue uninterrupted under fallback
    let avail = f.client.mock_all_auths().available(&id);
    assert!(avail >= 0);

    // Once p2 reports, quorum is restored and oracle resolution resumes
    f.client
        .mock_all_auths()
        .submit_oracle_time(&p2, &(now + 210));
    let res3 = f.client.mock_all_auths().resolve_time(&id, &true);
    assert!(res3.is_oracle);
    assert_eq!(res3.timestamp, now + 210); // median of [now+200, now+210]
}

#[test]
fn oracle_mode_accrual_property_bounded_by_staleness() {
    // Property test:
    // Accrual under oracle mode never exceeds ledger-mode accrual by more than
    // (max_stale_seconds * rate), where rate = deposit / duration.
    let f = Fixture::setup();
    let mut publishers = soroban_sdk::Vec::new(&f.env);
    let p1 = soroban_sdk::Address::generate(&f.env);
    let p2 = soroban_sdk::Address::generate(&f.env);
    publishers.push_back(p1.clone());
    publishers.push_back(p2.clone());

    let max_stale = 1800; // 30 minutes
    f.client
        .mock_all_auths()
        .set_oracle_config(&f.governor, &publishers, &2, &max_stale);

    let duration = 10 * DAY;
    let id_ledger = f.create_stream_with_oracle(DEPOSIT, 0, duration, false, false);
    let id_oracle = f.create_stream_with_oracle(DEPOSIT, 0, duration, false, true);

    // Advance time in steps and verify property
    for step in [100, 500, 1000, 2000, 5000, 50000] {
        f.advance_time(step);
        let current_ledger = f.env.ledger().timestamp();

        // Feed can report any timestamp bounded by [current_ledger - max_stale, current_ledger + max_stale]
        // Test an aggressive time: current_ledger + max_stale
        let reported = current_ledger + max_stale;
        f.client.mock_all_auths().submit_oracle_time(&p1, &reported);
        f.client.mock_all_auths().submit_oracle_time(&p2, &reported);

        let ledger_avail = f.client.mock_all_auths().available(&id_ledger);
        let oracle_avail = f.client.mock_all_auths().available(&id_oracle);

        // Maximum allowed difference is bounded by (max_stale + 1) * deposit / duration + 1
        let max_accrual_diff =
            ((DEPOSIT as u128) * ((max_stale + 1) as u128) / (duration as u128) + 1) as i128;

        assert!(
            oracle_avail >= ledger_avail,
            "oracle accrual should be >= ledger accrual when clock is ahead"
        );
        let diff = oracle_avail - ledger_avail;
        assert!(
            diff <= max_accrual_diff,
            "oracle accrual diff {diff} exceeded maximum staleness bound {max_accrual_diff}"
        );
    }
}

// ------------------------------------------------- ownership transfer -----

#[test]
fn recipient_transfer_mid_accrual_redirects_claims_and_keeps_indexes_consistent() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    f.advance_time(3 * DAY); // 2 of 10 days elapsed
    let available = DEPOSIT / 5;

    let new_recipient = Address::generate(&f.env);
    let now = f.env.ledger().timestamp();
    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.recipient, &id, &new_recipient);

    let pending = f.client.pending_ownership_transfer(&id).unwrap();
    assert_eq!(pending.stream_id, id);
    assert_eq!(pending.proposed_by, f.recipient);
    assert_eq!(pending.new_owner, new_recipient);
    assert_eq!(pending.role, OwnershipRole::Recipient);
    assert_eq!(pending.expires_at, now + OWNERSHIP_PROPOSAL_TTL_SECONDS);

    // A proposal alone changes nothing: the old recipient still owns claims
    // and the stream's accounting is untouched.
    let before = f.client.get_stream(&id);
    assert_eq!(before.recipient, f.recipient);
    assert_eq!(f.client.available(&id), available);

    f.client
        .mock_all_auths()
        .accept_ownership_transfer(&new_recipient, &id);
    let after = f.client.get_stream(&id);
    assert_eq!(after.recipient, new_recipient);
    assert_eq!(after.sender, f.sender);
    assert_eq!(after.deposit, before.deposit);
    assert_eq!(after.withdrawn, before.withdrawn);
    assert_eq!(after.start_time, before.start_time);
    assert_eq!(after.end_time, before.end_time);
    assert_eq!(after.use_oracle, before.use_oracle);
    assert_eq!(f.client.available(&id), available);
    assert!(f.client.pending_ownership_transfer(&id).is_none());

    // The old recipient's signature no longer satisfies the contract's
    // required auth; the new recipient can claim the full accrued balance.
    f.env.mock_auths(&[MockAuth {
        address: &f.recipient,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "withdraw",
            args: (id, available).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_withdraw(&id, &available).is_err());
    f.env.mock_all_auths();

    f.client.mock_all_auths().withdraw(&id, &available);
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&new_recipient),
        available
    );

    // Append-only indexes: the old recipient keeps its historical id and the
    // new recipient is appended on acceptance. Readers must consult
    // `get_stream` to learn the current role holder.
    assert_eq!(
        f.client.recipient_streams(&f.recipient, &0, &10),
        soroban_sdk::Vec::from_slice(&f.env, &[id]),
    );
    assert_eq!(
        f.client.recipient_streams(&new_recipient, &0, &10),
        soroban_sdk::Vec::from_slice(&f.env, &[id]),
    );
    assert_eq!(
        f.client.sender_streams(&f.sender, &0, &10),
        soroban_sdk::Vec::from_slice(&f.env, &[id]),
    );
}

#[test]
fn sender_transfer_mid_stream_moves_payer_rights_without_touching_accounting() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.advance_time(3 * DAY); // 2 of 10 days elapsed
    let new_payer = f.fund_payer();

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &new_payer);
    f.client
        .mock_all_auths()
        .accept_ownership_transfer(&new_payer, &id);

    let s = f.client.get_stream(&id);
    assert_eq!(s.sender, new_payer);
    assert_eq!(s.recipient, f.recipient);
    assert_eq!(s.deposit, DEPOSIT);
    assert_eq!(s.withdrawn, 0);
    assert_eq!(f.client.available(&id), DEPOSIT / 5);

    // The new payer can top up, and the deposit grows pro-rata as usual.
    let top_up = DEPOSIT / 2;
    f.client.mock_all_auths().top_up(&id, &top_up);
    let new_deposit = DEPOSIT + top_up;
    assert_eq!(f.client.get_stream(&id).deposit, new_deposit);
    assert_eq!(f.client.available(&id), new_deposit * 2 / 10);

    // The old payer is no longer an authorized canceller.
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_stream(&f.sender, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);

    // The new payer cancels: accrued goes to the recipient, the unaccrued
    // remainder is refunded to the new payer, and the contract drains exactly.
    let streamed = new_deposit * 2 / 10;
    f.client.mock_all_auths().cancel_stream(&new_payer, &id);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        streamed
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&new_payer),
        DEPOSIT - top_up + (new_deposit - streamed)
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
    // The previous payer's funds are untouched by the handoff.
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        DEPOSIT
    );

    // Both payers' append-only indexes contain the stream id.
    assert_eq!(
        f.client.sender_streams(&f.sender, &0, &10),
        soroban_sdk::Vec::from_slice(&f.env, &[id]),
    );
    assert_eq!(
        f.client.sender_streams(&new_payer, &0, &10),
        soroban_sdk::Vec::from_slice(&f.env, &[id]),
    );
}

#[test]
fn propose_then_cancel_clears_pending_proposal_and_allows_reproposal() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &first);
    assert!(f.client.pending_ownership_transfer(&id).is_some());

    f.client
        .mock_all_auths()
        .cancel_ownership_transfer(&f.sender, &id);
    assert!(f.client.pending_ownership_transfer(&id).is_none());

    let err = f
        .client
        .mock_all_auths()
        .try_accept_ownership_transfer(&first, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingOwnership);
    assert_eq!(f.client.get_stream(&id).sender, f.sender);

    // A cancelled proposal does not poison the stream: a fresh target works.
    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &second);
    f.client
        .mock_all_auths()
        .accept_ownership_transfer(&second, &id);
    assert_eq!(f.client.get_stream(&id).sender, second);
}

#[test]
fn expired_proposal_cannot_be_accepted() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let target = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &target);
    // The acceptance window is half-open: at exactly `expires_at` it is stale.
    f.advance_time(OWNERSHIP_PROPOSAL_TTL_SECONDS);

    let err = f
        .client
        .mock_all_auths()
        .try_accept_ownership_transfer(&target, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::OwnershipProposalExpired);
    // A failed call rolls back its writes, so the stale proposal remains
    // stored (and harmless) until propose replaces it or cancel removes it.
    assert!(f.client.pending_ownership_transfer(&id).is_some());
    assert_eq!(f.client.get_stream(&id).sender, f.sender);
}

#[test]
fn expired_proposal_may_be_replaced_or_cancelled() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let stale = Address::generate(&f.env);
    let fresh = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &stale);
    f.advance_time(OWNERSHIP_PROPOSAL_TTL_SECONDS + 1);

    // Stale proposals are cleared lazily by propose: no "pending" error.
    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &fresh);
    assert_eq!(
        f.client.pending_ownership_transfer(&id).unwrap().new_owner,
        fresh
    );

    // An expired proposal can also still be cancelled explicitly.
    f.client
        .mock_all_auths()
        .cancel_ownership_transfer(&f.sender, &id);
    assert!(f.client.pending_ownership_transfer(&id).is_none());
}

#[test]
fn second_proposal_while_one_is_pending_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &first);

    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&f.sender, &id, &second)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::OwnershipProposalPending);

    // The single proposal slot is per stream, not per role: the recipient
    // cannot overwrite the sender's pending proposal either.
    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&f.recipient, &id, &second)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::OwnershipProposalPending);

    assert_eq!(
        f.client.pending_ownership_transfer(&id).unwrap().new_owner,
        first
    );
}

#[test]
fn only_current_role_holders_can_propose() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&Address::generate(&f.env), &id, &Address::generate(&f.env))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
    assert!(f.client.pending_ownership_transfer(&id).is_none());
}

#[test]
fn only_named_target_can_accept() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let target = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &target);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_ownership_transfer(&Address::generate(&f.env), &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
    // A failed acceptance leaves the proposal intact.
    assert!(f.client.pending_ownership_transfer(&id).is_some());

    f.client
        .mock_all_auths()
        .accept_ownership_transfer(&target, &id);
    assert_eq!(f.client.get_stream(&id).sender, target);
}

#[test]
fn only_proposer_can_cancel_proposal() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let target = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &target);

    // Neither the counterparty nor the named target may cancel.
    for caller in [&f.recipient, &target] {
        let err = f
            .client
            .mock_all_auths()
            .try_cancel_ownership_transfer(caller, &id)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, StreamError::NotAuthorized);
    }
    assert!(f.client.pending_ownership_transfer(&id).is_some());

    f.client
        .mock_all_auths()
        .cancel_ownership_transfer(&f.sender, &id);
    assert!(f.client.pending_ownership_transfer(&id).is_none());
}

#[test]
fn cannot_propose_transfer_to_current_holder() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&f.sender, &id, &f.sender)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidTransferTarget);

    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&f.recipient, &id, &f.recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidTransferTarget);
    assert!(f.client.pending_ownership_transfer(&id).is_none());
}

#[test]
fn ownership_cannot_be_proposed_on_terminal_streams() {
    let f = Fixture::setup();
    let target = Address::generate(&f.env);

    let cancelled = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.client
        .mock_all_auths()
        .cancel_stream(&f.sender, &cancelled);
    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&f.sender, &cancelled, &target)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);

    let depleted = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.advance_time(3 * DAY);
    f.client.mock_all_auths().withdraw(&depleted, &DEPOSIT);
    let err = f
        .client
        .mock_all_auths()
        .try_propose_ownership_transfer(&f.recipient, &depleted, &target)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
}

#[test]
fn accepting_after_stream_terminates_reverts_and_clears_proposal() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let target = Address::generate(&f.env);

    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.recipient, &id, &target);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);

    let err = f
        .client
        .mock_all_auths()
        .try_accept_ownership_transfer(&target, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);
    // Reverting rolls back the lazy cleanup: the proposal stays stored, but
    // it can never move a terminal stream's role.
    assert!(f.client.pending_ownership_transfer(&id).is_some());
    assert_eq!(f.client.get_stream(&id).recipient, f.recipient);
}

#[test]
fn pending_view_on_unknown_stream_is_none_and_never_touches_ttl() {
    // `extend_ttl` fails on a key that was never written, so the read path must
    // check existence first. An unknown id must simply return `None`.
    let f = Fixture::setup();
    assert!(f.client.pending_ownership_transfer(&999).is_none());

    let target = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_ownership_transfer(&target, &999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingOwnership);
}

#[test]
fn ownership_events_are_emitted_with_expected_payloads() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let now = f.env.ledger().timestamp();
    // Drain StreamCreated so each assertion covers one transfer event.
    let _ = f.env.events().all();

    let target = Address::generate(&f.env);
    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.sender, &id, &target);
    let proposed = crate::OwnershipProposed {
        stream_id: id,
        current_owner: f.sender.clone(),
        new_owner: target.clone(),
        role: OwnershipRole::Sender,
        expires_at: now + OWNERSHIP_PROPOSAL_TTL_SECONDS,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [proposed.to_xdr(&f.env, &f.client.address)],
    );

    f.client
        .mock_all_auths()
        .accept_ownership_transfer(&target, &id);
    let accepted = crate::OwnershipAccepted {
        stream_id: id,
        previous_owner: f.sender.clone(),
        new_owner: target.clone(),
        role: OwnershipRole::Sender,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [accepted.to_xdr(&f.env, &f.client.address)],
    );
}

// ------------------------------------------------ rate renegotiation (#54) --

/// A ten-day window, so whole-day boundaries produce exact `owed` values.
const RENEGOTIATION_DURATION: u64 = 10 * DAY;

/// A stream funded at ledger time 0, advanced `at` seconds into its window.
fn schedule_fixture(deposit: i128, duration: u64, at: u64) -> (Fixture, u64) {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(deposit, 0, duration, false);
    f.advance_time(at);
    (f, id)
}

/// A window priced at `allocation` tokens over exactly its own length: the
/// shape a renegotiation writes, where accrual has no rounding residue.
fn window(start_time: u64, end_time: u64, allocation: i128) -> RateSegment {
    RateSegment {
        start_time,
        end_time,
        allocation,
        basis_seconds: end_time - start_time,
    }
}

/// Zero segments is not a special case of the schedule math: it must return the
/// single-window formula for every input, error included. Pinned around the
/// window edges and against the pure `streamed_at` the pre-feature contract
/// called, which is the differential the old-vs-new comparison needs.
#[test]
fn empty_plan_matches_single_window_formula() {
    let env = Env::default();
    env.mock_all_auths();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    let start = 1_000u64;
    let empty = soroban_sdk::Vec::<RateSegment>::new(&env);

    for duration in [
        1u64,
        2,
        60,
        DAY,
        RENEGOTIATION_DURATION,
        MAX_DURATION_SECONDS,
    ] {
        for deposit in [1i128, 999, DEPOSIT, i128::MAX / 2] {
            let s = Stream {
                id: 1,
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit,
                withdrawn: 0,
                start_time: start,
                end_time: start + duration,
                cancelable: false,
                status: StreamStatus::Active,
                use_oracle: false,
            };
            for offset in [0u64, 1, duration / 2, duration - 1, duration, duration + 1] {
                let now = start + offset;
                let single = streamed_amount_at(&s, now);
                let plan = streamed_amount_at_segments(&s, now, &empty);
                assert_eq!(
                    single, plan,
                    "empty schedule diverged at offset {offset} of a {duration}s window"
                );
                assert_eq!(
                    streamed_at(deposit, duration, offset.min(duration)),
                    plan,
                    "empty schedule diverged from the pure rate function"
                );
                assert_eq!(available_amount_at_segments(&s, now, &empty), single);
                if let Ok(streamed) = single {
                    let (recipient_leg, sender_leg) =
                        cancel_amounts_at_segments(&s, now, &empty).unwrap();
                    assert_eq!(recipient_leg, streamed);
                    assert_eq!(recipient_leg + sender_leg, deposit);
                } else {
                    assert!(cancel_amounts_at_segments(&s, now, &empty).is_err());
                }
            }
        }
    }
}

/// A rate increase is priced out of the unaccrued remainder, and the shortfall
/// is pulled from the sender in the same transaction that installs the window.
#[test]
fn rate_increase_pulls_the_exact_shortfall() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    let owed = DEPOSIT * 3 / 10; // three of ten days accrued
    let reserved = 20_000i128 * (RENEGOTIATION_DURATION - 3 * DAY) as i128;
    let shortfall = reserved - (DEPOSIT - owed);

    let before_sender = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    let before_contract = TokenClient::new(&f.env, &f.token).balance(&f.client.address);

    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);
    assert_eq!(
        f.client.pending_rate_change(&id),
        Some(PendingRateChange {
            stream_id: id,
            proposed_by: f.sender.clone(),
            counterparty: f.recipient.clone(),
            amount_per_second: 20_000,
            expires_at: 3 * DAY + RATE_PROPOSAL_TTL_SECONDS,
        })
    );
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);

    let s = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(s.deposit, owed + reserved);
    assert_eq!(s.withdrawn, 0);
    assert_eq!(s.status, StreamStatus::Active);
    assert_eq!(f.client.rate_segments(&id), {
        let mut expected = soroban_sdk::Vec::new(&f.env);
        // The head keeps the original `(deposit, duration)` pair, which is
        // what preserves the accrual computed before the change.
        expected.push_back(RateSegment {
            start_time: 0,
            end_time: 3 * DAY,
            allocation: DEPOSIT,
            basis_seconds: RENEGOTIATION_DURATION,
        });
        expected.push_back(window(3 * DAY, 10 * DAY, reserved));
        expected
    });
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        before_sender - shortfall
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        before_contract + shortfall
    );
    assert!(f.client.pending_rate_change(&id).is_none());
    assert_eq!(f.client.mock_all_auths().available(&id), owed);
}

/// The "rate increase without funds" case: the pull is the last check before the
/// effects, so a sender who cannot cover the shortfall leaves a stream that
/// looks exactly as if the negotiation never happened — including the offer,
/// which stays open for a retry once the balance is there.
#[test]
fn rate_increase_without_funds_changes_nothing() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &DEPOSIT);

    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::TopUpTransferFailed);

    assert_eq!(f.client.mock_all_auths().get_stream(&id).deposit, DEPOSIT);
    assert_eq!(f.client.rate_segments(&id).len(), 0);
    assert!(f.client.pending_rate_change(&id).is_some());
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        DEPOSIT
    );
}

/// A decrease frees exactly the escrow the new rate no longer needs. The refund
/// is the last interaction: were it to fail, the whole acceptance would roll
/// back rather than half-apply a schedule.
#[test]
fn rate_decrease_refunds_the_freed_escrow() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    let owed = DEPOSIT * 3 / 10;
    let reserved = 5_000i128 * (RENEGOTIATION_DURATION - 3 * DAY) as i128;
    let refund = (DEPOSIT - owed) - reserved;

    let before_sender = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.recipient, &id, &5_000);
    f.client.mock_all_auths().accept_rate_change(&f.sender, &id);

    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).deposit,
        owed + reserved
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        before_sender + refund
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        owed + reserved
    );
}

/// The funds-bug property, checked against the formula the stream used before
/// the change rather than a second reading of contract state: every timestamp
/// at or before the boundary still prices out of the original
/// `(deposit, duration)` pair, and every timestamp after it prices the new rate
/// with no rounding residue.
#[test]
fn rate_change_never_reprices_the_past() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    let boundary = 3 * DAY;
    let owed = DEPOSIT * 3 / 10;
    let new_rate = 20_000i128;
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &new_rate);
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);

    let s = f.client.mock_all_auths().get_stream(&id);
    let segments = f.client.rate_segments(&id);
    for offset in (0..=boundary).step_by(3_600) {
        assert_eq!(
            streamed_amount_at_segments(&s, offset, &segments),
            streamed_at(DEPOSIT, RENEGOTIATION_DURATION, offset),
            "accrual at {offset} changed retroactively"
        );
    }
    for offset in (boundary..=10 * DAY).step_by(7_331) {
        assert_eq!(
            streamed_amount_at_segments(&s, offset, &segments).unwrap(),
            owed + new_rate * (offset - boundary) as i128,
            "the new rate is not exact at {offset}"
        );
    }
    // The window ends fully funded: the endpoint of the schedule is the deposit
    // acceptance wrote, so nothing is left unstreamable and nothing overdrawn.
    assert_eq!(
        streamed_amount_at_segments(&s, 10 * DAY, &segments).unwrap(),
        s.deposit
    );

    // The on-chain read agrees at the boundary and after a day of the new rate.
    assert_eq!(f.client.mock_all_auths().available(&id), owed);
    f.advance_time(DAY);
    assert_eq!(
        f.client.mock_all_auths().available(&id),
        owed + new_rate * DAY as i128
    );
}

/// Whole-token flooring lives only in the original window. A deposit that does
/// not divide by its duration still leaves `owed` untouched at the boundary,
/// and the rest of the stream prices to the token.
#[test]
fn rate_decrease_mid_second_keeps_the_floor_where_it_belongs() {
    // 3_000_000_000 over 7 seconds: 428_571_428.57 tokens per second.
    let (f, id) = schedule_fixture(3_000_000_000, 7, 3);
    let owed = 3_000_000_000i128 * 3 / 7;
    assert_eq!(f.client.mock_all_auths().available(&id), owed);

    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &1);
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);

    let s = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(s.deposit, owed + 4);
    assert_eq!(f.client.mock_all_auths().available(&id), owed);
    for second in 1..=4u64 {
        f.advance_time(1);
        assert_eq!(
            f.client.mock_all_auths().available(&id),
            owed + second as i128
        );
    }
    // Cancelled at the endpoint: the recipient's claim is the whole deposit and
    // the sender's refund is zero.
    let before_recipient = TokenClient::new(&f.env, &f.token).balance(&f.recipient);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient) - before_recipient,
        owed + 4
    );
}

#[test]
fn rate_proposal_follows_the_two_step_window() {
    // Twenty days so the seven-day acceptance window closes before the stream
    // does: expiry and elapsed-window are different rejections.
    let (f, id) = schedule_fixture(DEPOSIT, 20 * DAY, 3 * DAY);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &1);

    let stranger = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&stranger, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);

    // Only one offer at a time, and neither party may overwrite the other's.
    let err = f
        .client
        .mock_all_auths()
        .try_propose_rate_change(&f.recipient, &id, &2)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::RateProposalPending);

    // An expired offer is unacceptible but replaceable, and a replacement is
    // cancellable by its own proposer only.
    f.advance_time(RATE_PROPOSAL_TTL_SECONDS);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::RateProposalExpired);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &2);
    let err = f
        .client
        .mock_all_auths()
        .try_cancel_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
    f.client.mock_all_auths().cancel_rate_change(&f.sender, &id);
    assert!(f.client.pending_rate_change(&id).is_none());

    // Accepting with no offer stored is its own code, not `NotAuthorized`.
    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NoPendingRateChange);
}

#[test]
fn rate_change_requires_an_active_stream_and_a_window_to_rate() {
    let f = Fixture::setup_quiet();
    let cancelled = f.create_stream(DEPOSIT, 0, RENEGOTIATION_DURATION, true);
    f.client
        .mock_all_auths()
        .cancel_stream(&f.sender, &cancelled);
    let err = f
        .client
        .mock_all_auths()
        .try_propose_rate_change(&f.sender, &cancelled, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::StreamNotActive);

    // A stream whose window closed while it stayed Active has nothing left to
    // re-rate: both halves of the handshake refuse it, and the open offer
    // changes nothing.
    let ended = f.create_stream(DEPOSIT, 0, 4 * DAY, false);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &ended, &1);
    f.advance_time(4 * DAY + 1);
    let err = f
        .client
        .mock_all_auths()
        .try_propose_rate_change(&f.sender, &ended, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidTimeRange);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &ended)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::InvalidTimeRange);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&ended).deposit,
        DEPOSIT
    );
    assert_eq!(f.client.rate_segments(&ended).len(), 0);

    // A stranger cannot open an offer at all. Checked on a live stream: the
    // window guard above fires first, and it is not an authorization failure.
    let live = f.create_stream(DEPOSIT, 0, RENEGOTIATION_DURATION, false);
    let err = f
        .client
        .mock_all_auths()
        .try_propose_rate_change(&Address::generate(&f.env), &live, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
    assert!(f.client.pending_rate_change(&live).is_none());
}

/// A role transfer changes the counterparty: the successor inherits the stream,
/// not a deal they never agreed to, and the stale offer still gets cleaned up by
/// whoever made it.
#[test]
fn ownership_transfer_invalidates_a_pending_rate_change() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);

    let heir = Address::generate(&f.env);
    f.client
        .mock_all_auths()
        .propose_ownership_transfer(&f.recipient, &id, &heir);
    f.client
        .mock_all_auths()
        .accept_ownership_transfer(&heir, &id);

    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotAuthorized);
    assert_eq!(f.client.mock_all_auths().get_stream(&id).deposit, DEPOSIT);

    // The successor is not bound, but is not blocked either: the original
    // proposer can drop the offer, and a fresh one is accepted normally.
    f.client.mock_all_auths().cancel_rate_change(&f.sender, &id);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);
    f.client.mock_all_auths().accept_rate_change(&heir, &id);
    assert_eq!(f.client.rate_segments(&id).len(), 2);
    assert_eq!(f.client.mock_all_auths().get_stream(&id).recipient, heir);
}

/// The read paths must not disagree with the money: `available`, `withdraw_max`
/// and the cancellation split all price the same schedule, and the two payouts
/// still add up to the deposit.
#[test]
fn withdrawals_and_cancellation_honor_the_schedule() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    let owed = DEPOSIT * 3 / 10;
    let new_rate = 5_000i128;
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &new_rate);
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);

    let deposit = f.client.mock_all_auths().get_stream(&id).deposit;
    f.advance_time(DAY); // four of ten days in
    let accrued = owed + new_rate * DAY as i128;
    assert_eq!(f.client.mock_all_auths().available(&id), accrued);
    assert_eq!(f.client.mock_all_auths().withdraw_max(&id), accrued);

    let s = f.client.mock_all_auths().get_stream(&id);
    assert_eq!(s.withdrawn, accrued);
    assert_eq!(s.status, StreamStatus::Active);
    assert_eq!(f.client.mock_all_auths().available(&id), 0);

    let before_sender = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender) - before_sender,
        deposit - accrued,
        "the cancel split must refund exactly the remainder of the schedule"
    );
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        0
    );
}

/// A top-up on a renegotiated stream grows the window being streamed, priced
/// pro-rata exactly as it is on a single-window stream, and leaves every
/// accepted window before it alone.
#[test]
fn top_up_after_a_rate_change_grows_only_the_current_window() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    let owed = DEPOSIT * 3 / 10;
    let reserved = 20_000i128 * (RENEGOTIATION_DURATION - 3 * DAY) as i128;
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);

    f.advance_time(2 * DAY); // two days of the new window have streamed
    let tail_seconds = RENEGOTIATION_DURATION - 3 * DAY;
    let top_up = 1_000i128;
    let before = f.client.mock_all_auths().available(&id);
    f.client.mock_all_auths().top_up(&id, &top_up);

    let segments = f.client.rate_segments(&id);
    assert_eq!(segments.len(), 2);
    let head = segments.get(0).unwrap();
    let tail = segments.get(1).unwrap();
    assert_eq!(head.allocation, DEPOSIT);
    assert_eq!(head.basis_seconds, RENEGOTIATION_DURATION);
    assert_eq!(tail.allocation, reserved + top_up);
    assert_eq!(tail.basis_seconds, tail_seconds);
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).deposit,
        owed + reserved + top_up
    );
    // The added funds accrue pro-rata over the window they were added to: two
    // of the seven remaining days, floored to whole tokens.
    assert_eq!(
        f.client.mock_all_auths().available(&id) - before,
        top_up * (2 * DAY as i128) / tail_seconds as i128
    );
}

/// The schedule is bounded so `available`/`withdraw` stay cheap to price: one
/// window more than `MAX_RATE_SEGMENTS` refuses, and the refusal leaves the
/// stream exactly as it was. Renegotiating at the floored original rate keeps
/// every adjustment negative, so no party ever needs new funds here.
#[test]
fn rate_segment_limit_is_enforced() {
    let rate = DEPOSIT / RENEGOTIATION_DURATION as i128;
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 0);
    for _ in 1..MAX_RATE_SEGMENTS {
        f.advance_time(1);
        f.client
            .mock_all_auths()
            .propose_rate_change(&f.sender, &id, &rate);
        f.client
            .mock_all_auths()
            .accept_rate_change(&f.recipient, &id);
    }
    assert_eq!(f.client.rate_segments(&id).len(), MAX_RATE_SEGMENTS);

    let before = f.client.mock_all_auths().get_stream(&id);
    let escrow = TokenClient::new(&f.env, &f.token).balance(&f.client.address);
    f.advance_time(1);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &rate);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::TooManyRateSegments);

    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).deposit,
        before.deposit
    );
    assert_eq!(f.client.rate_segments(&id).len(), MAX_RATE_SEGMENTS);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.client.address),
        escrow
    );
    // The rejected offer is still cancellable: hitting the cap never strands a
    // proposal on the stream.
    f.client.mock_all_auths().cancel_rate_change(&f.sender, &id);
    assert!(f.client.pending_rate_change(&id).is_none());
}

#[test]
fn rate_change_events_are_emitted_with_expected_payloads() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, RENEGOTIATION_DURATION, false);
    f.advance_time(3 * DAY);
    let now = f.env.ledger().timestamp();
    let _ = f.env.events().all();

    let new_rate = 20_000i128;
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &new_rate);
    let proposed = RateChangeProposed {
        stream_id: id,
        proposed_by: f.sender.clone(),
        counterparty: f.recipient.clone(),
        amount_per_second: new_rate,
        expires_at: now + RATE_PROPOSAL_TTL_SECONDS,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [proposed.to_xdr(&f.env, &f.client.address)],
    );

    let owed = DEPOSIT * 3 / 10;
    let reserved = new_rate * (RENEGOTIATION_DURATION - 3 * DAY) as i128;
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);
    let accepted = RateChangeAccepted {
        stream_id: id,
        accepted_by: f.recipient.clone(),
        new_amount_per_second: new_rate,
        effective_from: now,
        owed_at_change: owed,
        reserved_at_new_rate: reserved,
        adjustment: reserved - (DEPOSIT - owed),
        deposit: owed + reserved,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [accepted.to_xdr(&f.env, &f.client.address)],
    );
}

/// A frozen contract settles nothing: the offer can be neither placed nor
/// accepted, and the stream's schedule is untouched by the attempt.
#[test]
fn rate_change_is_blocked_while_frozen() {
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 3 * DAY);
    f.client.mock_all_auths().set_frozen(&f.governor, &true);

    let err = f
        .client
        .mock_all_auths()
        .try_propose_rate_change(&f.sender, &id, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);

    f.client.mock_all_auths().set_frozen(&f.governor, &false);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);
    f.client.mock_all_auths().set_frozen(&f.governor, &true);
    let err = f
        .client
        .mock_all_auths()
        .try_accept_rate_change(&f.recipient, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);
    assert_eq!(f.client.mock_all_auths().get_stream(&id).deposit, DEPOSIT);
    assert_eq!(f.client.rate_segments(&id).len(), 0);
}

/// Placing an offer settles nothing: the trace pins that a proposal moves no
/// tokens and writes no stream state, only the offer and its event.
#[test]
fn propose_rate_change_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, RENEGOTIATION_DURATION, false);
    f.advance_time(3 * DAY);

    crate::cei_trace::begin();
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/propose_rate_change.txt").trim_end()
    );
}

/// An increase pulls the shortfall *before* any effect: schedule, deposit and
/// offer are written only once the funds have arrived, so a token that refuses
/// the pull leaves the negotiation exactly where it was.
#[test]
fn accept_rate_increase_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, RENEGOTIATION_DURATION, false);
    f.advance_time(3 * DAY);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &20_000);

    crate::cei_trace::begin();
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/accept_rate_increase.txt").trim_end()
    );
}

/// A decrease is the mirror image: every effect lands first and the refund is
/// the last interaction, so a token that refuses it rolls the whole acceptance
/// back rather than half-applying a schedule.
#[test]
fn accept_rate_decrease_operation_order_matches_golden() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, RENEGOTIATION_DURATION, false);
    f.advance_time(3 * DAY);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.recipient, &id, &5_000);

    crate::cei_trace::begin();
    f.client.mock_all_auths().accept_rate_change(&f.sender, &id);
    let actual = crate::cei_trace::finish();

    assert_eq!(
        actual,
        include_str!("../test_orderings/accept_rate_decrease.txt").trim_end()
    );
}

/// `MAX_RATE_SEGMENTS` is a gas bound, not a tidiness rule: pricing a schedule
/// that is at the cap must stay predictable, so the worst case is measured here
/// rather than argued about. The number this asserts is the honest one -- a full
/// 32-window schedule costs a small multiple of the single-window path, and it
/// is what any client has to budget for before accepting a 32nd renegotiation.
#[test]
fn full_schedule_pricing_is_bounded() {
    let rate = DEPOSIT / RENEGOTIATION_DURATION as i128;
    let (f, id) = schedule_fixture(DEPOSIT, RENEGOTIATION_DURATION, 0);
    for _ in 1..MAX_RATE_SEGMENTS {
        f.advance_time(1);
        f.client
            .mock_all_auths()
            .propose_rate_change(&f.sender, &id, &rate);
        f.client
            .mock_all_auths()
            .accept_rate_change(&f.recipient, &id);
    }
    assert_eq!(f.client.rate_segments(&id).len(), MAX_RATE_SEGMENTS);

    f.advance_time(DAY);
    f.env.cost_estimate().budget().reset_unlimited();
    f.client.mock_all_auths().withdraw(&id, &(DEPOSIT / 50));
    let cpu_full = f.env.cost_estimate().budget().cpu_instruction_cost();
    assert!(
        cpu_full <= 850_000,
        "withdraw at the segment cap exceeded budget: {}",
        cpu_full
    );
}

/// MMIX 64-bit linear congruential generator: the schedule shapes in
/// [`piecewise_accrual_matches_the_reference_models`] must be reproducible from
/// the seed alone, so a CI failure can be re-run exactly without a corpus file.
struct ScheduleRng(u64);

impl ScheduleRng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 1
    }

    fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            0
        } else {
            self.next_u64() % bound
        }
    }
}

/// Seconds of `segment`'s window elapsed at `now`, written straight from the
/// definition rather than through the contract's helper.
fn window_elapsed(window_start: u64, window_end: u64, now: u64) -> u64 {
    if now <= window_start {
        0
    } else if now >= window_end {
        window_end - window_start
    } else {
        now - window_start
    }
}

/// The rounding-error analysis for piecewise accrual: `trials_count` randomly
/// shaped schedules, priced at randomly probed timestamps, against two models
/// that share no code with the contract path.
///
/// * A segment in the shape `accept_rate_change` writes (`allocation = rate *
///   window`, `basis_seconds = window`) must accrue *exactly* `rate * elapsed`:
///   an integer product with no division and therefore no residue. Every diff
///   against this model is the funds bug #54 warns about, and it is asserted to
///   be zero.
/// * A segment that carries an old `allocation / basis_seconds` pair through a
///   clip (the head of a schedule, whose basis is the original full duration)
///   does not divide evenly, so it is checked against a `u128` long-division
///   model, floor included.
///
/// Each trial also re-checks the invariants a wrong rounding would break:
/// accrual is monotone in `now`, never exceeds the sum of the allocations, and
/// for an all-exact schedule reaches exactly that sum at `end_time`. Returns the
/// number of windows priced, so a caller can report the size of its run.
fn price_random_schedules(trials_count: usize) -> usize {
    // Host objects live per-`Env`, so schedules are built in chunks and each
    // chunk's environment is dropped before the next one starts.
    const TRIALS_PER_ENV: usize = 1_000;
    let mut windows = 0usize;

    /// One window of a randomly shaped schedule, in the model's own terms.
    struct Shape {
        start_time: u64,
        length: u64,
        allocation: i128,
        basis_seconds: u64,
        /// `Some(rate)` for a window `accept_rate_change` wrote, `None` for a
        /// clipped head whose basis is the original, longer duration.
        rate: Option<i128>,
    }

    let mut rng = ScheduleRng(0x5EED_54F5_0000_0001);
    let mut trials = 0usize;
    while trials < trials_count {
        let env = Env::default();
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token = Address::generate(&env);
        for _ in 0..TRIALS_PER_ENV.min(trials_count - trials) {
            trials += 1;

            let start_time = rng.below(1_000);
            let mut cursor = start_time;
            let mut totals = 0i128;
            let mut exact = true;
            let mut shapes: Vec<Shape> = Vec::new();
            let mut segments = soroban_sdk::Vec::new(&env);
            for _ in 0..1 + rng.below(5) {
                let length = 1 + rng.below(500);
                let rate = 1 + rng.below(1_000_000) as i128;
                // Half the windows carry the shape acceptance writes, the rest
                // a clipped head: a basis longer than the window it covers.
                let head_shaped = rng.below(2) == 0;
                exact &= !head_shaped;
                let basis_seconds = if head_shaped {
                    length * (1 + rng.below(3))
                } else {
                    length
                };
                let allocation = rate * length as i128;
                shapes.push(Shape {
                    start_time: cursor,
                    length,
                    allocation,
                    basis_seconds,
                    rate: if head_shaped { None } else { Some(rate) },
                });
                segments.push_back(RateSegment {
                    start_time: cursor,
                    end_time: cursor + length,
                    allocation,
                    basis_seconds,
                });
                totals += allocation;
                cursor += length;
                windows += 1;
            }
            let end_time = cursor;
            let stream = Stream {
                id: 1,
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit: totals,
                withdrawn: 0,
                start_time,
                end_time,
                cancelable: false,
                status: StreamStatus::Active,
                use_oracle: false,
            };

            // Ascending probes, so the monotonicity assertion has an ordering
            // to check: before the window, inside it, and past its end.
            let mut probes: Vec<u64> = Vec::new();
            probes.push(start_time.saturating_sub(1));
            probes.push(end_time + 1);
            for _ in 0..4 {
                probes.push(rng.below(end_time + 2));
            }
            probes.sort_unstable();

            let mut previous = 0i128;
            for now in probes.iter() {
                let mut floor_model = 0i128;
                let mut exact_model = 0i128;
                for shape in shapes.iter() {
                    let elapsed =
                        window_elapsed(shape.start_time, shape.start_time + shape.length, *now);
                    let product = (shape.allocation as u128) * (elapsed as u128);
                    floor_model += (product / shape.basis_seconds as u128)
                        .min(shape.allocation as u128) as i128;
                    exact_model += shape.rate.map_or(0, |rate| rate * elapsed as i128);
                }
                let accrued = streamed_amount_at_segments(&stream, *now, &segments)
                    .unwrap_or_else(|error| panic!("{error:?} in trial {trials} at {now}"));

                assert!(
                    accrued >= 0 && accrued <= totals,
                    "trial {trials} at {now}: {accrued} escaped [0, {totals}]"
                );
                assert!(
                    accrued >= previous,
                    "trial {trials}: accrual went backwards at {now}"
                );
                previous = accrued;
                assert_eq!(
                    accrued, floor_model,
                    "trial {trials} at {now}: contract disagreed with the u128 model"
                );
                if exact {
                    assert_eq!(
                        accrued, exact_model,
                        "trial {trials} at {now}: an exact schedule rounded"
                    );
                }
            }

            if exact {
                assert_eq!(
                    streamed_amount_at_segments(&stream, end_time, &segments).unwrap(),
                    totals,
                    "trial {trials}: an exact schedule did not settle at its deposit"
                );
            }
        }
    }
    assert_eq!(trials, trials_count);
    windows
}

/// The suite-facing run: enough random schedules to catch a rounding change the
/// moment it lands, without turning `cargo test` into a benchmark.
#[test]
fn piecewise_accrual_matches_the_reference_models() {
    let windows = price_random_schedules(20_000);
    std::println!("ROUNDING ANALYSIS: 20_000 segment sets, {windows} windows priced, 0 diffs");
}

/// The review-facing run: 10^6 random segment sets, the number #54 asks a rate
/// change to be checked against. Ignored in the default suite because pricing a
/// million host-object schedules takes minutes; run it deliberately with
/// `cargo test --lib -- --ignored --nocapture` when a schedule change needs the
/// full analysis in the PR.
#[test]
#[ignore]
fn piecewise_accrual_rounding_analysis_over_a_million_schedules() {
    let windows = price_random_schedules(1_000_000);
    std::println!("ROUNDING ANALYSIS: 1_000_000 segment sets, {windows} windows priced, 0 diffs");
}
