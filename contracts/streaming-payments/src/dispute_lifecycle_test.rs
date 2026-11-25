//! Dispute bond lifecycle and accounting suite.
//!
//! Transition table derived from `dispute.rs` and `resolve_dispute` /
//! `expire_dispute` in `lib.rs` (events: `dispute_raised`,
//! `dispute_resolved`, `dispute_expired`):
//!
//! | from      | action                         | bond outcome                          | to        |
//! |-----------|--------------------------------|---------------------------------------|-----------|
//! | none      | `raise_dispute`                | recipient -> contract (held)          | open      |
//! | open      | `resolve_dispute(accept=false)`| contract -> sender (forfeited)        | none      |
//! | open      | `resolve_dispute(accept=true)` | contract -> recipient (returned)      | none      |
//! | open      | `expire_dispute` (>= expires_at)| split: sender ceil, recipient floor  | none      |
//! | open      | `expire_dispute` (< expires_at)| revert `DisputeNotExpired`, held      | open      |
//! | none      | resolve / expire               | revert `DisputeNotFound`              | none      |
//!
//! Every test asserts the conservation invariant through
//! [`assert_bond_accounted`]: the three parties plus the contract always hold
//! the same total, and the contract balance is exactly the stream escrow plus
//! the bond still held — a bond is never lost or duplicated.
#![cfg(test)]

extern crate std;

use soroban_sdk::token::Client as TokenClient;

use crate::test::Fixture;
use crate::{bond_shares, StreamError, StreamStatus};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;
const BOND: i128 = DEPOSIT / 20;
const TIMEOUT: u64 = crate::DISPUTE_TIMEOUT_SECONDS;

fn bal(f: &Fixture, who: &soroban_sdk::Address) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(who)
}

/// (sender, recipient, contract) balances.
fn balances(f: &Fixture) -> (i128, i128, i128) {
    (
        bal(f, &f.sender),
        bal(f, &f.recipient),
        bal(f, &f.client.address),
    )
}

/// Sum of all value in play; must be identical at every step.
fn total(f: &Fixture) -> i128 {
    let (s, r, c) = balances(f);
    s + r + c
}

/// Conservation invariant: value is neither created nor destroyed, and the
/// contract holds exactly `escrow` (stream funds still owed) + `bond_held`.
fn assert_bond_accounted(
    f: &Fixture,
    initial_total: i128,
    escrow: i128,
    bond_held: i128,
    ctx: &str,
) {
    assert_eq!(total(f), initial_total, "{ctx}: total value conserved");
    let (_, _, contract) = balances(f);
    assert_eq!(
        contract,
        escrow + bond_held,
        "{ctx}: contract = escrow + held bond"
    );
}

/// Extracts the registered contract error from a `try_*` client result.
fn err_of<T: core::fmt::Debug, C: core::fmt::Debug>(
    r: Result<T, Result<StreamError, C>>,
) -> StreamError {
    match r {
        Err(Ok(e)) => e,
        other => panic!("expected a registered contract error, got {other:?}"),
    }
}

#[test]
fn dispute_lifecycle_raise_then_reject_forfeits_bond_to_sender() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let d = f.raise_dispute(id);
    let t0 = total(&f);
    let (s0, r0, _) = balances(&f);
    assert_eq!(d.bond, BOND);
    assert_bond_accounted(&f, t0, DEPOSIT, BOND, "after raise");

    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);

    let (s1, r1, _) = balances(&f);
    assert_eq!(s1 - s0, BOND, "bond forfeited to sender");
    assert_eq!(r1 - r0, 0, "recipient gets nothing back");
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after reject");
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Active
    );
}

#[test]
fn dispute_lifecycle_raise_then_accept_returns_bond_to_recipient() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(4 * DAY);
    f.raise_dispute(id);
    let t0 = total(&f);
    let (s0, r0, _) = balances(&f);
    assert_bond_accounted(&f, t0, DEPOSIT, BOND, "after raise");

    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &true);

    let accrued = DEPOSIT * 4 / 10;
    let (s1, r1, _) = balances(&f);
    assert_eq!(r1 - r0, BOND + accrued, "bond returned plus accrued funds");
    assert_eq!(
        s1 - s0,
        DEPOSIT - accrued,
        "sender refunded the unaccrued remainder"
    );
    // Stream escrow is fully unwound, bond fully released.
    assert_bond_accounted(&f, t0, 0, 0, "after accept");
    assert_eq!(
        f.client.mock_all_auths().get_stream(&id).status,
        StreamStatus::Cancelled
    );
}

#[test]
fn dispute_lifecycle_raise_then_expire_splits_bond_without_loss() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    let t0 = total(&f);
    let (s0, r0, _) = balances(&f);

    f.advance_time(TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);

    let (sender_share, recipient_share) = bond_shares(BOND);
    assert_eq!(
        sender_share + recipient_share,
        BOND,
        "shares sum to the bond"
    );
    let (s1, r1, _) = balances(&f);
    assert_eq!(s1 - s0, sender_share);
    assert_eq!(r1 - r0, recipient_share);
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after expire");
}

#[test]
fn dispute_lifecycle_expire_with_odd_bond_rounds_to_sender_and_stays_exact() {
    let f = Fixture::setup();
    // 5% of this deposit is an odd number of units.
    let deposit = DEPOSIT + 20;
    let id = f.create_stream(deposit, DAY, 10 * DAY, false);
    let d = f.raise_dispute(id);
    assert_eq!(d.bond % 2, 1, "bond is odd");
    let t0 = total(&f);
    let (s0, r0, _) = balances(&f);

    f.advance_time(TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);

    let (s1, r1, _) = balances(&f);
    assert_eq!(s1 - s0, d.bond / 2 + 1, "sender takes the extra unit");
    assert_eq!(r1 - r0, d.bond / 2);
    assert_bond_accounted(&f, t0, deposit, 0, "after odd expire");
}

#[test]
fn dispute_lifecycle_clawback_timelock_holds_bond_until_expires_at() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let d = f.raise_dispute(id);
    let t0 = total(&f);
    let before = balances(&f);

    // One second early: reverts, nothing moves, dispute stays open.
    f.advance_time(TIMEOUT - 1);
    let err = err_of(f.client.mock_all_auths().try_expire_dispute(&id));
    assert_eq!(err, StreamError::DisputeNotExpired);
    assert_eq!(balances(&f), before, "no value moved on early expire");
    assert_bond_accounted(&f, t0, DEPOSIT, BOND, "during timelock");
    assert_eq!(f.client.get_dispute(&id), d);

    // Exactly at `expires_at` the bond is released.
    f.advance_time(1);
    f.client.mock_all_auths().expire_dispute(&id);
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after timelock");
    assert!(f.client.try_get_dispute(&id).is_err());
}

#[test]
fn dispute_lifecycle_resolve_twice_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    let t0 = total(&f);
    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);
    let after = balances(&f);

    for accept in [false, true] {
        let err = err_of(
            f.client
                .mock_all_auths()
                .try_resolve_dispute(&f.sender, &id, &accept),
        );
        assert_eq!(err, StreamError::DisputeNotFound);
    }
    assert_eq!(balances(&f), after, "second resolve moves nothing");
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after double resolve");
}

#[test]
fn dispute_lifecycle_resolve_after_expiry_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    let t0 = total(&f);
    f.advance_time(TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);
    let after = balances(&f);

    for accept in [false, true] {
        let err = err_of(
            f.client
                .mock_all_auths()
                .try_resolve_dispute(&f.sender, &id, &accept),
        );
        assert_eq!(err, StreamError::DisputeNotFound);
    }
    assert_eq!(balances(&f), after, "resolve after expiry moves nothing");
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after resolve-after-expiry");
}

#[test]
fn dispute_lifecycle_expire_after_resolve_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    let t0 = total(&f);
    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);
    let after = balances(&f);

    // Even well past the timelock, a resolved dispute cannot be expired.
    f.advance_time(2 * TIMEOUT);
    let err = err_of(f.client.mock_all_auths().try_expire_dispute(&id));
    assert_eq!(err, StreamError::DisputeNotFound);
    assert_eq!(balances(&f), after, "expire after resolve moves nothing");
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after expire-after-resolve");
}

#[test]
fn dispute_lifecycle_expire_twice_reverts() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    let t0 = total(&f);
    f.advance_time(TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);
    let after = balances(&f);

    let err = err_of(f.client.mock_all_auths().try_expire_dispute(&id));
    assert_eq!(err, StreamError::DisputeNotFound);
    assert_eq!(balances(&f), after, "second expire moves nothing");
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "after double expire");
}

#[test]
fn dispute_lifecycle_second_round_bond_is_accounted_independently() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);

    f.raise_dispute(id);
    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);

    // Round two escalates the bond; it is held, then split on expiry.
    let d2 = f.raise_dispute(id);
    assert_eq!(d2.bond, 2 * BOND);
    let t0 = total(&f);
    assert_bond_accounted(&f, t0, DEPOSIT, 2 * BOND, "round 2 held");

    f.advance_time(TIMEOUT);
    f.client.mock_all_auths().expire_dispute(&id);
    assert_bond_accounted(&f, t0, DEPOSIT, 0, "round 2 expired");
}
