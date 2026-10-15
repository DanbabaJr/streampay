//! Ledger-entry fixtures built with the SDK's XDR encoders.
//!
//! Encoding shapes are taken from the contract's own test snapshots
//! (`contracts/streaming-payments/test_snapshots/`), so these fixtures are the
//! ground truth the sentinel's decoders are checked against:
//! - `DataKey::Stream(u64)` → `ScVec[Symbol "Stream", U64 id]`
//! - `Stream` value → `ScMap` of symbol keys, `status` → `ScVec[Symbol]`
//! - instance value → `ScVal` contract-instance with Wasm executable

import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
export const ADDR_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';
export const ADDR_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4';

const EXT_V0 = xdr.ExtensionPoint.v0();

export function entryXdrOf(keyScv: xdr.ScVal, val: xdr.ScVal, contractId = CONTRACT_ID): string {
  const entry = new xdr.ContractDataEntry({
    ext: EXT_V0,
    contract: Address.fromString(contractId).toScAddress(),
    key: keyScv,
    durability: xdr.ContractDataDurability.persistent,
    val,
  });
  return xdr.LedgerEntryData.contractData(entry).toXDR('base64');
}

export function counterKeyScv(): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('NextStreamId')]);
}

export function streamKeyScv(id: number | bigint): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stream'), xdr.ScVal.scvU64(BigInt(id))]);
}

export function indexKeyScv(kind: 'SenderStreams' | 'RecipientStreams', address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind), xdr.ScVal.scvAddress(Address.fromString(address).toScAddress())]);
}

export interface StreamFixtureOpts {
  id?: number;
  sender?: string;
  recipient?: string;
  token?: string;
  deposit?: bigint;
  withdrawn?: bigint;
  start_time?: bigint;
  end_time?: bigint;
  cancelable?: boolean;
  status?: 'Active' | 'Cancelled' | 'Depleted';
}

/**
 * The 10-field struct exactly as the contract stores it — field *types*
 * matter: `nativeToScVal` on a bare bigint picks the narrowest integer type,
 * while the contract always writes `i128` for deposit/withdrawn, so those are
 * forced explicitly here.
 */
export function streamValueScv(opts: StreamFixtureOpts = {}): xdr.ScVal {
  const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: 'i128' });
  const u64 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: 'u64' });
  const address = (a: string): xdr.ScVal => nativeToScVal(Address.fromString(a), { type: 'address' });
  const entry = (name: string, val: xdr.ScVal): xdr.ScMapEntry =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });

  return xdr.ScVal.scvMap([
    entry('cancelable', xdr.ScVal.scvBool(opts.cancelable ?? true)),
    entry('deposit', i128(opts.deposit ?? 10_000_000_000n)),
    entry('end_time', u64(opts.end_time ?? 2_678_400n)),
    entry('id', u64(BigInt(opts.id ?? 1))),
    entry('recipient', address(opts.recipient ?? ADDR_B)),
    entry('sender', address(opts.sender ?? ADDR_A)),
    entry('start_time', u64(opts.start_time ?? 86_400n)),
    entry('status', xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(opts.status ?? 'Active')])), // enum → ScVec[Symbol]
    entry('token', address(opts.token ?? CONTRACT_ID)),
    entry('withdrawn', i128(opts.withdrawn ?? 0n)),
  ]);
}

export function streamEntryXdr(opts: StreamFixtureOpts = {}): string {
  return entryXdrOf(streamKeyScv(opts.id ?? 1), streamValueScv(opts));
}

export function counterEntryXdr(nextId: number | bigint): string {
  return entryXdrOf(counterKeyScv(), xdr.ScVal.scvU64(BigInt(nextId)));
}

export function indexEntryXdr(kind: 'SenderStreams' | 'RecipientStreams', address: string, ids: number[]): string {
  return entryXdrOf(
    indexKeyScv(kind, address),
    xdr.ScVal.scvVec(ids.map((id) => xdr.ScVal.scvU64(BigInt(id)))),
  );
}

export function instanceEntryXdr(wasmHash: Buffer): string {
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
    storage: null,
  });
  const instanceKey = xdr.ScVal.scvLedgerKeyContractInstance();
  return entryXdrOf(instanceKey, xdr.ScVal.scvContractInstance(instance));
}

export function byteLength(xdrBase64: string): number {
  return Buffer.byteLength(xdrBase64, 'base64');
}
