//! Sentinel state cache (JSON): last known stream count and party addresses,
//! plus the alert-dedup store and the extender's monthly spend meter.
//!
//! Used when the counter entry itself is missing (archived) so enumeration
//! still covers everything previously seen — and so index keys can still be
//! built for streams whose entries are archived.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AlertStoreState } from './alerts.js';
import type { SpenderState } from './extender.js';

export interface SentinelState {
  /** Highest stream id observed (ids are contiguous from 1). */
  maxStreamId: number;
  /** Addresses seen as sender or recipient (for index-key probes). */
  addresses: string[];
  /** Base64 LedgerKey of the deployed Wasm code entry, once discovered. */
  codeEntryKeyB64?: string;
  lastScanLedger?: number;
  lastScanIso?: string;
}

export function emptyState(): SentinelState {
  return { maxStreamId: 0, addresses: [] };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function loadState(path: string): SentinelState {
  const parsed = readJson<Partial<SentinelState>>(path, {});
  return {
    maxStreamId: typeof parsed.maxStreamId === 'number' && parsed.maxStreamId >= 0 ? parsed.maxStreamId : 0,
    addresses: Array.isArray(parsed.addresses) ? parsed.addresses.filter((a) => typeof a === 'string') : [],
    codeEntryKeyB64: typeof parsed.codeEntryKeyB64 === 'string' ? parsed.codeEntryKeyB64 : undefined,
    lastScanLedger: typeof parsed.lastScanLedger === 'number' ? parsed.lastScanLedger : undefined,
    lastScanIso: typeof parsed.lastScanIso === 'string' ? parsed.lastScanIso : undefined,
  };
}

export function saveState(path: string, state: SentinelState): void {
  writeJson(path, state);
}

export function loadAlertStore(path: string): AlertStoreState {
  const parsed = readJson<AlertStoreState>(path, { entries: {} });
  return parsed && typeof parsed.entries === 'object' && parsed.entries !== null ? parsed : { entries: {} };
}

export function saveAlertStore(path: string, state: AlertStoreState): void {
  writeJson(path, state);
}

/** Spend meter is persisted with stroops as a decimal string (JSON has no bigint). */
export function loadSpender(path: string): SpenderState {
  const parsed = readJson<{ month?: string; spentStroops?: string }>(path, {});
  return {
    month: typeof parsed.month === 'string' ? parsed.month : '',
    spentStroops: typeof parsed.spentStroops === 'string' ? BigInt(parsed.spentStroops) : 0n,
  };
}

export function saveSpender(path: string, state: SpenderState): void {
  writeJson(path, { month: state.month, spentStroops: state.spentStroops.toString() });
}
