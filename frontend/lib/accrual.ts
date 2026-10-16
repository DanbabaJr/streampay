/**
 * Per-second accrual math mirroring Soroban streaming-payments contract.
 * 
 * Computes: deposit * floor(now - start, 0, duration) / duration
 * Equivalent to contract's streamed_at(deposit, duration, floor_elapsed)
 * 
 * All math uses BigInt for exact i128 arithmetic without overflow.
 * Clamping ensures: 0 <= result <= deposit
 */

/**
 * Compute accrued amount at wall-clock time `now`, mirroring Soroban's
 * streamed_at(deposit, duration, elapsed) with floor division and clamping.
 *
 * @param deposit — total deposit (i128 as BigInt)
 * @param startTime — stream start timestamp (Unix seconds)
 * @param endTime — stream end timestamp (Unix seconds)
 * @param now — current wall-clock timestamp (Unix seconds as BigInt)
 * @returns streamed amount capped at deposit (0 <= result <= deposit)
 */
export function computeAccruedAt(
  deposit: bigint,
  startTime: number,
  endTime: number,
  now: bigint
): bigint {
  const duration: bigint = BigInt(endTime - startTime);
  const elapsed: bigint =
    now < BigInt(startTime) ? 0n : now > BigInt(endTime) ? duration : now - BigInt(startTime);

  if (elapsed === 0n || deposit <= 0n || duration === 0n) return 0n;

  const streamed: bigint = (deposit * elapsed) / duration;
  return streamed > deposit ? deposit : streamed;
}

/**
 * Compute accrued-but-unwithdrawn balance for an active stream.
 * Returns 0 for cancelled or depleted streams (mirrors contract's available_amount).
 */
export function computeAvailable(
  deposit: bigint,
  startTime: number,
  endTime: number,
  withdrawn: bigint,
  status: string,
  now: bigint
): bigint {
  if (status !== "Active") return 0n;
  return computeAccruedAt(deposit, startTime, endTime, now) - withdrawn;
}

export type StreamSnapshot = {
  deposit: bigint;
  startTime: number;
  endTime: number;
  withdrawn: bigint;
  status: string;
};