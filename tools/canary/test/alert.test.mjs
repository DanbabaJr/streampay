import assert from "node:assert/strict";
import test from "node:test";
import { renderAlert } from "../alert.mjs";

test("failure alert includes step, class, RPC excerpt, XDR, and run attribution", () => {
  const alert = renderAlert({
    status: "failed",
    network: "testnet",
    contractId: "C123",
    attribution: {
      commit: "abc123",
      actor: "canary-bot",
      runUrl: "https://github.com/example/repo/actions/runs/42",
    },
    failure: {
      step: "claim partial amount",
      failureClass: "simulation",
      rpcExcerpt: "contract rejected",
      transactionXdr: "unsigned-envelope",
      operationXdr: "operation-envelope",
    },
  });

  assert.match(alert, /Network: testnet/);
  assert.match(alert, /Step: claim partial amount/);
  assert.match(alert, /Failure class: simulation/);
  assert.match(alert, /RPC response: contract rejected/);
  assert.match(alert, /Transaction XDR \(unsigned\): unsigned-envelope/);
  assert.match(alert, /Operation XDR: operation-envelope/);
  assert.match(alert, /Commit: abc123/);
  assert.match(alert, /actions\/runs\/42/);
});
