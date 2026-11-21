import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fmtUnits,
  validateBatchSelection,
  validateWithdrawal,
  MAX_WITHDRAW_BATCH,
} from "./withdrawal.ts";

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

// `withdraw_many` enforces its bounds on-chain (#73 empty, #74 over the cap,
// #75 duplicates) and the list must not be able to build a request the contract
// would refuse — the checks here mirror those codes so the failure lands before
// a wallet prompt.
describe("Batch claim selection", () => {
  it("rejects an empty selection", () => {
    const res = validateBatchSelection([]);
    assert.equal(res.valid, false);
    assert.match(res.error ?? "", /at least one stream/);
    assert.deepEqual(res.ids, []);
  });

  it("accepts a single stream and preserves the requested order", () => {
    const res = validateBatchSelection(["12", "3", "7"]);
    assert.equal(res.valid, true);
    assert.deepEqual(res.ids, ["12", "3", "7"]);
  });

  it("accepts exactly the contract cap and rejects one more", () => {
    const atCap = Array.from({ length: MAX_WITHDRAW_BATCH }, (_, i) => `${i + 1}`);
    assert.equal(validateBatchSelection(atCap).valid, true);

    const overCap = validateBatchSelection([...atCap, "over"]);
    assert.equal(overCap.valid, false);
    assert.match(overCap.error ?? "", /at most 20 streams/);
  });

  it("rejects a duplicated stream instead of paying it twice", () => {
    const res = validateBatchSelection(["7", "9", "7"]);
    assert.equal(res.valid, false);
    assert.match(res.error ?? "", /once per batch/);
    assert.deepEqual(res.ids, []);
  });

  it("returns a copy, so mutating the selection cannot rewrite the request", () => {
    const selection = ["1", "2"];
    const res = validateBatchSelection(selection);
    selection.push("3");
    assert.deepEqual(res.ids, ["1", "2"]);
  });
});
