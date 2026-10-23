/**
 * Sequencing for the parallel ingester (issue #117).
 *
 * Parallel fetch buys throughput at the price of arrival order; sequencing is how
 * we get the guarantees back. Two independent questions, two small machines:
 *
 * - **Coverage**: did we read every ledger between the last committed cursor and
 *   the tip, with no hole? `LedgerCoverage` answers that. A hole is possible in
 *   exactly one way — the RPC refuses a `startLedger` older than its history
 *   retention — and that is a data-loss event, so it is counted and reported,
 *   never silently skipped.
 * - **Per-stream order**: is this event older than what the stream projection
 *   already holds? `StreamSequencer` answers that per stream, and is the metric
 *   that tells an operator the reorder window actually caught something.
 *
 * Neither is authoritative for correctness: the ledger guard in `store.ts` is.
 * These exist so the guard's no-ops are visible instead of mysterious.
 */

import type { LedgerWindow } from "./planner.js";

export interface SequencedEvent {
  id: string;
  streamId: string;
  ledger: number;
}

export type EventOrder = "in-order" | "late";

/** Cumulative counters, safe to expose on an ops endpoint. */
export interface SequencerMetrics {
  windowsCommitted: number;
  ledgersCovered: number;
  /** Committed windows that did not abut the previous coverage. */
  gapWindows: number;
  /** Ledgers skipped between the end of coverage and a later window. */
  gapLedgers: number;
  eventsSeen: number;
  /** Events older than the ledger already committed for their stream. */
  lateEvents: number;
  /** Highest ledger-gap in ledgers between a late event and committed state. */
  maxLateDepth: number;
  streamsTracked: number;
}

export class IngestSequencer {
  private windowsCommitted = 0;
  private ledgersCovered = 0;
  private gapWindows = 0;
  private gapLedgers = 0;
  private eventsSeen = 0;
  private lateEvents = 0;
  private maxLateDepth = 0;
  private lastCovered?: number;
  /** Highest ledger already committed per stream. Seeded from the database. */
  private readonly streamLedgers = new Map<string, number>();

  constructor(seed?: Iterable<readonly [string, number]>) {
    if (seed) {
      for (const [streamId, ledger] of seed) this.streamLedgers.set(streamId, ledger);
    }
  }

  /**
   * Records that `[from .. to]` is now durably committed.
   *
   * The first window only establishes the baseline; afterwards any window that
   * starts past `contiguousThrough + 1` means ledgers were never read, so the
   * skipped count is added to `gapLedgers` — the number an operator pages on.
   */
  coverWindow(window: LedgerWindow): void {
    this.windowsCommitted += 1;
    const span = Math.max(0, window.to - window.from + 1);
    this.ledgersCovered += span;
    if (this.lastCovered !== undefined && window.from > this.lastCovered + 1) {
      this.gapWindows += 1;
      this.gapLedgers += window.from - (this.lastCovered + 1);
    }
    this.lastCovered = Math.max(this.lastCovered ?? 0, window.to);
  }

  /** Ledger through which coverage is contiguous, or `undefined` if nothing yet. */
  get coveredThrough(): number | undefined {
    return this.lastCovered;
  }

  /**
   * Classifies one event against the stream's committed position, in commit
   * order. Advances the stream position for in-order events so a later replay of
   * the same window is classified correctly.
   */
  classify(event: SequencedEvent): EventOrder {
    this.eventsSeen += 1;
    const committed = this.streamLedgers.get(event.streamId);
    if (committed !== undefined && event.ledger < committed) {
      this.lateEvents += 1;
      this.maxLateDepth = Math.max(this.maxLateDepth, committed - event.ledger);
      return "late";
    }
    if (committed === undefined || event.ledger > committed) {
      this.streamLedgers.set(event.streamId, event.ledger);
    }
    return "in-order";
  }

  metrics(): SequencerMetrics {
    return {
      windowsCommitted: this.windowsCommitted,
      ledgersCovered: this.ledgersCovered,
      gapWindows: this.gapWindows,
      gapLedgers: this.gapLedgers,
      eventsSeen: this.eventsSeen,
      lateEvents: this.lateEvents,
      maxLateDepth: this.maxLateDepth,
      streamsTracked: this.streamLedgers.size,
    };
  }
}
