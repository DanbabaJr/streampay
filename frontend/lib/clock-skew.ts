/**
 * Clock-skew harness (issue #211).
 *
 * StreamPay balances are computed at three different moments by three
 * different clocks:
 *
 *  1. the live ticker interpolates with the *local* wall clock
 *     (`Date.now()/1000`, floor-truncated to whole seconds),
 *  2. the simulate-backed `available` read is evaluated at the *ledger* time
 *     the RPC pins the simulation to,
 *  3. `withdraw` is enforced at `ledger().timestamp()` of the ledger the
 *     transaction actually lands in.
 *
 * This module is the shared vocabulary and deterministic model of those
 * clocks for the test suite: it can replay the accrual path of any stream
 * under a controlled skew between the three sources and check the UX
 * contract ("a live counter may show stale-down, never over-up").
 *
 * Skew vocabulary:
 *  - epsilon:  the smallest time increment the contract observes — one whole
 *              ledger-second. One epsilon of accrual is the most a correct
 *              clock may ever run ahead within a single tick.
 *  - drift:    the (bounded) disagreement between the local clock and the
 *              ledger clock, in seconds. The suite pins the contract at
 *              +/- MAX_SKEW_SECONDS.
 *  - boundary: a skew sample taken within +/- 1s of `start_time` or
 *              `end_time`, where the half-open window makes the two clock
 *              semantics observable at their sharpest.
 */

import { computeAvailable, type StreamSnapshot } from "./accrual.ts";

/** One ledger-second: the contract's finest observable time granularity. */
export const EPSILON_SECONDS = 1n;

/** The skew domain both the property suite and the live probe must hold. */
export const MAX_SKEW_SECONDS = 10n;

/** Frontend refresh cadence (ms) and ticker cadence (ms), per the data-architecture doc. */
export const REFRESH_INTERVAL_MS = 15_000;
export const TICK_INTERVAL_MS = 1_000;

/** Window boundaries are probed at local time +/- 1s around start/end. */
export const BOUNDARY_OFFSETS = [-1n, 0n, 1n] as const;

export type SkewKind = "epsilon" | "drift" | "boundary";

/** One observation: what the local clock said when the ledger said `ledgerTime`. */
export type SkewPoint = {
  readonly localTime: bigint;
  readonly ledgerTime: bigint;
};

export function skewOf(point: SkewPoint): bigint {
  return point.localTime - point.ledgerTime;
}

export function makeSkew(ledgerTime: bigint, skewSeconds: bigint): SkewPoint {
  return { localTime: ledgerTime + skewSeconds, ledgerTime };
}

/** The drift vocabulary: every integer skew the property domain covers. */
export function driftLadder(): bigint[] {
  const ladder: bigint[] = [];
  for (let s = -MAX_SKEW_SECONDS; s <= MAX_SKEW_SECONDS; s += 1n) {
    ladder.push(s);
  }
  return ladder;
}

/**
 * Full time-matrix: every ledger moment x every drift-skew pair. This is the
 * harness every clock-skew property test iterates over.
 */
export function skewMatrix(ledgerTimes: readonly bigint[]): SkewPoint[] {
  const points: SkewPoint[] = [];
  for (const ledgerTime of ledgerTimes) {
    for (const skew of driftLadder()) {
      points.push(makeSkew(ledgerTime, skew));
    }
  }
  return points;
}

/**
 * Ledger moments around the half-open window edges of a snapshot:
 * `start_time` and `end_time`, each sampled at -1, 0, +1 seconds.
 */
export function boundaryLedgerTimes(snapshot: StreamSnapshot): bigint[] {
  const times: bigint[] = [];
  for (const edge of [BigInt(snapshot.startTime), BigInt(snapshot.endTime)]) {
    for (const offset of BOUNDARY_OFFSETS) {
      times.push(edge + offset);
    }
  }
  return times;
}

/** Mid-window ledger moments, sampled every epsilon around the centre. */
export function interiorLedgerTimes(snapshot: StreamSnapshot, samples = 5): bigint[] {
  const start = BigInt(snapshot.startTime);
  const end = BigInt(snapshot.endTime);
  const span = end - start;
  if (span <= 0n) return [start];
  const times: bigint[] = [];
  for (let i = 0; i < samples; i += 1) {
    times.push(start + (span * BigInt(i)) / BigInt(samples - 1 || 1) - 1n);
  }
  return times;
}

// ---------------------------------------------------------------- oracles --

/**
 * `elapsed_seconds` from contracts/streaming-payments/src/stream.rs evaluated
 * at an explicit ledger time: half-open window `[start_time, end_time)`.
 */
export function contractElapsedAt(
  startTime: number,
  endTime: number,
  ledgerTime: bigint
): bigint {
  const start = BigInt(startTime);
  const end = BigInt(endTime);
  if (ledgerTime <= start) return 0n;
  if (ledgerTime >= end) return end - start;
  return ledgerTime - start;
}

/**
 * `streamed_at` from stream.rs evaluated at an explicit ledger time:
 * `deposit * elapsed / duration`, floored, capped at `deposit`.
 */
export function contractStreamedAt(snapshot: StreamSnapshot, ledgerTime: bigint): bigint {
  if (snapshot.deposit <= 0n) return 0n;
  const duration = BigInt(snapshot.endTime - snapshot.startTime);
  if (duration <= 0n) return 0n;
  const elapsed = contractElapsedAt(snapshot.startTime, snapshot.endTime, ledgerTime);
  if (elapsed === 0n) return 0n;
  const streamed = (snapshot.deposit * elapsed) / duration;
  return streamed > snapshot.deposit ? snapshot.deposit : streamed;
}

/**
 * `available_amount` from stream.rs evaluated at an explicit ledger time.
 * Cancelled streams are settled at cancellation and read zero; every other
 * status keeps the contract's `streamed - withdrawn` semantics.
 */
export function contractAvailableAt(
  snapshot: StreamSnapshot,
  ledgerTime: bigint
): bigint {
  if (snapshot.status === "Cancelled") return 0n;
  return contractStreamedAt(snapshot, ledgerTime) - snapshot.withdrawn;
}

// ------------------------------------------------------------- consumers --

/**
 * Exactly what the shipped 1s ticker renders: the local wall-clock second,
 * floor-truncated from milliseconds, fed to `computeAvailable`.
 */
export function tickerDisplayedAvailable(
  snapshot: StreamSnapshot,
  localTimeMs: bigint
): bigint {
  const localSeconds = localTimeMs / 1000n;
  return computeAvailable(
    snapshot.deposit,
    snapshot.startTime,
    snapshot.endTime,
    snapshot.withdrawn,
    snapshot.status,
    localSeconds
  );
}

/**
 * Accrual observable within one epsilon at the given ledger moment: the
 * difference between contract-available one ledger-second later and now.
 * Zero for sub-epsilon rates — a stream slower than 1 unit/s can accrue
 * nothing within a single epsilon.
 */
export function epsilonUnits(snapshot: StreamSnapshot, ledgerTime: bigint): bigint {
  return (
    contractAvailableAt(snapshot, ledgerTime + EPSILON_SECONDS) -
    contractAvailableAt(snapshot, ledgerTime)
  );
}

/**
 * The guarded live display: what the ticker may show while honouring the
 * UX contract at the given skew point. It is the raw local interpolation
 * clamped to the contract-available at the ledger moment plus one epsilon,
 * so the number a user acts on can never exceed what `withdraw` will pay
 * at that ledger moment by more than the single epsilon of accrual a
 * perfectly-synchronised clock could legitimately show.
 */
export function guardedLiveDisplay(
  snapshot: StreamSnapshot,
  point: SkewPoint
): bigint {
  const raw = computeAvailable(
    snapshot.deposit,
    snapshot.startTime,
    snapshot.endTime,
    snapshot.withdrawn,
    snapshot.status,
    point.localTime
  );
  const cap =
    contractAvailableAt(snapshot, point.ledgerTime) +
    epsilonUnits(snapshot, point.ledgerTime);
  return raw < cap ? raw : cap;
}

// -------------------------------------------------------------- fixtures --

/**
 * Stream fixtures chosen so the property suite exercises every accrual
 * regime a skew can interact with: slower than one epsilon of accrual per
 * second, exactly one unit per second, many units per second, and a window
 * whose edges coincide with the sampled times.
 */
export function skewFixtureStreams(base: number): StreamSnapshot[] {
  const start = base;
  return [
    // Sub-epsilon rate: deposit < duration, so some seconds accrue 0 units.
    { deposit: 9n, startTime: start, endTime: start + 1000, withdrawn: 0n, status: "Active" },
    // Exactly 1 unit/second: epsilon is one whole unit everywhere mid-window.
    { deposit: 1000n, startTime: start, endTime: start + 1000, withdrawn: 0n, status: "Active" },
    // Fast stream: 1000 units/second — any positive skew over-shows quickly.
    { deposit: 1_000_000n, startTime: start, endTime: start + 1000, withdrawn: 0n, status: "Active" },
    // Partially withdrawn active stream: mid-accrual with a nonzero floor.
    { deposit: 1000n, startTime: start, endTime: start + 1000, withdrawn: 250n, status: "Active" },
    // Stream ending inside the skew horizon: boundary at end_time.
    { deposit: 500n, startTime: start, endTime: start + 5, withdrawn: 100n, status: "Active" },
    // Stream starting inside the skew horizon: boundary at start_time.
    { deposit: 1000n, startTime: start + 3, endTime: start + 1003, withdrawn: 0n, status: "Active" },
  ];
}
