//! A fake chain that models the *only* thing the sentinel cares about:
//! `liveUntilLedger` per entry, plus the contract's write rules.
//!
//! Write rules modelled from `contracts/streaming-payments/src/stream.rs`:
//! - `create_stream` writes the counter entry (min TTL, *never* extended) and
//!   the stream entry (extended: remaining < 200k → now + 500k)
//! - `withdraw` / `top_up` / `cancel_stream` rewrite the stream entry, so the
//!   same extension rule applies — a write while remaining ≥ 200k changes the
//!   value but not the TTL (the adversarial case)
//! - index entries are extended on write *and* on page reads
//! - the instance and Wasm code entries are never extended

import type { CadenceMeter } from '../src/cadence.js';
import { CadenceMeter as Meter } from '../src/cadence.js';
import {
  CONTRACT_TTL_EXTEND_LEDGERS,
  CONTRACT_TTL_THRESHOLD_LEDGERS,
  MIN_PERSISTENT_ENTRY_TTL,
} from '../src/constants.js';
import { codeKey, counterKey, indexKey, instanceKey, keyToBase64, streamKey } from '../src/keys.js';
import type { LedgerEntryObs, RpcClient } from '../src/rpc.js';
import { emptyState, type SentinelState } from '../src/state.js';
import { AlertEngine, MemorySink, type AlertEvent } from '../src/alerts.js';
import { defaultConfig, type SentinelConfig } from '../src/config.js';
import type { Projection } from '../src/project.js';
import { Scanner, type ScanReport } from '../src/scanner.js';
import {
  ADDR_A,
  ADDR_B,
  CONTRACT_ID,
  counterEntryXdr,
  indexEntryXdr,
  instanceEntryXdr,
  streamEntryXdr,
  type StreamFixtureOpts,
} from './fixtures.js';

export interface FakeEntry {
  xdr: string;
  liveUntil: number;
  lastModified: number;
}

export class FakeChain implements RpcClient {
  ledger: number;
  wallMs: number;
  readonly entries = new Map<string, FakeEntry>();
  /** Every getLedgerEntries call's key count (asserts ≤200 chunking). */
  readonly batchSizes: number[] = [];
  private nextStreamId = 1;
  /** Sub-ledger time carried between advances. */
  private pendingLedgers = 0;
  private readonly wasmHash = Buffer.alloc(32, 0x5a);
  readonly counterKeyB64: string;
  readonly instanceKeyB64: string;
  readonly codeKeyB64: string;

  constructor(opts: { startLedger?: number; wallMs?: number } = {}) {
    this.ledger = opts.startLedger ?? 1_000_000;
    this.wallMs = opts.wallMs ?? 1_700_000_000_000;
    this.counterKeyB64 = keyToBase64(counterKey(CONTRACT_ID));
    this.instanceKeyB64 = keyToBase64(instanceKey(CONTRACT_ID));
    this.codeKeyB64 = keyToBase64(codeKey(this.wasmHash));
    // Only the deployed contract exists before the first stream.
    this.entries.set(this.instanceKeyB64, {
      xdr: instanceEntryXdr(this.wasmHash),
      liveUntil: this.ledger + MIN_PERSISTENT_ENTRY_TTL - 1,
      lastModified: this.ledger,
    });
    this.entries.set(this.codeKeyB64, {
      // Opacity is fine here: nothing decodes the code entry, only its length.
      xdr: Buffer.alloc(120_000, 0).toString('base64'),
      liveUntil: this.ledger + MIN_PERSISTENT_ENTRY_TTL - 1,
      lastModified: this.ledger,
    });
  }

  // ---- RPC ----------------------------------------------------------------

  getLatestLedger(): Promise<{ sequence: number }> {
    return Promise.resolve({ sequence: this.ledger });
  }

  getLedgerEntries(keys: string[]): Promise<{ latestLedger: number; entries: LedgerEntryObs[] }> {
    this.batchSizes.push(keys.length);
    const entries: LedgerEntryObs[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      // Archived entries are simply not live any more and disappear from RPC.
      if (!entry || entry.liveUntil <= this.ledger) continue;
      entries.push({
        key,
        xdr: entry.xdr,
        lastModifiedLedgerSeq: entry.lastModified,
        liveUntilLedgerSeq: entry.liveUntil,
      });
    }
    return Promise.resolve({ latestLedger: this.ledger, entries });
  }

  // ---- Contract semantics -------------------------------------------------

  /** `create_stream`: first call also creates the never-extended counter. */
  createStream(opts: StreamFixtureOpts = {}, atLedger: number = this.ledger): number {
    const id = opts.id ?? this.nextStreamId;
    this.nextStreamId = Math.max(this.nextStreamId, id + 1);

    if (!this.entries.has(this.counterKeyB64)) {
      this.entries.set(this.counterKeyB64, {
        xdr: counterEntryXdr(this.nextStreamId),
        liveUntil: atLedger + MIN_PERSISTENT_ENTRY_TTL - 1,
        lastModified: atLedger,
      });
    } else {
      // `set` does NOT move the TTL: still never extended.
      const counter = this.entries.get(this.counterKeyB64) as FakeEntry;
      counter.xdr = counterEntryXdr(this.nextStreamId);
      counter.lastModified = atLedger;
    }

    this.entries.set(keyToBase64(streamKey(CONTRACT_ID, id)), {
      xdr: streamEntryXdr({ ...opts, id }),
      liveUntil: atLedger + CONTRACT_TTL_EXTEND_LEDGERS,
      lastModified: atLedger,
    });
    this.extendIndexes(atLedger);
    return id;
  }

  /** A mutating call that rewrites the stream entry (`withdraw`/`top_up`/`cancel`). */
  writeStream(id: number, opts: StreamFixtureOpts = {}, atLedger: number = this.ledger): void {
    const key = keyToBase64(streamKey(CONTRACT_ID, id));
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`no stream ${id}`);
    const remaining = entry.liveUntil - atLedger;
    if (remaining < CONTRACT_TTL_THRESHOLD_LEDGERS) {
      entry.liveUntil = atLedger + CONTRACT_TTL_EXTEND_LEDGERS;
    }
    entry.xdr = streamEntryXdr({ ...opts, id });
    entry.lastModified = atLedger;
    this.extendIndexes(atLedger);
  }

  /** Index entries get the same threshold/extend treatment on write and read. */
  extendIndexes(atLedger: number = this.ledger): void {
    for (const [kind, address] of [
      ['SenderStreams', ADDR_A],
      ['RecipientStreams', ADDR_B],
    ] as const) {
      const key = keyToBase64(indexKey(CONTRACT_ID, kind, address));
      const entry = this.entries.get(key);
      const liveUntil = atLedger + CONTRACT_TTL_EXTEND_LEDGERS;
      this.entries.set(key, {
        xdr: indexEntryXdr(kind, address, [1]),
        liveUntil: entry ? Math.max(entry.liveUntil, liveUntil) : liveUntil,
        lastModified: entry?.lastModified ?? atLedger,
      });
    }
  }

  /** Off-chain `ExtendFootprintTTL`: raises the floor, leaves lastModified alone. */
  extendOffchain(id: string, extendTo: number, atLedger: number = this.ledger): void {
    const keyB64 =
      id === 'counter'
        ? this.counterKeyB64
        : id === 'instance'
          ? this.instanceKeyB64
          : id.startsWith('code:')
            ? this.codeKeyB64
            : keyToBase64(streamKey(CONTRACT_ID, Number(id.split(':')[1])));
    const entry = this.entries.get(keyB64);
    if (!entry) throw new Error(`no entry ${id}`);
    entry.liveUntil = Math.max(entry.liveUntil, atLedger + extendTo);
  }

  // ---- Time ---------------------------------------------------------------

  /** Advance wall-clock time; ledgers close at `cadenceSec` per ledger. */
  advanceSeconds(seconds: number, cadenceSec = 5): void {
    this.wallMs += seconds * 1000;
    this.pendingLedgers += seconds / cadenceSec;
    const whole = Math.floor(this.pendingLedgers);
    this.ledger += whole;
    this.pendingLedgers -= whole;
  }

  advanceLedgers(count: number, cadenceSec = 5): void {
    this.advanceSeconds(count * cadenceSec, cadenceSec);
  }

  entryFor(id: string): FakeEntry | undefined {
    if (id === 'counter') return this.entries.get(this.counterKeyB64);
    if (id === 'instance') return this.entries.get(this.instanceKeyB64);
    if (id.startsWith('code:')) return this.entries.get(this.codeKeyB64);
    if (id.startsWith('stream:')) return this.entries.get(keyToBase64(streamKey(CONTRACT_ID, Number(id.split(':')[1]))));
    return undefined;
  }
}

export interface ScanSummary {
  atLedger: number;
  atIso: string;
  report: ScanReport;
  projections: Projection[];
  events: AlertEvent[];
}

/** Drives the real Scanner + AlertEngine against the fake chain. */
export class Harness {
  readonly cfg: SentinelConfig;
  readonly chain: FakeChain;
  readonly cadence: CadenceMeter;
  readonly state: SentinelState = emptyState();
  readonly sink = new MemorySink();
  readonly engine: AlertEngine;
  readonly history: ScanSummary[] = [];

  constructor(chain: FakeChain, cfgOverrides: Partial<SentinelConfig> = {}, reAlertEveryLedgers = 10_000_000) {
    this.chain = chain;
    this.cfg = { ...defaultConfig({ contractId: CONTRACT_ID }), ...cfgOverrides };
    this.cadence = new Meter({ floorSec: this.cfg.floorLedgerSec, targetSec: this.cfg.targetLedgerSec });
    this.engine = new AlertEngine({ reAlertEveryLedgers }, [this.sink], undefined);
  }

  async scan(): Promise<ScanSummary> {
    const scanner = new Scanner({
      rpc: this.chain,
      cfg: this.cfg,
      state: this.state,
      cadence: this.cadence,
      nowIso: () => new Date(this.chain.wallMs).toISOString(),
    });
    const { report, projections } = await scanner.scan();
    this.cadence.record(report.atLedger, this.chain.wallMs);
    const events = this.engine.evaluate(projections, {
      atLedger: report.atLedger,
      atIso: report.atIso,
      contractId: CONTRACT_ID,
    });
    const summary = { atLedger: report.atLedger, atIso: report.atIso, report, projections, events };
    this.history.push(summary);
    return summary;
  }

  /** Scan every `scanIntervalSec` of wall time, advancing `cadenceSec`-paced ledgers. */
  async run(opts: { scans: number; scanIntervalSec?: number; cadenceSec?: number }): Promise<ScanSummary[]> {
    const interval = opts.scanIntervalSec ?? this.cfg.scanIntervalSec;
    const cadenceSec = opts.cadenceSec ?? this.cfg.targetLedgerSec;
    const out: ScanSummary[] = [];
    for (let i = 0; i < opts.scans; i++) {
      out.push(await this.scan());
      this.chain.advanceSeconds(interval, cadenceSec);
    }
    return out;
  }

  eventsFor(id: string, severity?: string): AlertEvent[] {
    return this.history
      .flatMap((h) => h.events)
      .filter((e) => e.id === id && (severity === undefined || e.severity === severity));
  }

  allEvents(): AlertEvent[] {
    return this.history.flatMap((h) => h.events);
  }

  projectionFor(id: string): Projection | undefined {
    const last = this.history[this.history.length - 1];
    return last?.projections.find((p) => p.id === id);
  }
}
