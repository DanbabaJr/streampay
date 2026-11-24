import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePreconditions,
  processQueue,
} from "./offline-queue.ts";
import type { PendingTransaction } from "./offline-queue.ts";

describe("Offline Pending Transaction Prechecks", () => {
  const baseTx: PendingTransaction = {
    id: "tx-1",
    scope: "testnet:GB12345",
    action: "withdraw",
    sourceAccount: "GB12345",
    sequenceNumber: "1001",
    signedXdr: "AAAA...",
    minLedger: 500,
    maxLedger: 600,
    minTime: 1700000000,
    maxTime: 1700003600,
    createdAt: 1700000000,
    status: "queued",
  };

  it("accepts valid transaction when preconditions match", () => {
    const result = validatePreconditions(baseTx, "1000", 550, 1700001000);
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  it("refuses sequence drift when account sequence has moved past tx sequence", () => {
    // Current sequence is 1001, matching or exceeding tx sequence 1001
    const result = validatePreconditions(baseTx, "1001", 550, 1700001000);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "sequence_drift");
    assert.match(result.message || "", /drifted past/);
  });

  it("refuses sequence non-adjacency when a gap exists", () => {
    // Current sequence is 999, so expected next is 1000, but tx is 1001
    const result = validatePreconditions(baseTx, "999", 550, 1700001000);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "precondition_failed");
    assert.match(result.message || "", /not the immediate successor/);
  });

  it("refuses transaction with expired max ledger bound", () => {
    const result = validatePreconditions(baseTx, "1000", 601, 1700001000);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "expired_bounds");
    assert.match(result.message || "", /max ledger bound/);
  });

  it("refuses transaction with expired max timebound", () => {
    const result = validatePreconditions(baseTx, "1000", 550, 1700003601);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "expired_bounds");
    assert.match(result.message || "", /timebound expired/);
  });

  it("refuses transaction before min ledger bound is reached", () => {
    const result = validatePreconditions(baseTx, "1000", 499, 1700001000);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "precondition_failed");
    assert.match(result.message || "", /has not yet been reached/);
  });
});
