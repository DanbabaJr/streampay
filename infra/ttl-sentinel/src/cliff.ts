//! The worst-case "cliff": how long each storage-entry class can survive
//! without any further touch, derived from how (or whether) the contract
//! extends it.
//!
//! Soroban TTL mechanics used here (verified against soroban-sdk and the
//! protocol docs):
//!
//! * Writing a value (`persistent().set`) does **not** change an entry's TTL.
//!   Only `extend_ttl` / `ExtendFootprintTTL` moves `liveUntilLedger`.
//! * `extend_ttl(key, threshold, extend_to)` extends **only if** the entry's
//!   remaining TTL is below `threshold`, setting `liveUntil = now + extend_to`.
//! * A brand-new persistent entry starts at `min_persistent_entry_ttl`
//!   (counted inclusive: remaining is `min - 1`).
//!
//! From those three facts the cliff per entry class falls out:
//!
//! **Extended classes (stream / index).** A write at ledger `L` extends only
//! when `remaining < T`. Consider the *last* write that ever extends: it sets
//! `liveUntil = L_e + E`. Any later write happens while `remaining >= T`,
//! i.e. at most `E - T` ledgers after `L_e`, and does not extend. So the
//! final write of the entry's life occurs no later than `L_e + (E - T)`,
//! leaving at least `E - (E - T) = T` ledgers on the clock — and that bound
//! is tight (a write at `remaining == T + ε` never extends, expiry `T + ε`
//! ledgers later). Worst-case cliff = **threshold T = 200_000 ledgers**
//! (~11.6 days at 5 s/ledger); best case (last write extended) = **E = 500_000**
//! (~28.9 days).
//!
//! **Never-extended classes (counter / instance / code).** StreamPay never
//! calls `extend_ttl` on `DataKey::NextStreamId`, its contract instance
//! entry, or its Wasm code entry (invocations do *not* auto-extend them
//! either). Their TTL is fixed at creation (`min - 1 = 4095` ledgers **≈ 5.7
//! hours** at 5 s/ledger) until something restores/extends them off-chain.
//! Cliff = **4095 ledgers**, 48× below the stream cliff — the whole reason a
//! sentinel must model entry classes separately.

import { CONTRACT_TTL_EXTEND_LEDGERS, CONTRACT_TTL_THRESHOLD_LEDGERS, MIN_PERSISTENT_ENTRY_TTL } from './constants.js';

/** Storage-entry classes the sentinel tracks. */
export type EntryClass = 'stream' | 'index' | 'counter' | 'instance' | 'code';

export interface ClassCliff {
  /** Ledgers guaranteed between the class's last on-chain write and expiry. */
  worstCaseLedgers: number;
  /** Best case: the last write actually extended the entry. */
  bestCaseLedgers: number;
  /** Whether StreamPay's code ever calls extend_ttl for this key. */
  extendedOnChain: boolean;
  /** Human-readable derivation, surfaced in reports and the PR. */
  note: string;
}

/**
 * Worst-case cliff for a class that the contract extends with
 * `extend_ttl(threshold, extend_to)` on write: the threshold itself.
 * See the module docs for the derivation.
 */
export function worstCaseCliffLedgers(threshold: number, extendTo: number): number {
  if (extendTo <= threshold) {
    throw new Error(`extendTo (${extendTo}) must exceed threshold (${threshold})`);
  }
  return threshold;
}

/** Best case for an extending class: the last write triggered a full bump. */
export function bestCaseCliffLedgers(threshold: number, extendTo: number): number {
  if (extendTo <= threshold) {
    throw new Error(`extendTo (${extendTo}) must exceed threshold (${threshold})`);
  }
  return extendTo;
}

/** TTL granted to a never-extended entry at creation (inclusive count). */
export function creationCliffLedgers(minPersistentTtl: number = MIN_PERSISTENT_ENTRY_TTL): number {
  return minPersistentTtl - 1;
}

const NEVER_EXTENDED_NOTE =
  'never extended on-chain (set() does not move TTL; no extend_ttl call, and invocation does not auto-extend instance/code)';

/** The cliff table — one row per storage-entry class of the StreamPay contract. */
export const CLASS_CLIFFS: Record<EntryClass, ClassCliff> = {
  stream: {
    worstCaseLedgers: worstCaseCliffLedgers(CONTRACT_TTL_THRESHOLD_LEDGERS, CONTRACT_TTL_EXTEND_LEDGERS),
    bestCaseLedgers: bestCaseCliffLedgers(CONTRACT_TTL_THRESHOLD_LEDGERS, CONTRACT_TTL_EXTEND_LEDGERS),
    extendedOnChain: true,
    note: 'put_stream extends on every write (create/withdraw/top_up/cancel): extend only when remaining < 200k, to now + 500k → worst case 200k ledgers from the last write',
  },
  index: {
    worstCaseLedgers: worstCaseCliffLedgers(CONTRACT_TTL_THRESHOLD_LEDGERS, CONTRACT_TTL_EXTEND_LEDGERS),
    bestCaseLedgers: bestCaseCliffLedgers(CONTRACT_TTL_THRESHOLD_LEDGERS, CONTRACT_TTL_EXTEND_LEDGERS),
    extendedOnChain: true,
    note: 'index entries are extended on write AND on every page read — same 200k/500k mechanics as streams',
  },
  counter: {
    worstCaseLedgers: creationCliffLedgers(),
    bestCaseLedgers: creationCliffLedgers(),
    extendedOnChain: false,
    note: `DataKey::NextStreamId — ${NEVER_EXTENDED_NOTE}; archived counter makes create_stream fail until restored`,
  },
  instance: {
    worstCaseLedgers: creationCliffLedgers(),
    bestCaseLedgers: creationCliffLedgers(),
    extendedOnChain: false,
    note: `contract instance entry — ${NEVER_EXTENDED_NOTE}; expiry bricks every entrypoint until extended/restored`,
  },
  code: {
    worstCaseLedgers: creationCliffLedgers(),
    bestCaseLedgers: creationCliffLedgers(),
    extendedOnChain: false,
    note: `Wasm code entry — ${NEVER_EXTENDED_NOTE}; expiry bricks the instance too`,
  },
};

export interface ScheduleMargins {
  cls: EntryClass;
  cliffLedgers: number;
  warnLedgers: number;
  critLedgers: number;
  /** Max ledgers the sentinel can miss between two scans (fastest cadence). */
  worstScanGapLedgers: number;
  /**
   * `cliff - (warn + worstScanGap)`: ledgers of margin by which the warning
   * provably fires *inside* the worst-case cliff window. Must be > 0.
   */
  warnMarginLedgers: number;
  /** `crit - worstScanGap`: ledgers between a critical alert and archive. */
  critLeadLedgers: number;
}

/**
 * Fail-fast safety check for a whole schedule: every class's warning must
 * provably fire inside its worst-case cliff, even if the scan is delayed by a
 * full interval at the fastest credible cadence.
 */
export function assertScheduleSafety(
  schedules: Record<EntryClass, { warnLedgers: number; critLedgers: number }>,
  scanIntervalSec: number,
  fastestLedgerSec: number,
): Record<EntryClass, ScheduleMargins> {
  const out = {} as Record<EntryClass, ScheduleMargins>;
  for (const cls of Object.keys(schedules) as EntryClass[]) {
    const s = schedules[cls];
    const m = scheduleMargins(cls, s.warnLedgers, s.critLedgers, scanIntervalSec, fastestLedgerSec);
    if (m.warnMarginLedgers <= 0) {
      throw new Error(
        `schedule unsafe for ${cls}: warn (${s.warnLedgers}) + worst scan gap (${m.worstScanGapLedgers}) ` +
          `does not fit inside the ${m.cliffLedgers}-ledger worst-case cliff`,
      );
    }
    out[cls] = m;
  }
  return out;
}

/**
 * Schedule-vs-cliff margins for one class: the warning must fire strictly
 * inside the worst-case cliff with margin, at the fastest credible ledger
 * cadence (worst case = most ledgers elapse between scans).
 */
export function scheduleMargins(
  cls: EntryClass,
  warnLedgers: number,
  critLedgers: number,
  scanIntervalSec: number,
  fastestLedgerSec: number,
): ScheduleMargins {
  const cliffLedgers = CLASS_CLIFFS[cls].worstCaseLedgers;
  const worstScanGapLedgers = Math.ceil(scanIntervalSec / fastestLedgerSec);
  if (warnLedgers <= critLedgers) {
    throw new Error(`warn (${warnLedgers}) must exceed crit (${critLedgers}) for ${cls}`);
  }
  if (warnLedgers >= cliffLedgers) {
    throw new Error(
      `warn (${warnLedgers}) must stay below the ${cls} worst-case cliff (${cliffLedgers}) ` +
        'so warnings fire inside the cliff window',
    );
  }
  return {
    cls,
    cliffLedgers,
    warnLedgers,
    critLedgers,
    worstScanGapLedgers,
    warnMarginLedgers: cliffLedgers - (warnLedgers + worstScanGapLedgers),
    critLeadLedgers: critLedgers - worstScanGapLedgers,
  };
}
