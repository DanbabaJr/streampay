// Unit tests for accrual.ts using Node.js built-in test runner

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeAccruedAt, computeAvailable } from "./accrual.ts";

describe("computeAccruedAt", () => {
  it("returns 0 at stream start", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1000n), 0n);
  });

  it("returns 0 before start", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 500n), 0n);
  });

  it("returns full deposit at end", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 2000n), 1000n);
  });

  it("returns full deposit after end", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 2500n), 1000n);
  });

  it("returns partial amount in middle", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1500n), 500n);
  });

  it("returns zero for zero deposit", () => {
    assert.strictEqual(computeAccruedAt(0n, 1000, 2000, 1500n), 0n);
  });

  it("returns zero for zero duration", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 1000, 1500n), 0n);
  });

  it("returns zero for zero elapsed", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1000n), 0n);
  });

  it("handles floor division (truncates)", () => {
    // 1000 * 333 / 1000 = 333 (truncated)
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1333n), 333n);
  });

  it("handles large values", () => {
    // 1000000 * 999 / 1000 = 999000
    assert.strictEqual(computeAccruedAt(1000000n, 1000, 2000, 1999n), 999000n);
  });
});

describe("computeAvailable", () => {
  it("returns 0 for cancelled stream", () => {
    assert.strictEqual(computeAvailable(1000n, 1000, 2000, 100n, "Cancelled", 1500n), 0n);
  });

  it("returns 0 for depleted stream", () => {
    assert.strictEqual(computeAvailable(1000n, 1000, 2000, 100n, "Depleted", 1500n), 0n);
  });

  it("returns streamed - withdrawn for active stream", () => {
    // 1000n * 500n / 1000n = 500n, 500n - 100n = 400n
    assert.strictEqual(computeAvailable(1000n, 1000, 2000, 100n, "Active", 1500n), 400n);
  });
});