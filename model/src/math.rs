//! Pure checked accrual and fee arithmetic for StreamPay.
//!
//! All operations are checked and mirror the exact behavior of [`streampay_contract`].

use crate::errors::ModelError;
use crate::types::{ModelStream, ModelStreamStatus, BPS_DENOMINATOR};

/// Seconds elapsed within the half-open window `[start_time, end_time)`.
pub fn elapsed_seconds(now: u64, start_time: u64, end_time: u64) -> u64 {
    if now <= start_time {
        0
    } else if now >= end_time {
        end_time - start_time
    } else {
        now - start_time
    }
}

/// Validates that worst-case rate product `deposit * duration` fits in `u128`.
pub fn validate_capacity(deposit: i128, duration: u64) -> Result<(), ModelError> {
    let cap = u128::MAX / (duration.max(1) as u128);
    if (deposit as u128) > cap {
        return Err(ModelError::MathOverflow);
    }
    Ok(())
}

/// Pure linear accrual: `deposit * elapsed / duration`, floored, capped at `deposit`.
pub fn streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, ModelError> {
    if elapsed == 0 || deposit <= 0 || duration == 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(elapsed as u128)
        .ok_or(ModelError::MathOverflow)?;
    let streamed = (product / (duration.max(1) as u128)).min(deposit as u128);
    Ok(streamed as i128)
}

/// Accrued-but-unwithdrawn amount at `now`. Zero for cancelled streams.
pub fn available_amount(now: u64, stream: &ModelStream) -> Result<i128, ModelError> {
    if stream.status == ModelStreamStatus::Cancelled {
        return Ok(0);
    }
    let elapsed = elapsed_seconds(now, stream.start_time, stream.end_time);
    let streamed = streamed_at(stream.deposit, stream.duration(), elapsed)?;
    streamed
        .checked_sub(stream.withdrawn)
        .ok_or(ModelError::MathOverflow)
}

/// Cancel split: `(recipient_amount, sender_refund)`.
pub fn cancel_amounts(now: u64, stream: &ModelStream) -> Result<(i128, i128), ModelError> {
    let elapsed = elapsed_seconds(now, stream.start_time, stream.end_time);
    let streamed = streamed_at(stream.deposit, stream.duration(), elapsed)?;
    let recipient_amount = streamed
        .checked_sub(stream.withdrawn)
        .ok_or(ModelError::MathOverflow)?;
    let sender_amount = stream
        .deposit
        .checked_sub(streamed)
        .ok_or(ModelError::MathOverflow)?;
    Ok((recipient_amount, sender_amount))
}

/// Protocol fee: `deposit * fee_bps / 10_000`, floored.
pub fn fee_amount(deposit: i128, fee_bps: u32) -> Result<i128, ModelError> {
    if fee_bps == 0 || deposit <= 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ModelError::MathOverflow)?;
    Ok((product / (BPS_DENOMINATOR as u128)) as i128)
}

/// One window of a piecewise rate schedule: `[start_time, end_time)` priced at
/// `allocation` tokens over `basis_seconds`. A window written by a rate
/// renegotiation has `basis_seconds` equal to its own length, so it prices with
/// no rounding residue; a clipped head keeps the pair it was created with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelRateSegment {
    pub start_time: u64,
    pub end_time: u64,
    pub allocation: i128,
    pub basis_seconds: u64,
}

/// Accrual at `now` under a piecewise schedule: every window priced over its
/// own elapsed slice, summed. Mirrors the contract's
/// `streamed_amount_at_segments`, but built only from the plain-Rust
/// [`streamed_at`] above, which is what makes it usable as a differential
/// oracle for it.
pub fn streamed_at_schedule(now: u64, segments: &[ModelRateSegment]) -> Result<i128, ModelError> {
    let mut total: i128 = 0;
    for segment in segments {
        let elapsed = elapsed_seconds(now, segment.start_time, segment.end_time);
        let accrued = streamed_at(segment.allocation, segment.basis_seconds, elapsed)?;
        total = total.checked_add(accrued).ok_or(ModelError::MathOverflow)?;
    }
    Ok(total)
}

/// The same accrual for a schedule whose windows are each priced by a whole
/// tokens-per-second rate — `allocation == rate * (end_time - start_time)` over
/// exactly that window. No division appears anywhere: this is the property a
/// renegotiated rate must satisfy, and the oracle the segmented path is
/// diffed against.
pub fn streamed_at_rate_schedule(now: u64, rates: &[(u64, u64, i128)]) -> Result<i128, ModelError> {
    let mut total: i128 = 0;
    for (start_time, end_time, rate) in rates {
        let elapsed = elapsed_seconds(now, *start_time, *end_time) as i128;
        let accrued = rate.checked_mul(elapsed).ok_or(ModelError::MathOverflow)?;
        total = total.checked_add(accrued).ok_or(ModelError::MathOverflow)?;
    }
    Ok(total)
}
