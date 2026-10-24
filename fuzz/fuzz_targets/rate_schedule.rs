//! Coverage-guided fuzzing of piecewise (renegotiated) accrual.
//!
//! Issue #54 moved the contract from one rate per stream to a schedule of
//! windows, so the accrual oracle needs an input that is a *sequence*, not a
//! triple. This target generates random schedules and asserts five properties
//! on every one of them.
//!
//! Run locally with:
//!
//! ```sh
//! cargo +nightly install cargo-fuzz   # once
//! cd fuzz
//! cargo fuzz run rate_schedule        # runs until interrupted
//! cargo fuzz run rate_schedule -- -max_total_time=60   # 60s session
//! ```
//!
//! Oracles, for a random schedule and a random timestamp:
//!
//! 1. No panics, ever: the only error the segmented path may return is
//!    `MathOverflow`.
//! 2. Parity with the plain-Rust reference model
//!    (`streampay_model::streamed_at_schedule`), which is written from the
//!    single-window formula and shares no code with the contract's loop.
//! 3. Exactness for the shape a rate change writes (`allocation = rate *
//!    window`, `basis_seconds = window`): accrual must equal `rate * elapsed`
//!    summed over windows, a model with *no division anywhere*. A single token
//!    of drift here is the funds bug #54 is about.
//! 4. Monotonicity: one more second never accrues less, and accrual stays
//!    inside `[0, sum of the positive allocations]`.
//! 5. Backwards compatibility: an empty schedule accrues exactly what the
//!    single-window formula accrues for the same stream.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Env, Vec as SdkVec};
use streampay_contract::{
    streamed_amount_at_segments, streamed_at, RateSegment, Stream, StreamError, StreamStatus,
};
use streampay_model::{
    streamed_at_rate_schedule, streamed_at_schedule, ModelError, ModelRateSegment,
};

/// One generated window. `exact` marks the shape `accept_rate_change` stores;
/// the other shape is a clipped head, which carries an `allocation / basis`
/// pair inherited from the stream it was cut out of.
#[derive(Arbitrary, Debug)]
struct Segment {
    start: u32,
    length: u32,
    rate: i32,
    allocation: i64,
    basis: u32,
    exact: bool,
}

#[derive(Arbitrary, Debug)]
struct Schedule {
    segments: Vec<Segment>,
    now: u32,
}

/// Bound the inputs so a window count of `MAX_RATE_SEGMENTS` or an absurd
/// duration cannot turn a divergence into an arithmetic overflow in the test
/// harness itself.
const MAX_WINDOWS: usize = 8;
const COORDINATE_BOUND: u64 = 4_096;

fuzz_target!(|input: Schedule| {
    if input.segments.len() > MAX_WINDOWS {
        return;
    }

    let env = Env::default();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let mut contract_segments: SdkVec<RateSegment> = SdkVec::new(&env);
    let mut model_segments: Vec<ModelRateSegment> = Vec::new();
    let mut exact_windows: Vec<(u64, u64, i128)> = Vec::new();
    let mut all_exact = true;
    let mut positive_total: i128 = 0;
    let mut min_start = u64::MAX;
    let mut max_end = 0u64;

    for segment in input.segments.iter() {
        let start_time = (segment.start as u64) % COORDINATE_BOUND;
        let length = ((segment.length as u64) % COORDINATE_BOUND).max(1);
        let end_time = start_time + length;
        // A renegotiated window always has a positive rate (`propose_rate_change`
        // refuses anything else), so only a positive rate can be diffed against
        // the division-free model: a non-positive allocation accrues zero, it
        // does not accrue negatively.
        let positive_rate = segment.rate > 0;
        let (allocation, basis_seconds) = if segment.exact && positive_rate {
            (segment.rate as i128 * length as i128, length)
        } else {
            all_exact = false;
            // A stored basis is never zero: the head of a schedule keeps the
            // `(deposit, duration)` pair of a stream whose duration is at least
            // one second, and a renegotiated window's basis is that window's
            // length. The contract defends against a zero basis with `.max(1)`
            // inside `segment_accrual`, which the reference model, written from
            // the pre-#54 formula, reads as "nothing accrues". Feeding it here
            // would diff two policies for a state that cannot be stored.
            (
                (segment.allocation % 1_000_000_000_000) as i128,
                ((segment.basis as u64) % (COORDINATE_BOUND - 1)) + 1,
            )
        };

        contract_segments.push_back(RateSegment {
            start_time,
            end_time,
            allocation,
            basis_seconds,
        });
        model_segments.push(ModelRateSegment {
            start_time,
            end_time,
            allocation,
            basis_seconds,
        });
        if segment.exact && positive_rate {
            exact_windows.push((start_time, end_time, segment.rate as i128));
        }
        positive_total += allocation.max(0);
        min_start = min_start.min(start_time);
        max_end = max_end.max(end_time);
    }

    let deposit = positive_total;
    let start_time = if min_start == u64::MAX { 0 } else { min_start };
    let stream = Stream {
        id: 1,
        sender,
        recipient,
        token,
        deposit,
        withdrawn: 0,
        start_time,
        end_time: max_end,
        cancelable: false,
        status: StreamStatus::Active,
        use_oracle: false,
    };

    let now = (input.now as u64) % (COORDINATE_BOUND * 2);
    let accrued = match streamed_amount_at_segments(&stream, now, &contract_segments) {
        Ok(value) => value,
        Err(StreamError::MathOverflow) => {
            // (1) + (2): overflow is the only failure mode, and the reference
            // model has to hit it on the same input.
            assert_eq!(
                streamed_at_schedule(now, &model_segments),
                Err(ModelError::MathOverflow),
                "contract overflowed where the model did not"
            );
            return;
        }
        Err(other) => panic!("unexpected error variant on the segmented path: {other:?}"),
    };

    // (2) Parity with the plain-Rust model.
    assert_eq!(
        Ok(accrued),
        streamed_at_schedule(now, &model_segments),
        "segmented accrual diverged from the reference model at {now}"
    );

    // (3) Exactness for renegotiated windows.
    if all_exact && !exact_windows.is_empty() {
        assert_eq!(
            Ok(accrued),
            streamed_at_rate_schedule(now, &exact_windows),
            "a renegotiated schedule rounded at {now}: #54 funds bug"
        );
    }

    // (4) Bounds and monotonicity.
    assert!(
        accrued >= 0 && accrued <= deposit,
        "accrual {accrued} escaped [0, {deposit}] at {now}"
    );
    if let Some(next) = now.checked_add(1) {
        if let Ok(later) = streamed_amount_at_segments(&stream, next, &contract_segments) {
            assert!(
                later >= accrued,
                "accrual decreased from {accrued} to {later} one second later"
            );
        }
    }
    if all_exact && max_end > start_time {
        assert_eq!(
            streamed_amount_at_segments(&stream, max_end, &contract_segments),
            Ok(deposit),
            "an exact schedule did not settle at the sum of its windows"
        );
    }

    // (5) Empty schedule == the single-window formula, unchanged.
    let empty = SdkVec::new(&env);
    let duration = max_end.saturating_sub(start_time);
    let elapsed = if now <= start_time {
        0
    } else if now >= max_end {
        duration
    } else {
        now - start_time
    };
    assert_eq!(
        streamed_amount_at_segments(&stream, now, &empty),
        streamed_at(deposit, duration, elapsed),
        "the empty schedule stopped matching the pre-#54 accrual"
    );
});
