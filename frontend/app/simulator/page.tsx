"use client";

import { useState, useId } from "react";
import Link from "next/link";
import { streamedAt, computeVestingAccrual } from "@/lib/oracle";

interface SegmentInput {
  duration: number;
  percent: number; // 0 to 100
}

export default function SimulatorPage() {
  const [totalDeposit, setTotalDeposit] = useState<number>(10000);
  const [totalDuration, setTotalDuration] = useState<number>(3600); // 1 hour in seconds
  const [cliffDuration, setCliffDuration] = useState<number>(600); // 10 minutes
  const [cliffPercent, setCliffPercent] = useState<number>(20); // 20%
  const [timeCursor, setTimeCursor] = useState<number>(1800); // 30 minutes
  const [useSegments, setUseSegments] = useState<boolean>(false);
  const [segments, setSegments] = useState<SegmentInput[]>([
    { duration: 1800, percent: 40 },
    { duration: 1800, percent: 60 },
  ]);

  // Stable IDs for all form associations (WCAG 1.3.1 / 4.1.2)
  const uid = useId();
  const depositId = `${uid}-deposit`;
  const durationId = `${uid}-duration`;
  const useSegmentsId = `${uid}-use-segments`;
  const cliffDurId = `${uid}-cliff-dur`;
  const cliffPctId = `${uid}-cliff-pct`;
  const scrubberId = `${uid}-scrubber`;
  const paramsHeadingId = `${uid}-params`;
  const scrubberHeadingId = `${uid}-scrubber-heading`;
  const chartHeadingId = `${uid}-chart-heading`;
  const chartTitleId = `${uid}-chart-title`;
  const chartDescId = `${uid}-chart-desc`;
  const vestingLabelId = `${uid}-vesting-label`;
  const linearLabelId = `${uid}-linear-label`;

  const depositBig = BigInt(Math.max(0, Math.floor(totalDeposit)));
  const durationBig = BigInt(Math.max(1, Math.floor(totalDuration)));
  const cliffDurBig = BigInt(Math.max(0, Math.min(totalDuration, Math.floor(cliffDuration))));
  const cliffAmountBig = (depositBig * BigInt(Math.max(0, Math.min(100, cliffPercent)))) / 100n;
  const cursorBig = BigInt(Math.max(0, Math.min(totalDuration, Math.floor(timeCursor))));

  const accrualParams = {
    deposit: depositBig,
    duration: durationBig,
    cliffDuration: cliffDurBig,
    cliffAmount: cliffAmountBig,
    segments: useSegments
      ? segments.map((s) => ({
          duration: BigInt(Math.max(1, Math.floor(s.duration))),
          percentBps: BigInt(Math.max(0, Math.floor(s.percent * 100))),
        }))
      : undefined,
  };

  const pureContractAccrued = streamedAt(depositBig, durationBig, cursorBig);
  const scheduleAccrued = computeVestingAccrual(accrualParams, cursorBig);

  const steps = 100;
  const chartPoints = Array.from({ length: steps + 1 }, (_, i) => {
    const t = (BigInt(i) * durationBig) / BigInt(steps);
    const accrued = computeVestingAccrual(accrualParams, t);
    return {
      t: Number(t),
      accrued: Number(accrued),
      pureAccrued: Number(streamedAt(depositBig, durationBig, t)),
    };
  });

  const svgWidth = 600;
  const svgHeight = 240;
  const padding = 40;
  const plotWidth = svgWidth - padding * 2;
  const plotHeight = svgHeight - padding * 2;

  const maxVal = Math.max(1, totalDeposit);
  const maxT = Math.max(1, totalDuration);

  const getX = (t: number) => padding + (t / maxT) * plotWidth;
  const getY = (val: number) => svgHeight - padding - (val / maxVal) * plotHeight;

  const schedulePath = chartPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(p.t).toFixed(1)} ${getY(p.accrued).toFixed(1)}`)
    .join(" ");

  const contractPath = chartPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(p.t).toFixed(1)} ${getY(p.pureAccrued).toFixed(1)}`)
    .join(" ");

  const cursorX = getX(timeCursor);
  const cursorY = getY(Number(scheduleAccrued));

  const schedPct = totalDeposit > 0
    ? ((Number(scheduleAccrued) / totalDeposit) * 100).toFixed(2)
    : "0.00";

  return (
    <main className="wrap">
      <div style={{ marginBottom: "16px" }}>
        <Link href="/" style={{ color: "var(--accent2)", textDecoration: "none", fontSize: "14px" }}>
          ← Back to StreamPay
        </Link>
      </div>

      <div className="kicker mono" style={{ letterSpacing: "0.15em", color: "var(--accent2)" }}>
        INTERACTIVE TS ORACLE PLAYGROUND
      </div>
      <h1>Accrual &amp; Vesting Simulator</h1>
      <p className="muted">
        Pure client-side accrual oracle and vesting schedule playground. Drag
        parameters to model streamed_at rates, cliffs, and multi-segment
        milestones with instant curve visualization.
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* Schedule Parameters                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section className="card" aria-labelledby={paramsHeadingId}>
        <h2 id={paramsHeadingId}>Schedule Parameters</h2>
        <div className="row">
          <div>
            <label htmlFor={depositId}>
              Total Deposit (tokens): {totalDeposit.toLocaleString()}
            </label>
            <input
              id={depositId}
              type="range"
              min="100"
              max="1000000"
              step="100"
              value={totalDeposit}
              onChange={(e) => setTotalDeposit(Number(e.target.value))}
              aria-valuemin={100}
              aria-valuemax={1000000}
              aria-valuenow={totalDeposit}
            />
          </div>
          <div>
            <label htmlFor={durationId}>
              Total Duration (seconds): {totalDuration}s ({Math.round(totalDuration / 60)}m)
            </label>
            <input
              id={durationId}
              type="range"
              min="60"
              max="86400"
              step="60"
              value={totalDuration}
              onChange={(e) => {
                const val = Number(e.target.value);
                setTotalDuration(val);
                if (cliffDuration > val) setCliffDuration(val);
                if (timeCursor > val) setTimeCursor(val);
              }}
              aria-valuemin={60}
              aria-valuemax={86400}
              aria-valuenow={totalDuration}
            />
          </div>
        </div>

        {/*
         * The checkbox is wrapped in a <label> which means the <span>
         * inside also acts as a label — this is the correct HTML pattern.
         * The htmlFor approach would also work; the wrapping label is
         * preferred here since the existing design uses inline text.
         */}
        <div style={{ marginTop: "16px", display: "flex", gap: "12px", alignItems: "center" }}>
          <label
            style={{ margin: 0, display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
          >
            <input
              id={useSegmentsId}
              type="checkbox"
              checked={useSegments}
              onChange={(e) => setUseSegments(e.target.checked)}
            />
            <span>Enable Multi-Segment Milestones</span>
          </label>
        </div>

        {!useSegments ? (
          <div className="row" style={{ marginTop: "12px" }}>
            <div>
              <label htmlFor={cliffDurId}>
                Cliff Duration (seconds): {cliffDuration}s ({Math.round(cliffDuration / 60)}m)
              </label>
              <input
                id={cliffDurId}
                type="range"
                min="0"
                max={totalDuration}
                step="30"
                value={cliffDuration}
                onChange={(e) => setCliffDuration(Number(e.target.value))}
                aria-valuemin={0}
                aria-valuemax={totalDuration}
                aria-valuenow={cliffDuration}
              />
            </div>
            <div>
              <label htmlFor={cliffPctId}>
                Cliff Unlock: {cliffPercent}% ({cliffAmountBig.toString()} tokens)
              </label>
              <input
                id={cliffPctId}
                type="range"
                min="0"
                max="100"
                step="5"
                value={cliffPercent}
                onChange={(e) => setCliffPercent(Number(e.target.value))}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={cliffPercent}
              />
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "14px" }}>
            <p className="muted" style={{ marginBottom: "8px" }}>Custom Piecewise Segments:</p>
            {segments.map((seg, idx) => (
              <div key={idx} className="row" style={{ marginBottom: "8px", alignItems: "center" }}>
                <div>
                  {/* Each segment field needs an explicit label with a unique for/id pair */}
                  <label
                    htmlFor={`${uid}-seg-${idx}-dur`}
                    style={{ fontSize: "12px" }}
                  >
                    Segment {idx + 1} duration (seconds)
                  </label>
                  <input
                    id={`${uid}-seg-${idx}-dur`}
                    type="number"
                    min="1"
                    value={seg.duration}
                    onChange={(e) => {
                      const updated = [...segments];
                      updated[idx] = { ...updated[idx], duration: Number(e.target.value) };
                      setSegments(updated);
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`${uid}-seg-${idx}-pct`}
                    style={{ fontSize: "12px" }}
                  >
                    Segment {idx + 1} allocation (%)
                  </label>
                  <input
                    id={`${uid}-seg-${idx}-pct`}
                    type="number"
                    min="0"
                    max="100"
                    value={seg.percent}
                    onChange={(e) => {
                      const updated = [...segments];
                      updated[idx] = { ...updated[idx], percent: Number(e.target.value) };
                      setSegments(updated);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Time Scrubber                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="card" aria-labelledby={scrubberHeadingId}>
        <h2 id={scrubberHeadingId}>
          Time Scrubber (Elapsed: {timeCursor}s / {totalDuration}s)
        </h2>
        <div style={{ margin: "14px 0" }}>
          <label htmlFor={scrubberId}>Scrub Time (t = {timeCursor}s)</label>
          <input
            id={scrubberId}
            type="range"
            min="0"
            max={totalDuration}
            step="1"
            value={timeCursor}
            onChange={(e) => setTimeCursor(Number(e.target.value))}
            style={{ width: "100%" }}
            aria-valuemin={0}
            aria-valuemax={totalDuration}
            aria-valuenow={timeCursor}
          />
        </div>

        <div className="row" style={{ marginTop: "16px" }}>
          <div style={{ padding: "12px", background: "#0b121e", borderRadius: "8px", border: "1px solid var(--line)" }}>
            <span className="muted" id={vestingLabelId}>
              Claimable at t (Vesting Schedule)
            </span>
            <div
              className="mono"
              aria-labelledby={vestingLabelId}
              style={{ fontSize: "22px", fontWeight: "bold", color: "var(--green)" }}
            >
              {scheduleAccrued.toString()} tokens
            </div>
            <span className="muted" style={{ fontSize: "12px" }}>
              {schedPct}% unlocked
            </span>
          </div>

          <div style={{ padding: "12px", background: "#0b121e", borderRadius: "8px", border: "1px solid var(--line)" }}>
            <span className="muted" id={linearLabelId}>
              Contract Pure streamed_at (Linear)
            </span>
            <div
              className="mono"
              aria-labelledby={linearLabelId}
              style={{ fontSize: "22px", fontWeight: "bold", color: "var(--accent2)" }}
            >
              {pureContractAccrued.toString()} tokens
            </div>
            <span className="muted" style={{ fontSize: "12px" }}>
              Floor pro-rata reference
            </span>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Visual Chart — SVG with accessible title + desc (WCAG 1.1.1 / 4.1.2) */}
      {/* ------------------------------------------------------------------ */}
      <section className="card" aria-labelledby={chartHeadingId}>
        <h2 id={chartHeadingId}>Claim Curves (Claimable vs Time)</h2>
        <div style={{ overflowX: "auto", display: "flex", justifyContent: "center" }}>
          {/*
           * role="img" + aria-labelledby (title + desc) gives AT a complete
           * text alternative for the chart. The title names it; the desc
           * explains what the curves represent. WCAG 1.1.1.
           */}
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            role="img"
            aria-labelledby={`${chartTitleId} ${chartDescId}`}
            style={{
              width: "100%",
              maxWidth: `${svgWidth}px`,
              background: "#080c14",
              borderRadius: "8px",
              border: "1px solid var(--line)",
            }}
          >
            <title id={chartTitleId}>Accrual curve chart</title>
            <desc id={chartDescId}>
              Line chart of tokens claimable over time.
              The solid green line shows the vesting schedule (with cliff and
              optional segments). The dashed cyan line shows the pure linear
              streamed_at reference. X axis: elapsed seconds (0 to {totalDuration}s).
              Y axis: tokens accrued (0 to {totalDeposit.toLocaleString()}).
              {cliffDuration > 0 && !useSegments
                ? ` A dashed red cliff marker appears at ${cliffDuration}s.`
                : ""}
              {` Current cursor at ${timeCursor}s: vesting ${scheduleAccrued.toString()} tokens (${schedPct}% unlocked).`}
            </desc>

            {/* Grid & Axis — aria-hidden; visual decoration only */}
            <line
              x1={padding} y1={svgHeight - padding}
              x2={svgWidth - padding} y2={svgHeight - padding}
              stroke="#22304a"
              aria-hidden="true"
            />
            <line
              x1={padding} y1={padding}
              x2={padding} y2={svgHeight - padding}
              stroke="#22304a"
              aria-hidden="true"
            />

            {/* Contract Pure Linear Line (dashed cyan) */}
            <path
              d={contractPath}
              fill="none"
              stroke="var(--accent2)"
              strokeWidth="2"
              strokeDasharray="4 4"
              opacity="0.6"
              aria-hidden="true"
            />

            {/* Vesting Schedule Curve (solid green) */}
            <path
              d={schedulePath}
              fill="none"
              stroke="var(--green)"
              strokeWidth="3"
              aria-hidden="true"
            />

            {/* Cliff Marker */}
            {cliffDuration > 0 && !useSegments && (
              <line
                x1={getX(cliffDuration)} y1={padding}
                x2={getX(cliffDuration)} y2={svgHeight - padding}
                stroke="var(--red)"
                strokeDasharray="2 2"
                opacity="0.8"
                aria-hidden="true"
              />
            )}

            {/* Cursor Marker */}
            <line
              x1={cursorX} y1={padding}
              x2={cursorX} y2={svgHeight - padding}
              stroke="var(--accent)"
              strokeWidth="2"
              aria-hidden="true"
            />
            <circle
              cx={cursorX}
              cy={cursorY}
              r="5"
              fill="var(--green)"
              stroke="#fff"
              strokeWidth="2"
              aria-hidden="true"
            />

            {/* Axis labels — aria-hidden; textual values are in <desc> */}
            <text x={padding} y={svgHeight - 12} fill="var(--muted)" fontSize="11" fontFamily="monospace" aria-hidden="true">0s</text>
            <text x={svgWidth - padding - 30} y={svgHeight - 12} fill="var(--muted)" fontSize="11" fontFamily="monospace" aria-hidden="true">{totalDuration}s</text>
            <text x={10} y={padding + 10} fill="var(--muted)" fontSize="11" fontFamily="monospace" aria-hidden="true">{totalDeposit}</text>
            <text x={10} y={svgHeight - padding} fill="var(--muted)" fontSize="11" fontFamily="monospace" aria-hidden="true">0</text>
          </svg>
        </div>

        {/* Chart legend — role="list" so SR users get item count + can navigate */}
        <div
          style={{ display: "flex", gap: "20px", marginTop: "14px", fontSize: "13px", justifyContent: "center", flexWrap: "wrap" }}
          role="list"
          aria-label="Chart legend"
        >
          <div role="listitem" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {/* Colour swatch is decorative; the text label carries the meaning */}
            <span
              style={{ width: "16px", height: "3px", background: "var(--green)", display: "inline-block" }}
              aria-hidden="true"
            />
            <span>Vesting Schedule Curve</span>
          </div>
          <div role="listitem" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{ width: "16px", height: "2px", borderTop: "2px dashed var(--accent2)", display: "inline-block" }}
              aria-hidden="true"
            />
            <span>Pure streamed_at Reference</span>
          </div>
          {cliffDuration > 0 && !useSegments && (
            <div role="listitem" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span
                style={{ width: "16px", height: "2px", borderTop: "2px dashed var(--red)", display: "inline-block" }}
                aria-hidden="true"
              />
              <span>Cliff Point</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
