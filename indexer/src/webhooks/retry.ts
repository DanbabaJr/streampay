export const MAX_RETRY_ATTEMPTS = 5;

/**
 * Base retry schedule intervals in milliseconds:
 * Attempt 1: Immediate (0 ms)
 * Attempt 2: ~1 minute (60,000 ms)
 * Attempt 3: ~5 minutes (300,000 ms)
 * Attempt 4: ~15 minutes (900,000 ms)
 * Attempt 5: ~30 minutes (1,800,000 ms)
 * Total duration spans ~51 minutes (~1 hour window).
 */
export const BASE_RETRY_DELAYS_MS: readonly number[] = [
  0,
  60_000,
  300_000,
  900_000,
  1_800_000,
];

/**
 * Computes next retry delay applying ±20% pseudo-random jitter.
 * Prevents thundering herd problems when downstream endpoints recover.
 *
 * Jitter multiplier is uniformly distributed in [0.80, 1.20].
 */
export function calculateNextRetryDelay(
  attempt: number,
  randomFn: () => number = Math.random
): number {
  if (attempt <= 1) {
    return 0;
  }
  const index = Math.min(attempt - 1, BASE_RETRY_DELAYS_MS.length - 1);
  const baseDelay = BASE_RETRY_DELAYS_MS[index];

  // Jitter factor in [0.80, 1.20]
  const jitterFactor = 0.8 + randomFn() * 0.4;
  return Math.round(baseDelay * jitterFactor);
}

/**
 * Checks whether an attempt number has reached the maximum permitted attempts.
 */
export function isTerminalAttempt(attempt: number): boolean {
  return attempt >= MAX_RETRY_ATTEMPTS;
}
