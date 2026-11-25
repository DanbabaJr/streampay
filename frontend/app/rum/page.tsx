"use client";

import { useEffect, useState } from "react";
import type { RouteSummary } from "@/lib/rum/sink";

// Observability panel: real-user percentiles per route against budgets.
export default function RumDashboard() {
  const [rows, setRows] = useState<RouteSummary[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/rum")
      .then((r) => r.json())
      .then((d: { enabled: boolean; summary: RouteSummary[] }) => {
        setRows(d.summary);
        setEnabled(d.enabled);
      })
      .catch(() => setErr("Could not load field data."));
  }, []);

  const fmt = (metric: string, v: number) =>
    metric === "CLS" ? v.toFixed(3) : `${Math.round(v)} ms`;

  return (
    <main>
      <h1>Real-user performance</h1>
      {!enabled && <p>Collection is disabled (kill switch on).</p>}
      {err && <p role="alert">{err}</p>}
      <table>
        <thead>
          <tr>
            <th>Route</th><th>Metric</th><th>Samples</th><th>p50</th><th>p75</th><th>p95</th>
            <th>Budget (p75)</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={8}>No field data yet.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.route}-${r.metric}`}>
              <td>{r.route}</td><td>{r.metric}</td><td>{r.count}</td>
              <td>{fmt(r.metric, r.p50)}</td><td>{fmt(r.metric, r.p75)}</td>
              <td>{fmt(r.metric, r.p95)}</td><td>{fmt(r.metric, r.budget)}</td>
              <td>{r.overBudget ? "over budget" : "ok"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
