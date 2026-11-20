import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StreamStore } from "../store.js";
import type { DecodedEvent } from "../types.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { OutboxMetrics } from "./metrics.js";
import { formatReplaySummary, listDeadLetters, replayDeadLetters } from "./replay.js";
import { runReplayCli } from "./replay-cli.js";
import type { OutboxTransport, TransportResult } from "./transport.js";

function decodedEvent(id: string, ledger: number): DecodedEvent {
  return {
    id,
    pagingToken: `cursor-${ledger}-${id}`,
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    contractId: "C" + "X".repeat(54),
    name: "withdrawn",
    streamId: "1",
    data: { amount: "1000" },
  };
}

/** Transport whose behaviour flips at runtime: models a downstream outage that gets fixed. */
function switchableTransport() {
  const state = { up: false, delivered: [] as string[], attempts: 0 };
  const transport: OutboxTransport = async (intent): Promise<TransportResult> => {
    state.attempts++;
    if (!state.up) return { ok: false, status: 503, error: "downstream outage" };
    state.delivered.push(intent.idempotency_key);
    return { ok: true, status: 200 };
  };
  return { state, transport };
}

/** One consumer with max_attempts=1 so a single failed delivery dead-letters. */
function setup() {
  const store = new StreamStore(":memory:");
  store.outbox.createConsumer({
    id: "push-a",
    kind: "push",
    url: "https://example.invalid/hook",
    max_attempts: 1,
  });
  const sw = switchableTransport();
  const dispatcher = new OutboxDispatcher(store.outbox, sw.transport, new OutboxMetrics(), {
    randomFn: () => 0.5,
  });
  return { store, dispatcher, ...sw };
}

async function deadLetterTwoEvents() {
  const ctx = setup();
  ctx.store.ingest(decodedEvent("ev-1", 10));
  ctx.store.ingest(decodedEvent("ev-2", 11));
  await ctx.dispatcher.drainAll();
  return ctx;
}

function snapshot(store: StreamStore) {
  return JSON.stringify(store.outbox.listIntents({ limit: 100 }));
}

describe("outbox dead-letter replay", () => {
  it("a failed delivery lands in the DLQ and is listed", async () => {
    const { store, state } = await deadLetterTwoEvents();
    try {
      assert.equal(state.delivered.length, 0);
      const dlq = listDeadLetters(store.outbox);
      assert.deepEqual(dlq.map((e) => e.event_id), ["ev-1", "ev-2"]);
      assert.equal(dlq[0].consumer_id, "push-a");
      assert.equal(dlq[0].dead_reason, "max_attempts");
      assert.equal(dlq[0].last_error, "downstream outage");
    } finally {
      store.close();
    }
  });

  it("dry-run (the default) reports what would be replayed and changes nothing", async () => {
    const { store, dispatcher, state } = await deadLetterTwoEvents();
    try {
      state.up = true;
      const before = snapshot(store);
      const attemptsBefore = state.attempts;

      const summary = await replayDeadLetters(store.outbox, { dispatcher });
      assert.equal(summary.mode, "dry-run");
      assert.equal(summary.selected, 2);
      assert.equal(summary.replayed, 0);
      assert.deepEqual(summary.destinations, ["push-a"]);
      assert.deepEqual(summary.event_ids, ["ev-1", "ev-2"]);

      assert.equal(snapshot(store), before, "dry-run must not touch the store");
      assert.equal(state.attempts, attemptsBefore, "dry-run must not dispatch");
      assert.equal(state.delivered.length, 0);
      assert.match(formatReplaySummary(summary), /DRY RUN/);
    } finally {
      store.close();
    }
  });

  it("execute re-dispatches each entry exactly once through the normal dispatcher", async () => {
    const { store, dispatcher, state } = await deadLetterTwoEvents();
    try {
      state.up = true;
      const summary = await replayDeadLetters(store.outbox, { execute: true, dispatcher });
      assert.equal(summary.mode, "execute");
      assert.equal(summary.replayed, 2);
      assert.equal(summary.delivered, 2);
      assert.equal(summary.dead, 0);
      assert.deepEqual(state.delivered, ["push-a:ev-1", "push-a:ev-2"]);
      assert.equal(store.outbox.listIntents({ state: "dead", limit: 10 }).length, 0);
      assert.equal(store.outbox.listIntents({ state: "delivered", limit: 10 }).length, 2);
    } finally {
      store.close();
    }
  });

  it("a second replay is a no-op", async () => {
    const { store, dispatcher, state } = await deadLetterTwoEvents();
    try {
      state.up = true;
      await replayDeadLetters(store.outbox, { execute: true, dispatcher });
      const second = await replayDeadLetters(store.outbox, { execute: true, dispatcher });
      assert.equal(second.selected, 0);
      assert.equal(second.replayed, 0);
      assert.equal(state.delivered.length, 2, "no duplicate delivery");
    } finally {
      store.close();
    }
  });

  it("an entry that is no longer dead when replay runs is skipped, not re-dispatched", async () => {
    const { store, dispatcher, state } = await deadLetterTwoEvents();
    try {
      state.up = true;
      const [first] = listDeadLetters(store.outbox);
      // Another operator / the HTTP endpoint replays it first: the guarded
      // dead -> pending transition refuses a second reset.
      assert.equal(store.outbox.replayIntent(first.intent_id), true);
      assert.equal(store.outbox.replayIntent(first.intent_id), false);

      const summary = await replayDeadLetters(store.outbox, { execute: true, dispatcher });
      assert.equal(summary.selected, 1, "only the still-dead entry is selected");
      assert.equal(summary.delivered, 1);
      // The pending one is delivered by the normal dispatcher exactly once.
      assert.deepEqual([...state.delivered].sort(), ["push-a:ev-1", "push-a:ev-2"]);
    } finally {
      store.close();
    }
  });

  it("replaying while the downstream is still down dead-letters again, with a fresh retry budget", async () => {
    const { store, dispatcher, state } = await deadLetterTwoEvents();
    try {
      const summary = await replayDeadLetters(store.outbox, { execute: true, dispatcher });
      assert.equal(summary.replayed, 2);
      assert.equal(summary.dead, 2);
      assert.equal(summary.delivered, 0);
      assert.equal(state.delivered.length, 0);
      // The entries are still replayable once the outage is fixed.
      state.up = true;
      const retry = await replayDeadLetters(store.outbox, { execute: true, dispatcher });
      assert.equal(retry.delivered, 2);
    } finally {
      store.close();
    }
  });

  it("filters by consumer, event id, intent id and reason", async () => {
    const { store } = await deadLetterTwoEvents();
    try {
      assert.equal(listDeadLetters(store.outbox, { consumerId: "nope" }).length, 0);
      assert.deepEqual(listDeadLetters(store.outbox, { eventIds: ["ev-2"] }).map((e) => e.event_id), ["ev-2"]);
      const id = listDeadLetters(store.outbox)[0].intent_id;
      assert.equal(listDeadLetters(store.outbox, { intentIds: [id] }).length, 1);
      assert.equal(listDeadLetters(store.outbox, { reason: "reorg_retracted" }).length, 0);
      assert.equal(listDeadLetters(store.outbox, { reason: "max_attempts", limit: 1 }).length, 1);
    } finally {
      store.close();
    }
  });

  it("execute mode without a dispatcher is rejected before touching anything", async () => {
    const { store } = await deadLetterTwoEvents();
    try {
      const before = snapshot(store);
      await assert.rejects(replayDeadLetters(store.outbox, { execute: true }), /requires a dispatcher/);
      assert.equal(snapshot(store), before);
    } finally {
      store.close();
    }
  });

  it("replayIntent keeps attempts by default and resets them on request", async () => {
    const { store } = await deadLetterTwoEvents();
    try {
      const [a, b] = listDeadLetters(store.outbox);
      assert.equal(store.outbox.replayIntent(a.intent_id), true);
      assert.equal(store.outbox.getIntent(a.intent_id)?.attempts, 1);
      assert.equal(store.outbox.replayIntent(b.intent_id, { resetAttempts: true }), true);
      assert.equal(store.outbox.getIntent(b.intent_id)?.attempts, 0);
    } finally {
      store.close();
    }
  });
});

describe("outbox replay CLI", () => {
  async function fileDb() {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obx-replay-")), "outbox.sqlite");
    const store = new StreamStore(dbPath);
    store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook", max_attempts: 1 });
    store.ingest(decodedEvent("ev-1", 10));
    const down = new OutboxDispatcher(store.outbox, async () => ({ ok: false, error: "outage" }), new OutboxMetrics());
    await down.drainAll();
    store.close();
    return dbPath;
  }

  it("is dry-run by default, replays only with --execute, and a rerun is a no-op", async () => {
    const dbPath = await fileDb();
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    const delivered: string[] = [];
    const transport: OutboxTransport = async (i) => {
      delivered.push(i.idempotency_key);
      return { ok: true, status: 200 };
    };

    assert.equal(await runReplayCli(["--db", dbPath], io, { transport }), 0);
    assert.match(out.at(-1)!, /DRY RUN/);
    assert.match(out.at(-1)!, /ev-1/);
    assert.equal(delivered.length, 0);

    assert.equal(await runReplayCli(["--db", dbPath, "--execute", "--json"], io, { transport }), 0);
    const summary = JSON.parse(out.at(-1)!);
    assert.equal(summary.delivered, 1);
    assert.deepEqual(delivered, ["push-a:ev-1"]);

    assert.equal(await runReplayCli(["--db", dbPath, "--execute", "--json"], io, { transport }), 0);
    assert.equal(JSON.parse(out.at(-1)!).selected, 0);
    assert.equal(delivered.length, 1);
  });

  it("rejects bad arguments with exit code 2", async () => {
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    assert.equal(await runReplayCli(["--limit", "0"], io), 2);
    assert.equal(await runReplayCli(["--intent", "abc"], io), 2);
    assert.equal(await runReplayCli(["--bogus"], io), 2);
    assert.equal(await runReplayCli(["--help"], io), 0);
  });
});
