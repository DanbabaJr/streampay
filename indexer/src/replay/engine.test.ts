import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { StreamStore } from "../store.js";
import type { DecodedEvent } from "../types.js";
import { buildMerkleTree } from "../proof.js";
import { sanitizeAddress } from "../privacy.js";
import {
  ArrayReplaySource,
  ReplayEngine,
  ReplayFixtureError,
  SqliteReplaySource,
  computeReplayStateRoot,
  planReplayRanges,
  type ReplayEventRow,
  type ReplayRunOptions,
} from "./engine.js";
import { MissingUpcasterError } from "./upcasters.js";

const CONTRACT = "C" + "A".repeat(55);
const SENDER = "G" + "A".repeat(55);
const RECIPIENT = "G" + "B".repeat(55);
const TOKEN = "C" + "C".repeat(55);

const stores: StreamStore[] = [];
function newStore(): StreamStore {
  const store = new StreamStore(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function history(): ReplayEventRow[] {
  return [
    {
      id: "ev-1", streamId: "1", name: "stream_created", ledger: 10, ledgerClosedAt: "2026-01-01T00:00:10Z",
      payload: { sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: "1000", start_time: "1704067200", end_time: "1704153600", cancelable: true },
    },
    {
      id: "ev-2", streamId: "1", name: "withdrawn", ledger: 11, ledgerClosedAt: "2026-01-01T00:00:11Z",
      payload: { recipient: RECIPIENT, amount: "100", withdrawn_total: "100" },
    },
    {
      id: "ev-3", streamId: "1", name: "stream_topped_up", ledger: 12, ledgerClosedAt: "2026-01-01T00:00:12Z",
      payload: { sender: SENDER, amount: "500", new_deposit: "1500" },
    },
    {
      id: "ev-4", streamId: "1", name: "stream_cancelled", ledger: 13, ledgerClosedAt: "2026-01-01T00:00:13Z",
      payload: { cancelled_by: SENDER, recipient_amount: "300", sender_amount: "700" },
    },
  ];
}

function options(overrides: Partial<ReplayRunOptions> = {}): ReplayRunOptions {
  return { job: "test-job", contractId: CONTRACT, fromLedger: 10, toLedger: 13, ...overrides };
}

test("planReplayRanges covers the window in ascending, disjoint ranges", () => {
  assert.deepEqual(planReplayRanges(10, 20, 4), [
    { fromLedger: 10, toLedger: 13 },
    { fromLedger: 14, toLedger: 17 },
    { fromLedger: 18, toLedger: 20 },
  ]);
  assert.deepEqual(planReplayRanges(10, 10, 4), [{ fromLedger: 10, toLedger: 10 }]);
  assert.deepEqual(planReplayRanges(10, 9, 4), []);
  assert.throws(() => planReplayRanges(10, 20, 0), RangeError);
  assert.throws(() => planReplayRanges(-1, 20, 4), RangeError);
});

test("parallel ranges project in ledger order and preserve per-stream order", async () => {
  const store = newStore();
  const engine = new ReplayEngine(store, new ArrayReplaySource(history()));

  const result = await engine.run(options({ rangeSize: 1, concurrency: 4 }));

  assert.deepEqual(result.ranges.map((range) => range.fromLedger), [10, 11, 12, 13]);
  assert.equal(result.events, 4);
  assert.equal(result.skippedRanges, 0);
  assert.equal(result.resumedFrom, null);

  const stream = store.getStream("1")!;
  assert.equal(stream.status, "cancelled");
  assert.equal(stream.deposit, "1500");
  assert.equal(stream.withdrawn, "400", "withdrawn 100 + cancelled recipient_amount 300");
  assert.equal(stream.lastLedger, 13);
  assert.deepEqual(store.getStreamHistory("1").map((row) => row.event_type), [
    "stream_created", "withdrawn", "stream_topped_up", "stream_cancelled",
  ]);
  assert.equal(engine.checkpoint("test-job")!.watermark, 13);
});

test("replay is a projection only: no outbox intent and no webhook delivery is queued", async () => {
  const store = newStore();
  await new ReplayEngine(store, new ArrayReplaySource(history())).run(options({ rangeSize: 2, concurrency: 2 }));

  const count = (table: string): number =>
    (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count("outbox_events"), 0);
  assert.equal(count("outbox_intents"), 0);
  assert.equal(count("webhook_deliveries"), 0);
  assert.equal(count("events"), 4, "the journal refuses to hold the same event twice");
});

test("a crashed run resumes from its checkpoint and lands on the uninterrupted root", async () => {
  const fullStore = newStore();
  const full = await new ReplayEngine(fullStore, new ArrayReplaySource(history())).run(options({ rangeSize: 1 }));

  const store = newStore();
  const engine = new ReplayEngine(store, new ArrayReplaySource(history()));
  let applied = 0;
  await assert.rejects(
    engine.run(options({
      rangeSize: 1,
      concurrency: 2,
      onRangeApplied: () => {
        applied += 1;
        if (applied === 2) throw new Error("process died");
      },
    })),
    /process died/,
  );

  assert.equal(applied, 2);
  assert.equal(engine.checkpoint("test-job")!.watermark, 11, "only applied ranges are checkpointed");
  assert.equal(store.getStream("1")!.withdrawn, "100");

  const resumed = await engine.run(options({ rangeSize: 1 }));
  assert.equal(resumed.resumedFrom, 11);
  assert.equal(resumed.skippedRanges, 2);
  assert.equal(resumed.events, 2);
  assert.equal(resumed.stateRoot, full.stateRoot);
  assert.equal(computeReplayStateRoot(store.listAllStreams()), full.stateRoot);
});

test("an unknown event schema version aborts before anything is checkpointed", async () => {
  const store = newStore();
  const rows = history();
  rows[2] = { ...rows[2], name: "stream_paused", ledger: 12, payload: {}, schemaVersion: 0 };
  const engine = new ReplayEngine(store, new ArrayReplaySource(rows));

  await assert.rejects(engine.run(options()), MissingUpcasterError);
  assert.equal(engine.checkpoint("test-job"), undefined);
  assert.equal(store.getStream("1"), undefined);
});

test("a malformed payload aborts the range instead of projecting it", async () => {
  const store = newStore();
  const rows = history();
  rows[1] = { ...rows[1], payload: "{\"truncated\":" };
  const engine = new ReplayEngine(store, new ArrayReplaySource(rows));

  await assert.rejects(
    engine.run(options()),
    (err: unknown) => err instanceof ReplayFixtureError && err.eventId === "ev-2",
  );
  assert.equal(engine.checkpoint("test-job"), undefined);
});

test("the state root is independent of range size, concurrency and stream order", async () => {
  const one = newStore();
  const serial = await new ReplayEngine(one, new ArrayReplaySource(history())).run(options({ rangeSize: 10, concurrency: 1 }));
  const four = newStore();
  const parallel = await new ReplayEngine(four, new ArrayReplaySource(history())).run(options({ rangeSize: 1, concurrency: 4 }));

  assert.equal(serial.stateRoot, parallel.stateRoot);

  const streams = one.listAllStreams();
  assert.equal(computeReplayStateRoot(streams), computeReplayStateRoot([...streams].reverse()));
  assert.equal(computeReplayStateRoot([]), buildMerkleTree([]).root);
});

test("redaction is applied at the upcast boundary and stays deterministic", async () => {
  const plain = newStore();
  const plainResult = await new ReplayEngine(plain, new ArrayReplaySource(history())).run(options({ redact: false }));
  const redacted = newStore();
  const redactedResult = await new ReplayEngine(redacted, new ArrayReplaySource(history())).run(options({ redact: true }));

  assert.equal(redacted.getStream("1")!.sender, sanitizeAddress(SENDER), "8-character prefix, same as the live read paths");
  assert.notEqual(redactedResult.stateRoot, plainResult.stateRoot);

  const again = newStore();
  const repeated = await new ReplayEngine(again, new ArrayReplaySource(history())).run(options({ redact: true }));
  assert.equal(repeated.stateRoot, redactedResult.stateRoot);
});

test("legacy journal rows are counted as upcast; current rows are left alone", async () => {
  const store = newStore();
  const rows = history();
  rows[1] = { ...rows[1], schemaVersion: 0, payload: { recipient: RECIPIENT, amount: "100", total: "100" } };
  rows[2] = { ...rows[2], schemaVersion: 0, payload: { sender: SENDER, amount: "500", deposit: "1500" } };
  const result = await new ReplayEngine(store, new ArrayReplaySource(rows)).run(options());

  assert.equal(result.upcast, 2);
  assert.equal(store.getStream("1")!.deposit, "1500");
  assert.equal(store.getStream("1")!.withdrawn, "400");
});

test("the SQLite source reads committed rows in ledger order and refuses broken JSON", () => {
  const store = newStore();
  const event: DecodedEvent = {
    id: "ev-sql-1", pagingToken: "ev-sql-1", ledger: 10, ledgerClosedAt: "2026-01-01T00:00:10Z",
    contractId: CONTRACT, name: "stream_created", streamId: "1",
    data: { sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: "1000", start_time: "1", end_time: "2", cancelable: true },
  };
  store.ingest(event);
  const source = new SqliteReplaySource(store.db);
  const [row] = source.readRange(10, 10);
  assert.equal(row.id, "ev-sql-1");
  assert.deepEqual(row.payload, event.data);
  assert.equal(row.schemaVersion, undefined, "journals without a schema_version column replay at the current version");

  store.db
    .prepare("INSERT INTO events (id, stream_id, name, ledger, ledger_closed_at, payload) VALUES (?, ?, ?, ?, ?, ?)")
    .run("ev-sql-2", "1", "withdrawn", 11, "2026-01-01T00:00:11Z", "{\"truncated\":");
  assert.throws(() => source.readRange(10, 11), (err: unknown) => err instanceof ReplayFixtureError && err.eventId === "ev-sql-2");
});
