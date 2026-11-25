// Redaction at the boundary. The client (before sending) and the ingest
// endpoint (before storing) both run payloads through sanitizePayload, which
// builds a NEW object from an allowlist: unknown fields are dropped, never
// passed through. Routes are templated: stream ids, addresses and any unknown
// path collapse to a template or "other". Query strings and hashes are never kept.
import { METRIC_NAMES, type MetricName } from "./config";

export interface RumPayload {
  route: string;
  metric: MetricName;
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  nav?: "navigate" | "reload" | "back-forward" | "prerender" | "other";
}

const KNOWN_ROUTES = ["/", "/rum"] as const;
const RATINGS = ["good", "needs-improvement", "poor"] as const;
const NAVS = ["navigate", "reload", "back-forward", "prerender"] as const;
// Upper bounds reject garbage or hostile values. LCP/INP in ms.
const MAX_VALUE: Record<MetricName, number> = { LCP: 120_000, INP: 60_000, CLS: 50 };

export function normalizeRoute(input: unknown): string {
  if (typeof input !== "string") return "other";
  const path = input.split(/[?#]/)[0];
  if ((KNOWN_ROUTES as readonly string[]).includes(path)) return path;
  if (/^\/stream\/[^/]+\/?$/.test(path)) return "/stream/[id]";
  return "other";
}

export function sanitizePayload(raw: unknown): RumPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const metric = r.metric;
  if (typeof metric !== "string" || !(METRIC_NAMES as readonly string[]).includes(metric)) {
    return null;
  }
  const m = metric as MetricName;
  const value = r.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[m]) {
    return null;
  }
  const out: RumPayload = { route: normalizeRoute(r.route), metric: m, value };
  if (typeof r.rating === "string" && (RATINGS as readonly string[]).includes(r.rating)) {
    out.rating = r.rating as RumPayload["rating"];
  }
  out.nav =
    typeof r.nav === "string" && (NAVS as readonly string[]).includes(r.nav)
      ? (r.nav as RumPayload["nav"])
      : "other";
  return out;
}
