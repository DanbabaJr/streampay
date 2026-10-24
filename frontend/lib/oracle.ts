/**
 * Pure TypeScript implementation of StreamPay accrual and vesting oracle math.
 * Mirrors `streamed_at` in contracts/streaming-payments/src/stream.rs and
 * supports segmented / cliff vesting schedules.
 */

export interface VestingSegment {
  duration: bigint;
  percentBps: bigint; // basis points: 10000 = 100%
}

export interface AccrualParams {
  deposit: bigint;
  duration: bigint;
  cliffDuration?: bigint;
  cliffAmount?: bigint; // Or cliff release amount
  segments?: VestingSegment[];
}

export class MathOverflowError extends Error {
  constructor(message = "MathOverflow: product exceeds u128 or capacity bounds") {
    super(message);
    this.name = "MathOverflowError";
  }
}

/**
 * Pure streamed_at function identical to Soroban contract:
 * deposit * elapsed / duration (floored, capped at deposit)
 *
 * Rejects overflow when (deposit * elapsed) exceeds 2^128 - 1.
 */
export function streamedAt(
  deposit: bigint,
  duration: bigint,
  elapsed: bigint
): bigint {
  if (elapsed <= 0n || deposit <= 0n || duration <= 0n) {
    return 0n;
  }

  const u128Max = (1n << 128n) - 1n;
  const product = deposit * elapsed;
  if (product > u128Max) {
    throw new MathOverflowError("RateProductOverflow: deposit * elapsed exceeds u128::MAX");
  }

  const streamed = product / duration;
  return streamed > deposit ? deposit : streamed;
}

/**
 * General vesting / accrual calculation allowing cliff and segmented linear vesting.
 *
 * - If elapsed < cliffDuration: returns 0n (or 0 before cliff).
 * - At cliffDuration: cliffAmount is unlocked (if specified) and remaining linearly accrues,
 *   or if segments are defined, piecewise linear accrual is computed across segments.
 */
export function computeVestingAccrual(
  params: AccrualParams,
  elapsed: bigint
): bigint {
  const { deposit, duration, cliffDuration = 0n, cliffAmount = 0n, segments } = params;

  if (elapsed <= 0n || deposit <= 0n || duration <= 0n) {
    return 0n;
  }

  if (elapsed < cliffDuration) {
    return 0n;
  }

  // If piecewise segments are provided
  if (segments && segments.length > 0) {
    let accumulatedTime = cliffDuration;
    let accumulatedPayout = cliffAmount > deposit ? deposit : cliffAmount;
    const remainingDeposit = deposit > accumulatedPayout ? deposit - accumulatedPayout : 0n;

    if (elapsed === cliffDuration) {
      return accumulatedPayout;
    }

    for (const segment of segments) {
      const segDuration = segment.duration;
      const segAllocation = (remainingDeposit * segment.percentBps) / 10000n;

      if (elapsed >= accumulatedTime + segDuration) {
        accumulatedPayout += segAllocation;
        accumulatedTime += segDuration;
      } else {
        const segElapsed = elapsed - accumulatedTime;
        const segAccrued = streamedAt(segAllocation, segDuration, segElapsed);
        accumulatedPayout += segAccrued;
        return accumulatedPayout > deposit ? deposit : accumulatedPayout;
      }
    }

    return accumulatedPayout > deposit ? deposit : accumulatedPayout;
  }

  // Standard linear accrual with optional cliff
  if (cliffAmount > 0n || cliffDuration > 0n) {
    if (elapsed >= duration) {
      return deposit;
    }

    const postCliffDuration = duration - cliffDuration;
    if (postCliffDuration <= 0n) {
      return deposit;
    }

    const postCliffElapsed = elapsed - cliffDuration;
    const remainingToAccrue = deposit > cliffAmount ? deposit - cliffAmount : 0n;
    const linearPart = streamedAt(remainingToAccrue, postCliffDuration, postCliffElapsed);
    const total = cliffAmount + linearPart;
    return total > deposit ? deposit : total;
  }

  // Plain linear stream
  return streamedAt(deposit, duration, elapsed);
}
