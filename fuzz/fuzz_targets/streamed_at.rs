//! Coverage-guided fuzzing of the pure accrual function `streamed_at`.
//!
//! Run locally with:
//!
//! ```sh
//! cargo +nightly install cargo-fuzz   # once
//! cd fuzz
//! cargo fuzz run streamed_at          # runs until interrupted
//! cargo fuzz run streamed_at -- -max_total_time=60   # 60s session
//! ```
//!
//! Oracles asserted on every input `(deposit, duration, elapsed)`:
//!
//! 1. No panics on any input, ever (including negatives and zeros).
//! 2. `Ok(result)` implies `0 <= result <= max(deposit, 0)`.
//! 3. When the product `deposit * elapsed` fits in `u128`, the result equals
//!    the exact floor ratio `(deposit * elapsed) / duration`, capped at
//!    `deposit` — the deterministic reference the contract promises.
//! 4. `Err` is *only* ever `MathOverflow`, and only when the product above
//!    genuinely overflows `u128` (degenerate inputs return `Ok(0)`).
//! 5. Monotonicity: `streamed_at(d, dur, e)` <= `streamed_at(d, dur, e+1)`
//!    whenever both sides succeed.

#![no_main]

use libfuzzer_sys::fuzz_target;
use streampay_contract::{streamed_at, StreamError};

// `fuzz_target!` only accepts a single bound identifier, not a tuple pattern, so
// bind the structured input and destructure it here. The tuple implements
// `arbitrary::Arbitrary` (re-exported by `libfuzzer_sys`).
fuzz_target!(|input: (i128, u64, u64)| {
    let (deposit, duration, elapsed) = input;
    let reference = |e: u64| -> Option<Result<i128, StreamError>> {
        let product = (deposit as u128).checked_mul(e as u128)?;
        if deposit <= 0 || duration == 0 || e == 0 {
            return Some(Ok(0));
        }
        Some(Ok(
            (product / duration as u128).min(deposit as u128) as i128
        ))
    };

    match streamed_at(deposit, duration, elapsed) {
        Ok(result) => {
            // Bound (2): the payout is a non-negative part of the deposit.
            assert!(result >= 0, "negative accrual for {deposit}/{duration}/{elapsed}");
            assert!(
                result <= deposit.max(0),
                "accrual {result} exceeds deposit {deposit}"
            );
            // Exactness (3): matches the floor-ratio reference whenever the
            // product fits — which it must, since the call succeeded.
            if let Some(expected) = reference(elapsed) {
                assert_eq!(
                    Ok(result),
                    expected,
                    "accrual mismatch for {deposit}/{duration}/{elapsed}"
                );
            }
            // Monotonicity (5): one more second never pays out less.
            if let Some(next) = elapsed.checked_add(1) {
                if let Some(r) = streamed_at(deposit, duration, next).ok() {
                    assert!(
                        r >= result,
                        "accrual decreased from {result} to {r} at next tick"
                    );
                }
            }
        }
        Err(StreamError::MathOverflow) => {
            // (4): overflow is the only failure mode, and it is genuine.
            assert!(deposit > 0 && duration > 0 && elapsed > 0);
            assert!(
                (deposit as u128).checked_mul(elapsed as u128).is_none(),
                "MathOverflow reported although the product fits"
            );
        }
        Err(other) => panic!("unexpected error variant: {other:?}"),
    }
});
