/**
 * Per-stream projection table showing remaining balance, time-to-end,
 * and projected future accrual.
 *
 * Lazy-loaded — zero bundle impact on other routes.
 */
"use client";

import React from "react";
import { projectStream, type AnalyticsStream } from "../../lib/analytics";

interface Props {
  streams: AnalyticsStream[];
  nowSeconds: number;
}

function fmtAmount(n: bigint): string {
  if (n >= 1_000_000n) return `${(Number(n) / 1_000_000).toFixed(4)}M`;
  if (n >= 1_000n) return `${(Number(n) / 1_000).toFixed(2)}k`;
  return n.toString();
}

function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export default function StreamProjectionTable({ streams, nowSeconds }: Props) {
  const projections = streams
    .map((s) => ({ ...projectStream(s, nowSeconds), token: s.token, id: s.id }))
    .sort((a, b) => (b.projectedAccrual > a.projectedAccrual ? 1 : -1));

  if (projections.length === 0) {
    return <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>No active streams.</p>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
        aria-label="Stream projections"
      >
        <thead>
          <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
            <th style={thStyle}>Stream ID</th>
            <th style={thStyle}>Token</th>
            <th style={thStyle}>Remaining</th>
            <th style={thStyle}>Time left</th>
            <th style={thStyle}>Rate / s</th>
            <th style={thStyle}>Projected accrual</th>
          </tr>
        </thead>
        <tbody>
          {projections.map((p) => (
            <tr key={p.streamId} style={{ borderBottom: "1px solid #f3f4f6" }}>
              <td style={tdStyle}>
                <a href={`/stream/${p.streamId}`} style={{ color: "#2563eb" }}>
                  #{p.streamId}
                </a>
              </td>
              <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8rem" }}>
                {p.token.slice(0, 8)}…
              </td>
              <td style={tdStyle}>{fmtAmount(p.remaining)}</td>
              <td style={tdStyle}>{fmtDuration(p.secondsRemaining)}</td>
              <td style={tdStyle}>{fmtAmount(p.ratePerSecond)}</td>
              <td style={{ ...tdStyle, fontWeight: 600, color: "#0369a1" }}>
                {fmtAmount(p.projectedAccrual)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontWeight: 600,
  color: "#374151",
  fontSize: "0.8rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  color: "#374151",
};
