/**
 * Graceful-shutdown guarantees (issue #488).
 *
 * SIGTERM is delivered at three points - mid-ingest, mid-dispatch (transport
 * pending) and idle - and after each one the SQLite file is reopened, the way a
 * restarted process would, and checked for:
 *
 *   - no event lost       (every event ends up journalled, every intent delivered)
 *   - no double dispatch  (a delivered intent is never sent again after restart)
 *   - a bounded exit      (the process exits within the drain window)
 *
 * Each point is run twice: once where the work finishes inside the drain window,
 * and once where the window expires first. No real network or real signals are
 * used: the transport and the RPC source are mocks, and the "process" is an
 * EventEmitter the shutdown handlers are installed on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { StreamStore } from "./store.js";
import type { RateBudgetSnapshot } from "./rpc-manager.js";
import { IngestPipeline, type EventSource, type EventsPage, type TickReport } from "./ingest/pipeline.js";
import { OutboxDispatcher } from "./outbox/dispatcher.js";
import { OutboxMetrics } from "./outbox/metrics.js";
import type { OutboxTransport, TransportResult } from "./outbox/transport.js";
import { createGracefulShutdown, installShutdownHandlers } from "./shutdown.js";
import type { DecodedEvent, EventValue, RpcEvent } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tempDbPath(label: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `shutdown-${label}-`)), "indexer.sqlite");
}

function newMetrics(): OutboxMetrics {
  return new OutboxMetrics({ alarmWindow: 8, alarmMinDepth: 1000 });
}

const CONSUMER = "push-a";

function openStoreWithConsumer(dbPath: string): StreamStore {
  const store = new StreamStore(dbPath);
  if (!store.outbox.getConsumer(CONSUMER)) {
    store.outbox.createConsumer({ id: CONSUMER, kind: "push", url: "https://example.invalid/hook" });
  }
  return store;
}

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

/** Journal `count` events (each with one push intent), as a finished ingest would. */
function seedEvents(store: StreamStore, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `ev-${i}`;
    store.ingest(decodedEvent(id, 100 + i));
    ids.push(id);
  }
  return ids;
}

const keyOf = (eventId: string): string => `${CONSUMER}:${eventId}`;

/** The invariants that must hold at rest, whatever the shutdown path was. */
function assertConsistent(store: StreamStore, expectedEvents: number): void {
  const stats = store.outbox.stats();
  assert.equal(stats.depth.in_flight, 0, "no intent may be left in_flight after shutdown");
  assert.equal(stats.events, expectedEvents, "journal event count");
  const intents = store.outbox.listIntents({ limit: 10_000 });
  // Journal row and delivery intent commit together: one intent per event.
  assert.equal(intents.length, expectedEvents, "one intent per journalled event");
  assert.equal(new Set(intents.map((i) => i.idempotency_key)).size, intents.length, "intent keys are unique");
  for (const intent of intents) {
    if (intent.state === "pending") assert.equal(intent.claim_token, null, "pending intents carry no claim");
  }
}

interface Harness {
  proc: EventEmitter;
  /** Resolves with the exit code the first time the shutdown calls `exit`. */
  exited: Promise<number>;
  exitCodes: number[];
  stopAcceptingCalls: () => number;
  webhookStops: () => number;
  logs: string[];
  startedAt: number;
}

function installHarness(opts: {
  drainMs: number;
  store: StreamStore;
  outbox: OutboxDispatcher;
  pipeline?: IngestPipeline;
  inFlightIngest?: () => Promise<unknown> | null;
}): Harness {
  const proc = new EventEmitter();
  const exit = deferred<number>();
  const exitCodes: number[] = [];
  const logs: string[] = [];
  let stopAccepting = 0;
  let webhookStops = 0;
  const shutdown = createGracefulShutdown({
    drainMs: opts.drainMs,
    stopAccepting: () => {
      stopAccepting++;
    },
    pipeline: opts.pipeline,
    inFlightIngest: opts.inFlightIngest ?? (() => null),
    outbox: opts.outbox,
    webhooks: {
      stop: () => {
        webhookStops++;
      },
    },
    store: opts.store,
    exit: (code) => {
      exitCodes.push(code);
      exit.resolve(code);
    },
    log: (message) => logs.push(message),
  });
  installShutdownHandlers(proc, ["SIGINT", "SIGTERM"], shutdown);
  return {
    proc,
    exited: exit.promise,
    exitCodes,
    stopAcceptingCalls: () => stopAccepting,
    webhookStops: () => webhookStops,
    logs,
    startedAt: Date.now(),
  };
}

function assertStoreClosed(store: StreamStore): void {
  assert.throws(() => store.getState("lastLedger"), /not open/i, "the store must be closed after shutdown");
}

// ── Mock transport: lets a test hold a delivery "on the wire" ─────────────────

interface HeldTransport {
  transport: OutboxTransport;
  /** Idempotency keys in the order the transport was invoked. */
  calls: string[];
  /** Resolves when the first delivery is on the wire. */
  firstCallEntered: Promise<void>;
  /** Completes the held (first) delivery. */
  completeHeld: (result: TransportResult) => void;
}

function heldFirstTransport(): HeldTransport {
  const calls: string[] = [];
  const entered = deferred<void>();
  const held = deferred<TransportResult>();
  const transport: OutboxTransport = async (intent) => {
    calls.push(intent.idempotency_key);
    if (calls.length === 1) {
      entered.resolve();
      return held.promise;
    }
    return { ok: true, status: 200 };
  };
  return { transport, calls, firstCallEntered: entered.promise, completeHeld: held.resolve };
}

function recordingTransport(calls: string[]): OutboxTransport {
  return async (intent) => {
    calls.push(intent.idempotency_key);
    return { ok: true, status: 200 };
  };
}

function countOf(calls: string[], key: string): number {
  return calls.filter((c) => c === key).length;
}

// ── Mock RPC: lets a test hold an ingest read in flight ───────────────────────

interface EventSpec {
  ledger: number;
  streamId: string;
  name: string;
  data: Record<string, EventValue>;
}

/** stream_created at `base`, withdrawn at `base + 5`. */
function streamSpecs(streamId: string, base: number): EventSpec[] {
  return [
    {
      ledger: base,
      streamId,
      name: "stream_created",
      data: {
        sender: `GSENDER${streamId}`,
        recipient: `GRECIPIENT${streamId}`,
        token: "CTOKEN",
        deposit: "15000000",
        start_time: "1000",
        end_time: "2000",
        cancelable: true,
      },
    },
    { ledger: base + 5, streamId, name: "withdrawn", data: { withdrawn_total: "2000000" } },
  ];
}

function toRpcEvent(spec: EventSpec, index: number): RpcEvent {
  return {
    id: `${spec.ledger}-${index}`,
    pagingToken: String(spec.ledger),
    ledger: spec.ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + spec.ledger * 5_000).toISOString(),
    contractId: "CCONTRACT",
    topic: [spec.name, spec.streamId],
    value: spec.data,
  };
}

function fakeDecode(event: RpcEvent): DecodedEvent {
  const [name, streamId] = event.topic as string[];
  return {
    id: event.id,
    pagingToken: String(event.ledger),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    name,
    streamId: String(streamId),
    data: (event.value ?? {}) as Record<string, EventValue>,
  };
}

class GatedSource implements EventSource {
  private hold: { entered: Deferred<void>; released: Promise<void> } | null = null;
  private readonly ordered: RpcEvent[];

  constructor(specs: EventSpec[], readonly tip: number) {
    this.ordered = specs
      .map((spec, index) => toRpcEvent(spec, index))
      .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
  }

  /** The next `getEvents` call parks until `release()` is called. */
  holdNext(): { entered: Promise<void>; release: () => void } {
    const entered = deferred<void>();
    const released = deferred<void>();
    this.hold = { entered, released: released.promise };
    return { entered: entered.promise, release: () => released.resolve() };
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: this.tip };
  }

  async getEvents(params: Record<string, unknown>): Promise<EventsPage> {
    const hold = this.hold;
    this.hold = null;
    if (hold) {
      hold.entered.resolve();
      await hold.released;
    }
    const from = Number(params.startLedger ?? 1);
    const limit = Number((params.pagination as { limit: number }).limit);
    const events = this.ordered.filter((event) => event.ledger >= from).slice(0, limit);
    return { events, cursor: String(events.length), latestLedger: this.tip };
  }

  getRateBudget(): RateBudgetSnapshot {
    return {
      maxRps: 40,
      burstCapacity: 80,
      availableTokens: 1_000,
      observedLatencyMs: 200,
      healthyEndpoints: 2,
      hedgedReads: false,
    };
  }
}

/** Three windows' worth of events, so a stop can land between windows. */
const INGEST_SPECS: EventSpec[] = [
  ...streamSpecs("1", 2),
  ...streamSpecs("2", 12),
  ...streamSpecs("3", 22),
  ...streamSpecs("4", 32),
  ...streamSpecs("5", 52),
];
const INGEST_TIP = 60;

function newPipeline(store: StreamStore, source: GatedSource): IngestPipeline {
  return new IngestPipeline({
    source,
    sink: store,
    decode: fakeDecode,
    filters: [],
    initialLedger: 1,
    pageLimit: 1000,
    windowLedgers: 10,
    maxWindowLedgers: 10,
    maxWindowsPerTick: 100,
    maxInFlight: 1,
    sleep: async () => undefined,
  });
}

/** Runs ticks until caught up, as the poll loop would across restarts. */
async function ingestToTip(pipeline: IngestPipeline): Promise<{ inserted: number; duplicates: number }> {
  let inserted = 0;
  let duplicates = 0;
  for (let i = 0; i < 50; i++) {
    const report: TickReport = await pipeline.runTick();
    assert.equal(report.ok, true, `resume tick failed: ${report.error}`);
    inserted += report.eventsInserted;
    duplicates += report.duplicates;
    if (report.caughtUp) return { inserted, duplicates };
  }
  assert.fail("ingest never caught up");
}

// ── Idle ──────────────────────────────────────────────────────────────────────

describe("graceful shutdown: SIGTERM while idle", () => {
  it("exits cleanly and promptly, leaves the store consistent, and a restart loses and re-sends nothing", async () => {
    const dbPath = tempDbPath("idle");
    const store = openStoreWithConsumer(dbPath);
    const ids = seedEvents(store, 3);
    const outbox = new OutboxDispatcher(store.outbox, recordingTransport([]), newMetrics(), { batchSize: 10 });
    const h = installHarness({ drainMs: 2_000, store, outbox });

    h.proc.emit("SIGTERM");
    const code = await h.exited;

    assert.equal(code, 0);
    assert.ok(Date.now() - h.startedAt < 1_000, "idle shutdown must not wait out the drain window");
    assert.equal(h.stopAcceptingCalls(), 1);
    assert.equal(h.webhookStops(), 1);
    assertStoreClosed(store);

    const reopened = new StreamStore(dbPath);
    try {
      assertConsistent(reopened, 3);
      assert.deepEqual(reopened.outbox.stats().depth, { pending: 3, in_flight: 0, delivered: 0, dead: 0 });

      const calls: string[] = [];
      const restarted = new OutboxDispatcher(reopened.outbox, recordingTransport(calls), newMetrics(), { batchSize: 10 });
      await restarted.drainAll();
      for (const id of ids) assert.equal(countOf(calls, keyOf(id)), 1, `${id} dispatched exactly once`);
      assert.equal(reopened.outbox.stats().depth.delivered, 3);
    } finally {
      reopened.close();
    }
  });

  it("SIGINT takes the same path, and a repeated signal does not run the shutdown twice", async () => {
    const store = openStoreWithConsumer(tempDbPath("signals"));
    const outbox = new OutboxDispatcher(store.outbox, recordingTransport([]), newMetrics());
    const h = installHarness({ drainMs: 2_000, store, outbox });

    h.proc.emit("SIGINT");
    h.proc.emit("SIGTERM");
    h.proc.emit("SIGTERM");
    await h.exited;
    await sleep(20);

    assert.deepEqual(h.exitCodes, [0], "exit is called exactly once");
    assert.equal(h.stopAcceptingCalls(), 1);
    assert.equal(h.webhookStops(), 1);
  });
});

// ── Mid-dispatch ──────────────────────────────────────────────────────────────

describe("graceful shutdown: SIGTERM mid-dispatch (transport pending)", () => {
  it("waits for the delivery on the wire, claims nothing new, and a restart sends only what is left", async () => {
    const dbPath = tempDbPath("dispatch-drain");
    const store = openStoreWithConsumer(dbPath);
    const ids = seedEvents(store, 3);
    const wire = heldFirstTransport();
    const outbox = new OutboxDispatcher(store.outbox, wire.transport, newMetrics(), { batchSize: 10 });
    const h = installHarness({ drainMs: 5_000, store, outbox });

    const tick = outbox.tick();
    await wire.firstCallEntered;
    assert.equal(store.outbox.stats().depth.in_flight, 1, "the first intent is claimed and on the wire");

    h.proc.emit("SIGTERM");
    await sleep(30);
    assert.deepEqual(h.exitCodes, [], "shutdown must wait for the in-flight delivery");
    assert.doesNotThrow(() => store.getState("lastLedger"), "the store must stay open while draining");

    wire.completeHeld({ ok: true, status: 200 });
    const code = await h.exited;
    const report = await tick;

    assert.equal(code, 0);
    assert.equal(report.delivered, 1, "the in-flight delivery was recorded, not abandoned");
    assert.equal(wire.calls.length, 1, "no further intent was claimed once shutdown began");
    assertStoreClosed(store);

    const reopened = new StreamStore(dbPath);
    try {
      assertConsistent(reopened, 3);
      assert.deepEqual(reopened.outbox.stats().depth, { pending: 2, in_flight: 0, delivered: 1, dead: 0 });

      const afterRestart: string[] = [];
      const restarted = new OutboxDispatcher(reopened.outbox, recordingTransport(afterRestart), newMetrics(), { batchSize: 10 });
      await restarted.drainAll();

      assert.equal(countOf(afterRestart, keyOf(ids[0])), 0, "the delivered intent is not sent again");
      const all = [...wire.calls, ...afterRestart];
      for (const id of ids) assert.equal(countOf(all, keyOf(id)), 1, `${id} dispatched exactly once overall`);
      assert.equal(reopened.outbox.stats().depth.delivered, 3, "no event was lost");
    } finally {
      reopened.close();
    }
  });

  it("when the drain window expires, exits on time, requeues the stuck intent, and redelivers it at most once", async () => {
    const dbPath = tempDbPath("dispatch-timeout");
    const store = openStoreWithConsumer(dbPath);
    const ids = seedEvents(store, 3);
    const wire = heldFirstTransport();
    const outbox = new OutboxDispatcher(store.outbox, wire.transport, newMetrics(), { batchSize: 10 });
    const drainMs = 60;
    const h = installHarness({ drainMs, store, outbox });

    const tick = outbox.tick().then(
      (report) => ({ ok: true as const, report }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await wire.firstCallEntered;
    assert.equal(store.outbox.stats().depth.in_flight, 1);

    h.proc.emit("SIGTERM");
    const code = await h.exited;
    const elapsed = Date.now() - h.startedAt;

    assert.equal(code, 1, "a forced exit is reported as non-clean");
    assert.ok(elapsed >= drainMs - 10, `waited for the drain window (took ${elapsed}ms)`);
    assert.ok(elapsed < drainMs + 1_000, `exit is bounded by the drain window (took ${elapsed}ms)`);
    assert.ok(h.logs.some((l) => /released 1 claim/.test(l)), "the forced path is logged");
    assertStoreClosed(store);

    // Consistent at rest: the stuck intent is back to pending with its attempt
    // count untouched, not stranded in_flight until a claim timeout.
    const reopened = new StreamStore(dbPath);
    try {
      assertConsistent(reopened, 3);
      assert.deepEqual(reopened.outbox.stats().depth, { pending: 3, in_flight: 0, delivered: 0, dead: 0 });
      const stuck = reopened.outbox.listIntents({ limit: 10 }).find((i) => i.idempotency_key === keyOf(ids[0]));
      assert.ok(stuck);
      assert.equal(stuck.attempts, 0, "shutdown must not burn a retry attempt");
      assert.equal(stuck.claimed_at, null);

      const afterRestart: string[] = [];
      const restarted = new OutboxDispatcher(reopened.outbox, recordingTransport(afterRestart), newMetrics(), { batchSize: 10 });
      await restarted.drainAll();

      // The stuck delivery may already have reached the consumer, so it is sent
      // once more after restart (at-least-once, same idempotency key). Nothing
      // else is ever sent twice, and nothing is lost.
      const all = [...wire.calls, ...afterRestart];
      assert.equal(countOf(all, keyOf(ids[0])), 2, "the interrupted delivery is re-sent exactly once");
      assert.equal(countOf(all, keyOf(ids[1])), 1);
      assert.equal(countOf(all, keyOf(ids[2])), 1);
      assert.equal(reopened.outbox.stats().depth.delivered, 3, "no event was lost");

      // The old transport finally answers. It must not corrupt what the restarted
      // process recorded: its claim is gone and its store is closed.
      wire.completeHeld({ ok: true, status: 200 });
      await tick;
      const after = reopened.outbox.listIntents({ limit: 10 });
      assert.deepEqual(reopened.outbox.stats().depth, { pending: 0, in_flight: 0, delivered: 3, dead: 0 });
      assert.equal(after.find((i) => i.idempotency_key === keyOf(ids[0]))?.attempts, 0);
    } finally {
      reopened.close();
    }
  });
});

// ── Mid-ingest ────────────────────────────────────────────────────────────────

describe("graceful shutdown: SIGTERM mid-ingest", () => {
  it("lets the window being read commit atomically, then stops; a restart resumes with no loss or duplicates", async () => {
    const dbPath = tempDbPath("ingest-drain");
    const store = openStoreWithConsumer(dbPath);
    const source = new GatedSource(INGEST_SPECS, INGEST_TIP);
    const pipeline = newPipeline(store, source);
    const outbox = new OutboxDispatcher(store.outbox, recordingTransport([]), newMetrics());

    const hold = source.holdNext();
    let inFlight: Promise<TickReport> | null = pipeline.runTick();
    const tick = inFlight.finally(() => {
      inFlight = null;
    });
    await hold.entered;
    const h = installHarness({ drainMs: 5_000, store, outbox, pipeline, inFlightIngest: () => inFlight });

    h.proc.emit("SIGTERM");
    await sleep(30);
    assert.deepEqual(h.exitCodes, [], "shutdown must wait for the ingest tick in flight");

    hold.release();
    const code = await h.exited;
    const report = await tick;

    assert.equal(code, 0);
    assert.equal(report.ok, true);
    assert.equal(report.caughtUp, false, "the tick stopped early, it did not finish the backlog");
    assert.equal(report.windowsCommitted, 1, "only the window being read was committed");
    assertStoreClosed(store);

    const reopened = openStoreWithConsumer(dbPath);
    try {
      const position = Number(reopened.getState("ingest_ledger"));
      assert.ok(position >= 1 && position < INGEST_TIP, `partial position recorded (${position})`);
      // The position, the journal and the outbox intents all describe the same
      // ledgers: a window is all-or-nothing.
      const committed = INGEST_SPECS.filter((s) => s.ledger <= position);
      assert.ok(committed.length > 0 && committed.length < INGEST_SPECS.length);
      assertConsistent(reopened, committed.length);
      assert.ok(
        reopened.outbox.replayEvents("1", 0, 100).events.every((e) => e.ledger <= position),
        "nothing past the committed position was journalled"
      );

      const resumed = await ingestToTip(newPipeline(reopened, new GatedSource(INGEST_SPECS, INGEST_TIP)));
      assert.equal(resumed.inserted, INGEST_SPECS.length - committed.length, "only the remainder is ingested");
      assert.equal(resumed.duplicates, 0, "no committed event is ingested twice");
      assertConsistent(reopened, INGEST_SPECS.length);

      const restarted = new OutboxDispatcher(reopened.outbox, recordingTransport([]), newMetrics(), { batchSize: 100 });
      await restarted.drainAll();
      assert.equal(reopened.outbox.stats().depth.delivered, INGEST_SPECS.length, "no event lost end to end");
    } finally {
      reopened.close();
    }
  });

  it("when the drain window expires mid-read, exits on time with nothing half-applied, and a restart ingests everything once", async () => {
    const dbPath = tempDbPath("ingest-timeout");
    const store = openStoreWithConsumer(dbPath);
    const source = new GatedSource(INGEST_SPECS, INGEST_TIP);
    const pipeline = newPipeline(store, source);
    const outbox = new OutboxDispatcher(store.outbox, recordingTransport([]), newMetrics());

    const hold = source.holdNext();
    const tick = pipeline.runTick();
    await hold.entered;
    const drainMs = 60;
    const h = installHarness({ drainMs, store, outbox, pipeline, inFlightIngest: () => tick });

    h.proc.emit("SIGTERM");
    const code = await h.exited;
    const elapsed = Date.now() - h.startedAt;

    assert.equal(code, 1);
    assert.ok(elapsed >= drainMs - 10 && elapsed < drainMs + 1_000, `bounded exit (took ${elapsed}ms)`);
    assert.ok(h.logs.some((l) => /ingest tick did not finish/.test(l)));
    assertStoreClosed(store);

    const reopened = openStoreWithConsumer(dbPath);
    try {
      // The read never committed, so there is no partial state at all.
      assert.equal(reopened.getState("ingest_ledger"), undefined);
      assertConsistent(reopened, 0);

      // The stalled read finally returns. Its store is closed, so it cannot
      // write: the tick fails instead of landing a commit late.
      hold.release();
      const late = await tick.then(
        () => "resolved",
        (error: unknown) => error
      );
      assert.ok(late instanceof Error && /not open/i.test(late.message), "a late tick must not write after close");
      assertConsistent(reopened, 0);
      assert.equal(reopened.getState("ingest_ledger"), undefined);

      const resumed = await ingestToTip(newPipeline(reopened, new GatedSource(INGEST_SPECS, INGEST_TIP)));
      assert.equal(resumed.inserted, INGEST_SPECS.length);
      assert.equal(resumed.duplicates, 0);
      assertConsistent(reopened, INGEST_SPECS.length);
    } finally {
      reopened.close();
    }
  });
});

// ── Both at once, as a deploy would hit them ──────────────────────────────────

describe("graceful shutdown: ingest and dispatch both in flight", () => {
  it("drains both under one shared deadline", async () => {
    const dbPath = tempDbPath("both");
    const store = openStoreWithConsumer(dbPath);
    seedEvents(store, 2);
    const wire = heldFirstTransport();
    const outbox = new OutboxDispatcher(store.outbox, wire.transport, newMetrics(), { batchSize: 10 });
    const source = new GatedSource(INGEST_SPECS, INGEST_TIP);
    const pipeline = newPipeline(store, source);

    const hold = source.holdNext();
    const ingestTick = pipeline.runTick();
    const dispatchTick = outbox.tick();
    await Promise.all([hold.entered, wire.firstCallEntered]);
    const drainMs = 60;
    const h = installHarness({ drainMs, store, outbox, pipeline, inFlightIngest: () => ingestTick });

    h.proc.emit("SIGTERM");
    const code = await h.exited;
    const elapsed = Date.now() - h.startedAt;

    // One shared deadline, not one per component.
    assert.equal(code, 1);
    assert.ok(elapsed < drainMs + 1_000, `took ${elapsed}ms`);
    assertStoreClosed(store);

    hold.release();
    wire.completeHeld({ ok: true, status: 200 });
    // Both late completions hit a closed store and fail; neither may write.
    await ingestTick.catch(() => undefined);
    await dispatchTick.catch(() => undefined);

    const reopened = new StreamStore(dbPath);
    try {
      // Whatever the interleaving, nothing is half-applied: no in_flight intent,
      // and no ingest window partially written.
      assert.equal(reopened.outbox.stats().depth.in_flight, 0);
      assert.equal(reopened.getState("ingest_ledger"), undefined);
      assert.equal(reopened.outbox.stats().events, 2);
    } finally {
      reopened.close();
    }
  });
});
