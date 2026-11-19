/**
 * Tests for parallel ledger-window ingestion (issue #117).
 *
 * The contract under test is narrow and absolute: however the RPC responses
 * arrive, the committed state must be identical to the state a serial cursor
 * walk produces, and no event may be counted twice. The fake endpoint therefore
 * deliberately resolves windows in the *wrong* order, and the assertions check
 * that the pipeline refuses to let that reach the database.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StreamStore } from "../store.js";
import type { RateBudgetSnapshot } from "../rpc-manager.js";
import { IngestPipeline, type EventSource, type EventsPage, type TickReport } from "./pipeline.js";
import { deriveInFlight, planWindowLedgers, planWindows, type WindowSizeOptions } from "./planner.js";
import { IngestSequencer } from "./sequencer.js";
import type { DecodedEvent, EventValue, RpcEvent } from "../types.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

interface EventSpec {
  ledger: number;
  streamId: string;
  name: string;
  data?: Record<string, EventValue>;
}

/** A complete stream lifecycle: create, withdraw, top up, cancel. */
function streamEvents(streamId: string, base: number): EventSpec[] {
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
    { ledger: base + 10, streamId, name: "stream_topped_up", data: { new_deposit: "20000000" } },
    {
      ledger: base + 15,
      streamId,
      name: "stream_cancelled",
      data: { cancelled_by: `GSENDER${streamId}`, recipient_amount: "3000000", sender_amount: "10000000" },
    },
  ];
}

function toRpcEvent(spec: EventSpec, index: number): RpcEvent {
  return {
    id: `${spec.ledger}-${index}`,
    pagingToken: String(spec.ledger),
    ledger: spec.ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + spec.ledger * 5_000).toISOString(),
    contractId: "CCONTRACT",
    // The pipeline is decode-agnostic, so these tests keep topics as plain
    // strings and skip XDR; `decoder.test.ts` covers the XDR path.
    topic: [spec.name, spec.streamId],
    value: spec.data ?? {},
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

/**
 * An in-memory stand-in for Soroban RPC's `getEvents`.
 *
 * Models the two behaviours the correctness argument depends on: cursor
 * continuation within a range, and a responding endpoint that reports its *own*
 * `latestLedger`, which may be behind the window it was asked for.
 */
class FakeRpc implements EventSource {
  requests = 0;
  /**
   * The `startLedger` of each range request, in the order those requests were
   * answered. Cursor continuations are not logged: they belong to the window
   * that opened them, and the proof this feeds is about arrival order.
   */
  readonly completionOrder: number[] = [];
  /** Set below `tip` to simulate an endpoint that has not indexed the range yet. */
  servingTip: number | undefined;
  /** Fail this many upcoming requests with the manager's budget rejection. */
  exhaustFirst = 0;
  /** Report an empty bucket on this many upcoming admission checks. */
  starvedChecks = 0;
  /**
   * Report an *unmeasured* latency until this many responses have landed, the
   * way a manager's latency average looks before its first sample.
   */
  measureLatencyAfterRequests = 0;
  /** Requests issued and not yet answered, and the deepest the run overlapped. */
  inFlight = 0;
  maxObservedConcurrency = 0;
  answered = 0;
  /** When set, every request throws this error. */
  failWith: Error | undefined;
  /** When set, range requests are answered from the beginning: the bug that
   *  turns a cursor walk into an unbounded loop. */
  ignoresCursor = false;
  delayFor: (startLedger: number) => number;

  budget: RateBudgetSnapshot = {
    maxRps: 40,
    burstCapacity: 80,
    availableTokens: 1_000,
    observedLatencyMs: 200,
    healthyEndpoints: 2,
    hedgedReads: false,
  };

  private readonly ordered: RpcEvent[];

  constructor(
    specs: EventSpec[],
    public tip: number,
    delayFor: (startLedger: number) => number = () => 0
  ) {
    this.delayFor = delayFor;
    this.ordered = specs
      .map((spec, index) => toRpcEvent(spec, index))
      .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    this.answered += 1;
    return { sequence: this.tip };
  }

  async getEvents(params: Record<string, unknown>): Promise<EventsPage> {
    this.requests += 1;
    if (this.failWith) throw this.failWith;
    if (this.exhaustFirst > 0) {
      this.exhaustFirst -= 1;
      throw Object.assign(new Error("RPC rate budget exhausted; retry after ~7 ms"), {
        code: "RATE_EXHAUSTED",
        retryAfterMs: 7,
      });
    }

    const limit = Number((params.pagination as { limit: number }).limit);
    // An endpoint can only serve ledgers it has already indexed.
    const servedTip = this.servingTip ?? this.tip;
    const visible = this.ordered.filter((event) => event.ledger <= servedTip);
    let start = 0;
    if (params.cursor !== undefined && !this.ignoresCursor) {
      // A real cursor is opaque; an index of the last delivered event behaves
      // the same way for a client that only ever passes it back.
      start = Number(params.cursor) + 1;
    } else if (params.startLedger !== undefined) {
      const from = Number(params.startLedger);
      start = visible.findIndex((event) => event.ledger >= from);
      if (start < 0) start = visible.length;
    }
    const events = visible.slice(start, start + limit);

    // Always yield: a response that never suspends cannot overlap with another,
    // which would hide the concurrency the pipeline actually issued.
    this.inFlight += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.delayFor(Number(params.startLedger ?? -1))));
    this.inFlight -= 1;
    this.answered += 1;
    if (params.startLedger !== undefined) this.completionOrder.push(Number(params.startLedger));

    return {
      events,
      cursor: String(start + events.length - 1),
      latestLedger: servedTip,
    };
  }

  getRateBudget(): RateBudgetSnapshot {
    if (this.starvedChecks > 0) {
      this.starvedChecks -= 1;
      return { ...this.budget, availableTokens: 0 };
    }
    if (this.answered < this.measureLatencyAfterRequests) {
      // What a manager reports before it has measured any latency.
      return { ...this.budget, observedLatencyMs: 0 };
    }
    return this.budget;
  }
}

interface HarnessOptions {
  maxInFlight?: number;
  windowLedgers?: number;
  maxWindowLedgers?: number;
  maxWindowsPerTick?: number;
  pageLimit?: number;
  maxPagesPerWindow?: number;
  parallel?: boolean;
  delayFor?: (startLedger: number) => number;
  /** Default is ledger 1: a fresh database indexing the whole fixture. */
  initialLedger?: number;
  /** Pre-seeds the durable density estimate, i.e. a database that has already
   *  caught up once. Omitted means "cold start, probe only". */
  density?: number;
}

interface Harness {
  store: StreamStore;
  rpc: FakeRpc;
  pipeline: IngestPipeline;
  run: () => Promise<TickReport>;
}

function harness(specs: EventSpec[], tip: number, options: HarnessOptions = {}): Harness {
  const store = new StreamStore(":memory:");
  const rpc = new FakeRpc(specs, tip, options.delayFor);
  if (options.density !== undefined) store.setState("ingest_density", String(options.density));
  const pipeline = new IngestPipeline({
    source: rpc,
    sink: store,
    decode: fakeDecode,
    filters: [{ type: "contract", contractIds: ["CCONTRACT"] }],
    initialLedger: options.initialLedger ?? 1,
    pageLimit: options.pageLimit ?? 1_000,
    windowLedgers: options.windowLedgers ?? 20,
    maxWindowLedgers: options.maxWindowLedgers,
    maxWindowsPerTick: options.maxWindowsPerTick ?? 200,
    maxInFlight: options.maxInFlight ?? 8,
    maxPagesPerWindow: options.maxPagesPerWindow,
    parallel: options.parallel,
    sleep: async () => undefined,
  });
  return { store, rpc, pipeline, run: () => pipeline.runTick() };
}

/** Canonical view of everything ingestion is responsible for. */
function snapshot(store: StreamStore): { streams: unknown[]; events: unknown[] } {
  const streams = (store.db.prepare("SELECT * FROM streams ORDER BY stream_id").all() as Record<string, unknown>[])
    .map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
  const events = store.db
    .prepare("SELECT id, stream_id, name, ledger, ledger_closed_at FROM events ORDER BY ledger ASC, id ASC")
    .all() as Record<string, unknown>[];
  return { streams, events };
}

function count(store: StreamStore, table: "events" | "streams"): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const SIX_STREAMS = [
  ...streamEvents("1", 100),
  ...streamEvents("2", 118),
  ...streamEvents("3", 140),
  ...streamEvents("4", 157),
  ...streamEvents("5", 175),
  ...streamEvents("6", 190),
];

/**
 * A pre-seeded events-per-ledger estimate, so a test that is about depth or
 * ordering is not constrained by the cold-start probe. At the default page limit
 * of 1_000 this sizes windows at four ledgers, which tiles the 205-ledger
 * fixture into ~52 windows — far more than any test's `maxInFlight`, so the
 * reorder buffer can actually fill.
 */
const DENSITY = 250;

// ── Window planning ───────────────────────────────────────────────────────────

describe("planWindows", () => {
  it("tiles the range with no overlap and no holes", () => {
    const windows = planWindows(100, 165, { windowLedgers: 20, maxWindowsPerTick: 100 });
    assert.deepEqual(windows, [
      { from: 100, to: 119 },
      { from: 120, to: 139 },
      { from: 140, to: 159 },
      { from: 160, to: 165 },
    ]);
    for (let i = 1; i < windows.length; i++) {
      assert.equal(windows[i].from, windows[i - 1].to + 1, "windows must abut exactly");
    }
  });

  it("covers a single-ledger backlog", () => {
    assert.deepEqual(planWindows(50, 50, { windowLedgers: 20, maxWindowsPerTick: 8 }), [{ from: 50, to: 50 }]);
  });

  it("plans nothing when the backlog is empty", () => {
    assert.deepEqual(planWindows(51, 50, { windowLedgers: 20, maxWindowsPerTick: 8 }), []);
  });

  it("caps windows per tick so a tick stays bounded", () => {
    const windows = planWindows(1, 1_000, { windowLedgers: 10, maxWindowsPerTick: 3 });
    assert.equal(windows.length, 3);
    assert.equal(windows[2].to, 30);
  });

  it("refuses a zero-sized window instead of reporting a vacuous catch-up", () => {
    assert.throws(() => planWindows(1, 10, { windowLedgers: 0, maxWindowsPerTick: 5 }), /windowLedgers/);
  });
});

// ── Density-adaptive window sizing ────────────────────────────────────────────

describe("planWindowLedgers", () => {
  const size = (over: Partial<WindowSizeOptions>): number =>
    planWindowLedgers({
      windowLedgers: 20,
      maxWindowLedgers: 5_000,
      pageLimit: 1_000,
      eventsPerLedger: undefined,
      ledgers: 4_000,
      maxWindows: 200,
      ...over,
    });

  it("keeps the configured size until density is measured, if windows are cheap", () => {
    assert.equal(size({ eventsPerLedger: undefined, ledgers: 4_000, maxWindows: 200 }), 20);
  });

  it("samples an unmeasured backlog with the windows it is allowed, not one per range", () => {
    // 150,000 ledgers with a 32-window cap is 4,688 ledgers per window: a cold
    // tick pays a few requests to learn the density, not 7,500 to grind through
    // 20-ledger windows.
    assert.equal(size({ ledgers: 150_000, maxWindows: 32 }), 4_688);
    // A four-window probe wants 37,500-ledger ranges; the ceiling is what stops
    // one request from being asked to read half the backlog.
    assert.equal(size({ ledgers: 150_000, maxWindows: 4 }), 5_000);
  });

  it("widens windows on a sparse backlog to about one page each", () => {
    // 0.02 events/ledger means a page of 1,000 events spans 50,000 ledgers —
    // more than one window should read, so the ceiling binds.
    assert.equal(size({ eventsPerLedger: 0.02, ledgers: 100_000 }), 5_000);
    assert.equal(size({ eventsPerLedger: 0.2, ledgers: 100_000 }), 5_000);
  });

  it("narrows windows when the backlog is denser than a page per window", () => {
    assert.equal(size({ eventsPerLedger: 40 }), 25);
    assert.equal(size({ eventsPerLedger: 1_000, ledgers: 200 }), 1, "one ledger is the floor");
  });

  it("widens to cover a backlog the per-tick window cap cannot reach", () => {
    // 1,000,000 ledgers over 200 windows is 5,000 ledgers per window even though
    // the density would happily accept 20; refusing to widen would strand the
    // position behind the cap forever.
    assert.equal(size({ eventsPerLedger: 50, ledgers: 1_000_000 }), 5_000);
    assert.equal(size({ eventsPerLedger: undefined, ledgers: 40_000 }), 200);
  });

  it("never plans a window larger than the backlog", () => {
    assert.equal(size({ eventsPerLedger: 0.001, ledgers: 7 }), 7);
  });
});

// ── Budget-derived concurrency ────────────────────────────────────────────────

describe("deriveInFlight", () => {
  const budget = (over: Partial<RateBudgetSnapshot>): RateBudgetSnapshot => ({
    maxRps: 40,
    burstCapacity: 80,
    availableTokens: 1_000,
    observedLatencyMs: 200,
    healthyEndpoints: 2,
    hedgedReads: false,
    ...over,
  });

  it("starts serial until the endpoint's latency is measured", () => {
    assert.equal(deriveInFlight(budget({ observedLatencyMs: 0 }), { maxInFlight: 8 }), 1);
  });

  it("applies Little's law: rate x latency, not a magic number", () => {
    // 10 req/s at 200 ms funds exactly 2 in flight. Going beyond that is a
    // promise to exceed the budget the RPC manager is enforcing.
    assert.equal(deriveInFlight(budget({ maxRps: 10, observedLatencyMs: 200 }), { maxInFlight: 8 }), 2);
    assert.equal(deriveInFlight(budget({ maxRps: 10, observedLatencyMs: 50 }), { maxInFlight: 8 }), 1);
    assert.equal(deriveInFlight(budget({ maxRps: 50, observedLatencyMs: 200 }), { maxInFlight: 8 }), 8);
  });

  it("charges a hedged read as two requests", () => {
    assert.equal(deriveInFlight(budget({ maxRps: 40, observedLatencyMs: 200, hedgedReads: true }), { maxInFlight: 16 }), 4);
  });

  it("never exceeds what the bucket can fund at this instant", () => {
    assert.equal(deriveInFlight(budget({ availableTokens: 1 }), { maxInFlight: 8 }), 1);
    assert.equal(deriveInFlight(budget({ availableTokens: 0 }), { maxInFlight: 8 }), 1);
  });

  it("honours the operator ceiling but cannot raise the budget", () => {
    assert.equal(deriveInFlight(budget({ maxRps: 200, observedLatencyMs: 500 }), { maxInFlight: 3 }), 3);
  });
});

// ── Sequencing ────────────────────────────────────────────────────────────────

describe("IngestSequencer", () => {
  it("classifies an event older than the committed position as late", () => {
    const sequencer = new IngestSequencer();
    assert.equal(sequencer.classify({ id: "a", streamId: "1", ledger: 200 }), "in-order");
    assert.equal(sequencer.classify({ id: "b", streamId: "1", ledger: 150 }), "late");
    assert.equal(sequencer.classify({ id: "c", streamId: "2", ledger: 10 }), "in-order", "streams are independent");
    const metrics = sequencer.metrics();
    assert.equal(metrics.lateEvents, 1);
    assert.equal(metrics.maxLateDepth, 50);
    assert.equal(metrics.streamsTracked, 2);
  });

  it("treats events in the same ledger as in order, because a ledger can hold several", () => {
    const sequencer = new IngestSequencer([["1", 200]]);
    assert.equal(sequencer.classify({ id: "a", streamId: "1", ledger: 200 }), "in-order");
    assert.equal(sequencer.classify({ id: "b", streamId: "1", ledger: 199 }), "late");
  });

  it("counts skipped ledgers when coverage stops abutting", () => {
    const sequencer = new IngestSequencer();
    sequencer.coverWindow({ from: 100, to: 119 });
    sequencer.coverWindow({ from: 120, to: 139 });
    assert.equal(sequencer.metrics().gapWindows, 0);
    // An operator bumping the resume point past a range the endpoint trimmed.
    sequencer.coverWindow({ from: 150, to: 169 });
    const metrics = sequencer.metrics();
    assert.equal(metrics.gapWindows, 1);
    assert.equal(metrics.gapLedgers, 10);
    assert.equal(metrics.ledgersCovered, 60);
    assert.equal(sequencer.coveredThrough, 169);
  });
});

// ── The reordering torture test ───────────────────────────────────────────────

describe("parallel ingestion against a serial reference", () => {
  const tip = 205;

  it("produces identical state at depth 1 and depth 8 with inverted latencies", async () => {
    const serial = harness(SIX_STREAMS, tip, { maxInFlight: 1, density: DENSITY });
    const first = await serial.run();
    assert.equal(first.ok, true, first.error);
    assert.equal(first.caughtUp, true);
    const serialSnapshot = snapshot(serial.store);
    assert.equal(serialSnapshot.streams.length, 6, "the fixture must exercise the projection");
    assert.equal(serialSnapshot.events.length, 24);
    serial.store.close();

    // Later windows answer *faster*, so responses land in roughly the reverse of
    // plan order. Without the reorder buffer this is exactly how a parallel
    // ingester corrupts state.
    const parallel = harness(SIX_STREAMS, tip, {
      maxInFlight: 8,
      density: DENSITY,
      delayFor: (startLedger) => (220 - startLedger) / 10,
    });
    const second = await parallel.run();
    assert.equal(second.ok, true, second.error);
    assert.equal(second.caughtUp, true);
    assert.equal(second.windowsCommitted, first.windowsCommitted);
    assert.equal(second.maxInFlightObserved, 8, "the reorder buffer should have been full");

    const order = parallel.rpc.completionOrder;
    assert.ok(
      order.some((ledger, index) => index > 0 && ledger < order[index - 1]),
      `this test must prove responses landed out of plan order, got ${order.join(",")}`
    );

    assert.deepEqual(snapshot(parallel.store), serialSnapshot);
    parallel.store.close();
  });

  it("never needs the projection guard when commits stay ordered", async () => {
    const h = harness(SIX_STREAMS, tip, { maxInFlight: 8, density: DENSITY, delayFor: (start) => (start % 8 === 0 ? 4 : 0) });
    const tick = await h.run();
    assert.equal(tick.projectionSkips, 0, "in-order commits cannot be stale");
    assert.equal(tick.lateEvents, 0);
    assert.equal(tick.gapLedgers, 0);
    assert.equal(tick.duplicates, 0);
    assert.equal(count(h.store, "events"), 24);
    h.store.close();
  });

  it("keeps every stream's journalled events in ledger order at each depth", async () => {
    // Every third window answers late, so arrival order is neither plan order nor
    // its reverse at any depth.
    for (const depth of [1, 2, 5, 8]) {
      const h = harness(SIX_STREAMS, tip, { maxInFlight: depth, density: DENSITY, delayFor: (start) => (start % 3 === 1 ? 3 : 0) });
      const tick = await h.run();
      assert.equal(tick.ok, true, `depth ${depth} failed: ${tick.error}`);
      const unordered = h.store.db
        .prepare(`SELECT COUNT(*) AS n FROM (
            SELECT ledger, LAG(ledger) OVER (PARTITION BY stream_id ORDER BY rowid) AS previous
            FROM events
          ) WHERE previous IS NOT NULL AND ledger < previous`)
        .get() as { n: number };
      assert.equal(unordered.n, 0, `depth ${depth}: a stream journalled an event older than one already stored`);
      h.store.close();
    }
  });

  it("starts at the tip on a fresh database with no configured start", async () => {
    const store = new StreamStore(":memory:");
    const rpc = new FakeRpc(SIX_STREAMS, 110);
    const pipeline = new IngestPipeline({
      source: rpc,
      sink: store,
      decode: fakeDecode,
      filters: [],
      pageLimit: 1_000,
      windowLedgers: 20,
      maxWindowsPerTick: 200,
      maxInFlight: 8,
      sleep: async () => undefined,
    });
    const tick = await pipeline.runTick();
    assert.equal(tick.ok, true);
    assert.equal(tick.resumeAt, 110, "bootstrap records the tip as the position");
    assert.equal(count(store, "events"), 1, "only events at or after the tip are indexed");
    store.close();
  });
});

// ── Idempotency: duplicates, replays, late events ─────────────────────────────

describe("exactly-once under duplicate and late delivery", () => {
  const specs = [...streamEvents("1", 100), ...streamEvents("2", 118)];

  it("replaying a committed range changes nothing and counts duplicates", async () => {
    const h = harness(specs, 130, { maxInFlight: 8, windowLedgers: 8 });
    await h.run();
    const before = snapshot(h.store);
    const journalled = count(h.store, "events");
    assert.equal(journalled, 7, "events past the tip are not indexed");

    // Rewind the position as crash recovery would, then read the range again.
    h.store.setState("ingest_ledger", "99");
    const replay = await h.run();
    assert.equal(replay.duplicates, journalled, "every replayed event must be recognised");
    assert.equal(replay.eventsInserted, 0);
    assert.deepEqual(snapshot(h.store), before);
    assert.equal(h.store.getStream("1")?.withdrawn, "5000000", "cancel payout must not be counted twice");
    assert.equal(h.store.getStream("2")?.withdrawn, "2000000");
    h.store.close();
  });

  it("journals a genuinely late event without rewinding the projection", () => {
    const store = new StreamStore(":memory:");
    const ordered = streamEvents("7", 100).map((spec, index) => fakeDecode(toRpcEvent(spec, index)));
    store.ingestPage(ordered, undefined, 115);
    assert.equal(store.getStream("7")?.status, "cancelled");
    assert.equal(store.getStream("7")?.withdrawn, "5000000");
    assert.equal(store.getStream("7")?.deposit, "20000000");

    // A never-seen event id from an older ledger: a lagging endpoint finally
    // delivering something the earlier commit raced past.
    const late = fakeDecode(toRpcEvent({ ledger: 106, streamId: "7", name: "withdrawn", data: { withdrawn_total: "900000" } }, 999));
    const summary = store.ingestPage([late], undefined, 120);
    assert.equal(summary.inserted, 1, "the event itself is new");
    assert.equal(summary.projectionSkips, 1, "and its projection is refused");
    assert.equal(store.getStream("7")?.withdrawn, "5000000", "state must not move backwards");
    assert.equal(store.getStream("7")?.status, "cancelled");
    assert.equal(store.getStreamHistory("7").length, 5, "history keeps every event");
    store.close();
  });

  it("journals an unknown event name without touching the projection", () => {
    const store = new StreamStore(":memory:");
    const stranger = fakeDecode(toRpcEvent({ ledger: 101, streamId: "9", name: "governance_executed", data: { proposal: "3" } }, 0));
    const summary = store.ingestPage([stranger], undefined, 101);
    assert.equal(summary.inserted, 1);
    assert.equal(summary.projectionSkips, 0);
    assert.equal(store.getStream("9"), undefined);
    store.close();
  });

  it("seeds the sequencer from durable state so a restart still sees lateness", async () => {
    const h = harness(specs, 130, { maxInFlight: 4, windowLedgers: 20 });
    await h.run();
    const seed = h.store.maxLedgerByStream();
    assert.deepEqual([...seed.entries()].sort(), [["1", 115], ["2", 128]]);
    const restarted = new IngestSequencer(seed);
    assert.equal(restarted.classify({ id: "x", streamId: "1", ledger: 100 }), "late");
    assert.equal(restarted.classify({ id: "y", streamId: "2", ledger: 128 }), "in-order");
    h.store.close();
  });
});

// ── Density-adaptive window sizing ────────────────────────────────────────────

describe("density-adaptive catch-up", () => {
  // Four lifecycles spread over 40,000 ledgers: the shape of a contract whose
  // history is mostly empty blocks. Tiling it 20 ledgers at a time would need
  // 2,000 windows to move 16 events.
  const sparse = [
    ...streamEvents("1", 100),
    ...streamEvents("2", 10_000),
    ...streamEvents("3", 19_980),
    ...streamEvents("4", 30_000),
  ];

  it("probes an unmeasured backlog with few windows and reaches the tip", async () => {
    const h = harness(sparse, 20_000, { windowLedgers: 20, maxWindowsPerTick: 200, maxInFlight: 4 });
    const tick = await h.pipeline.runTick();

    assert.equal(tick.ok, true, tick.error);
    // Density is unknown, so the plan is a four-window sample of the range rather
    // than 1,000 windows of the configured 20 ledgers each.
    assert.equal(tick.windowLedgers, 5_000, "20,000 ledgers over a four-window probe");
    assert.equal(tick.windowsPlanned, 4);
    assert.equal(tick.requests, 5, "one tip read plus one request per window");
    assert.equal(tick.caughtUp, true, "a capped plan would strand the position mid-backlog");
    assert.equal(tick.eventsSeen, 12);
    assert.equal(count(h.store, "events"), 12);

    // The measurement the next tick plans from.
    const density = Number(h.store.getState("ingest_density"));
    assert.ok(Math.abs(density - 12 / 20_000) < 1e-9, `expected 0.0006, got ${density}`);
    h.store.close();
  });

  it("plans the next span from measured density instead of from the floor", async () => {
    const h = harness(sparse, 20_000, {
      windowLedgers: 20,
      maxWindowLedgers: 1_000,
      maxWindowsPerTick: 200,
      maxInFlight: 4,
    });
    const first = await h.pipeline.runTick();
    assert.equal(first.ok, true, first.error);
    // A ceiling of 1,000 ledgers caps the probe too, so the first tick samples
    // 4,000 ledgers of the 20,000 and leaves the rest as a bounded backlog.
    assert.equal(first.windowLedgers, 1_000);
    assert.equal(first.windowsPlanned, 4);
    assert.equal(first.ledgersCovered, 4_000);
    assert.equal(first.caughtUp, false, "a capped probe cannot reach the tip");
    const density = Number(h.store.getState("ingest_density"));
    assert.ok(Math.abs(density - 4 / 4_000) < 1e-9, `expected 0.001, got ${density}`);

    h.rpc.tip = 40_000;
    const second = await h.pipeline.runTick();

    assert.equal(second.ok, true, second.error);
    // 1,000 events per page at 0.001 events/ledger wants a 1M-ledger window; the
    // configured ceiling is what binds, so the remaining 36,000 ledgers tile into
    // 36 windows rather than the 20,000 the four-ledger floor would have needed.
    assert.equal(second.windowLedgers, 1_000);
    assert.equal(second.windowsPlanned, 36);
    assert.equal(second.requests, 37, "one tip read plus one request per window");
    assert.equal(second.caughtUp, true);
    assert.equal(count(h.store, "events"), 16);
    h.store.close();
  });
});

// ── Window completeness ───────────────────────────────────────────────────────

describe("window completeness", () => {
  it("follows cursors through a range denser than one page", async () => {
    // 60 events over ledgers 100..109, page limit 7, two pages per window: the
    // cap must be hit, and the range must still end up complete.
    const dense: EventSpec[] = [];
    for (let i = 0; i < 60; i++) {
      dense.push(
        i === 0
          ? { ledger: 100, streamId: "1", name: "stream_created", data: { sender: "S", recipient: "R", token: "T", deposit: "100", start_time: "1", end_time: "2", cancelable: true } }
          : { ledger: 100 + (i % 10), streamId: "1", name: "withdrawn", data: { withdrawn_total: "1" } }
      );
    }
    const h = harness(dense, 110, { maxInFlight: 4, windowLedgers: 5, pageLimit: 7, maxPagesPerWindow: 2 });
    let tick = await h.run();
    assert.equal(tick.ok, true, tick.error);
    assert.equal(tick.caughtUp, false, "a capped window must not claim to be caught up");

    for (let i = 0; i < 12 && !tick.caughtUp; i++) tick = await h.run();
    assert.equal(tick.caughtUp, true);
    assert.equal(count(h.store, "events"), 60, "every event in a dense range is ingested exactly once");
    assert.ok(tick.duplicates > 0, "the re-read boundary ledger must produce recognised duplicates");
    h.store.close();
  });

  it("commits only up to a lagging endpoint's tip and re-plans the rest", async () => {
    const h = harness(streamEvents("1", 100), 205, { maxInFlight: 8, windowLedgers: 20 });
    h.rpc.servingTip = 105;
    const first = await h.run();
    assert.equal(first.caughtUp, false);
    assert.ok((first.resumeAt ?? 0) <= 105, "the position must not pass the tip we were served");
    const partial = count(h.store, "events");
    assert.ok(partial > 0 && partial < 4, `expected a partial read, saw ${partial}`);

    // Same database, endpoint caught up: the remainder must arrive with no holes.
    h.rpc.servingTip = undefined;
    let tick = first;
    for (let i = 0; i < 8 && !tick.caughtUp; i++) tick = await h.run();
    assert.equal(tick.caughtUp, true);
    assert.equal(count(h.store, "events"), 4, "ledgers skipped while lagging must be recovered, not lost");
    assert.equal(h.store.getStream("1")?.withdrawn, "5000000");
    assert.equal(h.pipeline.metrics().gapLedgers, 0);
    h.store.close();
  });

  it("detects a coverage gap when the resume point jumps forward", async () => {
    const h = harness([...streamEvents("1", 100), ...streamEvents("2", 200)], 130, { maxInFlight: 4, windowLedgers: 10 });
    const first = await h.run();
    assert.equal(first.caughtUp, true);

    // Retention trim: ledgers 131..160 are gone, and the operator advances the
    // resume point past them. That must be visible, not silent.
    h.store.setState("ingest_ledger", "160");
    h.rpc.tip = 220;
    const second = await h.run();
    assert.equal(second.gapLedgers, 30, "ledgers 131..160 were never read");
    assert.equal(h.pipeline.metrics().gapWindows, 1);
    h.store.close();
  });

  it("refuses a tick rather than stalling on a ledger denser than the page budget", async () => {
    // 20 events in one ledger, 7 per page, 2 pages per window: the window cannot
    // be finished, and committing anyway would either skip part of the ledger or
    // make no forward progress at all.
    const hot: EventSpec[] = [{ ledger: 100, streamId: "1", name: "stream_created", data: { sender: "S", recipient: "R", token: "T", deposit: "10", start_time: "1", end_time: "2", cancelable: true } }];
    for (let i = 1; i < 20; i++) hot.push({ ledger: 100, streamId: "1", name: "withdrawn", data: { withdrawn_total: "1" } });
    const h = harness(hot, 100, { maxInFlight: 4, windowLedgers: 5, pageLimit: 7, maxPagesPerWindow: 2 });

    let tick = await h.run();
    for (let i = 0; i < 5 && tick.ok && !tick.caughtUp; i++) tick = await h.run();
    assert.equal(tick.ok, false, "the unreadable ledger must fail loudly");
    assert.match(tick.error ?? "", /holds more than 14 events/);
    assert.equal(tick.resumeAt, 99, "only ledgers proven complete may be recorded");
    assert.equal(count(h.store, "events"), 14, "what was read is still journalled");
    h.store.close();
  });
});

// ── Backpressure and failure ──────────────────────────────────────────────────

describe("rate budget backpressure", () => {
  it("waits out RATE_EXHAUSTED and completes the tick", async () => {
    const h = harness(streamEvents("1", 100), 120, { maxInFlight: 2, windowLedgers: 10 });
    h.rpc.exhaustFirst = 1;
    const tick = await h.run();
    assert.equal(tick.ok, true, tick.error);
    assert.equal(tick.caughtUp, true);
    assert.equal(count(h.store, "events"), 4, "a rejected request must be retried, not dropped");
    h.store.close();
  });

  it("refuses to start a request the bucket cannot fund", async () => {
    const h = harness(streamEvents("1", 100), 120, { maxInFlight: 2, windowLedgers: 10 });
    h.rpc.starvedChecks = 1;
    const tick = await h.run();
    assert.equal(tick.ok, true, tick.error);
    assert.equal(h.rpc.starvedChecks, 0, "the starved admission check must have been consulted");
    assert.equal(count(h.store, "events"), 4);
    h.store.close();
  });

  it("surfaces an endpoint failure as a failed tick without advancing the position", async () => {
    const h = harness(streamEvents("1", 100), 120, { maxInFlight: 2, windowLedgers: 10 });
    await h.run();
    h.store.setState("ingest_ledger", "99");
    h.rpc.failWith = new Error("all endpoints failed");
    const tick = await h.run();
    assert.equal(tick.ok, false);
    assert.match(tick.error ?? "", /all endpoints failed/);
    assert.equal(h.store.getState("ingest_ledger"), "99", "a failed tick must not advance the position");
    h.store.close();
  });

  it("gives up on a budget that never frees up", async () => {
    const h = harness(streamEvents("1", 100), 120, { maxInFlight: 2, windowLedgers: 10 });
    h.rpc.getRateBudget = () => ({ ...h.rpc.budget, availableTokens: 0 });
    const tick = await h.run();
    assert.equal(tick.ok, false);
    assert.match(tick.error ?? "", /did not free up/);
    assert.equal(h.rpc.requests, 0, "nothing may be requested against an unfunded bucket");
    h.store.close();
  });

  it("holds one request in flight while the endpoint's latency is unmeasured", async () => {
    const h = harness(SIX_STREAMS, 205, { maxInFlight: 8, density: DENSITY });
    h.rpc.measureLatencyAfterRequests = Number.MAX_SAFE_INTEGER;
    const tick = await h.pipeline.runTick();
    assert.equal(tick.ok, true, tick.error);
    assert.equal(tick.depth, 1);
    assert.equal(h.rpc.maxObservedConcurrency, 1, "an unmeasured endpoint must not be flooded");
    assert.equal(count(h.store, "events"), 24);
    h.store.close();
  });

  it("ramps to the budget's depth inside a single tick", async () => {
    const h = harness(SIX_STREAMS, 205, { maxInFlight: 8, density: DENSITY });
    // The manager's latency average fills in as responses land, which is exactly
    // what the first tick after a restart looks like. Depth is re-derived per
    // admission, so the tick widens itself instead of waiting for the next one.
    h.rpc.measureLatencyAfterRequests = 3;
    const tick = await h.pipeline.runTick();
    assert.equal(tick.ok, true, tick.error);
    assert.equal(tick.depth, 8);
    assert.equal(h.rpc.maxObservedConcurrency, 8, "the ramp cannot wait for a second tick");
    assert.equal(count(h.store, "events"), 24);
    h.store.close();
  });
});

// ── Serial compatibility ──────────────────────────────────────────────────────

describe("serial cursor path", () => {
  it("migrates a pre-windowing cursor and records a windowed position", async () => {
    const specs = [...streamEvents("1", 100), ...streamEvents("2", 118)];
    const store = new StreamStore(":memory:");
    const rpc = new FakeRpc(specs, 205);
    // A database written by the old sequential indexer: a cursor, no position.
    // "-1" is the index just before the first event.
    store.setState("cursor", "-1");
    const pipeline = new IngestPipeline({
      source: rpc,
      sink: store,
      decode: fakeDecode,
      filters: [],
      pageLimit: 4,
      windowLedgers: 20,
      maxWindowsPerTick: 50,
      maxInFlight: 8,
      sleep: async () => undefined,
    });

    const migrated = await pipeline.runTick();
    assert.equal(migrated.serial, true);
    assert.equal(migrated.caughtUp, true);
    assert.ok(migrated.resumeAt !== undefined);
    assert.equal(migrated.depth, 1);

    const windowed = await pipeline.runTick();
    assert.equal(windowed.serial, false);
    assert.equal(count(store, "events"), 8);
    assert.equal(store.getStream("1")?.withdrawn, "5000000");
    store.close();
  });

  it("runs when parallelism is switched off", async () => {
    const h = harness(streamEvents("1", 100), 130, { parallel: false, windowLedgers: 20, pageLimit: 3 });
    h.store.setState("cursor", "-1");
    const tick = await h.run();
    assert.equal(tick.serial, true);
    assert.equal(tick.caughtUp, true);
    assert.equal(count(h.store, "events"), 4);
    h.store.close();
  });

  it("bounds a tick when the endpoint ignores cursors", async () => {
    // The cursor walk's one unbounded risk: a proxy that answers every cursor
    // with the same full page. The tick must end at its request budget and leave
    // the resume cursor durable, not spin inside one poll.
    const h = harness(SIX_STREAMS, 205, { parallel: false, pageLimit: 3, maxWindowsPerTick: 5 });
    h.rpc.ignoresCursor = true;
    const tick = await h.run();
    assert.equal(tick.ok, true, tick.error);
    assert.equal(tick.serial, true);
    assert.equal(tick.caughtUp, false, "a page that never shortens cannot be caught up");
    assert.equal(tick.requests, 5, "one tick, one request budget");
    assert.ok(h.store.getState("cursor") !== undefined, "the resume cursor must survive the tick");
    assert.ok(count(h.store, "events") > 0);
    h.store.close();
  });
});
