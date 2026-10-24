/**
 * Stream analytics: time-series aggregation, per-stream projections,
 * and aggregate income forecast — all powered by the shared accrual oracle
 * from `accrual.ts` so there is exactly one implementation.
 *
 * Issue #96 — analytics panel with lazy-loaded charts.
 * Cross-linked with issue #46 (simulator): both use `computeAccruedAt` as
 * the single accrual oracle.
 */

import { computeAccruedAt, computeAvailable } from "./accrual.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnalyticsStream {
  id: string;
  token: string;
  deposit: bigint;
  withdrawn: bigint;
  startTime: number;
  endTime: number;
  status: string;
  /** Human-readable token symbol (optional). */
  symbol?: string;
}

/** A single point in a time-series chart. */
export interface TimeSeriesPoint {
  /** Unix timestamp (seconds). */
  timestamp: number;
  /** Accrued amount at this timestamp (all-time, including withdrawn). */
  accrued: bigint;
  /** Claimed (withdrawn) amount at this timestamp. */
  claimed: bigint;
  /** Available (accrued - claimed) at this timestamp. */
  available: bigint;
}

/** Projection of a single stream to its end_time. */
export interface StreamProjection {
  streamId: string;
  token: string;
  symbol?: string;
  /** Total deposit remaining (deposit - withdrawn). */
  remaining: bigint;
  /** Seconds until stream ends (0 if ended). */
  secondsRemaining: number;
  /** Projected additional accrual from now to end_time. */
  projectedAccrual: bigint;
  /** Per-second rate (deposit / duration, floored). */
  ratePerSecond: bigint;
}

/** Aggregate income forecast for all active streams. */
export interface IncomeForecast {
  /** Forecast horizon in days. */
  horizonDays: number;
  /** Total projected additional accrual across all active streams. */
  totalProjected: bigint;
  /** Per-token breakdown. */
  byToken: Record<string, bigint>;
}

// ── Time-series builder ────────────────────────────────────────────────────────

/**
 * Generates a time-series for a stream over `[fromTime, toTime]` with
 * `pointCount` evenly-spaced sample points.
 *
 * Uses `computeAccruedAt` — the shared accrual oracle — so chart values
 * are bit-identical to the simulator and the contract's on-chain math.
 */
export function buildTimeSeries(
  stream: AnalyticsStream,
  fromTime: number,
  toTime: number,
  pointCount = 50
): TimeSeriesPoint[] {
  if (pointCount < 2) pointCount = 2;
  if (fromTime >= toTime) return [];

  const step = (toTime - fromTime) / (pointCount - 1);
  const points: TimeSeriesPoint[] = [];

  for (let i = 0; i < pointCount; i++) {
    const t = BigInt(Math.round(fromTime + i * step));
    const accrued = computeAccruedAt(
      stream.deposit,
      stream.startTime,
      stream.endTime,
      t
    );
    // Claimed is capped at accrued (can't claim more than has accrued).
    const claimed = stream.withdrawn < accrued ? stream.withdrawn : accrued;
    const available = accrued - claimed;
    points.push({ timestamp: Number(t), accrued, claimed, available });
  }

  return points;
}

// ── Per-stream projection ─────────────────────────────────────────────────────

/**
 * Computes how much will accrue from `now` until `endTime` for one stream.
 *
 * Returns a zero projection for ended, cancelled, or depleted streams.
 */
export function projectStream(
  stream: AnalyticsStream,
  nowSeconds: number
): StreamProjection {
  const now = BigInt(nowSeconds);
  const duration = stream.endTime - stream.startTime;

  const accruedNow = computeAccruedAt(stream.deposit, stream.startTime, stream.endTime, now);
  const accruedEnd = stream.deposit; // by definition: full deposit at end_time
  const projectedAccrual =
    stream.status !== "Active"
      ? 0n
      : accruedEnd - accruedNow;

  const secondsRemaining =
    stream.status !== "Active" ? 0 : Math.max(0, stream.endTime - nowSeconds);

  const ratePerSecond =
    duration > 0 && stream.status === "Active"
      ? stream.deposit / BigInt(duration)
      : 0n;

  return {
    streamId: stream.id,
    token: stream.token,
    symbol: stream.symbol,
    remaining: stream.deposit - stream.withdrawn,
    secondsRemaining,
    projectedAccrual,
    ratePerSecond,
  };
}

// ── Aggregate income forecast ─────────────────────────────────────────────────

/**
 * Forecasts total additional accrual across all active streams over
 * `horizonDays` days from `nowSeconds`.
 *
 * Uses the shared accrual oracle: for each stream, the additional accrual
 * by `min(now + horizon, endTime)` is `accrued_at(horizon_end) - accrued_now`.
 */
export function forecastIncome(
  streams: AnalyticsStream[],
  nowSeconds: number,
  horizonDays: number
): IncomeForecast {
  const horizonEnd = nowSeconds + horizonDays * 86_400;
  const now = BigInt(nowSeconds);
  const horizonBig = BigInt(horizonEnd);

  const byToken: Record<string, bigint> = {};
  let totalProjected = 0n;

  for (const stream of streams) {
    if (stream.status !== "Active") continue;

    const accruedNow = computeAccruedAt(
      stream.deposit, stream.startTime, stream.endTime, now
    );
    const accruedHorizon = computeAccruedAt(
      stream.deposit, stream.startTime, stream.endTime, horizonBig
    );
    const additional = accruedHorizon - accruedNow;
    if (additional <= 0n) continue;

    totalProjected += additional;
    byToken[stream.token] = (byToken[stream.token] ?? 0n) + additional;
  }

  return { horizonDays, totalProjected, byToken };
}

// ── Aggregation over multiple streams ────────────────────────────────────────

/**
 * Builds an aggregated time-series (portfolio view) across multiple streams
 * for the same token.
 *
 * The accrued/claimed/available values are the sum across all provided streams.
 * Streams with different tokens can be separated by the caller before passing.
 */
export function buildAggregatedTimeSeries(
  streams: AnalyticsStream[],
  fromTime: number,
  toTime: number,
  pointCount = 50
): TimeSeriesPoint[] {
  if (streams.length === 0) return [];
  if (pointCount < 2) pointCount = 2;
  if (fromTime >= toTime) return [];

  const step = (toTime - fromTime) / (pointCount - 1);
  const points: TimeSeriesPoint[] = [];

  for (let i = 0; i < pointCount; i++) {
    const t = BigInt(Math.round(fromTime + i * step));
    let totalAccrued = 0n;
    let totalClaimed = 0n;

    for (const stream of streams) {
      const accrued = computeAccruedAt(
        stream.deposit, stream.startTime, stream.endTime, t
      );
      const claimed = stream.withdrawn < accrued ? stream.withdrawn : accrued;
      totalAccrued += accrued;
      totalClaimed += claimed;
    }

    points.push({
      timestamp: Number(t),
      accrued: totalAccrued,
      claimed: totalClaimed,
      available: totalAccrued - totalClaimed,
    });
  }

  return points;
}

// ── Window helpers ────────────────────────────────────────────────────────────

/** Returns a `[fromTime, toTime]` window for a given number of days ending now. */
export function windowFromDays(
  nowSeconds: number,
  pastDays: number,
  futureDays = 0
): [number, number] {
  return [
    nowSeconds - pastDays * 86_400,
    nowSeconds + futureDays * 86_400,
  ];
}

/**
 * Chooses a sensible default window for a stream:
 * starts at `stream.startTime`, ends at `stream.endTime` (capped to
 * `now + 30 days` to keep charts readable for long-duration streams).
 */
export function defaultStreamWindow(
  stream: AnalyticsStream,
  nowSeconds: number
): [number, number] {
  const from = stream.startTime;
  const to = Math.min(stream.endTime, nowSeconds + 30 * 86_400);
  return [from, Math.max(to, from + 1)];
}

// ── Staleness note ────────────────────────────────────────────────────────────

/** Data source note for the PR description requirement. */
export const DATA_SOURCE_NOTE =
  "Analytics data is reconstructed from on-chain stream state via " +
  "direct contract reads (get_stream / available) with explicit staleness " +
  "handling. An indexer history endpoint (issue #2) will be used when available.";
