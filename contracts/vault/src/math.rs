//! Pure vault math — no `Env` dependency, fully fuzz-able.
//!
//! # Solvency invariant
//!
//! A vault is solvent at time `t` if and only if every recipient can be paid
//! their full pro-rata share of accrued tokens from the pool's remaining
//! balance.  Formally, let:
//!
//! - `balance`  = tokens currently held by the vault contract
//! - `horizon`  = the vault's configured end time (Unix seconds)
//! - `now`      = current ledger timestamp
//! - `total_weight` = sum of all active recipient weights
//! - For each recipient `i` with weight `w_i` and already-paid `p_i`:
//!   - `rate_i = balance * w_i / total_weight / (horizon - now)`
//!     (tokens per second, expressed as a fraction to avoid integer loss)
//!   - `owed_i(t) = balance * w_i / total_weight * elapsed(t) / (horizon - now) - p_i`
//!
//! The combined drain over `[now, horizon]` is exactly `balance`, so
//! solvency reduces to: the total committed obligation never exceeds the
//! available balance given the remaining window.
//!
//! # Fair-degradation (underfunded pool)
//!
//! When `balance < required_deposit` at join time, we *do not* reject the
//! operation.  Instead, every recipient's effective deposit is scaled
//! pro-rata to `balance`:
//!
//!   `effective_deposit_i = balance * w_i / total_weight`
//!
//! This haircut is applied at each rebalance point so earlier recipients
//! never retain a disproportionate share.  The policy is:
//!   1. Rebalance settles all past accrual before recomputing deposits.
//!   2. New deposits are computed from the post-settlement pool balance.
//!   3. Resulting deposits are floor-divided (integer math), with the
//!      remainder left unallocated in the pool.
//!
//! # Accrual formula (reused from streaming-payments)
//!
//! `owed_at(deposit, duration, elapsed) = floor(deposit * elapsed / duration)`
//!
//! This is identical to `streamed_at` in the streaming-payments contract;
//! exposing it here as a pure function makes it independently fuzz-able.

use crate::errors::VaultError;

/// Linearly accrued amount after `elapsed` seconds of a `duration`-second
/// window seeded with `deposit` tokens.
///
/// Returns `MathOverflow` when `deposit * elapsed` cannot fit in `u128`.
/// Caps at `deposit` (cannot owe more than was deposited).
/// Pure: no `Env` required.
pub fn owed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, VaultError> {
    if elapsed == 0 || deposit <= 0 || duration == 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(elapsed as u128)
        .ok_or(VaultError::MathOverflow)?;
    let result = (product / (duration as u128)).min(deposit as u128);
    Ok(result as i128)
}

/// Seconds elapsed in a `[start, end)` window at time `now`.
/// Clamped to `[0, end - start]`.
pub fn elapsed(now: u64, start: u64, end: u64) -> u64 {
    if now <= start {
        0
    } else if now >= end {
        end - start
    } else {
        now - start
    }
}

/// Validate that a rebalance does not over-commit the pool.
///
/// After a rebalance, the sum of all effective deposits must not exceed
/// `pool_balance`.  This is the core solvency check; it is called after
/// pro-rata allocation so it should never fail in normal operation — but
/// it guards against integer rounding edge cases.
pub fn check_solvency(total_allocated: i128, pool_balance: i128) -> Result<(), VaultError> {
    if total_allocated > pool_balance {
        return Err(VaultError::Insolvent);
    }
    Ok(())
}

/// Compute each recipient's effective deposit given the pool balance and
/// their weight.
///
/// Returns `floor(pool_balance * weight / total_weight)`.
/// Returns `MathOverflow` if `pool_balance * weight` exceeds `u128`.
pub fn pro_rata_deposit(
    pool_balance: i128,
    weight: u32,
    total_weight: u64,
) -> Result<i128, VaultError> {
    if pool_balance <= 0 || total_weight == 0 {
        return Ok(0);
    }
    let product = (pool_balance as u128)
        .checked_mul(weight as u128)
        .ok_or(VaultError::MathOverflow)?;
    Ok((product / total_weight as u128) as i128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owed_at_zero_elapsed_is_zero() {
        assert_eq!(owed_at(1_000, 100, 0).unwrap(), 0);
    }

    #[test]
    fn owed_at_full_elapsed_is_deposit() {
        assert_eq!(owed_at(1_000, 100, 100).unwrap(), 1_000);
        // past the end: still caps at deposit
        assert_eq!(owed_at(1_000, 100, 200).unwrap(), 1_000);
    }

    #[test]
    fn owed_at_linear_midpoint() {
        assert_eq!(owed_at(1_000, 100, 50).unwrap(), 500);
    }

    #[test]
    fn owed_at_floors_fractional() {
        // 1 of 3 seconds elapsed on a 100-unit deposit: floor(100/3) = 33
        assert_eq!(owed_at(100, 3, 1).unwrap(), 33);
    }

    #[test]
    fn owed_at_overflow_returns_error() {
        // deposit * elapsed would exceed u128
        let r = owed_at(i128::MAX, 1, u64::MAX);
        assert!(r.is_err());
    }

    #[test]
    fn elapsed_clamping() {
        assert_eq!(elapsed(0, 10, 20), 0);
        assert_eq!(elapsed(10, 10, 20), 0); // half-open: start excluded
        assert_eq!(elapsed(15, 10, 20), 5);
        assert_eq!(elapsed(20, 10, 20), 10); // at end: full duration
        assert_eq!(elapsed(100, 10, 20), 10); // past end: still capped
    }

    #[test]
    fn pro_rata_deposit_splits_evenly() {
        // 3 recipients with equal weight 1: each gets 333 (floor of 1000/3)
        assert_eq!(pro_rata_deposit(1_000, 1, 3).unwrap(), 333);
    }

    #[test]
    fn pro_rata_deposit_zero_balance() {
        assert_eq!(pro_rata_deposit(0, 5, 10).unwrap(), 0);
    }

    #[test]
    fn check_solvency_exact_fit() {
        assert!(check_solvency(1_000, 1_000).is_ok());
    }

    #[test]
    fn check_solvency_over_commit_rejected() {
        assert!(check_solvency(1_001, 1_000).is_err());
    }
}
