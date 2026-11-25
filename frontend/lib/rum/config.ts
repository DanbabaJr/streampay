// RUM runtime configuration and per-route field budgets (all non-sensitive).
import budgets from "../../rum/budgets.json";

export type MetricName = "LCP" | "INP" | "CLS";
export const METRIC_NAMES: readonly MetricName[] = ["LCP", "INP", "CLS"];

export interface FieldBudget {
  lcp: number;
  inp: number;
  cls: number;
}

// Fraction of sessions that report (0..1). Decided once per page load.
export const DEFAULT_SAMPLE_RATE = 0.1;
// Max beacons a single page load may send.
export const MAX_BEACONS_PER_PAGE = 20;
// Ingest-side limit per client key per window.
export const INGEST_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;
export const INGEST_ENDPOINT = "/api/rum";
// Cap on stored samples per (route, metric) in the in-memory sink.
export const MAX_SAMPLES_PER_SERIES = 1000;

export function sampleRateFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SAMPLE_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SAMPLE_RATE;
  return Math.min(1, Math.max(0, n));
}

// Server-side kill switch. "1", "true" or "on" disables collection.
export function killSwitchOn(raw: string | undefined): boolean {
  return ["1", "true", "on"].includes((raw ?? "").trim().toLowerCase());
}

export function fieldBudgetFor(route: string): FieldBudget {
  const table = budgets.field as unknown as Record<string, FieldBudget>;
  return table[route] ?? table.default;
}
