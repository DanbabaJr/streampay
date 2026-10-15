//! Ledger-key builders mirroring the contract's `DataKey` enum.
//!
//! Encoding ground truth (contracts/streaming-payments test snapshots):
//! - `DataKey::NextStreamId`             → ScVal Vec[Symbol "NextStreamId"]
//! - `DataKey::Stream(u64)`              → ScVal Vec[Symbol "Stream", Uint64 id]
//! - `DataKey::SenderStreams(Address)`   → ScVal Vec[Symbol "SenderStreams", Address]
//! - `DataKey::RecipientStreams(Address)`→ ScVal Vec[Symbol "RecipientStreams", Address]
//!
//! API notes: this SDK's XDR layer exposes union arms with a string `.type`
//! discriminant and struct payloads as named properties (`key.contractData.key`).

import { Address, Contract, xdr } from '@stellar/stellar-sdk';

import type { EntryClass } from './cliff.js';

export type IndexKind = 'SenderStreams' | 'RecipientStreams';

function contractDataKey(contractId: string, key: xdr.ScVal): xdr.LedgerKeyContractDataArm {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

/** `DataKey::NextStreamId` */
export function counterKey(contractId: string): xdr.LedgerKey {
  return contractDataKey(contractId, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('NextStreamId')]));
}

/** `DataKey::Stream(id)` */
export function streamKey(contractId: string, id: bigint | number): xdr.LedgerKey {
  return contractDataKey(
    contractId,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stream'), xdr.ScVal.scvU64(BigInt(id))]),
  );
}

/** `DataKey::SenderStreams(addr)` / `DataKey::RecipientStreams(addr)` */
export function indexKey(contractId: string, kind: IndexKind, address: string): xdr.LedgerKey {
  return contractDataKey(
    contractId,
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(kind),
      xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
    ]),
  );
}

/** The contract's instance entry (its instance + code TTLs are never extended on-chain). */
export function instanceKey(contractId: string): xdr.LedgerKey {
  return new Contract(contractId).getFootprint();
}

/** The Wasm code entry a deployed instance points at. */
export function codeKey(wasmHash: Uint8Array): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
}

export function keyToBase64(key: xdr.LedgerKey): string {
  return key.toXDR('base64');
}

function symbolOf(scv: xdr.ScVal | undefined): string | null {
  if (!scv || scv.type !== 'scvSymbol') return null;
  return String(scv.sym);
}

function u64Of(scv: xdr.ScVal | undefined): bigint | null {
  if (!scv || scv.type !== 'scvU64') return null;
  return scv.u64;
}

function addressOf(scv: xdr.ScVal | undefined): string | null {
  if (!scv || scv.type !== 'scvAddress') return null;
  return Address.fromScAddress(scv.address).toString();
}

/** Human-stable id for alerts/state: `stream:12`, `counter`, `index:sender:G…`. */
export function idOfKey(key: xdr.LedgerKey): string {
  if (key.type === 'contractCode') return `code:${hashSuffix(key.contractCode.hash)}`;
  if (key.type !== 'contractData') return `entry:${key.toXDR('base64').slice(0, 12)}`;
  if (key.contractData.key.type === 'scvLedgerKeyContractInstance') return 'instance';

  const scv = key.contractData.key;
  const vec = scv.type === 'scvVec' ? (scv.vec ?? []) : [];
  const head = symbolOf(vec[0]);
  if (head === 'NextStreamId') return 'counter';
  if (head === 'Stream') return `stream:${u64Of(vec[1]) ?? '?'}`;
  if (head === 'SenderStreams' || head === 'RecipientStreams') {
    const addr = addressOf(vec[1]) ?? '?';
    return `index:${head === 'SenderStreams' ? 'sender' : 'recipient'}:${addr}`;
  }
  return `contractData:${head ?? key.toXDR('base64').slice(0, 12)}`;
}

/** Class of a built key, so the right schedule applies. */
export function classOfKey(key: xdr.LedgerKey): EntryClass {
  if (key.type === 'contractCode') return 'code';
  if (key.type === 'contractData') {
    const scv = key.contractData.key;
    // The contract-instance key is contract data whose key is the special
    // `SCV_LEDGER_KEY_CONTRACT_INSTANCE` value.
    if (scv.type === 'scvLedgerKeyContractInstance') return 'instance';
    const head = scv.type === 'scvVec' ? symbolOf(scv.vec?.[0]) : null;
    if (head === 'NextStreamId') return 'counter';
    if (head === 'Stream') return 'stream';
    if (head === 'SenderStreams' || head === 'RecipientStreams') return 'index';
  }
  throw new Error(`unrecognised ledger key: ${key.toXDR('base64').slice(0, 24)}`);
}

function hashSuffix(hash: unknown): string {
  const bytes = hashToBytes(hash);
  return bytes ? bytes.toString('hex').slice(0, 12) : '?';
}

/** XDR `Hash` payloads vary by SDK version (Uint8Array, Buffer, wrapper). */
export function hashToBytes(hash: unknown): Buffer | null {
  if (hash instanceof Uint8Array) return Buffer.from(hash);
  if (hash instanceof ArrayBuffer) return Buffer.from(hash);
  if (typeof hash === 'object' && hash !== null) {
    const candidate = hash as { bytes?: unknown; toXDR?: () => Buffer };
    if (candidate.bytes instanceof Uint8Array) return Buffer.from(candidate.bytes);
    if (typeof candidate.toXDR === 'function') return Buffer.from(candidate.toXDR());
  }
  return null;
}
