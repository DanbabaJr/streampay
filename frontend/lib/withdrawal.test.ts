import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimFloorApplies,
  claimReadiness,
  fmtUnits,
  validateBatchSelection,
  validateWithdrawal,
  MAX_WITHDRAW_BATCH,
  MIN_CLAIM_AMOUNT,
  MIN_STREAM_DEPOSIT,
  type ClaimFloorContext,
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

describe("Dust floor: not worth claiming yet (#78)", () => {
  // 10_000_000_000 base units over 10 days: ~11_574 units per second.
  const ctx: ClaimFloorContext = {
    startTime: 1_000,
    endTime: 1_000 + 864_000,
    deposit: 10_000_000_000n,
    nowSeconds: 1_001,
  };

  it("mirrors the contract constants", () => {
    assert.equal(MIN_CLAIM_AMOUNT, 1_000_000n);
    assert.equal(MIN_STREAM_DEPOSIT, 10n * MIN_CLAIM_AMOUNT);
  });

  it("applies the floor only while the window is open and the stream is not paused", () => {
    assert.equal(claimFloorApplies(ctx), true);
    assert.equal(claimFloorApplies({ ...ctx, paused: true }), false);
    assert.equal(claimFloorApplies({ ...ctx, nowSeconds: ctx.endTime }), false);
  });

  it("reports nothing to claim for an empty or unknown balance", () => {
    assert.deepEqual(claimReadiness(null, ctx), { state: "nothing" });
    assert.deepEqual(claimReadiness(0n, ctx), { state: "nothing" });
  });

  it("flags a sub-floor balance mid-stream and estimates when it clears", () => {
    const r = claimReadiness(11_574n, ctx);
    assert.equal(r.state, "not-worth-claiming-yet");
    if (r.state !== "not-worth-claiming-yet") return;
    assert.equal(r.shortfall, MIN_CLAIM_AMOUNT - 11_574n);
    // ceil(988_426 * 864_000 / 10_000_000_000) = 86 seconds.
    assert.equal(r.readyAt, ctx.nowSeconds + 86);
  });

  it("caps the estimate at end_time, when the floor lifts anyway", () => {
    const r = claimReadiness(1n, { ...ctx, deposit: 2n });
    assert.equal(r.state, "not-worth-claiming-yet");
    if (r.state === "not-worth-claiming-yet") assert.equal(r.readyAt, ctx.endTime);
  });

  it("treats a floor-sized, ended or paused balance as claimable", () => {
    assert.deepEqual(claimReadiness(MIN_CLAIM_AMOUNT, ctx), { state: "claimable" });
    assert.deepEqual(claimReadiness(5n, { ...ctx, nowSeconds: ctx.endTime }), {
      state: "claimable",
    });
    assert.deepEqual(claimReadiness(5n, { ...ctx, paused: true }), { state: "claimable" });
  });

  it("refuses a mid-stream sub-floor withdrawal with the contract's reason", () => {
    const res = validateWithdrawal("999999", 5_000_000n, ctx);
    assert.equal(res.valid, false);
    assert.equal(res.overWithdrawal, false);
    assert.match(res.error ?? "", /Not worth claiming yet/);
    assert.match(res.error ?? "", /ClaimBelowMinimum/);
  });

  it("accepts the floor itself, and any amount once the stream has ended", () => {
    assert.equal(validateWithdrawal("1000000", 5_000_000n, ctx).valid, true);
    assert.equal(
      validateWithdrawal("5", 5n, { ...ctx, nowSeconds: ctx.endTime + 1 }).valid,
      true
    );
  });

  it("keeps the old behaviour when no floor context is given", () => {
    assert.equal(validateWithdrawal("5", 100n).valid, true);
  });
});
