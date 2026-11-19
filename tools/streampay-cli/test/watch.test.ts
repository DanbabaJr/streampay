import assert from "node:assert/strict";
import test from "node:test";
import { decodeStreamState, type StreamState } from "../src/state.ts";
import { watchStream, type WatchChangeLine, type WatchSummaryLine } from "../src/watch.ts";
import { schemaError } from "./schema.ts";

const contract = "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL";

function stream(withdrawn: number): StreamState {
  return decodeStreamState({
    id: 7n,
    sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    token: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    deposit: 1_000n,
    withdrawn: BigInt(withdrawn),
    start_time: 1_700_000_000n,
    end_time: 1_700_086_400n,
    cancelable: true,
    status: "Active",
  });
}

test("watch emits one line per change, nothing for unchanged polls", async () => {
  const controller = new AbortController();
  const sequence = [0, 0, 1, 1, 1, 2];
  let reads = 0;
  const lines: Array<WatchChangeLine | WatchSummaryLine> = [];

  const result = await watchStream({
    command: "status",
    network: "testnet",
    contract,
    intervalMs: 1,
    signal: controller.signal,
    readStream: async () => {
      if (reads === sequence.length) {
        controller.abort();
        return stream(0);
      }
      const withdrawn = sequence[reads];
      reads += 1;
      return stream(withdrawn ?? 0);
    },
    writeLine: (line) => lines.push(line),
  });

  const changes = lines.filter(
    (line): line is WatchChangeLine => line.event === "change"
  );
  const summary = lines.at(-1) as WatchSummaryLine;

  // Six polls, three distinct states: the three unchanged polls emit nothing.
  assert.equal(result.polls, 6);
  assert.equal(result.changes, 3);
  assert.deepEqual(changes.map((line) => line.sequence), [1, 2, 3]);
  assert.deepEqual(changes.map((line) => line.stream.withdrawn), ["0", "1", "2"]);
  assert.equal(summary.event, "summary");
  assert.equal(summary.reason, "sigint");
  assert.equal(summary.polls, 6);
  assert.equal(summary.changes, 3);
  assert.deepEqual(summary.stream, stream(2));

  for (const line of lines) {
    assert.equal(schemaError(line), null, JSON.stringify(line));
  }
});

test("watch flushes a summary when stopped before the first poll", async () => {
  const controller = new AbortController();
  const lines: Array<WatchChangeLine | WatchSummaryLine> = [];
  controller.abort();

  const result = await watchStream({
    command: "get",
    network: "mainnet",
    contract,
    intervalMs: 1,
    signal: controller.signal,
    readStream: async () => stream(0),
    writeLine: (line) => lines.push(line),
  });

  assert.equal(result.polls, 0);
  assert.equal(result.changes, 0);
  assert.equal(lines.length, 1);
  const summary = lines[0] as WatchSummaryLine;
  assert.equal(summary.event, "summary");
  assert.equal(summary.stream, null);
  assert.equal(schemaError(summary), null);
});
