import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  evaluateClaim,
  renderDecisionsTable,
  replaySeries,
  type QueuedClaim,
  type SchedulerPolicy,
} from "./claim-scheduler";
import {
  FEE_PERCENTILE_KEYS,
  feeAt,
  parseFeeStats,
  type FeePercentiles,
  type FeeSnapshot,
} from "./fee-stats";
import {
  FEE_SERIES_NAMES,
  loadFeeSeries,
  seriesStartSeconds,
} from "./__fixtures__/fee-series";

const START = seriesStartSeconds("spike"); // 1790000000

function dist(level: number): FeePercentiles {
  const d = {} as FeePercentiles;
  for (const key of FEE_PERCENTILE_KEYS) d[key] = level;
  return d;
}

function snapshot(p50: number, observedAt = 0, ledger = 1): FeeSnapshot {
  return { ledger, observedAt, soroban: dist(p50), classic: dist(100) };
}

function claim(overrides: Partial<QueuedClaim> = {}): QueuedClaim {
  return {
    id: "c1",
    streamId: "1",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    signedXdr: "signed-envelope",
    signedValidUntil: START + 1800,
    streamStartTime: START,
    streamEndTime: START + 3600,
    createdAt: START,
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

const policy: SchedulerPolicy = {
  ...DEFAULT_POLICY,
  enabled: true,
  percentile: "p50",
  maxFeeStroops: 150,
  deadlineLeadSeconds: 900,
  submitLeadSeconds: 120,
  intentValiditySeconds: 1800,
  resignCooldownSeconds: 120,
};

// ---------------------------------------------------------------- fee stats --

describe("parseFeeStats", () => {
  it("parses the documented getFeeStats example", () => {
    const parsed = parseFeeStats(
      {
        sorobanInclusionFee: { ...dist(100), p90: 200, p99: 200 },
        inclusionFee: { ...dist(100), p99: 133 },
        latestLedger: 3730870,
      },
      42
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.ledger).toBe(3730870);
    expect(parsed?.observedAt).toBe(42);
    expect(feeAt(parsed!.soroban, "p50")).toBe(100);
    expect(feeAt(parsed!.soroban, "p90")).toBe(200);
    expect(feeAt(parsed!.classic, "p99")).toBe(133);
  });

  it("returns null instead of throwing on a malformed payload", () => {
    expect(parseFeeStats({}, 0)).toBeNull();
    expect(parseFeeStats({ sorobanInclusionFee: dist(100) }, 0)).toBeNull();
    expect(parseFeeStats(null, 0)).toBeNull();
    expect(
      parseFeeStats({ sorobanInclusionFee: dist(100), inclusionFee: { min: 1 } }, 0)
    ).toBeNull();
  });
});

// ----------------------------------------------------------- decision ladder --

describe("evaluateClaim", () => {
  it("does nothing for terminal claims", () => {
    expect(
      evaluateClaim(claim({ status: "submitted" }), snapshot(120), policy, START + 100)
    ).toMatchObject({ action: "done", reason: "already-terminal" });
  });

  it("waits when the scheduler is disabled", () => {
    expect(
      evaluateClaim(
        claim(),
        snapshot(120),
        { ...policy, enabled: false },
        START + 100
      )
    ).toMatchObject({ action: "wait", reason: "disabled" });
  });

  it("waits before anything has accrued", () => {
    expect(
      evaluateClaim(claim(), snapshot(120), policy, START)
    ).toMatchObject({ action: "wait", reason: "too-early" });
  });

  it("asks for a signature when none is held", () => {
    expect(
      evaluateClaim(
        claim({ signedXdr: null, signedValidUntil: null }),
        snapshot(120),
        policy,
        START + 100
      )
    ).toMatchObject({ action: "resign", reason: "awaiting-signature" });
  });

  it("re-signs a lapsed envelope", () => {
    expect(
      evaluateClaim(claim(), snapshot(120), policy, START + 1800)
    ).toMatchObject({ action: "resign", reason: "signature-expired" });
  });

  it("submits at the deadline even when fees are high", () => {
    // A live envelope that covers the whole horizon: nothing to re-sign, so
    // the deadline rule is the one that fires.
    const evaluation = evaluateClaim(
      claim({ signedValidUntil: START + 5400 }),
      snapshot(900),
      policy,
      START + 3600 - 900
    );
    expect(evaluation).toMatchObject({
      action: "submit",
      reason: "deadline-fallback",
    });
    expect(evaluation.secondsToStreamEnd).toBe(900);
  });

  it("submits a live envelope before it lapses", () => {
    expect(
      evaluateClaim(claim(), snapshot(900), policy, START + 1800 - 120)
    ).toMatchObject({ action: "submit", reason: "intent-expiring" });
  });

  it("submits under budget, waits over it", () => {
    expect(
      evaluateClaim(claim(), snapshot(120), policy, START + 300)
    ).toMatchObject({ action: "submit", reason: "fee-below-threshold" });
    expect(
      evaluateClaim(claim(), snapshot(400), policy, START + 300)
    ).toMatchObject({ action: "wait", reason: "fee-above-threshold" });
  });

  it("reports the observed percentile and budget it compared", () => {
    const evaluation = evaluateClaim(claim(), snapshot(137), policy, START + 300);
    expect(evaluation.feeStroops).toBe(137);
    expect(evaluation.thresholdStroops).toBe(150);
  });
});

// --------------------------------------------------------- replay simulation --

describe("replaySeries (recorded fee series)", () => {
  it("covers every scenario in the fixture", () => {
    expect([...FEE_SERIES_NAMES].sort()).toEqual(["lull", "spike"]);
  });

  it("lull: submits as soon as the fee drops under budget", () => {
    const rows = replaySeries(loadFeeSeries("lull"), claim(), policy);
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ action: "submit", reason: "fee-below-threshold" });
    expect(rows.slice(0, -1).every((r) => r.action === "wait")).toBe(true);
  });

  it("spike: falls back at the deadline when fees never drop", () => {
    // A signature that covers the horizon is what lets the scheduler actually
    // wait; see the next test for what happens when it does not.
    const rows = replaySeries(
      loadFeeSeries("spike"),
      claim({ signedValidUntil: START + 5400 }),
      policy
    );
    expect(rows.some((r) => r.action === "resign")).toBe(false);
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ action: "submit", reason: "deadline-fallback" });
    // The never-late guarantee: the fallback fires inside the deadline window.
    expect(last.secondsToStreamEnd).toBeLessThanOrEqual(policy.deadlineLeadSeconds);
  });

  it("spike: a short signature window forces an early submit", () => {
    // With a 30-minute envelope and a 120s submit lead, the scheduler is
    // forced to submit at t=1680s rather than wait — it must not let a live
    // signature lapse. This is why the settings UI lets you widen the window.
    const rows = replaySeries(loadFeeSeries("spike"), claim(), policy);
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ action: "submit", reason: "intent-expiring" });
    expect(last.secondsToIntentExpiry).toBe(policy.submitLeadSeconds);
    expect(last.secondsToStreamEnd).toBeGreaterThan(policy.deadlineLeadSeconds);
  });

  it("spike: a client that was offline re-signs, then falls back", () => {
    // Coming back online after the envelope's maxTime: the first decision is a
    // re-sign, then the scheduler resumes and falls back at the deadline.
    const afterOutage = loadFeeSeries("spike").filter(
      (s) => s.observedAt >= (START + 2000) * 1000
    );
    const rows = replaySeries(afterOutage, claim(), policy, {
      refreshValiditySeconds: 1800,
    });
    expect(rows[0]).toMatchObject({ action: "resign", reason: "signature-expired" });
    expect(rows.at(-1)).toMatchObject({
      action: "submit",
      reason: "deadline-fallback",
    });
  });

  it("every scenario eventually submits — a claim is never abandoned", () => {
    for (const name of FEE_SERIES_NAMES) {
      const rows = replaySeries(loadFeeSeries(name), claim({ signedValidUntil: START + 5400 }), policy);
      expect(rows.at(-1)?.action).toBe("submit");
    }
  });

  it("recorded decisions table (lull)", () => {
    const rows = replaySeries(loadFeeSeries("lull"), claim(), policy);
    expect(renderDecisionsTable(rows)).toMatchSnapshot();
  });

  it("recorded decisions table (spike, long signature)", () => {
    const rows = replaySeries(
      loadFeeSeries("spike"),
      claim({ signedValidUntil: START + 5400 }),
      policy
    );
    expect(renderDecisionsTable(rows)).toMatchSnapshot();
  });

  it("recorded decisions table (spike, short signature)", () => {
    const rows = replaySeries(loadFeeSeries("spike"), claim(), policy);
    expect(renderDecisionsTable(rows)).toMatchSnapshot();
  });

  it("recorded decisions table (spike, client returns after the outage)", () => {
    const afterOutage = loadFeeSeries("spike").filter(
      (s) => s.observedAt >= (START + 2000) * 1000
    );
    const rows = replaySeries(afterOutage, claim(), policy, {
      refreshValiditySeconds: 1800,
    });
    expect(renderDecisionsTable(rows)).toMatchSnapshot();
  });
});
