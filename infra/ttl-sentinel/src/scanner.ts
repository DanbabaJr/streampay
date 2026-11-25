//! The scanner: enumerate every ledger entry the contract's state lives in,
//! read their TTLs, and project expiry.
//!
//! Discovery strategy: `DataKey::NextStreamId` hands out contiguous ids from
//! 1, so enumerating `1..next_id-1` via batched `getLedgerEntries`
//! (≤200 keys/request) covers **every** stream regardless of RPC event
//! retention (a public RPC keeps only ~7 days of events, far less than the
//! 4095-ledger counter cliff it would need to cover). If the counter entry is
//! itself missing, the persisted state cache supplies the last known
//! high-water mark so coverage degrades gracefully — and the counter gets an
//! `expired` critical alert either way.

import { Buffer } from 'node:buffer';

import type { CadenceMeter } from './cadence.js';
import type { EntryClass } from './cliff.js';
import type { SentinelConfig } from './config.js';
import { RPC_MAX_LEDGER_KEYS } from './constants.js';
import {
  decodeCounterValue,
  decodeStreamValue,
  entryValueScVal,
  wasmHashFromInstanceVal,
  type DecodedStream,
} from './decode.js';
import { codeKey, counterKey, hashToBytes, indexKey, instanceKey, keyToBase64, streamKey, type IndexKind } from './keys.js';
import { xdr } from '@stellar/stellar-sdk';
import { project, type Observation, type Projection } from './project.js';
import type { LedgerEntryObs, RpcClient } from './rpc.js';
import type { SentinelState } from './state.js';

export interface EntryFacts {
  id: string;
  cls: EntryClass;
  /** Base64 LedgerKey, reused for off-chain TTL extension. */
  keyB64: string;
  present: boolean;
  liveUntilLedger: number | null;
  lastModifiedLedger: number | null;
  /** Measured LedgerEntryData XDR size (bytes) — basis for rent math. */
  sizeBytes: number | null;
}

export interface StreamFacts extends EntryFacts {
  streamId: number;
  stream: DecodedStream | null;
}

export interface ScanReport {
  atLedger: number;
  atIso: string;
  rpcLatestLedger: number;
  counter: EntryFacts & { nextId: number | null };
  instance: EntryFacts | null;
  code: EntryFacts | null;
  streams: {
    enumerated: number;
    present: number;
    missingIds: number[];
    entries: StreamFacts[];
  };
  indexes: EntryFacts[];
  /** Representative measured sizes per class (max observed; 0 if unknown). */
  sizes: Record<EntryClass, number>;
  /** True when the counter was unreadable and enumeration used the cache. */
  usedCounterFallback: boolean;
}

export interface ScanResult {
  report: ScanReport;
  projections: Projection[];
}

export interface ScanDeps {
  rpc: RpcClient;
  cfg: SentinelConfig;
  state: SentinelState;
  cadence: CadenceMeter;
  nowIso?: () => string;
}

function sizeOf(entry: LedgerEntryObs | undefined): number | null {
  return entry?.xdr ? Buffer.byteLength(entry.xdr, 'base64') : null;
}

function liveUntilOf(entry: LedgerEntryObs | undefined): number | null {
  if (!entry || typeof entry.liveUntilLedgerSeq !== 'number') return null;
  return entry.liveUntilLedgerSeq > 0 ? entry.liveUntilLedgerSeq : null;
}

function lastModifiedOf(entry: LedgerEntryObs | undefined): number | null {
  return typeof entry?.lastModifiedLedgerSeq === 'number' ? entry.lastModifiedLedgerSeq : null;
}

function facts(
  id: string,
  cls: EntryClass,
  keyB64: string,
  entry: LedgerEntryObs | undefined,
): EntryFacts {
  return {
    id,
    cls,
    keyB64,
    present: entry !== undefined && (entry.xdr !== undefined || (entry.liveUntilLedgerSeq ?? 0) > 0),
    liveUntilLedger: liveUntilOf(entry),
    lastModifiedLedger: lastModifiedOf(entry),
    sizeBytes: sizeOf(entry),
  };
}

async function chunked<T, R>(items: T[], size: number, fn: (chunk: T[]) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(await fn(items.slice(i, i + size)));
  return out;
}

export class Scanner {
  private readonly deps: ScanDeps;

  constructor(deps: ScanDeps) {
    this.deps = deps;
  }

  async scan(): Promise<ScanResult> {
    const { rpc, cfg, state, cadence } = this.deps;
    const nowIso = this.deps.nowIso ?? (() => new Date().toISOString());

    const { sequence: atLedger } = await rpc.getLatestLedger();

    // 1. counter (+ contract instance; needed anyway for the Wasm code key)
    const counterKb = keyToBase64(counterKey(cfg.contractId));
    const instanceKb = cfg.monitorContractEntries ? keyToBase64(instanceKey(cfg.contractId)) : null;
    const probeKeys = instanceKb ? [counterKb, instanceKb] : [counterKb];
    const probe = await rpc.getLedgerEntries(probeKeys);
    const byKey = new Map<string, LedgerEntryObs>(probe.entries.map((e) => [e.key, e]));

    const counterObs = byKey.get(counterKb);
    const counterFacts = facts('counter', 'counter', counterKb, counterObs);
    let nextId: number | null = null;
    if (counterObs?.xdr) {
      const decoded = decodeCounterValue(entryValueScVal(counterObs.xdr));
      if (decoded !== null && decoded <= BigInt(Number.MAX_SAFE_INTEGER)) nextId = Number(decoded);
    }

    // 2. enumerate streams (contiguous ids from 1)
    //
    // The counter is authoritative when readable. When it is *not* (it archives
    // after min_persistent_entry_ttl and is never extended), fall back to the
    // cached high-water mark and probe a bounded run past it, so ids created
    // while the sentinel was down are still discovered. Ids beyond the
    // confirmed range that turn up missing are treated as never-created — we
    // must not raise "expired" alerts for speculative ids.
    const usedCounterFallback = nextId === null;
    const confirmedMax = nextId !== null ? nextId - 1 : state.maxStreamId;
    const enumMax = nextId !== null ? confirmedMax : confirmedMax + cfg.counterFallbackProbeRun;
    const streamCount = Math.max(0, Math.min(enumMax, cfg.maxStreams));

    const streamKb: string[] = [];
    const idByKb = new Map<string, number>();
    for (let id = 1; id <= streamCount; id++) {
      const b64 = keyToBase64(streamKey(cfg.contractId, id));
      streamKb.push(b64);
      idByKb.set(b64, id);
    }
    const rawEntries = new Map<string, LedgerEntryObs>();
    const pages = await chunked(streamKb, RPC_MAX_LEDGER_KEYS, (chunk) => rpc.getLedgerEntries(chunk));
    for (const page of pages) for (const e of page.entries) rawEntries.set(e.key, e);

    const missingIds: number[] = [];
    const streamEntries: StreamFacts[] = [];
    const addresses = new Set<string>(state.addresses);
    for (const b64 of streamKb) {
      const id = idByKb.get(b64) as number;
      const entry = rawEntries.get(b64);
      let decoded: DecodedStream | null = null;
      if (entry?.xdr) {
        decoded = decodeStreamValue(entryValueScVal(entry.xdr));
        if (decoded?.sender) addresses.add(decoded.sender);
        if (decoded?.recipient) addresses.add(decoded.recipient);
      }
      const f = facts(`stream:${id}`, 'stream', b64, entry);
      if (!f.present) {
        if (id > confirmedMax) continue; // speculative probe: never created (or unreadable)
        missingIds.push(id);
      }
      streamEntries.push({ ...f, streamId: id, stream: decoded });
    }

    // 3. per-address index entries (extended on write *and* on read)
    const indexObs: EntryFacts[] = [];
    const indexProbes: { b64: string; id: string }[] = [];
    for (const address of addresses) {
      for (const kind of ['SenderStreams', 'RecipientStreams'] as const satisfies readonly IndexKind[]) {
        indexProbes.push({
          b64: keyToBase64(indexKey(cfg.contractId, kind, address)),
          id: `index:${kind === 'SenderStreams' ? 'sender' : 'recipient'}:${address}`,
        });
      }
    }
    if (indexProbes.length > 0) {
      const indexPages = await chunked(
        indexProbes.map((p) => p.b64),
        RPC_MAX_LEDGER_KEYS,
        (chunk) => rpc.getLedgerEntries(chunk),
      );
      const indexEntries = new Map<string, LedgerEntryObs>();
      for (const page of indexPages) for (const e of page.entries) indexEntries.set(e.key, e);
      for (const probe of indexProbes) {
        indexObs.push(facts(probe.id, 'index', probe.b64, indexEntries.get(probe.b64)));
      }
    }

    // 4. instance + Wasm code. The code key is remembered once discovered: the
    // code entry has its own (never-extended) TTL and must stay monitored even
    // if the instance entry archives first.
    let instanceFacts: EntryFacts | null = null;
    let codeFacts: EntryFacts | null = null;
    let codeKb = state.codeEntryKeyB64 ?? null;
    if (instanceKb) {
      const instanceObs = byKey.get(instanceKb);
      instanceFacts = facts('instance', 'instance', instanceKb, instanceObs);
      const wasmHash = instanceObs?.xdr ? wasmHashFromInstanceVal(entryValueScVal(instanceObs.xdr)) : null;
      if (wasmHash) codeKb = keyToBase64(codeKey(wasmHash));
    }
    if (codeKb) {
      const codeResp = await rpc.getLedgerEntries([codeKb]);
      codeFacts = facts(codeIdOf(codeKb), 'code', codeKb, codeResp.entries[0]);
      state.codeEntryKeyB64 = codeKb;
    }

    // 5. update the state cache (never shrink: archived ids stay covered)
    const highestPresent = streamEntries.reduce((max, s) => (s.present && s.streamId > max ? s.streamId : max), 0);
    state.maxStreamId = Math.max(state.maxStreamId, highestPresent, nextId !== null ? nextId - 1 : 0);
    state.addresses = [...addresses].sort();
    state.lastScanLedger = atLedger;
    state.lastScanIso = nowIso();

    const report: ScanReport = {
      atLedger,
      atIso: nowIso(),
      rpcLatestLedger: probe.latestLedger || atLedger,
      counter: { ...counterFacts, nextId },
      instance: instanceFacts,
      code: codeFacts,
      streams: { enumerated: streamCount, present: streamEntries.filter((s) => s.present).length, missingIds, entries: streamEntries },
      indexes: indexObs,
      sizes: representativeSizes(streamEntries, indexObs, counterFacts, instanceFacts, codeFacts),
      usedCounterFallback,
    };

    // 6. project every observation against its class schedule
    const observations: Observation[] = [
      { id: 'counter', cls: 'counter', liveUntilLedger: counterFacts.liveUntilLedger, lastModifiedLedger: counterFacts.lastModifiedLedger },
    ];
    if (instanceFacts) {
      observations.push({
        id: 'instance',
        cls: 'instance',
        liveUntilLedger: instanceFacts.liveUntilLedger,
        lastModifiedLedger: instanceFacts.lastModifiedLedger,
      });
    }
    if (codeFacts) {
      observations.push({
        id: codeFacts.id,
        cls: 'code',
        liveUntilLedger: codeFacts.liveUntilLedger,
        lastModifiedLedger: codeFacts.lastModifiedLedger,
      });
    }
    for (const s of streamEntries) {
      observations.push({ id: s.id, cls: 'stream', liveUntilLedger: s.liveUntilLedger, lastModifiedLedger: s.lastModifiedLedger });
    }
    for (const ix of indexObs) {
      observations.push({ id: ix.id, cls: 'index', liveUntilLedger: ix.liveUntilLedger, lastModifiedLedger: ix.lastModifiedLedger });
    }

    const projections = observations.map((obs) =>
      project(obs, cfg.schedules[obs.cls], { nowLedger: atLedger, nowIso: report.atIso, cadence }),
    );

    return { report, projections };
  }
}

/** Stable id for a code entry, derived from the Wasm hash in its key. */
function codeIdOf(keyB64: string): string {
  const key = xdr.LedgerKey.fromXDR(keyB64, 'base64');
  const hash = key.type === 'contractCode' ? hashToBytes(key.contractCode.hash) : null;
  return `code:${hash ? hash.toString('hex').slice(0, 12) : keyB64.slice(0, 12)}`;
}

function representativeSizes(
  streams: StreamFacts[],
  indexes: EntryFacts[],
  counter: EntryFacts,
  instance: EntryFacts | null,
  code: EntryFacts | null,
): Record<EntryClass, number> {
  const max = (list: (number | null)[]): number => list.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  return {
    stream: max(streams.map((s) => s.sizeBytes)),
    index: max(indexes.map((i) => i.sizeBytes)),
    counter: counter.sizeBytes ?? 0,
    instance: instance?.sizeBytes ?? 0,
    code: code?.sizeBytes ?? 0,
  };
}
