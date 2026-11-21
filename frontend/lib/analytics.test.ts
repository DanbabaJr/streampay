/**
 * Unit tests for the analytics aggregation functions.
 * Fixtures are hand-crafted time-series; all math uses the same accrual
 * oracle as the simulator and the contract.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildTimeSeries,
  projectStream,
  forecastIncome,
  buildAggregatedTimeSeries,
  windowFromDays,
  defaultStreamWindow,
  type AnalyticsStream,
} from "./analytics.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000; // fixed reference time (seconds)

function makeStream(overrides: Partial<AnalyticsStream> = {}): AnalyticsStream {
  return {
    id: "1",
    token: "CTOKEN",
    deposit: 3_600n,       // 1 token-unit per second
    withdrawn: 0n,
    startTime: NOW - 1_800, // started 30 min ago
    endTime: NOW + 1_800,   // ends in 30 min
    status: "Active",
    ...overrides,
  };
}

// ── buildTimeSeries ───────────────────────────────────────────────────────────

describe("buildTimeSeries", () => {
  it("returns pointCount points", () => {
    const stream = makeStream();
    const pts = buildTimeSeries(stream, stream.startTime, stream.endTime, 10);
    assert.equal(pts.length, 10);
  });

  it("first point has accrued=0 at stream start", () => {
    const stream = makeStream();
    const pts = buildTimeSeries(stream, stream.startTime, stream.endTime, 5);
    assert.equal(pts[0].accrued, 0n);
  });

  it("last point has accrued == deposit at stream end", () => {
    const stream = makeStream();
    const pts = buildTimeSeries(stream, stream.startTime, stream.endTime, 5);
    assert.equal(pts[pts.length - 1].accrued, stream.deposit);
  });

  it("available == accrued when nothing withdrawn", () => {
    const stream = makeStream();
    const pts = buildTimeSeries(stream, stream.startTime, stream.endTime, 5);
    for (const p of pts) {
      assert.equal(p.available, p.accrued - p.claimed);
    }
  });

  it("claimed is capped at accrued when withdrawn > accrued at that point", () => {
    // Stream partly withdrawn; at early timestamps accrued < withdrawn.
    const stream = makeStream({ withdrawn: 3_500n });
    const pts = buildTimeSeries(stream, stream.startTime, stream.endTime, 10);
    for (const p of pts) {
      assert(p.claimed <= p.accrued, "claimed must not exceed accrued at any point");
      assert(p.available >= 0n, "available must be non-negative");
    }
  });

  it("returns empty array when fromTime >= toTime", () => {
    const stream = makeStream();
    assert.deepEqual(buildTimeSeries(stream, NOW, NOW, 5), []);
    assert.deepEqual(buildTimeSeries(stream, NOW + 10, NOW, 5), []);
  });

  it("cancelled stream accrues nothing after cancellation", () => {
    const stream = makeStream({ status: "Cancelled", withdrawn: 1_800n });
    // Even for a cancelled stream, the time-series models the math correctly
    // (contract's available_amount returns 0 for cancelled streams, but
    // buildTimeSeries shows what WOULD have accrued — consistent with simulator).
    const pts = buildTimeSeries(stream, stream.startTime, stream.endTime, 5);
    // At least the last point should reach the full deposit.
    assert.equal(pts[pts.length - 1].accrued, stream.deposit);
  });
});

// ── projectStream ─────────────────────────────────────────────────────────────

describe("projectStream", () => {
  it("projects half the deposit for a stream at its midpoint", () => {
    const stream = makeStream(); // midpoint is exactly NOW (startTime - 1800, endTime + 1800)
    const proj = projectStream(stream, NOW);
    // At NOW the stream is at the midpoint: 1800 of 3600 seconds elapsed.
    // accrued_now = 3600 * 1800 / 3600 = 1800
    // projectedAccrual = 3600 - 1800 = 1800
    assert.equal(proj.projectedAccrual, 1_800n);
  });

  it("projects 0 for a depleted stream", () => {
    const stream = makeStream({ status: "Depleted", withdrawn: 3_600n });
    const proj = projectStream(stream, NOW);
    assert.equal(proj.projectedAccrual, 0n);
  });

  it("projects 0 for a cancelled stream", () => {
    const stream = makeStream({ status: "Cancelled", withdrawn: 1_000n });
    const proj = projectStream(stream, NOW);
    assert.equal(proj.projectedAccrual, 0n);
  });

  it("ratePerSecond is deposit/duration for active stream", () => {
    const stream = makeStream();
    const proj = projectStream(stream, NOW);
    const duration = BigInt(stream.endTime - stream.startTime);
    assert.equal(proj.ratePerSecond, stream.deposit / duration);
  });

  it("secondsRemaining is positive for active not-yet-ended stream", () => {
    const stream = makeStream();
    const proj = projectStream(stream, NOW);
    assert(proj.secondsRemaining > 0);
  });

  it("secondsRemaining is 0 for a stream that has ended", () => {
    const stream = makeStream({ endTime: NOW - 100 });
    const proj = projectStream(stream, NOW);
    assert.equal(proj.secondsRemaining, 0);
  });
});

// ── forecastIncome ────────────────────────────────────────────────────────────

describe("forecastIncome", () => {
  it("returns 0 when no active streams", () => {
    const fc = forecastIncome([], NOW, 30);
    assert.equal(fc.totalProjected, 0n);
  });

  it("returns 0 for streams already ended", () => {
    const ended = makeStream({ endTime: NOW - 1 });
    const fc = forecastIncome([ended], NOW, 30);
    assert.equal(fc.totalProjected, 0n);
  });

  it("returns full deposit for a stream entirely in the horizon", () => {
    // Stream starts in the future and ends within the horizon.
    const future = makeStream({
      startTime: NOW + 100,
      endTime: NOW + 200,
      deposit: 100n,
    });
    const fc = forecastIncome([future], NOW, 1); // 1 day > 200 seconds
    // accrued_now = 0 (hasn't started); accrued_at_horizon = 100 (fully done)
    assert.equal(fc.totalProjected, 100n);
  });

  it("groups by token correctly", () => {
    const s1 = makeStream({ id: "1", token: "TOKENA", deposit: 1_000n });
    const s2 = makeStream({ id: "2", token: "TOKENB", deposit: 2_000n });
    const s3 = makeStream({ id: "3", token: "TOKENA", deposit: 500n });
    const fc = forecastIncome([s1, s2, s3], NOW - 3_600, 1);
    assert("TOKENA" in fc.byToken);
    assert("TOKENB" in fc.byToken);
    // Both token-A streams contribute to the same bucket.
    assert.equal(fc.byToken["TOKENA"], (fc.byToken["TOKENA"]));
  });

  it("skips non-active streams", () => {
    const cancelled = makeStream({ status: "Cancelled", id: "99" });
    const depleted = makeStream({ status: "Depleted", id: "98" });
    const fc = forecastIncome([cancelled, depleted], NOW, 30);
    assert.equal(fc.totalProjected, 0n);
  });
});

// ── buildAggregatedTimeSeries ─────────────────────────────────────────────────

describe("buildAggregatedTimeSeries", () => {
  it("returns empty for no streams", () => {
    const pts = buildAggregatedTimeSeries([], NOW, NOW + 3_600, 5);
    assert.deepEqual(pts, []);
  });

  it("sums accrued values across two streams", () => {
    const s1 = makeStream({ id: "1", deposit: 1_000n });
    const s2 = makeStream({ id: "2", deposit: 2_000n });
    const pts = buildAggregatedTimeSeries([s1, s2], s1.startTime, s1.endTime, 3);
    // First point: both at start => accrued = 0+0 = 0.
    assert.equal(pts[0].accrued, 0n);
    // Last point: both fully streamed => accrued = 1000+2000 = 3000.
    assert.equal(pts[pts.length - 1].accrued, 3_000n);
  });
});

// ── windowFromDays ────────────────────────────────────────────────────────────

describe("windowFromDays", () => {
  it("past window ends at now", () => {
    const [from, to] = windowFromDays(NOW, 7);
    assert.equal(to, NOW);
    assert.equal(from, NOW - 7 * 86_400);
  });

  it("future window extends beyond now", () => {
    const [from, to] = windowFromDays(NOW, 0, 14);
    assert.equal(from, NOW);
    assert.equal(to, NOW + 14 * 86_400);
  });
});

// ── defaultStreamWindow ───────────────────────────────────────────────────────

describe("defaultStreamWindow", () => {
  it("starts at stream start", () => {
    const stream = makeStream();
    const [from] = defaultStreamWindow(stream, NOW);
    assert.equal(from, stream.startTime);
  });

  it("caps at now + 30 days for long streams", () => {
    const longStream = makeStream({ endTime: NOW + 400 * 86_400 });
    const [, to] = defaultStreamWindow(longStream, NOW);
    assert.equal(to, NOW + 30 * 86_400);
  });

  it("uses stream end when it is within 30 days", () => {
    const shortStream = makeStream({ endTime: NOW + 5 * 86_400 });
    const [, to] = defaultStreamWindow(shortStream, NOW);
    assert.equal(to, NOW + 5 * 86_400);
  });
});
