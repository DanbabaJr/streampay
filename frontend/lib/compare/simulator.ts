// Pure-TS accrual simulator mirroring the contract's `streamed_at`
// (contracts/streaming-payments/src/stream.rs): linear rate, deposit * elapsed
// / duration, floored to whole units, capped at deposit. All amounts are bigint.
export interface StreamParams {
  /** Deposit in smallest token units. */
  deposit: bigint;
  /** Stream length in seconds (>= 1). */
  duration: bigint;
}

export const MAX_DURATION_SECONDS = 3_155_760_000n; // ~100 years, UI sanity bound

export function streamedAt(deposit: bigint, duration: bigint, elapsed: bigint): bigint {
  if (elapsed <= 0n || deposit <= 0n || duration <= 0n) return 0n;
  const streamed = (deposit * elapsed) / duration;
  return streamed > deposit ? deposit : streamed;
}

/** Whole units per second, floored (display only; accrual never uses it). */
export function ratePerSecond(p: StreamParams): bigint {
  return p.duration > 0n ? p.deposit / p.duration : 0n;
}

export interface CurvePoint {
  /** Seconds since start. */
  t: bigint;
  accrued: bigint;
}

/** Samples the curve at `points` evenly spaced offsets, inclusive of start and end. */
export function accrualCurve(p: StreamParams, points = 24): CurvePoint[] {
  const n = BigInt(Math.max(2, Math.floor(points)));
  const out: CurvePoint[] = [];
  for (let i = 0n; i < n; i++) {
    const t = (p.duration * i) / (n - 1n);
    out.push({ t, accrued: streamedAt(p.deposit, p.duration, t) });
  }
  return out;
}
