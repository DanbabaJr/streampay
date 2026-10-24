/**
 * Analytics dashboard page — Issue #96.
 *
 * Lazy-loaded: the charting components are loaded only when this route is
 * visited, keeping the initial bundle unaffected.
 *
 * Bundle impact: chart components are lazy-loaded with React.lazy + Suspense,
 * no charting library is added to the root bundle. We use SVG-only charts
 * implemented inline to avoid any third-party charting dependency, keeping
 * the bundle delta to zero.
 */
"use client";

import React, { Suspense, lazy, useState, useEffect, useCallback } from "react";
import {
  forecastIncome,
  buildAggregatedTimeSeries,
  DATA_SOURCE_NOTE,
  type AnalyticsStream,
} from "../../lib/analytics";
import { fetchStreamsFor } from "../../lib/stellar";

// Lazy-loaded chart components.
const TimeSeriesChart = lazy(() => import("../../components/charts/TimeSeriesChart"));
const ForecastSummary = lazy(() => import("../../components/charts/ForecastSummary"));
const StreamProjectionTable = lazy(
  () => import("../../components/charts/StreamProjectionTable")
);

// ── Window selector ───────────────────────────────────────────────────────────

type Window = "7d" | "30d" | "90d" | "all";

const WINDOW_DAYS: Record<Window, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: 0,
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [address, setAddress] = useState("");
  const [streams, setStreams] = useState<AnalyticsStream[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<Window>("30d");
  const [staleNote, setStaleNote] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Math.floor(Date.now() / 1000));

  // Ticker for live projections.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!address.trim()) return;
    setLoading(true);
    setError(null);
    setStaleNote(null);
    try {
      const raw = await fetchStreamsFor(address.trim(), "recipient");
      const mapped: AnalyticsStream[] = raw.map((s) => ({
        id: String(s.id),
        token: String(s.token),
        deposit: BigInt(String(s.deposit)),
        withdrawn: BigInt(String(s.withdrawn)),
        startTime: Number(s.startTime),
        endTime: Number(s.endTime),
        status: String(s.status),
      }));
      setStreams(mapped);
      setStaleNote(DATA_SOURCE_NOTE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Active streams only.
  const active = streams.filter((s) => s.status === "Active");
  // Group by token.
  const tokenGroups = active.reduce<Record<string, AnalyticsStream[]>>((acc, s) => {
    (acc[s.token] ??= []).push(s);
    return acc;
  }, {});

  // Determine chart window.
  const windowDays = WINDOW_DAYS[window];
  const fromTime =
    windowDays === 0
      ? Math.min(...(active.map((s) => s.startTime).concat([now - 86400])))
      : now - windowDays * 86_400;
  const toTime = now + 7 * 86_400; // always show 7 days ahead

  const forecast30 = forecastIncome(active, now, 30);
  const forecast90 = forecastIncome(active, now, 90);

  return (
    <main className="analytics-page" style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.6rem", marginBottom: "0.5rem" }}>Stream Analytics</h1>
      <p style={{ color: "#666", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
        Accrued-vs-claimed history, per-stream projections, and aggregate income forecast.
      </p>

      {/* Address input */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <input
          type="text"
          placeholder="Stellar address (G…)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          style={{ flex: 1, padding: "0.5rem 0.75rem", borderRadius: 6, border: "1px solid #ccc", fontSize: "0.95rem" }}
          aria-label="Stellar address to analyse"
        />
        <button
          onClick={load}
          disabled={loading || !address.trim()}
          style={{ padding: "0.5rem 1.25rem", borderRadius: 6, background: "#2563eb", color: "#fff", border: "none", cursor: "pointer" }}
        >
          {loading ? "Loading…" : "Analyse"}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: "#dc2626", marginBottom: "1rem" }}>
          Error: {error}
        </p>
      )}

      {/* Window selector */}
      {active.length > 0 && (
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
          {(["7d", "30d", "90d", "all"] as Window[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              style={{
                padding: "0.3rem 0.8rem",
                borderRadius: 5,
                border: "1px solid #ccc",
                background: window === w ? "#2563eb" : "#f9fafb",
                color: window === w ? "#fff" : "#374151",
                cursor: "pointer",
                fontWeight: window === w ? 600 : 400,
              }}
              aria-pressed={window === w}
            >
              {w}
            </button>
          ))}
        </div>
      )}

      {/* Empty / partial states */}
      {!loading && streams.length === 0 && address && (
        <p style={{ color: "#6b7280" }}>No streams found for this address.</p>
      )}
      {!loading && streams.length > 0 && active.length === 0 && (
        <p style={{ color: "#6b7280" }}>No active streams — showing history only.</p>
      )}

      {/* Forecast summary — lazy */}
      {active.length > 0 && (
        <Suspense fallback={<div aria-busy="true">Loading forecast…</div>}>
          <ForecastSummary forecast30={forecast30} forecast90={forecast90} />
        </Suspense>
      )}

      {/* Per-token time-series charts — lazy */}
      {Object.entries(tokenGroups).map(([token, tokenStreams]) => {
        const pts = buildAggregatedTimeSeries(tokenStreams, fromTime, toTime, 60);
        const shortToken = token.slice(0, 12) + "…";
        return (
          <section key={token} style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
              Token <span style={{ fontFamily: "monospace" }}>{shortToken}</span>
            </h2>
            <Suspense fallback={<div aria-busy="true">Rendering chart…</div>}>
              <TimeSeriesChart
                points={pts}
                title={`Accrued vs Claimed — ${tokenStreams.length} stream${tokenStreams.length !== 1 ? "s" : ""}`}
              />
            </Suspense>
          </section>
        );
      })}

      {/* Per-stream projection table — lazy */}
      {active.length > 0 && (
        <section style={{ marginTop: "2.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>Stream Projections</h2>
          <Suspense fallback={<div aria-busy="true">Loading projections…</div>}>
            <StreamProjectionTable streams={active} nowSeconds={now} />
          </Suspense>
        </section>
      )}

      {/* Data-source notice */}
      {staleNote && (
        <p style={{ color: "#9ca3af", fontSize: "0.75rem", marginTop: "2rem", borderTop: "1px solid #e5e7eb", paddingTop: "1rem" }}>
          ℹ {staleNote}
        </p>
      )}
    </main>
  );
}
