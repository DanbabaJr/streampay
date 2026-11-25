// Ingest-side logic: rate limit, store, percentile aggregation. In-memory and
// bounded; swap for a real store in production. Samples carry no identifiers
// (no IP, no user agent, no session id).
import { INGEST_RATE_LIMIT, MAX_SAMPLES_PER_SERIES, METRIC_NAMES, fieldBudgetFor } from "./config";
import type { MetricName } from "./config";
import type { RumPayload } from "./redact";

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private max: number = INGEST_RATE_LIMIT.max,
    private windowMs: number = INGEST_RATE_LIMIT.windowMs,
    private maxKeys = 5000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now >= h.reset) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      if (this.hits.size >= this.maxKeys) return false; // fail closed under flood
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    if (h.count >= this.max) return false;
    h.count += 1;
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
  }
}

export interface RouteSummary {
  route: string;
  metric: MetricName;
  count: number;
  p50: number;
  p75: number;
  p95: number;
  budget: number;
  overBudget: boolean;
}

export class Sink {
  private series = new Map<string, number[]>();

  add(p: RumPayload): void {
    const key = `${p.route}\u0000${p.metric}`;
    const arr = this.series.get(key) ?? [];
    arr.push(p.value);
    if (arr.length > MAX_SAMPLES_PER_SERIES) arr.shift();
    this.series.set(key, arr);
  }

  summary(): RouteSummary[] {
    const out: RouteSummary[] = [];
    for (const [key, values] of this.series) {
      const [route, metric] = key.split("\u0000") as [string, MetricName];
      const sorted = [...values].sort((a, b) => a - b);
      const budget = fieldBudgetFor(route)[metric.toLowerCase() as "lcp" | "inp" | "cls"];
      const p75 = percentile(sorted, 75);
      out.push({
        route,
        metric,
        count: sorted.length,
        p50: percentile(sorted, 50),
        p75,
        p95: percentile(sorted, 95),
        budget,
        overBudget: p75 > budget,
      });
    }
    return out.sort(
      (a, b) =>
        a.route.localeCompare(b.route) ||
        METRIC_NAMES.indexOf(a.metric) - METRIC_NAMES.indexOf(b.metric),
    );
  }
}

export const sink = new Sink();
export const limiter = new RateLimiter();
