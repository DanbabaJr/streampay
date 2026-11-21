/**
 * Tests for horizontal sharding by stream-id range (issue #578).
 *
 * The contract under test:
 * - a stream always lands on exactly one shard, in ledger order, and a
 *   shard boundary never splits it;
 * - cross-shard reads merge with a stable order/cursor and dedup;
 * - outbox rows are exactly-once across shards, including across a move;
 * - a rebalance interrupted mid-move (including by a full node loss, i.e.
 *   close + reopen of file-backed databases) resumes from its durable
 *   checkpoint with no lost or duplicated streams/events.
 *
 * Shard layout in these tests: 3 shards, rangeSize 10, so
 * `[0,10) -> 0`, `[10,20) -> 1`, `[20,30) -> 2`, `[30,40) -> 0`, …
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ShardMap, STREAMLESS_SHARD } from "./sharding/shard-map.js";
import { ShardedStore } from "./sharding/sharded-store.js";
import { ShardRebalancer } from "./sharding/rebalancer.js";
import { collectShardingMetrics, renderShardingMetricsPrometheus } from "./sharding/metrics.js";
import type { DecodedEvent, EventValue } from "./types.js";

function makeEvent(
  id: string,
  streamId: string | null,
  ledger: number,
  name: string,
  data: Record<string, EventValue> = {}
): DecodedEvent {
  return {
    id,
    pagingToken: String(ledger),
    ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 1_000).toISOString(),
    contractId: "C",
    name,
    streamId,
    data,
  };
}

function createdEvent(streamId: string, ledger: number, recipient?: string): DecodedEvent {
  return makeEvent(`ev-${streamId}-created`, streamId, ledger, "stream_created", {
    sender: `GSENDER${streamId}`,
    recipient: recipient ?? `GRECIPIENT${streamId}`,
    token: "CTOKEN",
    deposit: "15000000",
    start_time: "1000",
    end_time: "2000",
    cancelable: true,
  });
}

function withdrawnEvent(streamId: string, ledger: number, total: string): DecodedEvent {
  return makeEvent(`ev-${streamId}-withdrawn-${ledger}`, streamId, ledger, "withdrawn", {
    withdrawn_total: total,
  });
}

/** Ingest one full stream (create + withdraw) on a sharded store. */
function ingestStream(store: ShardedStore, streamId: string, baseLedger: number, recipient?: string): void {
  store.ingestPage([createdEvent(streamId, baseLedger, recipient), withdrawnEvent(streamId, baseLedger + 5, "200")], undefined, baseLedger + 5);
}

test("shard map: contiguous ranges, deterministic, boundary ids split correctly", () => {
  const map = new ShardMap({ shardCount: 3, rangeSize: 10 });
  assert.equal(map.shardForStreamId("5"), 0);
  assert.equal(map.shardForStreamId("9"), 0);
  assert.equal(map.shardForStreamId("10"), 1);
  assert.equal(map.shardForStreamId("19"), 1);
  assert.equal(map.shardForStreamId("20"), 2);
  assert.equal(map.shardForStreamId("29"), 2);
  assert.equal(map.shardForStreamId("30"), 0);
  // Same stream, same shard, every time.
  assert.equal(map.shardForStreamId("15"), map.shardForStreamId("15"));
  // A stream and its range agree, and ranges are contiguous blocks.
  assert.deepEqual(
    { start: map.rangeForStreamId("15").start, end: map.rangeForStreamId("15").end },
    { start: 10n, end: 20n }
  );
  // Stream-less events have a designated shard, not a hash.
  assert.equal(map.shardForStreamId(null), STREAMLESS_SHARD);
  assert.equal(STREAMLESS_SHARD, 0);
  // Non-numeric ids are hashed deterministically onto one shard.
  const hashed = map.shardForStreamId("GRECIPIENT");
  assert.ok(hashed >= 0 && hashed < 3);
  assert.equal(map.shardForStreamId("GRECIPIENT"), hashed);
  // Overrides move a whole range.
  map.moveRange(10n, 2);
  assert.equal(map.shardForStreamId("15"), 2);
  assert.equal(map.shardForStreamId("5"), 0, "other ranges are untouched");
});

test("partitioned ingestion: one stream, one shard, per-stream order preserved", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    ingestStream(store, "5", 10);
    ingestStream(store, "12", 20);
    ingestStream(store, "25", 30);

    assert.equal(store.shardForStreamId("5"), 0);
    assert.equal(store.shardForStreamId("12"), 1);
    assert.equal(store.shardForStreamId("25"), 2);
    assert.equal(store.shards[0]!.getStream("12"), undefined, "stream 12 is not on shard 0");
    assert.equal(store.shards[1]!.getStream("12")?.withdrawn, "200");
    assert.equal(store.getStream("25")?.deposit, "15000000");

    // A late event (older ledger than the projection) is journalled for
    // history but never rewinds the projection — the monotonic guard, per shard.
    store.ingest(withdrawnEvent("5", 11, "100"));
    assert.equal(store.getStream("5")?.withdrawn, "200", "late delivery did not rewind withdrawn");
    assert.equal(store.sequencerMetrics().lateEvents, 1, "gap/late signal is recorded");
    assert.equal(store.getStreamHistory("5").length, 3, "the late event is still in history");

    // Duplicate delivery of the same event id is a no-op everywhere.
    const before = store.counts().reduce((n, c) => n + c.events, 0);
    store.ingestPage([createdEvent("5", 10)], "10", 10);
    assert.equal(store.counts().reduce((n, c) => n + c.events, 0), before);
  } finally {
    store.close();
  }
});

test("stream-less events go to the designated shard and touch no projection", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    const freeze = makeEvent("freeze-1", null, 20, "contract_frozen_state_changed", { frozen: true });
    assert.equal(store.ingest(freeze), STREAMLESS_SHARD);
    const row = store.shards[0]!.db.prepare("SELECT stream_id FROM events WHERE id = 'freeze-1'").get() as { stream_id: string | null };
    assert.equal(row.stream_id, null);
    assert.equal((store.shards[1]!.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
    assert.equal(store.listAddress("Ggov").length, 0);
  } finally {
    store.close();
  }
});

test("cross-shard address portfolios merge, dedup, and page with a stable cursor", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    for (const [id, ledger] of [["5", 10], ["12", 20], ["15", 30], ["25", 40], ["32", 50]] as const) {
      ingestStream(store, id, ledger, "GCOMMON");
    }
    const all = store.listAddress("GCOMMON");
    assert.deepEqual(all.map((s) => s.streamId), ["5", "12", "15", "25", "32"]);
    assert.deepEqual(
      store.listStreamsByRecipient("GCOMMON").map((s) => s.streamId),
      ["5", "12", "15", "25", "32"]
    );

    // Paging with limit 2 walks the same total order, disjointly.
    const p1 = store.listAddressPaged("GCOMMON", { limit: 2 });
    const p2 = store.listAddressPaged("GCOMMON", { limit: 2, cursor: p1.nextCursor });
    const p3 = store.listAddressPaged("GCOMMON", { limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(p1.streams.map((s) => s.streamId), ["5", "12"]);
    assert.deepEqual(p2.streams.map((s) => s.streamId), ["15", "25"]);
    assert.deepEqual(p3.streams.map((s) => s.streamId), ["32"]);
    assert.equal(p3.nextCursor, null);
    // Cursor stability: re-reading a cursor returns the same page.
    const p2again = store.listAddressPaged("GCOMMON", { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2again.streams.map((s) => s.streamId), ["15", "25"]);
    assert.equal(p2again.nextCursor, p2.nextCursor);
  } finally {
    store.close();
  }
});

test("cross-shard getEventsAfter merges in (ledger, id) order", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    store.ingestPage(
      [createdEvent("5", 10), createdEvent("25", 11), withdrawnEvent("5", 12, "200"), withdrawnEvent("25", 13, "300")],
      undefined,
      13
    );
    const after = store.getEventsAfter("ev-5-created");
    assert.deepEqual(after.map((e) => e.id), ["ev-25-created", "ev-5-withdrawn-12", "ev-25-withdrawn-13"]);
    assert.equal(store.getEventsAfter("no-such-event").length, 0);
    // Single-stream form still routes to one shard.
    assert.deepEqual(
      store.getEventsAfter("ev-5-created", undefined, "5").map((e) => e.id),
      ["ev-5-withdrawn-12"]
    );
  } finally {
    store.close();
  }
});

test("exactly-once outbox across shards: duplicate deliveries journal once", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    const events = [createdEvent("5", 10), createdEvent("25", 11)];
    store.ingestPage(events, "11", 11);
    store.ingestPage(events, "11", 11); // duplicate delivery of the whole page
    store.ingest(createdEvent("5", 10)); // and again, singly
    const outbox = store.listOutboxEvents();
    assert.equal(outbox.length, 2, "one outbox row per event, across shards");
    assert.deepEqual(outbox.map((e) => e.event_id), ["ev-5-created", "ev-25-created"]);
    assert.equal(new Set(outbox.map((e) => e.idempotency_key)).size, 2);
    const replay = store.replayOutbox("5", 0, 10);
    assert.equal(replay.events.length, 1);
    assert.equal(replay.events[0]!.event_id, "ev-5-created");
  } finally {
    store.close();
  }
});

test("rebalance moves a range with no lost or duplicated streams/events", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    ingestStream(store, "5", 10);
    ingestStream(store, "12", 20);
    ingestStream(store, "15", 30);
    ingestStream(store, "25", 40);
    const beforeStreams = store.listAllStreams().map((s) => s.streamId).sort();
    const beforeEvents = store.allEventIds();
    const beforeAddress = store.listAddress("GRECIPIENT12").map((s) => s.streamId);

    const rebalancer = new ShardRebalancer(store);
    const cp = rebalancer.startMove(10n, 2, { batchSize: 1 });
    assert.equal(cp.status, "done");
    assert.equal(cp.streamsCopied, 2);
    assert.equal(cp.eventsCopied, 4);

    assert.equal(store.shardForStreamId("12"), 2);
    assert.equal(store.shardForStreamId("15"), 2);
    assert.equal(store.getStream("12")?.withdrawn, "200");
    assert.equal(store.getStream("15")?.withdrawn, "200");
    assert.equal(store.shards[1]!.getStream("12"), undefined, "source copy is gone");
    assert.deepEqual(store.listAllStreams().map((s) => s.streamId).sort(), beforeStreams);
    assert.deepEqual(store.allEventIds(), beforeEvents);
    assert.deepEqual(store.listAddress("GRECIPIENT12").map((s) => s.streamId), beforeAddress);
    // Outbox rows moved with the range, still exactly once.
    assert.equal(store.listOutboxEvents().length, 8);
    // Cursors survive the move: the merged order is unchanged.
    assert.deepEqual(store.listAddress("GRECIPIENT12").map((s) => s.streamId), ["12"]);
    assert.deepEqual(rebalancer.progress(cp.moveId), {
      moveId: cp.moveId,
      status: "done",
      rangesMoved: 1,
      rangesTotal: 1,
      streamsCopied: 2,
      totalStreams: 2,
      eventsCopied: 4,
      totalEvents: 4,
      lastCopiedStreamId: "15",
      fromShard: 1,
      toShard: 2,
    });
  } finally {
    store.close();
  }
});

test("crash mid-rebalance + node loss: resume from checkpoint, no loss or duplication", () => {
  const dir = mkdtempSync(join(tmpdir(), "streampay-sharding-578-"));
  const basePath = join(dir, "shard");
  let store = new ShardedStore({ shardCount: 3, rangeSize: 10, basePath });
  try {
    ingestStream(store, "5", 10);
    ingestStream(store, "12", 20);
    ingestStream(store, "15", 30);
    ingestStream(store, "18", 40);
    ingestStream(store, "25", 50);
    const beforeStreams = store.listAllStreams().map((s) => s.streamId).sort();
    const beforeEvents = store.allEventIds();
    const beforeOutbox = store.listOutboxEvents().map((e) => e.idempotency_key).sort();
    const beforeHistory12 = store.getStreamHistory("12").map((e) => e.id);

    // Chaos: fail after the first checkpointed batch, mid-move.
    const rebalancer = new ShardRebalancer(store);
    assert.throws(
      () => rebalancer.startMove(10n, 2, { batchSize: 1, failAfterBatches: 1 }),
      /simulated crash mid-rebalance/
    );
    const cp = rebalancer.checkpoint("move-10-1-to-2")!;
    assert.equal(cp.status, "copying");
    assert.equal(cp.streamsCopied, 1);
    assert.equal(cp.lastCopiedStreamId, "12");
    // The map has not switched: the source is still authoritative.
    assert.equal(store.shardForStreamId("12"), 1);
    assert.equal(store.getStream("12")?.withdrawn, "200");
    assert.deepEqual(store.listAllStreams().map((s) => s.streamId).sort(), beforeStreams);
    assert.deepEqual(store.allEventIds(), beforeEvents);

    // Node loss: close every shard (the "node" dies) and reopen from disk.
    store.close();
    store = new ShardedStore({ shardCount: 3, rangeSize: 10, basePath });
    const recovered = new ShardRebalancer(store);
    const resumed = recovered.resumeAllIncomplete();
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.status, "done");

    // No lost or duplicated projections after the crash + resume.
    assert.deepEqual(store.listAllStreams().map((s) => s.streamId).sort(), beforeStreams);
    assert.deepEqual(store.allEventIds(), beforeEvents);
    assert.equal(store.allEventIds().size, beforeEvents.size);
    assert.deepEqual(store.listOutboxEvents().map((e) => e.idempotency_key).sort(), beforeOutbox);
    assert.deepEqual(store.getStreamHistory("12").map((e) => e.id), beforeHistory12);
    assert.equal(store.getStream("15")?.withdrawn, "200");
    assert.equal(store.shardForStreamId("18"), 2);
    // Resuming a finished move is a no-op.
    assert.equal(recovered.resumeAllIncomplete().length, 0);
  } finally {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metrics: per-shard lag and rebalance progress, plus Prometheus render", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    ingestStream(store, "5", 10); // shard 0, lastLedger 15
    ingestStream(store, "12", 20); // shard 1, lastLedger 25
    // Shard 2 holds nothing: lastLedger 0, full lag.
    const rebalancer = new ShardRebalancer(store);
    const cp = rebalancer.startMove(10n, 2, { batchSize: 5 });
    const metrics = collectShardingMetrics(store, { tipLedger: 100, rebalance: [rebalancer.progress(cp.moveId)!] });
    assert.equal(metrics.totalStreams, 2);
    assert.equal(metrics.totalEvents, 4);
    assert.equal(metrics.maxLastLedger, 25);
    assert.deepEqual(
      metrics.shards.map((s) => [s.shard, s.lastLedger, s.lag]),
      [[0, 15, 85], [1, 0, 100], [2, 25, 75]]
    );
    assert.equal(metrics.rebalance[0]!.rangesMoved, 1);
    const text = renderShardingMetricsPrometheus(metrics);
    assert.match(text, /streampay_shard_streams\{shard="0"\} 1/);
    assert.match(text, /streampay_shard_lag_ledgers\{shard="2"\} 75/);
    assert.match(text, /streampay_rebalance_events_copied\{move="move-10-1-to-2"\} 2/);
  } finally {
    store.close();
  }
});

test("sharded store implements the pipeline IngestSink (global state on shard 0)", () => {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  try {
    store.setState("ingest_ledger", "42");
    assert.equal(store.getState("ingest_ledger"), "42");
    ingestStream(store, "5", 10);
    ingestStream(store, "25", 20);
    assert.deepEqual([...store.maxLedgerByStream().entries()].sort(), [["25", 25], ["5", 15]]);
  } finally {
    store.close();
  }
});
