import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const contract = process.env.STREAMPAY_TEST_CONTRACT_ID;
const source = process.env.STREAMPAY_TEST_SOURCE;
const streamId = process.env.STREAMPAY_TEST_STREAM_ID;
const rpcUrl = process.env.STREAMPAY_TEST_RPC_URL ?? "https://soroban-testnet.stellar.org";
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("sandbox dry-run returns RPC footprint and simulated transfer deltas", {
  skip: !contract || !source || !streamId,
}, () => {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    cliPath,
    "--contract", contract!,
    "--rpc-url", rpcUrl,
    "--source", source!,
    "--signer", "ledger",
    "--dry-run",
    "--json",
    "withdraw",
    "--stream-id", streamId!,
    "--amount", "1",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    schemaVersion: number;
    status: string;
    batches: Array<{ simulation: { footprint: { readWrite: string[] }; expectedBalances: { changes: unknown[] } } }>;
  };
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.status, "simulated");
  assert.ok(output.batches[0]?.simulation.footprint.readWrite.length);
  assert.ok(output.batches[0]?.simulation.expectedBalances.changes.length);
});