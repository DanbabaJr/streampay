import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateWithdrawal, fmtUnits } from "./withdrawal.ts";

describe("Withdrawal Validation", () => {
  it("rejects empty or whitespace-only inputs", () => {
    const res1 = validateWithdrawal("", 100n);
    assert.equal(res1.valid, false);
    assert.match(res1.error ?? "", /enter an amount/);

    const res2 = validateWithdrawal("   ", 100n);
    assert.equal(res2.valid, false);
    assert.match(res2.error ?? "", /enter an amount/);
  });

  it("rejects invalid non-integer inputs", () => {
    const res = validateWithdrawal("abc", 100n);
    assert.equal(res.valid, false);
    assert.match(res.error ?? "", /Invalid numeric/);
  });

  it("rejects zero and negative amounts", () => {
    const res0 = validateWithdrawal("0", 100n);
    assert.equal(res0.valid, false);
    assert.match(res0.error ?? "", /greater than zero/);

    const resNeg = validateWithdrawal("-50", 100n);
    assert.equal(resNeg.valid, false);
    assert.match(resNeg.error ?? "", /greater than zero/);
  });

  it("flags and rejects amounts exceeding available accrued balance", () => {
    const res = validateWithdrawal("150", 100n);
    assert.equal(res.valid, false);
    assert.equal(res.overWithdrawal, true);
    assert.match(res.error ?? "", /AmountExceedsAvailable/);
  });

  it("accepts valid amount within available balance", () => {
    const res = validateWithdrawal("50", 100n);
    assert.equal(res.valid, true);
    assert.equal(res.overWithdrawal, false);
    assert.equal(res.amount, 50n);
  });

  it("accepts exact available balance", () => {
    const res = validateWithdrawal("100", 100n);
    assert.equal(res.valid, true);
    assert.equal(res.overWithdrawal, false);
    assert.equal(res.amount, 100n);
  });

  it("formats token units safely", () => {
    assert.equal(fmtUnits(1000n), "1000");
    assert.equal(fmtUnits("500"), "500");
    assert.equal(fmtUnits(250), "250");
  });
});
