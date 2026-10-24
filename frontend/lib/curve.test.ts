import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  validateQueryParams,
  computeStateHash,
  computeETag,
  matchesIfNoneMatch,
  computeCurve,
  type StreamData,
  ValidationError,
} from "./curve.ts";
import { computeAccruedAt } from "./accrual.ts";

const mockStream: StreamData = {
  id: "42",
  sender: "GBEXAMPLE...SENDER",
  recipient: "GBEXAMPLE...RECIPIENT",
  token: "CBEXAMPLE...TOKEN",
  deposit: 10_000_000_000n, // 1,000 XLM
  withdrawn: 2_000_000_000n, // 200 XLM
  startTime: 1000,
  endTime: 2000,
  cancelable: true,
  status: "Active",
  asOfLedger: 500000,
  asOfTimestamp: 1500,
};

describe("Curve Computation & Mathematical Correctness", () => {
  it("matches pure computeAccruedAt at every sample point", () => {
    const params = { id: "42", from: 1000, to: 2000, step: 100 };
    const curve = computeCurve(mockStream, params);

    assert.strictEqual(curve.length, 11);
    for (const point of curve) {
      const expected = computeAccruedAt(
        mockStream.deposit,
        mockStream.startTime,
        mockStream.endTime,
        BigInt(point.timestamp)
      );
      assert.strictEqual(point.accrued, expected.toString());
    }
  });

  it("handles empty range / single point when from == to", () => {
    const params = { id: "42", from: 1500, to: 1500, step: 10 };
    const curve = computeCurve(mockStream, params);

    assert.strictEqual(curve.length, 1);
    assert.strictEqual(curve[0].timestamp, 1500);
    // At halfway (1500 in 1000..2000), accrued = half deposit = 5,000,000,000
    assert.strictEqual(curve[0].accrued, "5000000000");
  });

  it("handles boundaries before start and after end", () => {
    const params = { id: "42", from: 500, to: 2500, step: 500 };
    const curve = computeCurve(mockStream, params);

    // t=500: before start => 0
    assert.strictEqual(curve[0].timestamp, 500);
    assert.strictEqual(curve[0].accrued, "0");

    // t=1000: start => 0
    assert.strictEqual(curve[1].timestamp, 1000);
    assert.strictEqual(curve[1].accrued, "0");

    // t=1500: mid => 5000000000
    assert.strictEqual(curve[2].timestamp, 1500);
    assert.strictEqual(curve[2].accrued, "5000000000");

    // t=2000: end => deposit
    assert.strictEqual(curve[3].timestamp, 2000);
    assert.strictEqual(curve[3].accrued, mockStream.deposit.toString());

    // t=2500: after end => clamped to deposit
    assert.strictEqual(curve[4].timestamp, 2500);
    assert.strictEqual(curve[4].accrued, mockStream.deposit.toString());
  });

  it("handles step sizes larger than the range", () => {
    const params = { id: "42", from: 1200, to: 1300, step: 500 };
    const curve = computeCurve(mockStream, params);

    // Only one point fits (1200) because 1200 + 500 > 1300
    assert.strictEqual(curve.length, 1);
    assert.strictEqual(curve[0].timestamp, 1200);
  });

  it("handles step sizes that do not evenly divide the range", () => {
    const params = { id: "42", from: 1000, to: 1025, step: 10 };
    const curve = computeCurve(mockStream, params);

    // Points at 1000, 1010, 1020 (1030 exceeds 1025)
    assert.strictEqual(curve.length, 3);
    assert.strictEqual(curve[0].timestamp, 1000);
    assert.strictEqual(curve[1].timestamp, 1010);
    assert.strictEqual(curve[2].timestamp, 1020);
  });
});

describe("State Hash & ETag Generation", () => {
  it("generates deterministic state hash for identical state", () => {
    const hash1 = computeStateHash(mockStream);
    const hash2 = computeStateHash({ ...mockStream });
    assert.strictEqual(hash1, hash2);
  });

  it("changes state hash when any contract state property changes", () => {
    const originalHash = computeStateHash(mockStream);

    const changedDeposit = computeStateHash({ ...mockStream, deposit: 999n });
    assert.notStrictEqual(originalHash, changedDeposit);

    const changedLedger = computeStateHash({ ...mockStream, asOfLedger: 500001 });
    assert.notStrictEqual(originalHash, changedLedger);

    const changedStatus = computeStateHash({ ...mockStream, status: "Cancelled" });
    assert.notStrictEqual(originalHash, changedStatus);
  });

  it("generates identical ETag for identical state and query params", () => {
    const hash = computeStateHash(mockStream);
    const params = { id: "42", from: 1000, to: 2000, step: 60 };

    const etag1 = computeETag(hash, params);
    const etag2 = computeETag(hash, { ...params });
    assert.strictEqual(etag1, etag2);
    assert.ok(etag1.startsWith('W/"'));
    assert.ok(etag1.endsWith('"'));
  });

  it("generates different ETags when query params change", () => {
    const hash = computeStateHash(mockStream);
    const base = { id: "42", from: 1000, to: 2000, step: 60 };

    const etagBase = computeETag(hash, base);
    const etagDifferentFrom = computeETag(hash, { ...base, from: 1100 });
    const etagDifferentStep = computeETag(hash, { ...base, step: 30 });
    const etagDifferentId = computeETag(hash, { ...base, id: "43" });

    assert.notStrictEqual(etagBase, etagDifferentFrom);
    assert.notStrictEqual(etagBase, etagDifferentStep);
    assert.notStrictEqual(etagBase, etagDifferentId);
  });

  it("matches If-None-Match header with weak and strong tags", () => {
    const etag = 'W/"abcd1234ef5678"';

    // Direct match
    assert.strictEqual(matchesIfNoneMatch('W/"abcd1234ef5678"', etag), true);
    // Strong version of same hash
    assert.strictEqual(matchesIfNoneMatch('"abcd1234ef5678"', etag), true);
    // In comma-separated list
    assert.strictEqual(
      matchesIfNoneMatch('"xyz999", W/"abcd1234ef5678", "foo"', etag),
      true
    );
    // Wildcard
    assert.strictEqual(matchesIfNoneMatch("*", etag), true);

    // Non-matching
    assert.strictEqual(matchesIfNoneMatch('"other"', etag), false);
    assert.strictEqual(matchesIfNoneMatch(null, etag), false);
    assert.strictEqual(matchesIfNoneMatch("", etag), false);
  });
});

describe("Input Validation", () => {
  it("accepts valid parameters", () => {
    const validated = validateQueryParams({
      id: "123",
      from: "1000",
      to: "2000",
      step: "50",
    });
    assert.deepStrictEqual(validated, {
      id: "123",
      from: 1000,
      to: 2000,
      step: 50,
    });
  });

  it("rejects missing or malformed stream id", () => {
    assert.throws(
      () => validateQueryParams({ id: "", from: "0", to: "10", step: "1" }),
      (err: ValidationError) => err.code === "INVALID_STREAM_ID"
    );
    assert.throws(
      () => validateQueryParams({ id: "-5", from: "0", to: "10", step: "1" }),
      (err: ValidationError) => err.code === "INVALID_STREAM_ID"
    );
    assert.throws(
      () => validateQueryParams({ id: "abc", from: "0", to: "10", step: "1" }),
      (err: ValidationError) => err.code === "INVALID_STREAM_ID"
    );
  });

  it("rejects from > to", () => {
    assert.throws(
      () => validateQueryParams({ id: "1", from: "2000", to: "1000", step: "10" }),
      (err: ValidationError) => err.code === "FROM_GREATER_THAN_TO"
    );
  });

  it("rejects step <= 0", () => {
    assert.throws(
      () => validateQueryParams({ id: "1", from: "100", to: "200", step: "0" }),
      (err: ValidationError) => err.code === "INVALID_STEP_POSITIVE"
    );
    assert.throws(
      () => validateQueryParams({ id: "1", from: "100", to: "200", step: "-5" }),
      (err: ValidationError) => err.code === "INVALID_STEP_POSITIVE"
    );
  });

  it("rejects negative from/to timestamps", () => {
    assert.throws(
      () => validateQueryParams({ id: "1", from: "-10", to: "200", step: "1" }),
      (err: ValidationError) => err.code === "NEGATIVE_FROM"
    );
    assert.throws(
      () => validateQueryParams({ id: "1", from: "10", to: "-200", step: "1" }),
      (err: ValidationError) => err.code === "NEGATIVE_TO"
    );
  });

  it("enforces hard point limit to prevent unbounded computations", () => {
    // 0 to 1000 with step 1 = 1001 points > 1000
    assert.throws(
      () => validateQueryParams({ id: "1", from: "0", to: "1000", step: "1" }, 1000),
      (err: ValidationError) =>
        err.code === "POINT_LIMIT_EXCEEDED" &&
        err.message.includes("1001 points") &&
        err.message.includes("1000")
    );

    // Exactly 1000 points (0 to 999 by 1) succeeds
    const ok = validateQueryParams(
      { id: "1", from: "0", to: "999", step: "1" },
      1000
    );
    assert.strictEqual(ok.from, 0);
    assert.strictEqual(ok.to, 999);
  });
});
