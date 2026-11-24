import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mockStream, startMockRpc } from "./mock-rpc.ts";
import { schemaError } from "./schema.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const contract = "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL";

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function spawnCli(args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...args],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  child.stdin.end();
  return child;
}

function collect(child: ChildProcessWithoutNullStreams): {
  stdout: () => string;
  stderr: () => string;
  wait: () => Promise<RunResult>;
} {
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  return {
    stdout: () => out,
    stderr: () => err,
    wait: () =>
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout: out, stderr: err }));
      }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for CLI output");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("SIGINT ends watch mode with exit 0 and a schema-valid summary", { timeout: 30_000 }, async () => {
  const rpc = await startMockRpc(contract, [
    mockStream({ withdrawn: 0n }),
    mockStream({ withdrawn: 1n }),
    mockStream({ withdrawn: 2n }),
  ]);
  const child = spawnCli([
    "--contract",
    contract,
    "--rpc-url",
    rpc.url,
    "--network",
    "testnet",
    "status",
    "--stream-id",
    "7",
    "--watch",
    "--interval",
    "1000",
  ]);
  const output = collect(child);
  try {
    await waitFor(
      () =>
        jsonLines(output.stdout()).filter((line) => line.event === "change").length >= 2,
      20_000
    );
    assert.ok(child.kill("SIGINT"));
    const result = await output.wait();

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    const lines = jsonLines(result.stdout);
    for (const line of lines) {
      assert.equal(schemaError(line), null, JSON.stringify(line));
    }
    const changes = lines.filter((line) => line.event === "change");
    assert.deepEqual(
      changes.map((line) => line.sequence),
      changes.map((_, index) => index + 1)
    );
    const summary = lines.at(-1) as Record<string, unknown>;
    assert.equal(summary.event, "summary");
    assert.equal(summary.reason, "sigint");
    assert.equal(summary.changes, changes.length);
    assert.ok((summary.changes as number) >= 2);
    assert.ok((summary.polls as number) >= 2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rpc.close();
  }
});

test("unchanged watch polls emit nothing", { timeout: 30_000 }, async () => {
  const rpc = await startMockRpc(contract, [mockStream({ withdrawn: 9n })]);
  const child = spawnCli([
    "--contract",
    contract,
    "--rpc-url",
    rpc.url,
    "status",
    "--stream-id",
    "7",
    "--watch",
    "--interval",
    "1000",
  ]);
  const output = collect(child);
  try {
    await waitFor(
      () => jsonLines(output.stdout()).some((line) => line.event === "change"),
      20_000
    );
    // At least one more poll at 1000 ms observes the same state.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.ok(child.kill("SIGINT"));
    const result = await output.wait();

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const lines = jsonLines(result.stdout);
    assert.equal(lines.filter((line) => line.event === "change").length, 1);
    const summary = lines.at(-1) as Record<string, unknown>;
    assert.equal(summary.changes, 1);
    assert.ok((summary.polls as number) >= 2);
    for (const line of lines) {
      assert.equal(schemaError(line), null, JSON.stringify(line));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rpc.close();
  }
});

test("non-watch output is a single stable JSON line despite ledger noise", { timeout: 30_000 }, async () => {
  const rpc = await startMockRpc(contract, [mockStream({ withdrawn: 4n })]);
  const args = [
    "--contract",
    contract,
    "--rpc-url",
    rpc.url,
    "--network",
    "testnet",
    "--json",
    "get",
    "--stream-id",
    "7",
  ];
  try {
    const first = collect(spawnCli(args));
    const firstResult = await first.wait();
    assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);

    const second = collect(spawnCli(args));
    const secondResult = await second.wait();
    assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);

    // The mock's latestLedger advances between calls; the snapshot must not.
    assert.equal(firstResult.stdout, secondResult.stdout);
    const lines = jsonLines(firstResult.stdout);
    assert.equal(lines.length, 1);
    assert.equal(schemaError(lines[0]), null);
    assert.equal(lines[0]?.command, "get");
    assert.equal((lines[0]?.stream as Record<string, unknown>).withdrawn, "4");
  } finally {
    await rpc.close();
  }
});

test("watch interval below the documented minimum is rejected", { timeout: 30_000 }, async () => {
  const child = spawnCli([
    "--contract",
    contract,
    "--rpc-url",
    "http://127.0.0.1:1",
    "--json",
    "status",
    "--stream-id",
    "7",
    "--watch",
    "--interval",
    "500",
  ]);
  const result = await collect(child).wait();
  assert.equal(result.code, 2);
  const line = jsonLines(result.stdout)[0] as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(line.ok, false);
  assert.equal(line.error.code, "USAGE");
  assert.equal(schemaError(line), null);
});
