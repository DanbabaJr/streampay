/**
 * Soroban RPC fee statistics — parsing and percentile selection.
 *
 * `getFeeStats` returns two inclusion-fee distributions: one for Soroban
 * (smart-contract) transactions, one for classic Stellar transactions
 * (normalized per operation). Each reports `min` / `mode` / `max` and the
 * p10–p99 nearest-rank percentiles, **in stroops**, over the last
 * `ledgerCount` ledgers.
 *
 * Reference:
 * https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getFeeStats
 *
 * This module is pure — no SDK import, no I/O — so the scheduler and its
 * simulation tests run anywhere. `fee-observer.ts` performs the RPC call.
 */

/** Every fee statistic `getFeeStats` reports for a distribution. */
export type FeePercentileKey =
  | "min"
  | "mode"
  | "max"
  | "p10"
  | "p20"
  | "p30"
  | "p40"
  | "p50"
  | "p60"
  | "p70"
  | "p80"
  | "p90"
  | "p95"
  | "p99";

/** Ordered low → high, so UI controls can render a natural picker. */
export const FEE_PERCENTILE_KEYS: readonly FeePercentileKey[] = [
  "min",
  "p10",
  "p20",
  "p30",
  "p40",
  "p50",
  "p60",
  "p70",
  "p80",
  "p90",
  "p95",
  "p99",
  "mode",
  "max",
];

/** Short human labels for the settings UI. */
export const FEE_PERCENTILE_LABELS: Record<FeePercentileKey, string> = {
  min: "min",
  p10: "p10",
  p20: "p20",
  p30: "p30",
  p40: "p40",
  p50: "p50 (median)",
  p60: "p60",
  p70: "p70",
  p80: "p80",
  p90: "p90",
  p95: "p95",
  p99: "p99",
  mode: "mode (most common)",
  max: "max",
};

/** One inclusion-fee distribution, all values in stroops. */
export interface FeePercentiles {
  min: number;
  mode: number;
  max: number;
  p10: number;
  p20: number;
  p30: number;
  p40: number;
  p50: number;
  p60: number;
  p70: number;
  p80: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * A single observation of network fees, ready for the scheduler.
 *
 * `observedAt` is the client wall clock in milliseconds; the scheduler works
 * in unix seconds and derives them from this. Keeping the two clocks on the
 * same snapshot makes replays and tests deterministic.
 */
export interface FeeSnapshot {
  /** Latest ledger the RPC had seen when the snapshot was taken. */
  ledger: number;
  /** Client wall-clock (ms) at observation time. */
  observedAt: number;
  /** Inclusion fees for Soroban transactions, stroops per transaction. */
  soroban: FeePercentiles;
  /** Inclusion fees for classic transactions, stroops per operation. */
  classic: FeePercentiles;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parses one `FeeDistribution` object, or `null` if any field is missing. */
export function parseFeePercentiles(raw: unknown): FeePercentiles | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out = {} as FeePercentiles;
  for (const key of FEE_PERCENTILE_KEYS) {
    const n = num(r[key]);
    if (n === null) return null;
    out[key] = n;
  }
  return out;
}

/**
 * Parses a raw `getFeeStats` result into a {@link FeeSnapshot}. Returns
 * `null` — rather than throwing — when the payload is not the expected shape,
 * so a single odd RPC response never breaks the scheduler loop.
 */
export function parseFeeStats(raw: unknown, observedAt: number): FeeSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const soroban = parseFeePercentiles(r.sorobanInclusionFee);
  const classic = parseFeePercentiles(r.inclusionFee);
  if (!soroban || !classic) return null;
  return {
    ledger: num(r.latestLedger) ?? 0,
    observedAt,
    soroban,
    classic,
  };
}

/** Reads one percentile out of a distribution. */
export function feeAt(fees: FeePercentiles, key: FeePercentileKey): number {
  return fees[key];
}
