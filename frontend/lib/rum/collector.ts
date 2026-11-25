// Consent-gated, sampled Core Web Vitals collector. Dependencies are injected
// so every gate is unit-testable without a browser.
import { MAX_BEACONS_PER_PAGE, type MetricName } from "./config";
import { normalizeRoute, sanitizePayload, type RumPayload } from "./redact";

export interface MetricInput {
  name: string;
  value: number;
  rating?: string;
  navigationType?: string;
}

export interface CollectorDeps {
  hasConsent: () => boolean;
  isKilled: () => boolean;
  send: (payload: RumPayload) => void;
  sampleRate: number;
  random?: () => number;
  getRoute: () => string;
  maxBeacons?: number;
}

export function createCollector(deps: CollectorDeps) {
  const random = deps.random ?? Math.random;
  const max = deps.maxBeacons ?? MAX_BEACONS_PER_PAGE;
  // Sampling is decided once per page load: a session is all-in or all-out.
  const sampled = random() < deps.sampleRate;
  let sent = 0;

  return {
    sampled,
    report(metric: MetricInput): boolean {
      // Gates are re-checked on every report so opt-out and the kill switch
      // apply immediately, not just at startup.
      if (!deps.hasConsent()) return false;
      if (deps.isKilled()) return false;
      if (!sampled) return false;
      if (sent >= max) return false;
      const payload = sanitizePayload({
        route: normalizeRoute(deps.getRoute()),
        metric: metric.name as MetricName,
        value: metric.value,
        rating: metric.rating,
        nav: metric.navigationType,
      });
      if (!payload) return false;
      sent += 1;
      deps.send(payload);
      return true;
    },
  };
}
