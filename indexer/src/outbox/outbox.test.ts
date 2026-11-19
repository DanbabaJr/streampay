import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { StreamStore } from "../store.js";
import { createApp } from "../index.js";
import type { DecodedEvent } from "../types.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { OutboxMetrics } from "./metrics.js";
import { outboxRetryDelayMs, isTerminalAttempt } from "./retry.js";
import type { OutboxConsumerConfig, OutboxTransport, TransportResult } from "./transport.js";

function decodedEvent(
  id: string,
  ledger: number,
  name = "withdrawn",
  streamId = "1",
  extra: Record<string, unknown> = {}
): DecodedEvent {
  return {
    id,
    pagingToken: `cursor-${ledger}-${id}`,
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    contractId: "C" + "X".repeat(54),
    name,
    streamId,
    data: { amount: "1000", ...extra },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDbPath(label: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `obx-${label}-`)), "outbox.sqlite");
}

async function withServer(
  store: StreamStore,
  fn: (baseUrl: string) => Promise<void>,
  outboxDispatcher?: OutboxDispatcher,
  outboxMetrics?: OutboxMetrics
): Promise<void> {
  const app = createApp(store, undefined, outboxDispatcher, outboxMetrics);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function httpJson(
  url: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}

function recordingTransport(delivered: string[]): OutboxTransport {
  return async (intent): Promise<TransportResult> => {
    delivered.push(intent.idempotency_key);
    return { ok: true, status: 200 };
  };
}

const alwaysFail: OutboxTransport = async () => ({ ok: false, status: 500, error: "boom" });

describe("outbox store: state machine and guards", () => {
  it("guarded claim, delivery, and failure transitions are atomic and idempotent", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      store.ingest(decodedEvent("ev-1", 10));

      const ids = store.outbox.dueIntents("push-a", 10, Date.now());
      assert.equal(ids.length, 1);
      const id = ids[0];

      const token1 = store.outbox.claimToken();
      const claimed = store.outbox.claimIntent(id, token1, Date.now());
      assert.ok(claimed);
      assert.equal(claimed.state, "in_flight");
      // A second dispatcher can never claim the same in-flight intent.
      assert.equal(store.outbox.claimIntent(id, store.outbox.claimToken(), Date.now()), undefined);

      // Wrong claim token cannot complete or fail the intent.
      assert.equal(store.outbox.markDelivered(id, "not-the-token"), false);
      assert.equal(store.outbox.recordFailure(id, "not-the-token", "x", 2, 0), "stale");
      assert.equal(store.outbox.markDelivered(id, token1), true);
      // Replaying the completion is a no-op (idempotent terminal transition).
      assert.equal(store.outbox.markDelivered(id, token1), false);
    } finally {
      store.close();
    }
  });

  it("reclaimStale returns crashed in-flight intents to pending", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      store.ingest(decodedEvent("ev-1", 10));
      const id = store.outbox.dueIntents("push-a", 10, Date.now())[0];
      store.outbox.claimIntent(id, store.outbox.claimToken(), Date.now() - 5_000);
      assert.equal(store.outbox.reclaimStale(1_000, Date.now()), 1);
      const intent = store.outbox.getIntent(id);
      assert.ok(intent);
      assert.equal(intent.state, "pending");
      assert.equal(intent.claim_token, null);
      assert.equal(store.outbox.reclaimStale(1_000, Date.now()), 0);
    } finally {
      store.close();
    }
  });

  it("replayIntent resurrects dead intents and rejects live ones", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook", max_attempts: 1 });
      store.ingest(decodedEvent("ev-1", 10));
      const id = store.outbox.dueIntents("push-a", 10, Date.now())[0];
      const token = store.outbox.claimToken();
      store.outbox.claimIntent(id, token, Date.now());
      assert.equal(store.outbox.recordFailure(id, token, "boom", 1, Date.now()), "dead");
      const deadIntent = store.outbox.getIntent(id);
      assert.ok(deadIntent);
      assert.equal(deadIntent.state, "dead");
      assert.equal(store.outbox.replayIntent(id), true);
      const revived = store.outbox.getIntent(id);
      assert.ok(revived);
      assert.equal(revived.state, "pending");
      assert.equal(store.outbox.replayIntent(id), false, "pending intents are not replayable");
    } finally {
      store.close();
    }
  });
});

describe("outbox: transactional ingestion", () => {
  it("event rows and delivery intents commit atomically; a mid-transaction failure rolls both back", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      const good = decodedEvent("ev-1", 10);
      const poison = decodedEvent("ev-2", 11, "stream_cancelled", "1", {
        recipient_amount: "not-a-bigint",
        sender_amount: "0",
        cancelled_by: "someone",
      });
      assert.throws(() => store.ingestPage([good, poison], "cursor-11", 11));
      assert.equal(store.outbox.stats().events, 0, "journal rolled back with the ingestion transaction");
      assert.equal(store.getStreamHistory("1").length, 0, "event log rolled back too");
      const db = store.db.prepare("SELECT COUNT(*) AS n FROM outbox_intents").get() as { n: number };
      assert.equal(db.n, 0, "no delivery intents survived the rollback");
    } finally {
      store.close();
    }
  });

  it("duplicate ingestion never duplicates journal rows or intents", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      const page = [decodedEvent("ev-1", 10), decodedEvent("ev-2", 11)];
      store.ingestPage(page, "cursor-11", 11);
      store.ingestPage(page.map((e) => ({ ...e })), "cursor-11", 11);
      assert.equal(store.outbox.stats().events, 2);
      assert.equal(store.outbox.listIntents({ limit: 100 }).length, 2);
      assert.equal(store.outbox.listIntents({ consumerId: "push-a", limit: 100 }).length, 2);
    } finally {
      store.close();
    }
  });

  it("journal carries the per-event ledger cursor for reorg retraction", () => {
    const store = new StreamStore(":memory:");
    try {
      store.ingest(decodedEvent("ev-1", 10));
      const row = store.outbox.replayEvents("1", 0, 10);
      assert.equal(row.events[0].ledger_cursor, "cursor-10-ev-1");
    } finally {
      store.close();
    }
  });

  it("intents fan out only to active push consumers", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-1", kind: "push", url: "https://example.invalid/hook" });
      store.outbox.createConsumer({ id: "pull-1", kind: "pull" });
      store.outbox.createConsumer({ id: "push-off", kind: "push", url: "https://example.invalid/hook" });
      store.outbox.setConsumerStatus("push-off", "disabled");
      store.ingest(decodedEvent("ev-1", 10));
      const intents = store.outbox.listIntents({ limit: 100 });
      assert.deepEqual(intents.map((i) => i.consumer_id), ["push-1"]);
    } finally {
      store.close();
    }
  });
});

describe("outbox dispatcher: delivery, retry, dead-letter", () => {
  it("delivers every intent with a healthy consumer", async () => {
    const store = new StreamStore(":memory:");
    try {
      const delivered: string[] = [];
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      store.ingestPage([decodedEvent("ev-1", 10), decodedEvent("ev-2", 11), decodedEvent("ev-3", 12)], "c", 12);
      const metrics = new OutboxMetrics();
      const dispatcher = new OutboxDispatcher(store.outbox, recordingTransport(delivered), metrics, {
        tickMs: 1000,
        batchSize: 50,
      });
      const report = await dispatcher.drainAll();
      assert.equal(report.delivered, 3);
      assert.deepEqual(delivered.sort(), ["push-a:ev-1", "push-a:ev-2", "push-a:ev-3"]);
      const stats = store.outbox.stats();
      assert.equal(stats.depth.delivered, 3);
      assert.equal(stats.depth.pending, 0);
      assert.equal(metrics.render(stats).includes('streampay_outbox_dispatch_total{outcome="delivered"} 3'), true);
    } finally {
      store.close();
    }
  });

  it("retries with backoff+jitter then dead-letters after max attempts", async () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({
        id: "push-a",
        kind: "push",
        url: "https://example.invalid/hook",
        max_attempts: 2,
      });
      store.ingest(decodedEvent("ev-1", 10));
      const dispatcher = new OutboxDispatcher(store.outbox, alwaysFail, new OutboxMetrics(), {
        batchSize: 10,
        randomFn: () => 0,
      });

      let report = await dispatcher.tick();
      assert.equal(report.retried, 1, "first failure schedules a retry");
      let intent = store.outbox.getIntent(store.outbox.listIntents({ limit: 10 })[0].id);
      assert.ok(intent);
      assert.equal(intent.state, "pending");
      assert.ok(intent.next_retry_at > Date.now(), "retry is deferred by backoff");
      report = await dispatcher.tick();
      assert.equal(report.retried + report.dead, 0, "nothing due before the backoff window");

      await sleep(intent.next_retry_at - Date.now() + 20);
      report = await dispatcher.tick();
      assert.equal(report.dead, 1, "terminal attempt dead-letters");
      intent = store.outbox.getIntent(intent.id);
      assert.ok(intent);
      assert.equal(intent.state, "dead");
      assert.equal(intent.dead_reason, "max_attempts");
      assert.equal(intent.attempts, 2);
    } finally {
      store.close();
    }
  });

  it("reclaims intents when the dispatcher dies mid-delivery and redelivers them", async () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      store.ingestPage([decodedEvent("ev-1", 10), decodedEvent("ev-2", 11)], "c", 11);

      // Dispatcher #1 claims both intents and then "dies": no completion is
      // ever recorded for ev-1, ev-2 stays claimed in flight.
      const deadToken = store.outbox.claimToken();
      const ids = store.outbox.dueIntents("push-a", 10, Date.now());
      for (const id of ids) store.outbox.claimIntent(id, deadToken, Date.now());

      const delivered: string[] = [];
      const revived = new OutboxDispatcher(store.outbox, recordingTransport(delivered), new OutboxMetrics(), {
        claimTimeoutMs: 40,
        batchSize: 10,
      });
      let report = await revived.tick();
      assert.equal(report.delivered, 0, "claims are not expired yet");

      await sleep(60);
      report = await revived.tick();
      assert.equal(report.reclaimed, 2);
      assert.equal(report.delivered, 2, "revived dispatcher redelivers reclaimed intents");
      assert.equal(store.outbox.stats().depth.in_flight, 0);
      // The dead dispatcher's stale completion/failure tokens are inert.
      assert.equal(store.outbox.markDelivered(ids[0], deadToken), false);
      assert.equal(store.outbox.recordFailure(ids[0], deadToken, "late", 5, 0), "stale");
    } finally {
      store.close();
    }
  });

  it("duplicate connections double-draining never deliver the same intent twice", async () => {
    const file = tempDbPath("double");
    const storeA = new StreamStore(file);
    const storeB = new StreamStore(file);
    try {
      storeA.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      const events = Array.from({ length: 20 }, (_, i) => decodedEvent(`ev-${i}`, 100 + i));
      storeA.ingestPage(events, "c", 120);

      const seen: string[] = [];
      const slowTransport: OutboxTransport = async (intent) => {
        seen.push(`${intent.idempotency_key}@${intent.claim_token}`);
        await sleep(2);
        return { ok: true, status: 200 };
      };
      const dA = new OutboxDispatcher(storeA.outbox, slowTransport, new OutboxMetrics(), {
        batchSize: 5,
        claimTimeoutMs: 600_000,
      });
      const dB = new OutboxDispatcher(storeB.outbox, slowTransport, new OutboxMetrics(), {
        batchSize: 5,
        claimTimeoutMs: 600_000,
      });

      // Interleave two independent dispatchers over one shared SQLite file.
      for (let i = 0; i < 12; i++) {
        await Promise.all([dA.tick(), dB.tick()]);
      }

      const keys = seen.map((s) => s.split("@")[0]);
      assert.equal(keys.length, 20, "every intent delivered exactly once");
      assert.equal(new Set(keys).size, 20, "no intent was double-drained");
      assert.equal(storeA.outbox.stats().depth.delivered, 20);
    } finally {
      storeA.close();
      storeB.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(file + suffix, { force: true });
        } catch {}
      }
    }
  });

  it("throttles per-consumer rate and applies global depth backpressure", async () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({
        id: "push-slow",
        kind: "push",
        url: "https://example.invalid/hook",
        rate_limit_per_sec: 2,
      });
      store.ingestPage(Array.from({ length: 10 }, (_, i) => decodedEvent(`ev-${i}`, 10 + i)), "c", 19);
      const delivered: string[] = [];
      const dispatcher = new OutboxDispatcher(store.outbox, recordingTransport(delivered), new OutboxMetrics(), {
        tickMs: 1000,
        batchSize: 100,
      });
      const report = await dispatcher.tick();
      assert.equal(report.delivered, 2, "rate budget = 2/s x 1s tick");

      const throttled = new OutboxDispatcher(store.outbox, recordingTransport(delivered), new OutboxMetrics(), {
        batchSize: 100,
        maxDepth: 5,
      });
      const bp = await throttled.tick();
      assert.equal(bp.rejectedBackpressure, true);
      assert.equal(store.outbox.stats().depth.delivered, 2, "backpressure stops new claims while depth stays high");
    } finally {
      store.close();
    }
  });

  it("a poison consumer dead-letters without blocking healthy consumers", async () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({
        id: "poison",
        kind: "push",
        url: "https://example.invalid/hook",
        max_attempts: 1,
      });
      store.outbox.createConsumer({ id: "healthy", kind: "push", url: "https://example.invalid/hook" });
      store.ingestPage(Array.from({ length: 5 }, (_, i) => decodedEvent(`ev-${i}`, 10 + i)), "c", 14);

      const delivered: string[] = [];
      const poisonTransport: OutboxTransport = async (intent) => {
        if (intent.consumer_id === "poison") return alwaysFail(intent, { } as OutboxConsumerConfig);
        return recordingTransport(delivered)(intent, {} as OutboxConsumerConfig);
      };
      const dispatcher = new OutboxDispatcher(store.outbox, poisonTransport, new OutboxMetrics(), {
        batchSize: 50,
        randomFn: () => 0,
      });
      const report = await dispatcher.drainAll(50);
      assert.equal(report.delivered, 5, "healthy consumer fully drained despite the poison neighbour");
      assert.equal(report.dead, 5, "poison consumer dead-lettered its own intents only");
      const dead = store.outbox.listIntents({ state: "dead", limit: 50 });
      assert.equal(dead.length, 5);
      assert.ok(dead.every((i) => i.consumer_id === "poison"));
    } finally {
      store.close();
    }
  });
});

describe("outbox: reorg retraction", () => {
  it("retracts journal entries and pending intents above the divergence ledger", () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      store.ingestPage(
        [decodedEvent("ev-1", 100), decodedEvent("ev-2", 101), decodedEvent("ev-3", 102, "withdrawn", "2")],
        "cursor-102",
        102
      );
      const result = store.outbox.retractAfterLedger(101, "chain_reorg");
      assert.equal(result.events_retracted, 1);
      assert.equal(result.intents_retracted, 1);
      const row = store.outbox.replayEvents("1", 0, 10);
      assert.deepEqual(row.events.map((e) => e.event_id), ["ev-1", "ev-2"]);
      const dead = store.outbox.listIntents({ state: "dead", limit: 10 });
      assert.equal(dead[0].dead_reason, "reorg_retracted");
      assert.equal(dead[0].event_id, "ev-3");
      // Idempotent: retracting the same boundary again changes nothing.
      assert.deepEqual(store.outbox.retractAfterLedger(101, "chain_reorg"), {
        events_retracted: 0,
        intents_retracted: 0,
      });
      // The retracted event keeps its ledger cursor for reconciliation audits.
      const retracted = store.outbox.getEventBySeq(row.events.length + 1);
      assert.ok(retracted);
      assert.equal(retracted.retract_reason, "chain_reorg");
      assert.equal(retracted.ledger_cursor, "cursor-102-ev-3");
    } finally {
      store.close();
    }
  });

  it("delivered intents survive retraction as tombstones instead of being replayed", async () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook" });
      store.ingestPage([decodedEvent("ev-1", 100), decodedEvent("ev-2", 101)], "cursor-101", 101);
      const delivered: string[] = [];
      const dispatcher = new OutboxDispatcher(store.outbox, recordingTransport(delivered), new OutboxMetrics(), {
        batchSize: 10,
      });
      await dispatcher.drainAll();
      assert.equal(delivered.length, 2);

      store.outbox.retractAfterLedger(100, "reorg");
      const survivor = store.outbox.getIntent(2);
      assert.ok(survivor);
      assert.equal(survivor.state, "delivered", "already-delivered intent is untouched");
      assert.deepEqual(store.outbox.replayEvents("1", 0, 10).events.map((e) => e.event_id), ["ev-1"]);
    } finally {
      store.close();
    }
  });
});

describe("outbox HTTP surface", () => {
  it("serves cursor replay, consumer registry, dead-letter replay, retract hook and metrics", async () => {
    const store = new StreamStore(":memory:");
    try {
      store.outbox.createConsumer({ id: "push-a", kind: "push", url: "https://example.invalid/hook", max_attempts: 1 });
      store.ingestPage(
        [
          decodedEvent("ev-1", 100),
          decodedEvent("ev-2", 101, "withdrawn", "2"),
          decodedEvent("ev-3", 102),
        ],
        "cursor-102",
        102
      );
      const metrics = new OutboxMetrics();
      const dispatcher = new OutboxDispatcher(store.outbox, alwaysFail, metrics, {
        batchSize: 50,
        randomFn: () => 0,
      });
      await dispatcher.drainAll();

      await withServer(store, async (base) => {
        // Replay feed with monotonic cursor semantics.
        const all = await httpJson(`${base}/streams/1/events?after=0`);
        assert.equal(all.status, 200);
        const page = all.data as { events: Array<{ seq: number; event_id: string; idempotency_key: string; stream_id: string }>; next_cursor: number };
        assert.deepEqual(page.events.map((e) => e.event_id), ["ev-1", "ev-3"]);
        assert.ok(page.events[0].seq < page.events[1].seq, "cursor is monotonic");
        assert.equal(page.events[0].idempotency_key, "ev-1");

        const tail = await httpJson(`${base}/streams/1/events?after=${page.events[0].seq}`);
        const tailPage = tail.data as { events: Array<{ seq: number }>; next_cursor: number };
        assert.deepEqual(tailPage.events.map((e) => e.seq), [page.events[1].seq]);

        const limited = await httpJson(`${base}/streams/1/events?after=0&limit=1`);
        const limitedPage = limited.data as { events: Array<{ seq: number }>; next_cursor: number };
        assert.equal(limitedPage.events.length, 1);

        const badCursor = await httpJson(`${base}/streams/1/events?after=-3`);
        assert.equal(badCursor.status, 400);
        const badId = await httpJson(`${base}/streams/not-a-number/events`);
        assert.equal(badId.status, 400);

        // Consumer registry (pull consumers skip SSRF).
        const created = await httpJson(`${base}/api/outbox/consumers`, {
          method: "POST",
          body: { id: "analytics-pull", kind: "pull" },
        });
        assert.equal(created.status, 201);
        const listed = await httpJson(`${base}/api/outbox/consumers`);
        assert.equal((listed.data as Array<{ id: string }>).length, 2);

        const blockedPush = await httpJson(`${base}/api/outbox/consumers`, {
          method: "POST",
          body: { kind: "push", url: "http://169.254.169.254/latest/meta-data" },
        });
        assert.equal(blockedPush.status, 400);

        // Dead-letter visibility and replay.
        const deadRes = await httpJson(`${base}/api/outbox/intents?state=dead`);
        const deadIntents = deadRes.data as Array<{ id: number; consumer_id: string }>;
        assert.equal(deadIntents.length, 3);
        const replayed = await httpJson(`${base}/api/outbox/intents/${deadIntents[0].id}/replay`, { method: "POST" });
        assert.equal(replayed.status, 200);

        // Reorg retraction hook for the reconciliation service.
        const retract = await httpJson(`${base}/api/outbox/retract`, {
          method: "POST",
          body: { after_ledger: 100, reason: "reconciler_divergence" },
        });
        assert.equal(retract.status, 200);
        assert.equal((retract.data as { events_retracted: number }).events_retracted, 2);
        const afterRetract = await httpJson(`${base}/streams/1/events?after=0`);
        assert.equal((afterRetract.data as { events: unknown[] }).events.length, 1);

        // Prometheus-style metrics exposition.
        const res = await fetch(`${base}/metrics`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
        const body = await res.text();
        assert.match(body, /# TYPE streampay_outbox_depth gauge/);
        assert.match(body, /streampay_outbox_depth\{state="dead"\} \d+/);
        assert.match(body, /streampay_outbox_lag_seconds /);
        assert.match(body, /streampay_outbox_divergence_alarm 0/);
      }, dispatcher, metrics);
    } finally {
      store.close();
    }
  });
});

describe("outbox metrics: divergence alarm", () => {
  it("fires when depth grows monotonically past the alarm window", () => {
    const metrics = new OutboxMetrics({ alarmWindow: 3, alarmMinDepth: 10 });
    const statsFor = (pending: number) => ({
      events: pending,
      depth: { pending, in_flight: 0, delivered: 0, dead: 0 },
      oldestPendingAgeMs: 0,
      maxSeq: 0,
    });
    assert.equal(metrics.sampleDepth(statsFor(11)), false);
    assert.equal(metrics.sampleDepth(statsFor(20)), false);
    assert.equal(metrics.sampleDepth(statsFor(30)), false);
    assert.equal(metrics.sampleDepth(statsFor(40)), true, "4 consecutive growth samples above min depth");
    assert.equal(metrics.sampleDepth(statsFor(35)), false, "any drop clears the alarm");
    assert.match(metrics.render(statsFor(35)), /streampay_outbox_divergence_alarm 0/);
  });

  it("retry schedule is bounded exponential with jitter", () => {
    assert.equal(outboxRetryDelayMs(1), 0);
    assert.equal(outboxRetryDelayMs(2, () => 0.5), 500);
    assert.equal(outboxRetryDelayMs(3, () => 0.5), 1000);
    const min = outboxRetryDelayMs(9, () => 0);
    const max = outboxRetryDelayMs(9, () => 1);
    assert.ok(max > min && min >= 0.8 * 12_800 - 1 && max <= 1.2 * 30 * 60_000);
    assert.equal(outboxRetryDelayMs(40, () => 0.5), 1_800_000, "capped at 30 minutes");
    assert.equal(isTerminalAttempt(8, 8), true);
    assert.equal(isTerminalAttempt(7, 8), false);
  });
});

describe("outbox load: 10k event backlog", () => {
  it("ingests 10,000 events and drains the backlog through the dispatcher", async () => {
    const file = tempDbPath("load");
    const store = new StreamStore(file);
    try {
      store.outbox.createConsumer({ id: "push-load", kind: "push", url: "https://example.invalid/hook" });
      const t0 = Date.now();
      for (let p = 0; p < 100; p++) {
        const events = Array.from({ length: 100 }, (_, i) => decodedEvent(`load-${p}-${i}`, 1_000 + p));
        store.ingestPage(events, `cursor-${p}`, 1_000 + p);
      }
      const ingestMs = Date.now() - t0;
      const stats = store.outbox.stats();
      assert.equal(stats.events, 10_000);
      assert.equal(stats.depth.pending, 10_000);

      let count = 0;
      const fastTransport: OutboxTransport = async () => {
        count++;
        return { ok: true, status: 200 };
      };
      const dispatcher = new OutboxDispatcher(store.outbox, fastTransport, new OutboxMetrics(), {
        batchSize: 1_000,
      });
      const t1 = Date.now();
      const report = await dispatcher.drainAll(100);
      const drainMs = Date.now() - t1;
      assert.equal(report.delivered, 10_000);
      assert.equal(count, 10_000);
      assert.equal(store.outbox.stats().depth.pending, 0);
      assert.ok(drainMs < 30_000, `drain finished in ${drainMs}ms`);
      console.log(
        `outbox load: ingested 10k events in ${ingestMs}ms, drained 10k intents in ${drainMs}ms ` +
          `(${Math.round((10_000 / drainMs) * 1000)} intents/sec)`
      );
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(file + suffix, { force: true });
        } catch {}
      }
    }
  });
});
