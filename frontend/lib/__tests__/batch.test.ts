import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeSelection,
  decodeSelection,
  createStreamSnapshot,
  detectStaleSelections,
  checkContractBatchSupport,
  simulateSingleAction,
  simulateBatchAction,
  executeBatch,
  notifyBatchResult,
  type StreamSnapshot,
  type ItemSimulationFootprint,
} from "../batch.ts";

import type { StreamView } from "../stellar.ts";

test("URL Selection Encoding & Decoding handles all edge cases", () => {
  // Empty array
  assert.strictEqual(encodeSelection([]), "");
  assert.deepStrictEqual(decodeSelection(""), []);
  assert.deepStrictEqual(decodeSelection(null), []);
  assert.deepStrictEqual(decodeSelection(undefined), []);

  // Standard IDs
  assert.strictEqual(encodeSelection(["1", "2", "3"]), "1,2,3");
  assert.deepStrictEqual(decodeSelection("1,2,3"), ["1", "2", "3"]);

  // Deduplication & sorting
  assert.strictEqual(encodeSelection(["5", "2", "5", "1"]), "1,2,5");
  assert.deepStrictEqual(decodeSelection("5,2,5,1"), ["1", "2", "5"]);

  // Edge cases: whitespace, non-numeric, empty strings
  assert.strictEqual(encodeSelection([" 4 ", "abc", "", "-1", "7"]), "4,7");
  assert.deepStrictEqual(decodeSelection(" 4 , abc, , 7, -5, !! "), ["4", "7"]);
});

test("Stale-selection race detection invalidates modified or cancelled streams", () => {
  const baseStreams: StreamView[] = [
    {
      id: "1",
      sender: "GAAA",
      recipient: "GBBB",
      token: "T1",
      deposit: "1000",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    },
    {
      id: "2",
      sender: "GAAA",
      recipient: "GCCC",
      token: "T1",
      deposit: "500",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    },
    {
      id: "3",
      sender: "GAAA",
      recipient: "GDDD",
      token: "T1",
      deposit: "800",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: false,
      status: "Active",
    },
  ];

  // User selects stream 1, 2, and 3, taking snapshots
  const snapshots = new Map<string, StreamSnapshot>();
  for (const s of baseStreams) {
    snapshots.set(s.id, createStreamSnapshot(s));
  }

  // Scenario 1: No changes on-chain
  const check1 = detectStaleSelections(["1", "2", "3"], baseStreams, snapshots);
  assert.deepStrictEqual(check1.validIds, ["1", "2", "3"]);
  assert.strictEqual(check1.invalidated.length, 0);

  // Scenario 2: Live race — Stream #2 gets cancelled by sender mid-selection
  // Stream #3 gets withdrawn by recipient mid-selection
  const updatedStreams: StreamView[] = [
    baseStreams[0], // unchanged
    { ...baseStreams[1], status: "Cancelled" }, // cancelled on-chain!
    { ...baseStreams[2], withdrawn: "400" }, // withdrawn on-chain!
  ];

  const check2 = detectStaleSelections(
    ["1", "2", "3"],
    updatedStreams,
    snapshots
  );
  assert.deepStrictEqual(check2.validIds, ["1"]);
  assert.strictEqual(check2.invalidated.length, 2);

  const reasons = check2.invalidated.map((n) => n.reason);
  assert.ok(reasons.some((r) => r.includes("Stream #2 status changed")));
  assert.ok(reasons.some((r) => r.includes("Stream #3 withdrawn balance changed")));

  // Scenario 3: Stream removed / missing from current stream index
  const check3 = detectStaleSelections(["1", "99"], baseStreams, snapshots);
  assert.deepStrictEqual(check3.validIds, ["1"]);
  assert.strictEqual(check3.invalidated.length, 1);
  assert.ok(check3.invalidated[0].reason.includes("Stream #99 was not found"));
});

test("checkContractBatchSupport returns true against current contract", async () => {
  const supported = await checkContractBatchSupport();
  assert.strictEqual(supported, true);

  // Probe with simulated contract rejection code WithdrawBatchEmpty (#96)
  const probeWithCode96 = await checkContractBatchSupport(async () => true);
  assert.strictEqual(probeWithCode96, true);

  // Probe when contract does not support batching
  const probeUnsupported = await checkContractBatchSupport(async () => false);
  assert.strictEqual(probeUnsupported, false);
});

test("Sequential fallback execution handles pre-submit stale state and succeeds", async () => {
  const stream101: StreamView = {
    id: "101",
    sender: "GAAA",
    recipient: "GBBB",
    token: "T1",
    deposit: "1000",
    withdrawn: "0",
    startTime: 100,
    endTime: 200,
    cancelable: true,
    status: "Active",
  };
  const stream102: StreamView = {
    ...stream101,
    id: "102",
  };

  const sim101 = await simulateSingleAction(
    stream101,
    "withdraw_max",
    async () => 100n
  );
  const sim102 = await simulateSingleAction(
    stream102,
    "withdraw_max",
    async () => 0n
  );

  const items: ItemSimulationFootprint[] = [
    sim101,
    sim102,
  ];

  // Assert against real simulated values not hardcoded "100000" constant
  assert.strictEqual(items[0].estimatedFeeStroops, sim101.estimatedFeeStroops);
  assert.notStrictEqual(items[0].estimatedFeeStroops, "100000");
  assert.strictEqual(items[1].estimatedFeeStroops, sim102.estimatedFeeStroops);
  assert.notStrictEqual(items[1].estimatedFeeStroops, "100000");

  const progressLog: string[] = [];
  const result = await executeBatch({
    caller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    action: "withdraw_max",
    items,
    readStreamFn: async (id) => ({
      id,
      sender: "GAAA",
      recipient: "GBBB",
      token: "T1",
      deposit: "1000",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    }),
    readAvailableFn: async () => 100n,
    withdrawMaxFn: async () => "100",
    onProgress: (_comp, _tot, _curr, text) => {
      progressLog.push(text);
    },
  });

  // Verify execution mode is sequential fallback
  assert.strictEqual(result.mode, "sequential_fallback");
  assert.strictEqual(result.total, 1); // only 1 was ready
  assert.strictEqual(result.succeeded.length, 1);
  assert.strictEqual(result.failed.length, 0);
  assert.strictEqual(progressLog.length > 0, true);
});

test("Mixed success/failure batch scenario: reports honest per-action outcomes and never shows all-green summary", async () => {
  const caller = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const stream201: StreamView = {
    id: "201",
    sender: "GAAA",
    recipient: caller,
    token: "T1",
    deposit: "1000",
    withdrawn: "0",
    startTime: 100,
    endTime: 200,
    cancelable: true,
    status: "Active",
  };
  const stream202: StreamView = {
    ...stream201,
    id: "202",
  };

  const sim201 = await simulateSingleAction(
    stream201,
    "withdraw_max",
    async () => 250n
  );
  const sim202 = await simulateSingleAction(
    stream202,
    "withdraw_max",
    async () => 500n
  );

  const items: ItemSimulationFootprint[] = [
    sim201,
    sim202,
  ];

  // Assert against real simulated values not hardcoded "100000" constant
  assert.strictEqual(items[0].estimatedFeeStroops, sim201.estimatedFeeStroops);
  assert.notStrictEqual(items[0].estimatedFeeStroops, "100000");
  assert.strictEqual(items[1].estimatedFeeStroops, sim202.estimatedFeeStroops);
  assert.notStrictEqual(items[1].estimatedFeeStroops, "100000");

  const result = await executeBatch({
    caller,
    action: "withdraw_max",
    items,
    readStreamFn: async (id) => ({
      id,
      sender: "GAAA",
      recipient: caller,
      token: "T1",
      deposit: "1000",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    }),
    readAvailableFn: async () => 500n,
    withdrawMaxFn: async (_caller, id) => {
      if (id === "201") {
        return "250"; // Succeeded
      }
      // Stream 202 reverts on-chain!
      throw new Error("token transfer failed");
    },
  });

  // 1. Verify batch execution result structure
  assert.strictEqual(result.total, 2);
  assert.deepStrictEqual(result.succeeded, ["201"]);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].id, "202");
  assert.ok(result.failed[0].error.includes("token transfer failed"));

  // Verify per-item detailed results
  assert.strictEqual(result.results.length, 2);
  assert.strictEqual(result.results[0].streamId, "201");
  assert.strictEqual(result.results[0].status, "success");
  assert.strictEqual(result.results[0].paid, "250");

  assert.strictEqual(result.results[1].streamId, "202");
  assert.strictEqual(result.results[1].status, "failed");
  assert.ok(result.results[1].error?.includes("token transfer failed"));

  // 2. Verify UI Toast Notification honesty: must NOT be all-green summary
  const toastSuccessCalls: string[] = [];
  const toastErrorCalls: string[] = [];
  const toastInfoCalls: string[] = [];

  const mockToast = {
    success: (msg: string) => {
      toastSuccessCalls.push(msg);
    },
    error: (msg: string) => {
      toastErrorCalls.push(msg);
    },
    info: (msg: string) => {
      toastInfoCalls.push(msg);
    },
  };

  const notification = notifyBatchResult(result, mockToast);

  // Must report as mixed outcome
  assert.strictEqual(notification.type, "mixed");
  assert.strictEqual(notification.succeededCount, 1);
  assert.strictEqual(notification.failedCount, 1);

  // Assert both outcomes are reflected in UI toasts
  assert.strictEqual(toastSuccessCalls.length, 1);
  assert.ok(
    toastSuccessCalls[0].includes(
      "Partial batch success: 1 stream succeeded (#201)"
    )
  );

  assert.strictEqual(toastErrorCalls.length, 1);
  assert.ok(
    toastErrorCalls[0].includes(
      "Batch operation failures: 1 stream reverted on-chain (#202"
    )
  );

  // Crucial check: verify that an all-green summary was NEVER emitted
  const allSuccessText = toastSuccessCalls.join(" ");
  assert.strictEqual(
    allSuccessText.includes("all 2 streams processed successfully"),
    false
  );
});

test("Simulation modal footprint calculation accurately reflects per-item and aggregate resources", async () => {
  const testStreams: StreamView[] = [
    {
      id: "301",
      sender: "GAAA",
      recipient: "GBBB",
      token: "T1",
      deposit: "1000",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    },
    {
      id: "302",
      sender: "GAAA",
      recipient: "GBBB",
      token: "T1",
      deposit: "1000",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: false,
      status: "Active",
    },
  ];

  // Test simulation for cancel: stream 301 is cancelable, stream 302 is non-cancelable (ineligible)
  const sim = await simulateBatchAction(testStreams, "cancel");
  assert.strictEqual(sim.items.length, 2);
  assert.strictEqual(sim.validCount, 1);
  assert.strictEqual(sim.ineligibleCount, 1);
  assert.strictEqual(sim.items[0].status, "ready");
  assert.strictEqual(sim.items[1].status, "ineligible");
  assert.ok(sim.items[1].error?.includes("non-cancelable"));

  // The cost of this batch is a sum of real simulated fees
  assert.strictEqual(sim.totalFeeStroops, sim.items[0].estimatedFeeStroops);
  assert.notStrictEqual(sim.totalFeeStroops, "100000");
});
