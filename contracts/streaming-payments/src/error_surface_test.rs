//! Error-surface matrix tests.
//!
//! Generated against [`Branch`](crate::surface::Branch): for every branch in the
//! registry this module runs a probe that triggers it and asserts that the
//! contract returned the branch's declared code *and* that this exact branch
//! (not merely some error sharing the code) was the one that fired. The
//! coverage tests then prove the reverse direction — no error code is dead —
//! with the retired codes explicitly exempted.
//!
//! The mapping is never hand-maintained: it lives in `surface.rs`, the probe
//! dispatch below is exhaustive over `Branch` (so a new branch is a compile
//! error until it has a probe), and `docs/ERRORS.md` is generated from the same
//! table.

#![cfg(test)]

use std::vec::Vec;

use soroban_sdk::{testutils::Address as _, BytesN, String as SdkString};

use crate::stream::{streamed_at, DataKey};
use crate::surface::{trace, Branch, Reachability, RETIRED_CODES};
use crate::test::Fixture;
use crate::{
    StreamError, MAX_ATTESTATIONS_PER_STREAM, MAX_DURATION_SECONDS, MAX_FEE_BPS, MAX_TAG_LEN,
};
use crate::test::{Fixture, RefusingFixture};
use crate::{StreamError, MAX_DURATION_SECONDS, MAX_FEE_BPS};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

/// A 32-byte attestation hash filled with `byte`.
fn attestation_hash(env: &soroban_sdk::Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// A short attestation tag.
fn attestation_tag(env: &soroban_sdk::Env, s: &str) -> SdkString {
    SdkString::from_str(env, s)
fn schedule_intent(f: &Fixture, execute_after: u64, expires_at: u64) -> u64 {
    let now = f.env.ledger().timestamp();
    f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 2 * DAY),
        &(now + 3 * DAY),
        &false,
        &0,
        &1,
        &0,
        &execute_after,
        &expires_at,
    )
}

/// Unwraps the contract's rejection into its `StreamError`.
macro_rules! rejected {
    ($call:expr) => {
        $call
            .expect_err("expected the contract to reject the call")
            .unwrap()
    };
}

/// Triggers `branch` and returns the error the contract produced, or `None` for
/// a branch classified [`Reachability::Defensive`] (no reachable trigger).
fn probe(branch: Branch) -> Option<StreamError> {
    match branch {
        // ----------------------------------------------------- create_stream
        Branch::CreateDepositNonPositive => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &0,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::CreateStartTimeInPast => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.advance_time(DAY);
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &now,
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::CreateInvalidTimeRange => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + DAY),
                &false,
            )))
        }
        Branch::CreateDurationTooLong => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &now,
                &(now + MAX_DURATION_SECONDS + 1),
                &false,
            )))
        }
        Branch::CapacityOverflow => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &i128::MAX,
                &now,
                &(now + 2 * 365 * DAY),
                &false,
            )))
        }
        // ---------------------------------------------------------- withdraw
        Branch::WithdrawAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &0)))
        }
        Branch::WithdrawAmountExceedsAvailable => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_withdraw(&id, &(DEPOSIT / 10 + 1))))
        }
        // ------------------------------------------------------ withdraw_max
        Branch::WithdrawMaxNothingToWithdraw => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw_max(&id)))
        }
        // ----------------------------------------------------- cancel_stream
        Branch::CancelStreamNotCancellable => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&f.recipient, &id)))
        }
        Branch::CancelStreamNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            let stranger = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&stranger, &id)))
        }
        // ----------------------------------------------------------- top_up
        Branch::TopUpAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_top_up(&id, &0)))
        }
        Branch::TopUpDepositOverflow => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            // DEPOSIT + i128::MAX overflows i128.
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_top_up(&id, &i128::MAX)))
        }
        // --------------------------------------------------- attach_metadata
        Branch::AttachMetadataNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let stranger = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f.client.mock_all_auths().try_attach_metadata(
                &stranger,
                &id,
                &attestation_hash(&f.env, 0x01),
                &attestation_tag(&f.env, "invoice-0042"),
            )))
        }
        Branch::AttachMetadataTagTooLong => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let too_long: std::string::String =
                "a".repeat(usize::try_from(MAX_TAG_LEN).unwrap() + 1);
            Some(rejected!(f.client.mock_all_auths().try_attach_metadata(
                &f.sender,
                &id,
                &attestation_hash(&f.env, 0x02),
                &SdkString::from_str(&f.env, &too_long),
            )))
        }
        Branch::AttachMetadataLimitReached => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            // Fill the stream's append-only list to its cap, then attach once more.
            for _ in 0..MAX_ATTESTATIONS_PER_STREAM {
                f.client.mock_all_auths().attach_metadata(
                    &f.sender,
                    &id,
                    &attestation_hash(&f.env, 0x0F),
                    &attestation_tag(&f.env, "label"),
                );
            }
            Some(rejected!(f.client.mock_all_auths().try_attach_metadata(
                &f.sender,
                &id,
                &attestation_hash(&f.env, 0xFF),
                &attestation_tag(&f.env, "one-too-many"),
            )))
        }
        // --------------------------------------------- shared storage / math
        Branch::StreamNotFound => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_get_stream(&999)))
        }
        Branch::StreamNotActive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.client.mock_all_auths().cancel_stream(&f.sender, &id);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &1)))
        }
        Branch::RateProductOverflow => {
            // The pure rate function's overflow guard, reachable directly
            // (its error is a bare `StreamError`, not a host error wrapper).
            Some(streamed_at(i128::MAX, 3, 3).unwrap_err())
        }
        // ---------------------------------------------------------- treasury
        Branch::SetFeeRateTooHigh => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_set_fee_bps(&f.governor, &(MAX_FEE_BPS + 1),)))
        }
        Branch::GovernorNotAllowed => {
            let f = Fixture::setup_quiet();
            let stranger = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_set_fee_bps(&stranger, &0)))
        }
        Branch::AcceptGovernorNoPending => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_governor(&f.sender)))
        }
        Branch::AcceptGovernorNotNominee => {
            let f = Fixture::setup_quiet();
            f.client
                .mock_all_auths()
                .nominate_governor(&f.governor, &f.recipient);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_governor(&f.sender)))
        }
        Branch::WithdrawTreasuryAmountNonPositive => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor,
                &f.token,
                &f.recipient,
                &0,
            )))
        }
        Branch::WithdrawTreasuryExceedsBalance => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor,
                &f.token,
                &f.recipient,
                &1,
            )))
        }
        // ------------------------------------------------ scheduled intents
        Branch::IntentNotFound => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.try_get_intent(&999)))
        }
        Branch::IntentNotPending => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            let _ = f
                .client
                .mock_all_auths()
                .execute_scheduled(&id, &f.recipient);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentNotYetExecutable => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now + DAY, now + 3 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentExpired => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            f.advance_time(DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentNotCancellable => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_scheduled(&f.sender, &id,)))
        }
        Branch::ScheduleInvalidParameters => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_schedule_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + 2 * DAY),
                &(now + 3 * DAY),
                &false,
                &0,
                &0,
                &0,
                &now,
                &(now + DAY),
            )))
        }
        Branch::IntentParamsMismatch => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            let contract = f.client.address.clone();
            f.env.as_contract(&contract, || {
                let mut intent: crate::ScheduledIntent = f
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
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentNotExpired => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            Some(rejected!(f.client.try_reclaim_expired(&id)))
        }
        // ---------------------------------------------- token interactions
        //
        // These branches fire when the *token* refuses a movement. The probes
        // use [`RefusingFixture`]: a minimal SEP-41 contract whose error code
        // deliberately equals 13 (`NothingToWithdraw`), so receiving StreamPay's
        // own code proves the raw token error did not leak.
        Branch::CreateDepositTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            f.refuse(false, true); // refuses the incoming pull
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &now,
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::TopUpTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.refuse(false, true); // stops accepting incoming transfers
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_top_up(&id, &DEPOSIT)))
        }
        Branch::RecipientPayoutFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.advance_time(DAY); // 1 of 10 days accrued
            f.refuse(true, false); // asset stops paying out
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_withdraw(&id, &(DEPOSIT / 10))))
        }
        Branch::SenderRefundFailed => {
            let f = RefusingFixture::setup_quiet();
            // Not started: recipient_amount is 0, so only the refund leg runs.
            let id = f.create(DEPOSIT, DAY, 10 * DAY);
            f.refuse(true, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&f.sender, &id)))
        }
        Branch::TreasuryPayoutFailed => {
            let f = RefusingFixture::setup_quiet();
            f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
            // Charges a fee into the treasury ledger (1 % of the deposit).
            let _id = f.create(DEPOSIT, 0, 10 * DAY);
            f.refuse(true, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor,
                &f.token,
                &f.recipient,
                &1,
            )))
        }
        // Invariant-protected: a stored stream always satisfies
        // `0 <= withdrawn <= streamed <= deposit <= i128::MAX`, so these
        // checked subtractions/addition can never cross an i128 boundary —
        // not even for a corrupt entry, because `streamed - withdrawn` is
        // bounded below by `-i128::MAX`.
        Branch::AvailableBalanceOverflow | Branch::CancelSplitOverflow | Branch::PayoutOverflow => {
            None
        }
    }
}

/// The matrix: every reachable branch fires its declared code, and every
/// defensive branch is never reached.
#[test]
fn error_surface_matrix_proves_every_branch_is_reachable() {
    for &branch in Branch::ALL.iter() {
        trace::clear();
        let got = probe(branch);
        let hits = trace::drain();

        match branch.reachability() {
            Reachability::Reachable => {
                let error = got.unwrap_or_else(|| {
                    panic!("branch {branch:?} produced no rejection but is marked Reachable")
                });
                assert_eq!(
                    error,
                    branch.error(),
                    "branch {branch:?} returned the wrong code"
                );
                assert!(
                    hits.contains(&branch),
                    "branch {branch:?} was classified reachable but never fired (trace: {hits:?})"
                );
            }
            Reachability::Defensive => {
                assert!(
                    got.is_none() && hits.is_empty(),
                    "defensive branch {branch:?} unexpectedly fired"
                );
            }
        }
    }
}

/// No error code is dead: every variant is either produced by a reachable
/// branch or explicitly retired. A new, uncovered code fails this test.
#[test]
fn every_error_code_is_produced_or_retired() {
    for &code in StreamError::ALL.iter() {
        let produced = Branch::ALL
            .iter()
            .any(|b| b.error() == code && b.reachability() == Reachability::Reachable);
        let retired = RETIRED_CODES.contains(&code);
        assert!(
            produced || retired,
            "dead error code {code:?} (#{}): no reachable branch produces it and it is not retired",
            code.code()
        );
        assert!(
            !(produced && retired),
            "code {code:?} is both reachable and retired — remove it from RETIRED_CODES"
        );
    }
}

/// Retired codes must not be produced by any branch (otherwise they are not
/// retired).
#[test]
fn retired_codes_are_not_produced() {
    for &code in RETIRED_CODES.iter() {
        assert!(
            !Branch::ALL.iter().any(|b| b.error() == code),
            "retired code {code:?} is still produced by a branch"
        );
    }
}

/// Every branch is unique in the registry.
#[test]
fn branch_registry_has_no_duplicates() {
    for (i, &a) in Branch::ALL.iter().enumerate() {
        for &b in &Branch::ALL[i + 1..] {
            assert_ne!(a, b, "branch {a:?} appears more than once in Branch::ALL");
        }
    }
}

/// The defensive set is exactly the invariant-protected guards; every other
/// branch is probed by the matrix.
#[test]
fn defensive_branches_are_exactly_documented() {
    let defensive: Vec<Branch> = Branch::ALL
        .iter()
        .copied()
        .filter(|b| b.reachability() == Reachability::Defensive)
        .collect();
    assert_eq!(
        defensive,
        std::vec![
            Branch::AvailableBalanceOverflow,
            Branch::CancelSplitOverflow,
            Branch::PayoutOverflow,
        ],
        "the defensive set changed; update the matrix test and docs/ERRORS.md"
    );
}

/// Compile-time guard: adding a [`StreamError`] variant breaks this exhaustive
/// match, forcing the author to acknowledge it. It also checks every listed
/// variant really is in [`StreamError::ALL`].
#[test]
fn stream_error_variant_list_is_exhaustive() {
    fn listed(e: StreamError) -> bool {
        match e {
            StreamError::StreamNotFound
            | StreamError::NotStreamSender
            | StreamError::NotStreamRecipient
            | StreamError::StreamNotCancellable
            | StreamError::StreamNotActive
            | StreamError::StartTimeInPast
            | StreamError::InvalidTimeRange
            | StreamError::DurationTooLong
            | StreamError::ZeroAmount
            | StreamError::AmountExceedsAvailable
            | StreamError::MathOverflow
            | StreamError::NotAuthorized
            | StreamError::NothingToWithdraw
            | StreamError::MetadataTagTooLong
            | StreamError::MetadataLimitReached => StreamError::ALL.contains(&e),
            StreamError::FeeRateTooHigh
            | StreamError::NotGovernor
            | StreamError::NoPendingGovernor
            | StreamError::InsufficientTreasuryBalance
            | StreamError::IntentNotFound
            | StreamError::IntentNotPending
            | StreamError::IntentNotYetExecutable
            | StreamError::IntentExpired
            | StreamError::IntentNotCancellable
            | StreamError::InvalidScheduleParameters
            | StreamError::IntentParamsMismatch
            | StreamError::IntentNotExpired
            | StreamError::DepositTransferFailed
            | StreamError::TopUpTransferFailed
            | StreamError::RecipientPayoutFailed
            | StreamError::SenderRefundFailed
            | StreamError::TreasuryPayoutFailed => StreamError::ALL.contains(&e),
        }
    }

    for &e in StreamError::ALL.iter() {
        assert!(listed(e), "variant {e:?} missing from StreamError::ALL");
    }
}
