export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 8;
export const OUTBOX_MAX_BATCH = 1000;
const OUTBOX_BACKOFF_BASE_MS = 500;
const OUTBOX_BACKOFF_CAP_MS = 1_800_000;

/**
 * Exponential backoff with ±20% jitter, clamped to a 30 minute cap.
 * attempt 1 -> 0 (first dispatch is immediate), attempt n>=2 -> base * 2^(n-2).
 */
export function outboxRetryDelayMs(
  attempt: number,
  randomFn: () => number = Math.random
): number {
  if (attempt <= 1) return 0;
  const exp = Math.min(attempt - 2, 24);
  const base = Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** exp, OUTBOX_BACKOFF_CAP_MS);
  const jitterFactor = 0.8 + randomFn() * 0.4;
  return Math.round(base * jitterFactor);
}

export function isTerminalAttempt(attempt: number, maxAttempts: number): boolean {
  return attempt >= maxAttempts;
}
