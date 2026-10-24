import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamedAt, MathOverflowError, computeVestingAccrual } from "./oracle.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface VectorEntry {
  deposit: string;
  duration: string;
  elapsed: string;
  expected_result: string | null;
  expected_error: string | null;
}

describe("oracle differential fuzz-vector suite against contract streamed_at", () => {
  const vectorPath = resolve(__dirname, "../../tests/vectors/accrual_vectors.json");

  it("loads vector corpus", () => {
    assert.strictEqual(existsSync(vectorPath), true);
  });

  const content = readFileSync(vectorPath, "utf-8");
  const vectors: VectorEntry[] = JSON.parse(content);

  it(`passes all ${vectors.length} differential test vectors without divergence`, () => {
    let checked = 0;
    for (const vector of vectors) {
      const deposit = BigInt(vector.deposit);
      const duration = BigInt(vector.duration);
      const elapsed = BigInt(vector.elapsed);

      if (vector.expected_error) {
        assert.throws(
          () => streamedAt(deposit, duration, elapsed),
          MathOverflowError
        );
      } else {
        const actual = streamedAt(deposit, duration, elapsed);
        assert.strictEqual(actual.toString(), vector.expected_result);
      }
      checked++;
    }
    assert.strictEqual(checked, vectors.length);
  });
});

describe("computeVestingAccrual", () => {
  it("respects cliff duration — returns 0 before cliff", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 25n,
      cliffAmount: 250n,
    };
    assert.strictEqual(computeVestingAccrual(params, 10n), 0n);
    assert.strictEqual(computeVestingAccrual(params, 24n), 0n);
  });

  it("unlocks cliff amount at cliff elapsed", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 25n,
      cliffAmount: 250n,
    };
    assert.strictEqual(computeVestingAccrual(params, 25n), 250n);
  });

  it("accrues linearly after cliff up to total duration", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 25n,
      cliffAmount: 250n,
    };
    // At t=62.5 (37.5 after cliff out of 75 duration = 50% of 750 = 375 => total 625)
    // t=62 -> 37 elapsed after cliff. (750 * 37) / 75 = 370. Total = 250 + 370 = 620.
    assert.strictEqual(computeVestingAccrual(params, 62n), 620n);
    assert.strictEqual(computeVestingAccrual(params, 100n), 1000n);
    assert.strictEqual(computeVestingAccrual(params, 150n), 1000n);
  });

  it("handles segmented piecewise schedules", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 0n,
      cliffAmount: 0n,
      segments: [
        { duration: 50n, percentBps: 2000n }, // 20% over first 50s = 200
        { duration: 50n, percentBps: 8000n }, // 80% over next 50s = 800
      ],
    };

    assert.strictEqual(computeVestingAccrual(params, 25n), 100n);
    assert.strictEqual(computeVestingAccrual(params, 50n), 200n);
    assert.strictEqual(computeVestingAccrual(params, 75n), 600n);
    assert.strictEqual(computeVestingAccrual(params, 100n), 1000n);
  });
});
