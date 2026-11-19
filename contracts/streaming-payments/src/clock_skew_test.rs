//! Clock-skew tests (issue #211).
//!
//! The frontend renders live balances from `Date.now()`, simulates reads at
//! one ledger moment, and the contract enforces `withdraw` at
//! `ledger().timestamp()` of whichever ledger the transaction lands in. These
//! tests pin the three clocks against each other: a skew matrix over
//! (local_time, ledger_time) pairs in the +/- 10s domain proves that a client
//! may lead by at most the time the ledger actually advances, that leading
//! beyond the landing ledger reverts with `AmountExceedsAvailable` (fail-safe,
//! never over-paid), and that `withdraw_max` is skew-proof by construction.
//!
//! Vocabulary matches `frontend/lib/clock-skew.ts`: epsilon = one
//! ledger-second, drift = bounded local/ledger disagreement, boundary = the
//! half-open window edges.

#![cfg(test)]

use crate::stream::streamed_at;
use crate::test::Fixture;
use crate::StreamError;

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;
const MAX_SKEW: i64 = 10;

/// What a client clock set to `at` would render for the stream right now,
/// computed from the on-chain state exactly like the frontend's
/// `computeAvailable` (same floor math, same clamps).
fn client_view_at(f: &Fixture, id: u64, at: u64) -> i128 {
    let s = f.client.get_stream(&id);
    let duration = s.end_time - s.start_time;
    let elapsed = if at <= s.start_time {
        0
    } else if at >= s.end_time {
        duration
    } else {
        at - s.start_time
    };
    streamed_at(s.deposit, duration, elapsed).expect("rate math") - s.withdrawn
}

#[test]
fn ledger_time_offset_helpers_move_the_contract_clock() {
    let f = Fixture::setup();
    let t0 = f.ledger_time();

    f.set_ledger_time(1_000);
    assert_eq!(f.ledger_time(), 1_000);

    f.offset_ledger_time(10);
    assert_eq!(f.ledger_time(), 1_010);

    f.offset_ledger_time(-30);
    assert_eq!(f.ledger_time(), 980);

    // A negative offset can never underflow the unsigned timestamp.
    f.offset_ledger_time(-10_000);
    assert_eq!(f.ledger_time(), 0);

    f.set_ledger_time(t0);
    assert_eq!(f.ledger_time(), t0);
}

#[test]
fn skew_matrix_ahead_clock_or_lands_or_reverts_never_overpays() {
    // One fixture per (skew, landing-delta) cell so every case starts from a
    // clean stream: ~11.6 units/second is strictly observable per skewed
    // second at this window size.
    for skew in -MAX_SKEW..=MAX_SKEW {
        for landing_delta in [0u64, 5, 10, 20] {
            let f = Fixture::setup();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            let start = f.client.get_stream(&id).start_time;
            let base = start + 5 * DAY; // deep mid-window
            let local = if skew >= 0 {
                base + skew as u64
            } else {
                base - skew.unsigned_abs()
            };

            // What the client would submit, computed at its own local time.
            let amount = client_view_at(&f, id, local);
            assert!(amount > 0, "skew {}s stream should still be paying", skew);

            // The transaction is enforced at the landing ledger.
            f.set_ledger_time(base + landing_delta);
            let truth_at_landing = client_view_at(&f, id, base + landing_delta);

            if landing_delta as i64 >= skew {
                // The landing ledger is at or past the client's local time:
                // everything the client believed has genuinely accrued, and
                // the withdraw succeeds.
                f.client.mock_all_auths().withdraw(&id, &amount);
                assert_eq!(
                    f.client.available(&id),
                    truth_at_landing - amount,
                    "landing {} should pay {} viewed at {}",
                    base + landing_delta,
                    amount,
                    local
                );
            } else {
                // The client led the landing ledger: the over-up attempt is
                // rejected fail-safe with nothing applied.
                let err = f
                    .client
                    .mock_all_auths()
                    .try_withdraw(&id, &amount)
                    .unwrap_err()
                    .unwrap();
                assert_eq!(err, StreamError::AmountExceedsAvailable);
                assert_eq!(f.client.available(&id), truth_at_landing);
            }
        }
    }
}

#[test]
fn honest_clock_may_lead_by_exactly_one_epsilon() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let start = f.client.get_stream(&id).start_time;
    let ledger = start + 5 * DAY;
    f.set_ledger_time(ledger);

    // A clock one epsilon ahead displays contract-available(ledger) plus the
    // accrual of exactly one epsilon-second; a tx landing one ledger later
    // pays it in full.
    let shown = client_view_at(&f, id, ledger + 1);
    let actual = f.client.available(&id);
    let eps = shown - client_view_at(&f, id, ledger);
    assert!(eps > 0);
    assert_eq!(shown, actual + eps);

    f.set_ledger_time(ledger + 1);
    f.client.mock_all_auths().withdraw(&id, &shown);
    assert_eq!(f.client.available(&id), 0);
}

#[test]
fn leading_beyond_the_landing_ledger_reverts_instead_of_overpaying() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let start = f.client.get_stream(&id).start_time;
    let ledger = start + 5 * DAY;
    f.set_ledger_time(ledger);

    // NTP drift: the client thinks it is 5 seconds ahead of the ledger the
    // withdraw is enforced at. The displayed amount must fail, not pay out
    // funds that have not accrued.
    let over_up = client_view_at(&f, id, ledger + 5);
    f.set_ledger_time(ledger + 1);
    let err = f
        .client
        .mock_all_auths()
        .try_withdraw(&id, &over_up)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::AmountExceedsAvailable);
    // And the fail-safe left nothing half-applied.
    assert_eq!(f.client.available(&id), client_view_at(&f, id, ledger + 1));
}

#[test]
fn window_boundaries_agree_with_client_math_to_the_second() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let s = f.client.get_stream(&id);
    let (start, end) = (s.start_time, s.end_time);

    // Contract oracle vs client model agree at every second around both
    // edges of the half-open window: no flicker is allowed between the two
    // clocks at identical timestamps.
    for at in (start - 3)..=(start + 3) {
        f.set_ledger_time(at);
        assert_eq!(
            f.client.available(&id),
            client_view_at(&f, id, at),
            "client/contract disagree at {}",
            at
        );
    }
    for at in (end - 3)..=(end + 11) {
        f.set_ledger_time(at);
        assert_eq!(
            f.client.available(&id),
            client_view_at(&f, id, at),
            "client/contract disagree at {}",
            at
        );
    }

    // The edges themselves: zero strictly up to start, full deposit from end.
    f.set_ledger_time(start);
    assert_eq!(f.client.available(&id), 0);
    f.set_ledger_time(end);
    assert_eq!(f.client.available(&id), DEPOSIT);
    // After end, extra skew (a fast clock, or a late-landing tx) changes
    // nothing: accrual is clamped, so over-up cannot occur past the window.
    f.set_ledger_time(end + MAX_SKEW as u64);
    assert_eq!(f.client.available(&id), DEPOSIT);
    assert_eq!(client_view_at(&f, id, end + MAX_SKEW as u64), DEPOSIT);
}

#[test]
fn withdraw_max_ignores_client_clock_entirely() {
    let f = Fixture::setup();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
    let start = f.client.get_stream(&id).start_time;
    let ledger = start + 5 * DAY;
    f.set_ledger_time(ledger);

    // Whatever a skewed clock shows, withdraw_max pays exactly what the
    // contract has at the landing ledger — the amount never comes from the
    // client, so skew cannot make it over- or under-pay.
    let truth = f.client.available(&id);
    let paid = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(paid, truth);
    assert_eq!(f.client.available(&id), 0);
}
