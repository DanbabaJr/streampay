//! Decoding of ledger-entry values read via `getLedgerEntries`.
//!
//! Ground truth from the contract's test snapshots:
//! - `Stream` value → ScMap with symbol keys (cancelable, deposit, end_time,
//!   id, recipient, sender, start_time, status, token, withdrawn);
//!   `status` is `ScVec[Symbol]` (`Active` / `Cancelled` / `Depleted`).
//! - `NextStreamId` value → ScVal u64.
//! - index values → ScVec of u64 ids.
//! - instance value → ScVal contract-instance (executable Wasm hash).
//!
//! `scValToNative` turns maps into plain objects, u64/i128 into `bigint`,
//! vecs into arrays, symbols/addresses into strings — handled defensively.

import { scValToNative, xdr } from '@stellar/stellar-sdk';

import { hashToBytes } from './keys.js';

export interface DecodedStream {
  id: bigint | null;
  sender: string | null;
  recipient: string | null;
  token: string | null;
  deposit: bigint | null;
  withdrawn: bigint | null;
  start_time: bigint | null;
  end_time: bigint | null;
  cancelable: boolean | null;
  status: string | null;
}

/** Parse base64 LedgerEntryData XDR and return the contract-data `val` ScVal. */
export function entryValueScVal(entryXdrBase64: string): xdr.ScVal {
  const data = xdr.LedgerEntryData.fromXDR(entryXdrBase64, 'base64');
  if (data.type !== 'contractData') {
    throw new Error(`expected contractData entry, got ${data.type}`);
  }
  return data.contractData.val;
}

/** Extract the Wasm hash from a contract-instance entry value (null if not Wasm). */
export function wasmHashFromInstanceVal(val: xdr.ScVal): Buffer | null {
  if (val.type !== 'scvContractInstance') return null;
  const executable = val.instance.executable;
  if (executable.type !== 'contractExecutableWasm') return null;
  return hashToBytes(executable.wasmHash);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  if (v instanceof Map) return Object.fromEntries(v);
  return null;
}

function asBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  const rec = asRecord(v);
  // i128/u128 decode to 128-bit parts in some SDK versions.
  if (rec && 'hi' in rec && 'lo' in rec) {
    const hi = asBigInt(rec['hi']);
    const lo = asBigInt(rec['lo']);
    if (hi !== null && lo !== null) return (hi << 64n) | (lo & ((1n << 64n) - 1n));
  }
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** `StreamStatus` decodes to `["Active"]`-shaped arrays; tolerate raw symbols too. */
function asStatus(v: unknown): string | null {
  if (Array.isArray(v) && v.length > 0) return asString(v[0]);
  if (typeof v === 'string') return v;
  const rec = asRecord(v);
  if (rec && typeof rec['status'] === 'string') return rec['status'];
  return null;
}

function toNative(input: xdr.ScVal | unknown): unknown {
  // `instanceof xdr.ScVal` narrows to the abstract base in this SDK version,
  // so assert back to the union the converter expects.
  return input instanceof xdr.ScVal ? scValToNative(input as xdr.ScVal) : input;
}

/** Decode a `Stream` value into a record of known fields (null if not a stream). */
export function decodeStreamValue(input: xdr.ScVal | unknown): DecodedStream | null {
  let native: unknown;
  try {
    native = toNative(input);
  } catch {
    return null;
  }
  const r = asRecord(native);
  if (!r || !('end_time' in r) || !('start_time' in r)) return null;
  return {
    id: asBigInt(r['id']),
    sender: asString(r['sender']),
    recipient: asString(r['recipient']),
    token: asString(r['token']),
    deposit: asBigInt(r['deposit']),
    withdrawn: asBigInt(r['withdrawn']),
    start_time: asBigInt(r['start_time']),
    end_time: asBigInt(r['end_time']),
    cancelable: asBool(r['cancelable']),
    status: asStatus(r['status']),
  };
}

/** Decode `DataKey::NextStreamId` (ScVal u64) into the next id. */
export function decodeCounterValue(input: xdr.ScVal | unknown): bigint | null {
  try {
    return asBigInt(toNative(input));
  } catch {
    return null;
  }
}

/** Decode an index value (`Vec<u64>`) into stream ids. */
export function decodeIndexValue(input: xdr.ScVal | unknown): bigint[] | null {
  let native: unknown;
  try {
    native = toNative(input);
  } catch {
    return null;
  }
  if (!Array.isArray(native)) return null;
  const ids: bigint[] = [];
  for (const item of native) {
    const id = asBigInt(item);
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}
