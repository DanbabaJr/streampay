import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { formatAmount, formatAmountWithSymbol } from "./format.ts";

describe("formatAmount", () => {
  it("formats standard 7-decimal amounts (Stellar / XLM)", () => {
    assert.equal(formatAmount(10_000_000n, 7), "1");
    assert.equal(formatAmount(1n, 7), "0.0000001");
    assert.equal(formatAmount(12_345_678n, 7), "1.2345678");
    assert.equal(formatAmount(0n, 7), "0");
    assert.equal(formatAmount(-5_000_000n, 7), "-0.5");
  });

  it("trims trailing zeros correctly", () => {
    assert.equal(formatAmount(10_500_000n, 7), "1.05");
    assert.equal(formatAmount(10_050_000n, 7), "1.005");
    assert.equal(formatAmount(10_000_001n, 7), "1.0000001");
    assert.equal(formatAmount(100_000_000n, 7), "10");
  });

  it("handles other decimal places (0, 2, 6, 18)", () => {
    // 0 decimals
    assert.equal(formatAmount(42n, 0), "42");
    assert.equal(formatAmount(0n, 0), "0");
    assert.equal(formatAmount(-7n, 0), "-7");

    // 2 decimals (e.g. fiat style)
    assert.equal(formatAmount(1050n, 2), "10.5");
    assert.equal(formatAmount(1005n, 2), "10.05");
    assert.equal(formatAmount(1000n, 2), "10");
    assert.equal(formatAmount(5n, 2), "0.05");

    // 6 decimals (e.g. USDC style)
    assert.equal(formatAmount(1_000_000n, 6), "1");
    assert.equal(formatAmount(1_250_000n, 6), "1.25");
    assert.equal(formatAmount(500_000n, 6), "0.5");

    // 18 decimals (e.g. EVM-style tokens)
    assert.equal(formatAmount(1_000_000_000_000_000_000n, 18), "1");
    assert.equal(formatAmount(1_500_000_000_000_000_000n, 18), "1.5");
    assert.equal(formatAmount(1n, 18), "0.000000000000000001");
  });

  it("accepts string and number inputs safely", () => {
    assert.equal(formatAmount("10000000", 7), "1");
    assert.equal(formatAmount("12500000", 7), "1.25");
    assert.equal(formatAmount(10000000, 7), "1");
  });

  it("formats with symbol when using formatAmountWithSymbol", () => {
    assert.equal(formatAmountWithSymbol(10_000_000n, 7, "XLM"), "1 XLM");
    assert.equal(formatAmountWithSymbol(1_250_000n, 6, "USDC"), "1.25 USDC");
    assert.equal(formatAmountWithSymbol(100n, 0), "100");
  });
});
