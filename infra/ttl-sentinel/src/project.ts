//! Projection of a scanned entry's TTL into severity + wall-clock ETA.
//!
//! The projection itself is exact in ledger units (`remaining = liveUntil -
//! latestLedger`); the only interpretation layers are (a) the per-class
//! alert thresholds, and (b) cadence-based wall-clock ETAs.

import type { CadenceMeter } from './cadence.js';
import type { EntryClass } from './cliff.js';

export type Severity = 'ok' | 'warn' | 'crit' | 'expired';

export const SEVERITY_RANK: Record<Severity, number> = { ok: 0, warn: 1, crit: 2, expired: 3 };

export interface ClassSchedule {
  /** Alert when remaining TTL drops below this (ledger units). */
  warnLedgers: number;
  /** Alert when remaining TTL drops below this (ledger units). */
  critLedgers: number;
}

export interface Observation {
  /** Stable identity for alerts/state, e.g. `stream:12`, `counter`, `instance`. */
  id: string;
  cls: EntryClass;
  /** liveUntilLedger from RPC; null when the entry is absent/archived. */
  liveUntilLedger: number | null;
  /** lastModifiedLedgerSeq from RPC (last value write), when known. */
  lastModifiedLedger: number | null;
}

export interface Projection {
  id: string;
  cls: EntryClass;
  severity: Severity;
  /** Ledgers until archive; 0 for expired/missing entries. */
  remainingLedgers: number;
  /**
   * TTL actually granted at the entry's last write
   * (`liveUntil - lastModified`): the *observed* cliff for this very entry.
   */
  observedCliffLedgers: number | null;
  /** Earliest plausible wall-clock seconds until archive (fastest cadence). */
  etaSecondsFastest: number | null;
  /** Seconds until archive at the 5 s protocol target (display). */
  etaSecondsTarget: number | null;
  /** Seconds until archive at the sampled cadence when known. */
  etaSecondsMeasured: number | null;
  reason: string;
}

export interface ProjectionContext {
  nowLedger: number;
  nowIso: string;
  cadence: CadenceMeter;
}

/**
 * Classify one observation against its class schedule.
 *
 * Severity rules:
 * - entry absent or `liveUntil <= nowLedger` → `expired`
 * - `remaining <= crit` → `crit`
 * - `remaining <= warn` → `warn`
 * - otherwise → `ok`
 *
 * (An entry is live *through* `liveUntil`; it archives once the ledger
 * sequence exceeds it.)
 */
export function project(obs: Observation, schedule: ClassSchedule, ctx: ProjectionContext): Projection {
  const { nowLedger, cadence } = ctx;

  if (obs.liveUntilLedger === null) {
    return {
      id: obs.id,
      cls: obs.cls,
      severity: 'expired',
      remainingLedgers: 0,
      observedCliffLedgers: null,
      etaSecondsFastest: 0,
      etaSecondsTarget: 0,
      etaSecondsMeasured: 0,
      reason: 'entry not found in live ledger state (archived or never written)',
    };
  }

  const remaining = obs.liveUntilLedger - nowLedger;
  const observedCliff =
    obs.lastModifiedLedger !== null && obs.liveUntilLedger >= obs.lastModifiedLedger
      ? obs.liveUntilLedger - obs.lastModifiedLedger
      : null;

  const eta = (mode: 'fastest' | 'target' | 'measured'): number | null =>
    remaining > 0 ? cadence.secondsForLedgers(remaining, mode) : 0;

  if (remaining <= 0) {
    return {
      id: obs.id,
      cls: obs.cls,
      severity: 'expired',
      remainingLedgers: Math.max(0, remaining),
      observedCliffLedgers: observedCliff,
      etaSecondsFastest: 0,
      etaSecondsTarget: 0,
      etaSecondsMeasured: 0,
      reason: `liveUntilLedger ${obs.liveUntilLedger} <= ledger ${nowLedger}: entry archives at the next ledger close`,
    };
  }

  const severity: Severity =
    remaining <= schedule.critLedgers ? 'crit' : remaining <= schedule.warnLedgers ? 'warn' : 'ok';

  const bound = severity === 'ok' ? 'monitoring' : severity === 'warn' ? 'below warn threshold' : 'below critical threshold';
  return {
    id: obs.id,
    cls: obs.cls,
    severity,
    remainingLedgers: remaining,
    observedCliffLedgers: observedCliff,
    etaSecondsFastest: eta('fastest'),
    etaSecondsTarget: eta('target'),
    etaSecondsMeasured: eta('measured'),
    reason: `${bound}: ${remaining} ledgers remain (live until ${obs.liveUntilLedger})`,
  };
}
