/**
 * Ledger-window planning and budget-derived concurrency for the parallel
 * ingester (issue #117).
 *
 * Two pure pieces, so the interesting parts of the design can be tested without
 * a network or a database:
 *
 * - `planWindows` turns a backlog `[start .. tip]` into disjoint, contiguous
 *   ledger ranges. Disjoint + contiguous is what makes the parallel fetch safe:
 *   every event belongs to exactly one window, so windows can be fetched in any
 *   order and simply concatenated to reproduce the serial ordering.
 * - `planWindowLedgers` sizes those ranges from the observed event density, so a
 *   sparse backlog does not cost one request per few empty ledgers.
 * - `deriveInFlight` sizes how many windows may be in flight from the RPC
 *   manager's own rate budget (issue #56), rather than a constant.
 */

import type { RateBudgetSnapshot } from "../rpc-manager.js";

export interface LedgerWindow {
  /** Inclusive lower ledger bound. */
  from: number;
  /** Inclusive upper ledger bound. */
  to: number;
}

export interface PlanOptions {
  /** Ledgers per window. Small windows finish sooner and parallelise better;
   *  large windows cost fewer requests. */
  windowLedgers: number;
  /** Hard cap on windows planned per tick, keeping one tick bounded in both
   *  memory and wall-clock time. Whatever is left over is picked up next tick. */
  maxWindowsPerTick: number;
}

/**
 * Plans the windows covering `[start .. tip]` inclusive.
 *
 * Returns `[]` when there is nothing to catch up. Throws on a non-positive
 * window so a misconfigured `WINDOW_LEDGERS=0` cannot silently produce an
 * empty plan that the operator reads as "caught up".
 */
export function planWindows(start: number, tip: number, opts: PlanOptions): LedgerWindow[] {
  if (opts.windowLedgers < 1) throw new Error("planWindows: windowLedgers must be >= 1");
  if (!Number.isFinite(start) || !Number.isFinite(tip)) {
    throw new Error(`planWindows: start/tip must be finite integers (got ${start}/${tip})`);
  }
  const windows: LedgerWindow[] = [];
  if (opts.maxWindowsPerTick < 1) return windows;
  let from = Math.max(start, 1);
  while (from <= tip && windows.length < opts.maxWindowsPerTick) {
    const to = Math.min(from + Math.floor(opts.windowLedgers) - 1, tip);
    windows.push({ from, to });
    from = to + 1;
  }
  return windows;
}

/** The ledger just past the last planned window — i.e. where the next tick starts. */
export function nextStartAfter(windows: readonly LedgerWindow[], fallback: number): number {
  const last = windows[windows.length - 1];
  return last ? last.to + 1 : fallback;
}

export interface WindowSizeOptions {
  /** Ledgers per window as configured: the floor for a cold start. */
  windowLedgers: number;
  /** Ceiling for one window, so a sparse range cannot become one request. */
  maxWindowLedgers: number;
  /** Per-request `pagination.limit`: a window should hold about one page. */
  pageLimit: number;
  /** Events per ledger as observed, or `undefined` before the first measurement. */
  eventsPerLedger: number | undefined;
  /** Ledgers still to catch up. */
  ledgers: number;
  /**
   * Windows this tick may plan. The caller lowers it while density is unknown,
   * so the first tick samples the backlog instead of paying one request per
   * configured window.
   */
  maxWindows: number;
}

/**
 * Sizes a window from the observed event density.
 *
 * Windowing trades request *count* for latency hiding: one window costs at least
 * one request whether it holds 0 events or 10,000. Fixed small windows therefore
 * lose badly on a sparse backlog — 20-ledger windows over a 150,000-ledger range
 * is 7,500 requests to move a few thousand events, where the serial cursor walk
 * needed one request per page of events.
 *
 * Matching the two paths is what makes the parallel speedup pure: pick the
 * window so it is expected to hold roughly one page (`pageLimit / density`). The
 * request count then approaches the cursor walk's, and every one of those
 * requests can be in flight at once.
 */
export function planWindowLedgers(opts: WindowSizeOptions): number {
  const ledgers = Math.max(1, Math.floor(opts.ledgers));
  const density = opts.eventsPerLedger;
  const max = Math.max(1, Math.floor(opts.maxWindowLedgers));

  let size = density === undefined || !Number.isFinite(density) || density <= 0
    ? Math.floor(opts.windowLedgers)
    : Math.round(opts.pageLimit / density);
  size = Math.min(Math.max(size, 1), max);

  // A backlog longer than this tick's windows must still be coverable: widen the
  // window rather than strand the position behind the cap. While density is
  // unknown the caller caps the window *count* low, so this term is what makes
  // the cold-start tick a cheap density sample rather than a fixed-size grind.
  // The ceiling still binds, so a backlog wider than `maxWindows * max` simply
  // takes more ticks — bounded progress instead of one request asked to read
  // half the chain.
  const spread = Math.ceil(ledgers / Math.max(1, Math.floor(opts.maxWindows)));
  return Math.min(Math.max(size, spread), max, ledgers);
}

export interface DepthOptions {
  /**
   * Operator ceiling from configuration. The budget can only ever lower the
   * depth below this, never raise it.
   */
  maxInFlight: number;
}

/**
 * How many window fetches may be in flight without exceeding the shared rate
 * budget.
 *
 * Little's law: to sustain `R` requests per second at an observed latency of
 * `L` milliseconds you may keep `R * L / 1000` in flight. Anything more is a
 * promise to exceed the budget, which is how a parallel indexer turns a healthy
 * endpoint into a 429 storm — the failure mode issue #100 exists to prevent.
 *
 * `availableTokens` then trims that to what the bucket can actually pay for at
 * this instant.
 *
 * A hedged read is charged as two requests. `RpcManager.call()` spends one token
 * per call and hedges inside it, so this is deliberately stricter than the
 * bucket's own accounting: when the primary stalls, the *endpoints* really do see
 * two requests, and endpoints are what a 429 storm comes from.
 *
 * Before the first response lands, latency is unmeasured and the depth is
 * deliberately 1: the pipeline starts serial and opens up as it learns the
 * endpoint's speed.
 */
export function deriveInFlight(budget: RateBudgetSnapshot, opts: DepthOptions): number {
  const ceiling = Math.max(1, Math.floor(opts.maxInFlight));
  const perRead = budget.hedgedReads ? 2 : 1;
  const sustained = Math.floor((budget.maxRps * budget.observedLatencyMs) / 1000 / perRead);
  const affordable = Math.floor(budget.availableTokens / perRead);
  return Math.min(ceiling, Math.max(1, Math.min(sustained, affordable)));
}
