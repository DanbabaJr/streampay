/**
 * Parallel ledger-event ingestion with ordering guarantees (issue #117).
 *
 * # Why it is safe to fetch in parallel
 *
 * `getEvents` cursor pagination is strictly sequential: page N+1's cursor is only
 * known after page N has been fetched, so the obvious loop spends almost all of
 * its wall-clock time waiting on one endpoint at a time.
 *
 * The fix is to stop paginating by cursor and start paginating by **ledger
 * range**. A tick reads the current tip once, then plans the backlog
 * `[resume .. tip]` as disjoint, contiguous windows of `windowLedgers` ledgers.
 * Disjointness means an event belongs to exactly one window; contiguity means the
 * windows tile the range with no holes. Therefore
 *
 *   concat(read(w0), read(w1), …, read(wk)) == the serial cursor walk
 *
 * in ledger order, regardless of the order the reads *complete* in. Parallelism
 * only changes *when* a read is issued; the commit order is pinned to the plan
 * order by the reorder buffer below.
 *
 * # Sizing the windows
 *
 * A window costs at least one request whether it holds no events or ten
 * thousand, so a fixed window size is a bet on one density. `planWindowLedgers`
 * removes the bet: it sizes each tick's windows from the events-per-ledger the
 * last ticks observed, targeting about one page of events per window. The
 * estimate is durable (`ingest_density`) and smoothed, and the windows are then
 * widened further if the backlog is longer than `maxWindowsPerTick` windows can
 * cover — otherwise a 150,000-ledger gap would take 150,000/20 = 7,500 requests
 * to close, which is how a "parallel" indexer ends up slower than the cursor
 * walk it replaced.
 *
 * Until there is an estimate to plan from, the tick plans only `PROBE_WINDOWS`
 * windows and lets the spread rule size them: it samples the backlog in a handful
 * of requests and learns its density, rather than grinding through the configured
 * window size one empty range at a time.
 *
 * Depth is re-derived at every admission, not once per tick. The RPC manager's
 * latency average is empty until a response lands, so a cold tick starts with one
 * request in flight and widens itself as that first response is measured.
 *
 * # Proving a window complete *
 * A window only advances the durable position if it is proven to contain every
 * event in its range, because `ingest_ledger` is the resume point and a wrong
 * proof loses history permanently. A read is proven complete when either:
 *
 * 1. the response contained an event past the window's upper bound — ledger
 *    ordering means we read beyond the end, so nothing in range was missed; or
 * 2. the response was shorter than the page limit **and** the responding
 *    endpoint's own `latestLedger` is at or past the window's upper bound.
 *
 * The second half of rule 2 is the one that is easy to get wrong: a lagging
 * endpoint (issue #56's health manager keeps it in the pool, just deprioritised)
 * returns a short page for a range it has not seen yet. Treating that as
 * complete would silently drop the missing ledgers. Instead the window commits
 * only up to that endpoint's tip and the tick stops, so the next tick re-plans
 * the remainder.
 *
 * # Exactly-once
 *
 * Two independent mechanisms, in this order:
 *
 * - `events.id` (a `ledger-tx-op-event` triple) keys the journal, inserted with
 *   `INSERT OR IGNORE`. Refetching a window boundary after a partial commit,
 *   replaying a page after a crash, or a duplicate delivery cannot double-count.
 * - the stream projection is monotonic: `ON CONFLICT … WHERE
 *   excluded.last_ledger >= streams.last_ledger` refuses to move a stream's
 *   derived state backwards, so an event that arrives late and is older (the cost
 *   of parallelism) is journalled for history and ignored for state.
 *
 * The serial cursor walk (`runSerial`) is retained: it is used when the database
 * holds a pre-windowing cursor, and `parallel: false` selects it permanently.
 */

import type { RateBudgetSnapshot } from "../rpc-manager.js";
import type { IngestSummary } from "../store.js";
import type { DecodedEvent, RpcEvent } from "../types.js";
import { deriveInFlight, planWindowLedgers, planWindows, type LedgerWindow } from "./planner.js";
import { IngestSequencer, type SequencerMetrics } from "./sequencer.js";

/** One `getEvents` response, narrowed to what ingestion needs. */
export interface EventsPage {
  events: RpcEvent[];
  latestLedger: number;
  cursor: string;
}

/** The slice of `RpcManager` the pipeline uses, kept small so tests can fake it. */
export interface EventSource {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(params: Record<string, unknown>): Promise<EventsPage>;
  getRateBudget(): RateBudgetSnapshot;
}

/** The slice of `StreamStore` the pipeline uses. */
export interface IngestSink {
  ingestPage(events: DecodedEvent[], cursor: string | undefined, latestLedger: number): IngestSummary;
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  maxLedgerByStream(): Map<string, number>;
}

export interface PipelineConfig {
  source: EventSource;
  sink: IngestSink;
  decode: (event: RpcEvent) => DecodedEvent;
  /** Passed through to `getEvents` verbatim (contract id + topic filters). */
  filters: unknown;
  /** Durable state key holding the highest proven-complete ledger. */
  positionKey?: string;
  /** Ledger to start from on a fresh database when no position exists. */
  initialLedger?: number;
  /** Per-request `pagination.limit`. */
  pageLimit: number;
  /**
   * Window size for a cold start, and the floor the adaptive sizing keeps to.
   */
  windowLedgers: number;
  /**
   * Ceiling for one adaptive window. A sparse backlog wants wide windows (see
   * `planWindowLedgers`); this bounds the worst case a single request can pull.
   */
  maxWindowLedgers?: number;
  maxWindowsPerTick: number;
  maxInFlight: number;
  /**
   * Ledgers withheld from the tip. `getEvents` only reports closed ledgers, so 0
   * is correct; the knob exists for deployments whose endpoint advertises a tip
   * it has not finished indexing.
   */
  confirmations?: number;
  /** Pages one window may consume before it is committed short and resumed. */
  maxPagesPerWindow?: number;
  /** Budget waits before the tick gives up. */
  maxBudgetWaits?: number;
  /** Ceiling applied to a `retryAfterMs` the bucket advertises. */
  maxBackpressureMs?: number;
  /** Sleep when the bucket reports it can fund nothing. */
  backpressureMs?: number;
  /** When false, always use the serial cursor walk. */
  parallel?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TickReport {
  ok: boolean;
  /** Serial cursor walk was used instead of windows. */
  serial: boolean;
  /** In-flight depth the budget allowed for this tick. */
  depth: number;
  /** Deepest the reorder buffer actually got — the realised reorder window. */
  maxInFlightObserved: number;
  windowsPlanned: number;
  windowsCommitted: number;
  /** RPC calls this tick paid for out of the shared budget. */
  requests: number;
  /** False when the last committed window was proven incomplete (lagging tip). */
  caughtUp: boolean;
  eventsSeen: number;
  eventsInserted: number;
  duplicates: number;
  projectionSkips: number;
  lateEvents: number;
  gapLedgers: number;
  /** Window size actually planned this tick: adaptive, unless density is unknown. */
  windowLedgers: number;
  /** Ledgers this tick proved complete, so the density estimate can be updated. */
  ledgersCovered: number;
  /** Ledger the next tick resumes at. */
  resumeAt: number | undefined;
  durationMs: number;
  error?: string;
}

interface WindowRead {
  window: LedgerWindow;
  events: DecodedEvent[];
  /** Highest ledger in this window that is proven complete. */
  through: number;
  complete: boolean;
  /** Pages this window consumed; >1 means the range was denser than a page. */
  pages: number;
}

const POSITION_KEY = "ingest_ledger";
/** Durable events-per-ledger estimate; see `planWindowLedgers`. */
const DENSITY_KEY = "ingest_density";
const DENSITY_ALPHA = 0.4;
const DEFAULT_MAX_WINDOW_LEDGERS = 5_000;
/**
 * Windows planned on a tick that has no density estimate yet. Four is enough to
 * measure the range while costing about the same as the cursor walk it replaces
 * — a larger sample would make the first tick slower than the old indexer, which
 * is the opposite of the point.
 */
const PROBE_WINDOWS = 4;
const DEFAULT_MAX_BACKPRESSURE_MS = 5_000;

function retryAfterMs(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "RATE_EXHAUSTED") return undefined;
  const raw = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

class TickAccumulator {
  ok = true;
  serial = false;
  depth = 0;
  maxInFlightObserved = 0;
  windowsPlanned = 0;
  windowsCommitted = 0;
  requests = 0;
  caughtUp = true;
  eventsSeen = 0;
  eventsInserted = 0;
  duplicates = 0;
  projectionSkips = 0;
  windowLedgers = 0;
  ledgersCovered = 0;
  error?: string;
}

export class IngestPipeline {
  private readonly sequencer: IngestSequencer;
  private readonly positionKey: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly cfg: PipelineConfig) {
    this.sequencer = new IngestSequencer(cfg.sink.maxLedgerByStream());
    this.positionKey = cfg.positionKey ?? POSITION_KEY;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = cfg.now ?? (() => Date.now());
  }

  metrics(): SequencerMetrics {
    return this.sequencer.metrics();
  }

  /** Reads the durable windowed position, or `undefined` on a fresh database. */
  resumeLedger(): number | undefined {
    const raw = this.cfg.sink.getState(this.positionKey);
    if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return value >= 1 ? value : undefined;
  }

  async runTick(): Promise<TickReport> {
    const acc = new TickAccumulator();
    const started = this.now();
    const position = this.resumeLedger();
    const legacyCursor = this.cfg.sink.getState("cursor");

    if (this.cfg.parallel === false) return this.runSerial(legacyCursor, started, acc);
    // A database written before windowed ingestion: finish the migration with
    // the cursor walk, which records a position later ticks can window from.
    if (position === undefined && legacyCursor !== undefined) {
      return this.runSerial(legacyCursor, started, acc);
    }

    try {
      const head = await this.withBudget(() => this.cfg.source.getLatestLedger());
      acc.requests += 1;
      const tip = head.sequence - (this.cfg.confirmations ?? 0);
      const start = position === undefined
        ? Math.max(1, this.cfg.initialLedger ?? tip)
        : position + 1;

      if (start > tip) {
        // Nothing to read. Record the tip so /health reflects liveness.
        this.cfg.sink.setState("lastLedger", String(Math.max(tip, 1)));
        return this.report(acc, started);
      }

      // While density is unknown the tick plans few windows, each spanning a
      // large slice of the backlog: that samples the range cheaply and produces
      // the estimate the next ticks plan from, instead of grinding through the
      // configured window size one empty range at a time.
      const eventsPerLedger = this.density();
      const maxWindows = eventsPerLedger === undefined
        ? Math.min(this.cfg.maxWindowsPerTick, PROBE_WINDOWS)
        : this.cfg.maxWindowsPerTick;
      const windowLedgers = planWindowLedgers({
        windowLedgers: this.cfg.windowLedgers,
        maxWindowLedgers: this.cfg.maxWindowLedgers ?? DEFAULT_MAX_WINDOW_LEDGERS,
        pageLimit: this.cfg.pageLimit,
        eventsPerLedger,
        ledgers: tip - start + 1,
        maxWindows,
      });
      const windows = planWindows(start, tip, {
        windowLedgers,
        maxWindowsPerTick: maxWindows,
      });
      acc.windowLedgers = windowLedgers;
      acc.windowsPlanned = windows.length;

      // ── Reorder buffer ───────────────────────────────────────────────────
      // Reads are issued up to `depth` ahead but always consumed from the front,
      // so commits happen in plan order no matter which endpoint answers first.
      const pending: Array<Promise<WindowRead>> = [];
      let issued = 0;
      const fill = (): void => {
        for (;;) {
          // Re-derived on every admission: the latency EWMA and the token bucket
          // both move while windows are in flight, so a tick starts serial and
          // ramps within its first response instead of waiting for the next tick.
          acc.depth = deriveInFlight(this.cfg.source.getRateBudget(), { maxInFlight: this.cfg.maxInFlight });
          if (pending.length >= acc.depth || issued >= windows.length) return;
          const read = this.readWindow(windows[issued++]);
          // A result that gets discarded because an earlier window failed or
          // stopped the tick must not surface as an unhandled rejection.
          read.catch(() => undefined);
          pending.push(read);
        }
      };

      fill();
      while (pending.length > 0) {
        acc.maxInFlightObserved = Math.max(acc.maxInFlightObserved, pending.length);
        const read = await pending.shift()!;
        this.commit(read, acc);
        if (!read.complete) {
          // Lagging tip: stop rather than commit later windows out of order.
          acc.caughtUp = false;
          break;
        }
        fill();
      }

      // A plan truncated by the per-tick window cap or by the density ceiling
      // leaves the rest of the backlog for the next tick; that is progress, not
      // a catch-up, and reporting it as one would make the lag invisible.
      const last = windows[windows.length - 1];
      if (acc.caughtUp && (last === undefined || last.to < tip)) acc.caughtUp = false;

      return this.report(acc, started);
    } catch (error) {
      acc.ok = false;
      acc.caughtUp = false;
      acc.error = error instanceof Error ? error.message : String(error);
      return this.report(acc, started);
    }
  }

  /**
   * Reads every event in `window`, following cursors when the range is denser
   * than one page, and reports the highest ledger proven complete.
   */
  private async readWindow(window: LedgerWindow): Promise<WindowRead> {
    const maxPages = this.cfg.maxPagesPerWindow ?? 8;
    const collected: RpcEvent[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      if (pages >= maxPages) {
        // A window denser than the cap. Commit only up to the last ledger known
        // to be finished: the cut may have landed mid-ledger, so the final ledger
        // is re-read next tick and the duplicate ids that come back with it are
        // ignored by the journal.
        if (collected.length === 0) {
          return { window, events: [], through: window.from - 1, complete: false, pages };
        }
        const through = Number(collected[collected.length - 1].ledger) - 1;
        if (through < window.from) {
          // Every event this window could read sits in a single ledger, and that
          // ledger is still not finished for us. Committing would either skip the
          // rest of it or make no forward progress, so refuse the tick loudly:
          // this needs a larger page or window, not a silent stall.
          throw new Error(
            `ledger ${window.from} holds more than ${maxPages * this.cfg.pageLimit} events; ` +
              "raise INGEST_PAGE_LIMIT or INGEST_MAX_PAGES_PER_WINDOW"
          );
        }
        return { window, events: this.decodeAll(collected), through, complete: false, pages };
      }

      const page = await this.withBudget(() => this.cfg.source.getEvents({
        ...(cursor ? { cursor } : { startLedger: window.from }),
        filters: this.cfg.filters,
        pagination: { limit: this.cfg.pageLimit },
        xdrFormat: "base64",
      }));
      pages += 1;

      let overflowed = false;
      for (const event of page.events) {
        if (Number(event.ledger) <= window.to) collected.push(event);
        else {
          overflowed = true;
          break;
        }
      }

      if (overflowed) {
        // Reading past the upper bound proves the range was fully consumed.
        return { window, events: this.decodeAll(collected), through: window.to, complete: true, pages };
      }

      if (page.events.length < this.cfg.pageLimit) {
        // A short page proves exhaustion only up to *this* endpoint's own tip.
        const reachedTip = page.latestLedger >= window.to;
        return {
          window,
          events: this.decodeAll(collected),
          through: reachedTip ? window.to : Math.max(window.from - 1, page.latestLedger),
          complete: reachedTip,
          pages,
        };
      }

      if (!page.cursor) {
        throw new Error(`window ${window.from}-${window.to}: a full page came back without a cursor`);
      }
      cursor = page.cursor;
    }
  }

  private decodeAll(events: RpcEvent[]): DecodedEvent[] {
    return events.map((event) => this.cfg.decode(event));
  }

  private commit(read: WindowRead, acc: TickAccumulator): void {
    // Deliberately not passing the page cursor through: a cursor from a window
    // that proved itself complete by reading past its upper bound points beyond
    // that bound, and storing it would let a fallback resume skip the windows in
    // between. `ingest_ledger` is the resume key for the windowed path.
    const summary = this.cfg.sink.ingestPage(read.events, undefined, read.through);
    for (const event of read.events) this.sequencer.classify(event);
    this.sequencer.coverWindow({ from: read.window.from, to: read.through });
    // The position moves with the data it describes, and only over ledgers that
    // were proven complete.
    this.cfg.sink.setState(this.positionKey, String(read.through));
    acc.windowsCommitted += 1;
    acc.requests += read.pages;
    acc.eventsSeen += read.events.length;
    acc.ledgersCovered += Math.max(0, read.through - read.window.from + 1);
    acc.eventsInserted += summary.inserted;
    acc.duplicates += summary.duplicates;
    acc.projectionSkips += summary.projectionSkips;
  }

  /** The pre-#117 cursor walk, kept as the migration path and an escape hatch. */
  private async runSerial(cursor: string | undefined, started: number, acc: TickAccumulator): Promise<TickReport> {
    acc.serial = true;
    acc.depth = 1;
    acc.caughtUp = false;
    try {
      const resume = this.resumeLedger();
      let activeCursor = cursor;
      let through = 0;
      for (;;) {
        let startLedger = this.cfg.initialLedger ?? (resume === undefined ? undefined : resume + 1);
        if (!activeCursor && startLedger === undefined) {
          // No cursor, no configured start and no windowed position: begin at the
          // tip, as the original indexer did.
          startLedger = (await this.withBudget(() => this.cfg.source.getLatestLedger())).sequence;
          acc.requests += 1;
        }
        if (acc.requests >= this.cfg.maxWindowsPerTick) {
          // Same bound as a windowed tick, read here as "requests per tick": an
          // endpoint that ignores cursors and keeps handing back full pages would
          // otherwise spin inside one poll instead of yielding to the next tick.
          // The cursor the store already recorded makes the next tick resume
          // exactly here, so progress is still forward.
          break;
        }
        const page = await this.withBudget(() => this.cfg.source.getEvents({
          ...(activeCursor ? { cursor: activeCursor } : { startLedger }),
          filters: this.cfg.filters,
          pagination: { limit: this.cfg.pageLimit },
          xdrFormat: "base64",
        }));
        const events = this.decodeAll(page.events);
        const next = page.cursor || activeCursor;
        const summary = this.cfg.sink.ingestPage(events, next, page.latestLedger);
        for (const event of events) this.sequencer.classify(event);
        through = Math.max(through, page.latestLedger);
        acc.eventsSeen += events.length;
        acc.eventsInserted += summary.inserted;
        acc.duplicates += summary.duplicates;
        acc.projectionSkips += summary.projectionSkips;
        acc.windowsCommitted += 1;
        acc.requests += 1;
        acc.maxInFlightObserved = 1;
        activeCursor = next;
        if (page.events.length < this.cfg.pageLimit || !activeCursor) {
          acc.caughtUp = true;
          break;
        }
      }
      // Hand the next tick a windowed position: everything up to the tip that
      // answered us has been read, so window planning can start after it.
      if (acc.caughtUp) this.cfg.sink.setState(this.positionKey, String(through));
    } catch (error) {
      acc.ok = false;
      acc.caughtUp = false;
      acc.error = error instanceof Error ? error.message : String(error);
    }
    return this.report(acc, started);
  }

  /**
   * Rate-budget admission. Refuses to start a request the shared bucket cannot
   * pay for, and treats `RATE_EXHAUSTED.retryAfterMs` as the backpressure signal
   * it is: wait that long (bounded), then try again.
   */
  private async withBudget<T>(run: () => Promise<T>): Promise<T> {
    const maxWaits = this.cfg.maxBudgetWaits ?? 4;
    const ceiling = this.cfg.maxBackpressureMs ?? DEFAULT_MAX_BACKPRESSURE_MS;

    for (let attempt = 0; ; attempt++) {
      const budget = this.cfg.source.getRateBudget();
      if (budget.availableTokens < 1) {
        if (attempt >= maxWaits) throw new Error(`rate budget did not free up after ${maxWaits} waits`);
        await this.sleep(Math.min(this.cfg.backpressureMs ?? 50, ceiling));
        continue;
      }
      try {
        return await run();
      } catch (error) {
        // Another caller can drain the bucket between our check and the call.
        // `retryAfterMs` is the manager saying how long that takes; ignoring it
        // and retrying immediately is what turns one slow indexer into a 429.
        const wait = retryAfterMs(error);
        if (wait === undefined || attempt >= maxWaits) throw error;
        await this.sleep(Math.min(wait, ceiling));
      }
    }
  }

  private report(acc: TickAccumulator, started: number): TickReport {
    const metrics = this.sequencer.metrics();
    this.recordDensity(acc);
    return {
      ok: acc.ok,
      serial: acc.serial,
      depth: acc.depth,
      maxInFlightObserved: acc.maxInFlightObserved,
      windowsPlanned: acc.windowsPlanned,
      windowsCommitted: acc.windowsCommitted,
      requests: acc.requests,
      caughtUp: acc.caughtUp,
      eventsSeen: acc.eventsSeen,
      eventsInserted: acc.eventsInserted,
      duplicates: acc.duplicates,
      projectionSkips: acc.projectionSkips,
      lateEvents: metrics.lateEvents,
      gapLedgers: metrics.gapLedgers,
      windowLedgers: acc.windowLedgers,
      ledgersCovered: acc.ledgersCovered,
      resumeAt: this.resumeLedger(),
      durationMs: Math.max(0, this.now() - started),
      error: acc.error,
    };
  }

  /** The last tick's events per ledger, or `undefined` before one is measured. */
  private density(): number | undefined {
    const raw = this.cfg.sink.getState(DENSITY_KEY);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /**
   * Feeds `planWindowLedgers` for the next tick. Smoothed rather than replaced
   * outright: one dense range must not widen every later window to a page's
   * worth of ledgers, and one empty range must not narrow them to one ledger.
   */
  private recordDensity(acc: TickAccumulator): void {
    if (acc.ledgersCovered < 1) return;
    const observed = acc.eventsSeen / acc.ledgersCovered;
    const previous = this.density();
    const value = previous === undefined ? observed : previous * (1 - DENSITY_ALPHA) + observed * DENSITY_ALPHA;
    this.cfg.sink.setState(DENSITY_KEY, value.toFixed(6));
  }
}
