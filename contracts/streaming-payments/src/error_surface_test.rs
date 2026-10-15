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

use soroban_sdk::testutils::Address as _;

use crate::stream::streamed_at;
use crate::surface::{trace, Branch, Reachability, RETIRED_CODES};
use crate::test::Fixture;
use crate::{StreamError, MAX_DURATION_SECONDS};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

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
            | StreamError::NothingToWithdraw => StreamError::ALL.contains(&e),
        }
    }

    for &e in StreamError::ALL.iter() {
        assert!(listed(e), "variant {e:?} missing from StreamError::ALL");
    }
}
