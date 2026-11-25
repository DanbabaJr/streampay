/**
 * Aggregate income forecast summary card.
 *
 * Shows 30-day and 90-day projected accrual across all active streams,
 * with per-token breakdown.
 *
 * Lazy-loaded — zero bundle impact on other routes.
 */
"use client";

import React from "react";
import type { IncomeForecast } from "../../lib/analytics";

interface Props {
  forecast30: IncomeForecast;
  forecast90: IncomeForecast;
}

function fmtAmount(n: bigint): string {
  if (n >= 1_000_000n) return `${(Number(n) / 1_000_000).toFixed(4)}M`;
  if (n >= 1_000n) return `${(Number(n) / 1_000).toFixed(2)}k`;
  return n.toString();
}

export default function ForecastSummary({ forecast30, forecast90 }: Props) {
  const tokens30 = Object.entries(forecast30.byToken);

  return (
    <section
      aria-label="Income forecast"
      style={{
        background: "#f0f9ff",
        border: "1px solid #bae6fd",
        borderRadius: 8,
        padding: "1rem 1.25rem",
        marginBottom: "1rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", color: "#0369a1" }}>
        Income Forecast
      </h2>

      <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: 2 }}>Next 30 days</div>
          <div style={{ fontSize: "1.4rem", fontWeight: 700, color: "#0369a1" }}>
            {fmtAmount(forecast30.totalProjected)}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>stroops</div>
        </div>
        <div>
          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: 2 }}>Next 90 days</div>
          <div style={{ fontSize: "1.4rem", fontWeight: 700, color: "#0369a1" }}>
            {fmtAmount(forecast90.totalProjected)}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>stroops</div>
        </div>
      </div>

      {tokens30.length > 1 && (
        <div style={{ marginTop: "0.75rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: 4 }}>
            30-day by token:
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {tokens30.map(([token, amount]) => (
              <li
                key={token}
                style={{
                  background: "#e0f2fe",
                  borderRadius: 4,
                  padding: "2px 8px",
                  fontSize: "0.8rem",
                  color: "#0c4a6e",
                  fontFamily: "monospace",
                }}
              >
                {token.slice(0, 8)}…: {fmtAmount(amount)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
