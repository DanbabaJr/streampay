/**
 * Pure SVG time-series chart — no third-party charting library.
 *
 * Renders accrued (blue) and claimed (green) lines over time. The gap between
 * them is the available (unclaimed) balance, filled with a light blue area.
 *
 * Bundle impact: zero — this component is only loaded on the /analytics route
 * via React.lazy. No external charting package is imported.
 */
"use client";

import React, { useMemo } from "react";
import type { TimeSeriesPoint } from "../../lib/analytics";

interface Props {
  points: TimeSeriesPoint[];
  title?: string;
  /** Chart width in pixels (default 800). */
  width?: number;
  /** Chart height in pixels (default 200). */
  height?: number;
}

const PAD = { top: 16, right: 16, bottom: 32, left: 56 };

function formatAmount(n: bigint): string {
  if (n >= 1_000_000n) return `${(Number(n) / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000n) return `${(Number(n) / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatDate(ts: number): string {
  return new Date(ts * 1_000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function TimeSeriesChart({ points, title, width = 760, height = 200 }: Props) {
  const { accruedPath, claimedPath, availableArea, yLabels, xLabels, maxVal } =
    useMemo(() => {
      if (points.length < 2) return { accruedPath: "", claimedPath: "", availableArea: "", yLabels: [], xLabels: [], maxVal: 1n };

      const innerW = width - PAD.left - PAD.right;
      const innerH = height - PAD.top - PAD.bottom;

      const maxAccrued = points.reduce((m, p) => (p.accrued > m ? p.accrued : m), 0n);
      const maxVal = maxAccrued > 0n ? maxAccrued : 1n;

      const ts0 = points[0].timestamp;
      const ts1 = points[points.length - 1].timestamp;
      const tsRange = ts1 - ts0 || 1;

      const px = (ts: number) => PAD.left + ((ts - ts0) / tsRange) * innerW;
      const py = (v: bigint) => PAD.top + innerH - (Number(v) / Number(maxVal)) * innerH;

      const pathFor = (getter: (p: TimeSeriesPoint) => bigint) =>
        points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.timestamp).toFixed(1)},${py(getter(p)).toFixed(1)}`).join(" ");

      const accruedPath = pathFor((p) => p.accrued);
      const claimedPath = pathFor((p) => p.claimed);

      // Available area: polygon from claimed up to accrued and back.
      const top = points.map((p) => `${px(p.timestamp).toFixed(1)},${py(p.accrued).toFixed(1)}`).join(" ");
      const bottom = [...points].reverse().map((p) => `${px(p.timestamp).toFixed(1)},${py(p.claimed).toFixed(1)}`).join(" ");
      const availableArea = `${top} ${bottom}`;

      // Y-axis labels (3 ticks).
      const yLabels = [0, 50, 100].map((pct) => {
        const v = (BigInt(pct) * maxVal) / 100n;
        const y = py(v);
        return { y, label: formatAmount(v) };
      });

      // X-axis labels (4 ticks).
      const xStep = Math.floor(points.length / 3);
      const xLabels = [0, xStep, xStep * 2, points.length - 1].map((i) => {
        const p = points[Math.min(i, points.length - 1)];
        return { x: px(p.timestamp), label: formatDate(p.timestamp) };
      });

      return { accruedPath, claimedPath, availableArea, yLabels, xLabels, maxVal };
    }, [points, width, height]);

  if (points.length < 2) {
    return (
      <div style={{ padding: "1rem", color: "#6b7280", fontSize: "0.875rem" }}>
        Not enough data to render chart.
      </div>
    );
  }

  return (
    <figure style={{ margin: 0 }} aria-label={title ?? "Stream time-series chart"}>
      {title && (
        <figcaption style={{ fontSize: "0.875rem", color: "#374151", marginBottom: 4 }}>
          {title}
        </figcaption>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={title ?? "Stream time-series chart"}
        style={{ maxWidth: "100%", display: "block" }}
      >
        {/* Y-axis lines */}
        {yLabels.map(({ y, label }) => (
          <g key={label}>
            <line
              x1={PAD.left}
              y1={y}
              x2={width - PAD.right}
              y2={y}
              stroke="#e5e7eb"
              strokeDasharray="4 4"
            />
            <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize={10} fill="#9ca3af">
              {label}
            </text>
          </g>
        ))}

        {/* Available area fill */}
        <polygon points={availableArea} fill="#bfdbfe" fillOpacity={0.4} />

        {/* Accrued line */}
        <path d={accruedPath} fill="none" stroke="#2563eb" strokeWidth={2} />

        {/* Claimed line */}
        <path d={claimedPath} fill="none" stroke="#16a34a" strokeWidth={2} />

        {/* X-axis labels */}
        {xLabels.map(({ x, label }) => (
          <text key={label} x={x} y={height - 4} textAnchor="middle" fontSize={10} fill="#9ca3af">
            {label}
          </text>
        ))}

        {/* Legend */}
        <g transform={`translate(${PAD.left}, ${PAD.top})`}>
          <rect x={0} y={0} width={10} height={10} fill="#2563eb" rx={2} />
          <text x={14} y={9} fontSize={10} fill="#374151">Accrued</text>
          <rect x={70} y={0} width={10} height={10} fill="#16a34a" rx={2} />
          <text x={84} y={9} fontSize={10} fill="#374151">Claimed</text>
          <rect x={140} y={0} width={10} height={10} fill="#bfdbfe" rx={2} />
          <text x={154} y={9} fontSize={10} fill="#374151">Available</text>
        </g>
      </svg>
    </figure>
  );
}
