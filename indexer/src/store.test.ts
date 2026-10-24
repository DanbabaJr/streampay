import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { StreamStore } from "./store.js";
import type { DecodedEvent } from "./types.js";

type Journal = "events" | "outbox_events" | "webhook_deliveries" | "webhook_dead_letter";

function count(store: StreamStore, table: Journal): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function indexCount(store: StreamStore, index: string): number {
  return (
    store.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index) as { n: number }
  ).n;
}

test("event upserts are idempotent and project stream lifecycle", () => {
  const store = new StreamStore(":memory:");
  const base: DecodedEvent = { id: "event-1", pagingToken: "1", ledger: 10, ledgerClosedAt: "2026-01-01T00:00:00Z", contractId: "C", name: "stream_created", streamId: "7", data: { sender: "Gsender", recipient: "Grecipient", token: "Ctoken", deposit: 1000n, start_time: 1n, end_time: 10n, cancelable: true } };
  store.ingestPage([base], "1", 10);
  store.ingestPage([base], "1", 10);
  assert.equal(store.getState("cursor"), "1");
  assert.equal(store.getState("lastLedger"), "10");
  assert.equal(store.getStream("7")?.deposit, "1000");
  assert.equal(store.listAddress("Grecipient").length, 1);
  store.ingest({ ...base, id: "event-2", pagingToken: "2", ledger: 11, name: "withdrawn", data: { recipient: "Grecipient", amount: 100n, withdrawn_total: 100n } });
  assert.equal(store.getStream("7")?.withdrawn, "100");
  store.ingest({ ...base, id: "event-3", pagingToken: "3", ledger: 12, name: "stream_topped_up", data: { new_deposit: 1500n } });
  assert.equal(store.getStream("7")?.deposit, "1500");
  store.ingest({ ...base, id: "event-4", pagingToken: "4", ledger: 13, name: "stream_cancelled", data: { sender_amount: 1n, recipient_amount: 2n } });
  assert.equal(store.getStream("7")?.status, "cancelled");
  store.close();
});

test("a stream-less event is journalled with a null stream and touches no projection", () => {
  const store = new StreamStore(":memory:");
  store.webhooks.createEndpoint({
    url: "https://api.acme.corp/webhooks/streampay",
    events: ["contract_frozen_state_changed"],
  });

  // What the old decoder produced for this event was streamId: "true" — the
  // `frozen` bool lifted out of the first positional topic.
  const freeze: DecodedEvent = {
    id: "freeze-1",
    pagingToken: "9",
    ledger: 20,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: "C",
    name: "contract_frozen_state_changed",
    streamId: null,
    data: { frozen: true, changed_by: "Ggov" },
  };
  store.ingest(freeze);

  const row = store.db.prepare("SELECT stream_id, name FROM events WHERE id = 'freeze-1'").get() as
    | { stream_id: string | null; name: string }
    | undefined;
  assert.ok(row, "the event is still journalled");
  assert.equal(row.stream_id, null);
  assert.equal(store.getStream("true"), undefined, "no stream row keyed by the bool");
  assert.equal(store.listAddress("Ggov").length, 0);

  // Subscribers matching by name still get it, with the field present and null
  // rather than a fabricated id.
  const [delivery] = store.webhooks.listDeliveries(10).filter((d) => d.event_id === "freeze-1");
  assert.ok(delivery, "webhook delivery was queued");
  assert.equal(delivery.stream_id, null);

  // Exhausting its retries promotes it to the dead-letter queue, which used to
  // require a non-null stream id.
  store.db.prepare("UPDATE webhook_deliveries SET attempt = 5 WHERE id = ?").run(delivery.id);
  store.webhooks.recordDeliveryFailure(delivery.id, 500, "endpoint returned 500", 12);
  const [dlq] = store.webhooks.listDLQ(10).filter((item) => item.event_id === "freeze-1");
  assert.ok(dlq, "the stream-less delivery reached the dead-letter queue");
  assert.equal(dlq.stream_id, null);
  store.close();
});

test("a database built with the old NOT NULL stream_id is migrated in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "streampay-indexer-migration-"));
  const path = join(dir, "indexer.db");
  let store: StreamStore | undefined;
  try {
    // The pre-change schema, written by hand so the migration has something to
    // find: NOT NULL on stream_id in all four journals, with rows in each.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, name TEXT NOT NULL,
        ledger INTEGER NOT NULL, ledger_closed_at TEXT NOT NULL, tx_hash TEXT, trace_id TEXT,
        span_id TEXT, payload TEXT NOT NULL);
      CREATE INDEX events_stream ON events(stream_id, ledger);
      CREATE TABLE outbox_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL, stream_id TEXT NOT NULL, name TEXT NOT NULL, ledger INTEGER NOT NULL,
        ledger_cursor TEXT NOT NULL, payload TEXT NOT NULL, ingested_at TEXT NOT NULL, retracted_at TEXT,
        retract_reason TEXT);
      CREATE INDEX idx_outbox_events_stream_seq ON outbox_events(stream_id, seq);
      CREATE INDEX idx_outbox_events_ledger ON outbox_events(ledger);
      CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL,
        stream_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending', status_code INTEGER, error TEXT, next_retry_at INTEGER NOT NULL,
        history TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, completed_at TEXT);
      CREATE INDEX idx_deliveries_pending ON webhook_deliveries(status, next_retry_at);
      CREATE TABLE webhook_dead_letter (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
        event_id TEXT NOT NULL, stream_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
        attempts_count INTEGER NOT NULL, last_error TEXT NOT NULL, last_status_code INTEGER,
        created_at TEXT NOT NULL, replayed_at TEXT);
      CREATE INDEX idx_dlq_endpoint ON webhook_dead_letter(endpoint_id);
    `);
    legacy
      .prepare("INSERT INTO events (id, stream_id, name, ledger, ledger_closed_at, payload) VALUES (?,?,?,?,?,?)")
      .run("old-1", "7", "withdrawn", 5, "2026-01-01T00:00:00Z", "{}");
    legacy
      .prepare("INSERT INTO outbox_events (idempotency_key, event_id, stream_id, name, ledger, ledger_cursor, payload, ingested_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("old-1", "old-1", "7", "withdrawn", 5, "5", "{}", "2026-01-01T00:00:00Z");
    legacy
      .prepare("INSERT INTO webhook_deliveries (id, endpoint_id, event_id, stream_id, event_type, payload, next_retry_at, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("del-old", "wh_1", "old-1", "7", "withdrawn", "{}", 0, "2026-01-01T00:00:00Z");
    legacy
      .prepare("INSERT INTO webhook_dead_letter (id, delivery_id, endpoint_id, event_id, stream_id, event_type, payload, attempts_count, last_error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("dlq-old", "del-old", "wh_1", "old-1", "7", "withdrawn", "{}", 6, "endpoint down", "2026-01-01T00:00:00Z");
    legacy.close();

    store = new StreamStore(path);

    // History is intact and the constraint is gone.
    assert.equal(count(store, "events"), 1);
    assert.equal(count(store, "outbox_events"), 1);
    assert.equal(count(store, "webhook_deliveries"), 1);
    assert.equal(count(store, "webhook_dead_letter"), 1);
    for (const table of ["events", "outbox_events", "webhook_deliveries", "webhook_dead_letter"] as Journal[]) {
      const columns = store.db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>;
      const column = columns.find((c) => c.name === "stream_id");
      assert.equal(column?.notnull, 0, `${table}.stream_id is nullable after migration`);
    }

    // The rebuilt tables kept their indexes, so the per-stream lookups the
    // journals depend on still work.
    for (const index of ["events_stream", "idx_outbox_events_stream_seq", "idx_deliveries_pending", "idx_dlq_endpoint"]) {
      assert.equal(
        indexCount(store, index),
        1,
        `${index} survived the rebuild`
      );
    }
    assert.deepEqual(
      store.db.prepare("SELECT stream_id FROM events WHERE id = 'old-1'").get(),
      { stream_id: "7" },
      "pre-migration rows keep their stream ids"
    );
    assert.equal(store.webhooks.listDLQ()[0]?.stream_id, "7", "the dead-letter row round-trips its stream id");
    assert.equal(store.getStreamHistory("7").length, 1);

    // And a stream-less event now inserts cleanly where it used to fail.
    store.ingest({
      id: "freeze-2",
      pagingToken: "30",
      ledger: 30,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      contractId: "C",
      name: "contract_frozen_state_changed",
      streamId: null,
      data: { frozen: false, changed_by: "Ggov" },
    });
    assert.equal(
      (store.db.prepare("SELECT stream_id FROM events WHERE id = 'freeze-2'").get() as { stream_id: string | null }).stream_id,
      null
    );

    // AUTOINCREMENT did not reset: the next outbox seq continues the history.
    store.ingest({
      id: "withdrawn-2",
      pagingToken: "31",
      ledger: 31,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      contractId: "C",
      name: "withdrawn",
      streamId: "7",
      data: { recipient: "Gr", amount: 1n, withdrawn_total: 1n },
    });
    const seq = (store.db.prepare("SELECT MAX(seq) AS seq FROM outbox_events").get() as { seq: number }).seq;
    // The migrated row took seq 1, so the two journalled events land at 2 and 3.
    assert.equal(seq, 3, "outbox sequence resumes above the migrated row");
  } finally {
    store?.close();
    // Windows keeps the database handle alive briefly after close(), so the
    // sidecar files are removed individually before the directory, and a
    // still-locked file is left behind rather than failing the run.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(path + suffix, { force: true });
      } catch {}
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
