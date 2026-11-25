//! Ledger-cadence measurement and the wall-clock bounds derived from it.
//!
//! Everything safety-critical is computed in **ledger units** (deterministic:
//! `remaining = liveUntil - now`). Cadence only converts ledgers to wall
//! time, in two directions:
//!
//! * **ETA display** — how long until archive: `ledgers × sec/ledger`.
//! * **Schedule safety** — how many ledgers can elapse between two scans
//!   spaced `scanIntervalSec` apart in wall time. Worst case = *fastest*
//!   credible cadence (most ledgers per second), which is the 1 s
//!   whole-second protocol floor — never the 5 s target.

import { FASTEST_CREDIBLE_LEDGER_SECONDS, TARGET_LEDGER_SECONDS } from './constants.js';

export interface CadenceSample {
  ledger: number;
  wallMs: number;
}

export interface CadenceStats {
  /** Sampled seconds-per-ledger, or null until at least two samples exist. */
  measuredSecPerLedger: number | null;
  sampleCount: number;
  /** Hard floor used for worst-case math (default 1 s). */
  floorSec: number;
  /** Protocol target, used for human-facing "at 5 s/ledger" estimates. */
  targetSec: number;
}

export class CadenceMeter {
  private readonly samples: CadenceSample[] = [];
  private readonly maxSamples: number;
  readonly floorSec: number;
  readonly targetSec: number;

  constructor(opts: { floorSec?: number; targetSec?: number; maxSamples?: number } = {}) {
    this.floorSec = opts.floorSec ?? FASTEST_CREDIBLE_LEDGER_SECONDS;
    this.targetSec = opts.targetSec ?? TARGET_LEDGER_SECONDS;
    this.maxSamples = opts.maxSamples ?? 64;
    if (this.floorSec <= 0 || this.targetSec <= 0) {
      throw new Error('cadence bounds must be positive');
    }
    if (this.floorSec > this.targetSec) {
      throw new Error('floorSec must not exceed targetSec');
    }
  }

  /** Record an observed (ledger, wall-clock) pair; keeps a bounded window. */
  record(ledger: number, wallMs: number): void {
    const last = this.samples[this.samples.length - 1];
    // Only strictly advancing ledgers carry cadence information (a ledger that
    // has not closed since the last sample cannot tell us seconds per ledger),
    // and out-of-order observations are ignored outright.
    if (last && ledger <= last.ledger) return;

    this.samples.push({ ledger, wallMs });
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }

  stats(): CadenceStats {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    let measured: number | null = null;
    if (first && last && last.ledger > first.ledger) {
      measured = (last.wallMs - first.wallMs) / 1000 / (last.ledger - first.ledger);
      if (measured < this.floorSec) measured = this.floorSec;
      if (measured > this.targetSec * 4) measured = this.targetSec * 4; // clamp wild samples
    }
    return {
      measuredSecPerLedger: measured,
      sampleCount: this.samples.length,
      floorSec: this.floorSec,
      targetSec: this.targetSec,
    };
  }

  /**
   * Worst-case ledgers that can elapse in `wallSeconds` — the number the
   * scan-schedule safety math must use (fastest credible cadence).
   */
  maxLedgersInWallSeconds(wallSeconds: number): number {
    if (wallSeconds < 0) throw new Error('wallSeconds must be >= 0');
    return Math.ceil(wallSeconds / this.floorSec);
  }

  /**
   * Seconds until `ledgers` more ledgers close. `mode`:
   * - `'fastest'` — 1 s floor: earliest plausible wall-clock event (used for
   *   alert ETAs so operators plan against the soonest expiry),
   * - `'target'` — 5 s protocol target,
   * - `'measured'` — sampled cadence when available, else target.
   */
  secondsForLedgers(ledgers: number, mode: 'fastest' | 'target' | 'measured'): number {
    if (ledgers < 0) throw new Error('ledgers must be >= 0');
    const measured = this.stats().measuredSecPerLedger;
    const sec = mode === 'fastest' ? this.floorSec : mode === 'target' ? this.targetSec : (measured ?? this.targetSec);
    return ledgers * sec;
  }
}

/** Format a seconds duration as a compact human string ("11.6d", "4h12m"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'n/a';
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
