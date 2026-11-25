"use client";
// Browser wiring: web-vitals -> collector -> sendBeacon. Imported lazily.
import { onCLS, onINP, onLCP } from "web-vitals";
import { createCollector } from "./collector";
import { hasConsent } from "./consent";
import { INGEST_ENDPOINT, sampleRateFromEnv } from "./config";
import type { RumPayload } from "./redact";

let started = false;
// Remote kill switch: the ingest endpoint answers 410 when disabled; the
// client then stops for the rest of the page load.
let killed = false;

function send(payload: RumPayload): void {
  const body = JSON.stringify(payload);
  try {
    void fetch(INGEST_ENDPOINT, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
      credentials: "omit",
    }).then((res) => {
      if (res.status === 410) killed = true;
    });
  } catch {
    // telemetry must never break the app
  }
}

// Starts collection once. Safe to call repeatedly. Does nothing without consent.
export function startRum(getRoute: () => string = () => window.location.pathname): void {
  if (started || typeof window === "undefined") return;
  if (!hasConsent()) return;
  started = true;
  const collector = createCollector({
    hasConsent: () => hasConsent(),
    isKilled: () => killed,
    send,
    sampleRate: sampleRateFromEnv(process.env.NEXT_PUBLIC_RUM_SAMPLE_RATE),
    getRoute,
  });
  const handler = (m: Parameters<typeof collector.report>[0]) => void collector.report(m);
  onLCP(handler);
  onINP(handler);
  onCLS(handler);
}
