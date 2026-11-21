import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamPayError, decodeError } from "../src/errors.js";
import { contractErrorName, contractErrorFromMessage } from "../src/generated.js";

test("contract error codes map to names", () => {
  assert.equal(contractErrorName(10), "AmountExceedsAvailable");
  assert.equal(contractErrorName(999), undefined);
  assert.equal(contractErrorFromMessage("HostError: Error(Contract, #13)"), 13);
  assert.equal(contractErrorFromMessage("network down"), undefined);
});

test("simulation failures keep the contract code", () => {
  const error = StreamPayError.fromRpc(
    "simulation",
    "HostError: Error(Contract, #10)",
    "AAAA"
  );
  assert.equal(error.kind, "simulation");
  assert.deepEqual(error.contract, { code: 10, name: "AmountExceedsAvailable" });
  assert.match(error.message, /simulation failed: AmountExceedsAvailable \(#10\)/);
  assert.equal(error.transactionXdr, "AAAA");
});

test("submission failures without a contract code are still classified", () => {
  const error = StreamPayError.fromRpc("submission", "tx_bad_seq");
  assert.equal(error.kind, "submission");
  assert.equal(error.contract, undefined);
  assert.match(error.message, /submission failed: tx_bad_seq/);
});

test("decode failures are their own class", () => {
  const error = decodeError("expected u64, got bool");
  assert.equal(error.kind, "decode");
  assert.match(error.message, /decode failed/);
});
