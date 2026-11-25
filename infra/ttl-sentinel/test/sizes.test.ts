//! Ground truth: the fixtures below mirror the contract's own snapshots, and
//! the sizes measured here are the ones the rent table uses. If the contract's
//! `Stream` struct changes, these tests fail and the cost table must be
//! refreshed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Address, Contract, scValToNative, xdr } from '@stellar/stellar-sdk';

import { classOfKey, counterKey, idOfKey, indexKey, instanceKey, streamKey } from '../src/keys.js';
import {
  decodeCounterValue,
  decodeIndexValue,
  decodeStreamValue,
  entryValueScVal,
  wasmHashFromInstanceVal,
} from '../src/decode.js';
import { MEASURED_ENTRY_BYTES, estimateIndexBytes } from '../src/sizes.js';
import {
  ADDR_A,
  ADDR_B,
  CONTRACT_ID,
  byteLength,
  counterEntryXdr,
  indexEntryXdr,
  instanceEntryXdr,
  streamEntryXdr,
} from './fixtures.js';

test('DataKey encodings match the contract snapshots', () => {
  const scv = (key: xdr.LedgerKey): unknown => {
    assert.equal(key.type, 'contractData');
    if (key.type !== 'contractData') throw new Error('unreachable');
    return scValToNative(key.contractData.key);
  };

  assert.deepEqual(scv(counterKey(CONTRACT_ID)), ['NextStreamId']);
  assert.deepEqual(scv(streamKey(CONTRACT_ID, 7)), ['Stream', 7n]);
  assert.deepEqual(scv(indexKey(CONTRACT_ID, 'SenderStreams', ADDR_A)), ['SenderStreams', ADDR_A]);
  assert.deepEqual(scv(indexKey(CONTRACT_ID, 'RecipientStreams', ADDR_B)), ['RecipientStreams', ADDR_B]);

  // The instance key is contract data with the special ledger-key value.
  const instance = instanceKey(CONTRACT_ID);
  assert.equal(instance.type, 'contractData');
  if (instance.type !== 'contractData') throw new Error('unreachable');
  assert.equal(instance.contractData.key.type, 'scvLedgerKeyContractInstance');
  assert.equal(new Contract(CONTRACT_ID).getFootprint().toXDR('base64'), instance.toXDR('base64'));
});

test('ids and classes derive from the keys', () => {
  assert.equal(idOfKey(counterKey(CONTRACT_ID)), 'counter');
  assert.equal(idOfKey(streamKey(CONTRACT_ID, 42)), 'stream:42');
  assert.equal(idOfKey(indexKey(CONTRACT_ID, 'SenderStreams', ADDR_A)), `index:sender:${ADDR_A}`);
  assert.equal(idOfKey(indexKey(CONTRACT_ID, 'RecipientStreams', ADDR_B)), `index:recipient:${ADDR_B}`);
  assert.equal(idOfKey(instanceKey(CONTRACT_ID)), 'instance');

  assert.equal(classOfKey(counterKey(CONTRACT_ID)), 'counter');
  assert.equal(classOfKey(streamKey(CONTRACT_ID, 1)), 'stream');
  assert.equal(classOfKey(indexKey(CONTRACT_ID, 'RecipientStreams', ADDR_A)), 'index');
  assert.equal(classOfKey(instanceKey(CONTRACT_ID)), 'instance');
});

test('decoders read the contract’s stored shapes', () => {
  const stream = decodeStreamValue(entryValueScVal(streamEntryXdr({ id: 3, deposit: 5n, withdrawn: 2n, status: 'Cancelled' })));
  assert.ok(stream);
  assert.equal(stream.id, 3n);
  assert.equal(stream.deposit, 5n);
  assert.equal(stream.withdrawn, 2n);
  assert.equal(stream.status, 'Cancelled');
  assert.equal(stream.start_time, 86_400n);
  assert.equal(stream.end_time, 2_678_400n);
  assert.equal(stream.cancelable, true);
  assert.equal(stream.sender, ADDR_A);
  assert.equal(stream.recipient, ADDR_B);

  assert.equal(decodeCounterValue(entryValueScVal(counterEntryXdr(9))), 9n);

  const ids = decodeIndexValue(entryValueScVal(indexEntryXdr('SenderStreams', ADDR_A, [1, 2, 3])));
  assert.deepEqual(ids, [1n, 2n, 3n]);

  // Non-stream values must not be mistaken for streams.
  assert.equal(decodeStreamValue(entryValueScVal(counterEntryXdr(1))), null);
});

test('the instance value exposes the Wasm hash', () => {
  const hash = Buffer.alloc(32, 0xab);
  const val = entryValueScVal(instanceEntryXdr(hash));
  assert.equal(val.type, 'scvContractInstance');
  assert.equal(wasmHashFromInstanceVal(val)?.toString('hex'), hash.toString('hex'));
});

test('measured entry sizes match the cost-table constants', () => {
  assert.equal(byteLength(streamEntryXdr({ id: 1 })), MEASURED_ENTRY_BYTES.stream);
  assert.equal(MEASURED_ENTRY_BYTES.stream, 504);
  assert.equal(byteLength(counterEntryXdr(2)), MEASURED_ENTRY_BYTES.counter);
  assert.equal(byteLength(instanceEntryXdr(Buffer.alloc(32, 7))), MEASURED_ENTRY_BYTES.instance);
});

test('index entries grow by exactly 12 bytes per indexed id', () => {
  const one = byteLength(indexEntryXdr('RecipientStreams', ADDR_B, [1]));
  const ten = byteLength(indexEntryXdr('RecipientStreams', ADDR_B, Array.from({ length: 10 }, (_, i) => i + 1)));
  const fifty = byteLength(indexEntryXdr('RecipientStreams', ADDR_B, Array.from({ length: 50 }, (_, i) => i + 1)));

  assert.equal(one, estimateIndexBytes(1));
  assert.equal(one, MEASURED_ENTRY_BYTES.index);
  assert.equal(ten, estimateIndexBytes(10));
  assert.equal(fifty, estimateIndexBytes(50));
  assert.equal(ten - one, 12 * 9);
  assert.equal(fifty - ten, 12 * 40);
});

test('the status symbol length pads the entry (Active vs Cancelled)', () => {
  const active = byteLength(streamEntryXdr({ status: 'Active' }));
  const cancelled = byteLength(streamEntryXdr({ status: 'Cancelled' }));
  const depleted = byteLength(streamEntryXdr({ status: 'Depleted' }));
  assert.equal(active, MEASURED_ENTRY_BYTES.stream);
  assert.equal(active, depleted, 'Depleted (8 chars) pads like Active (6 chars)');
  assert.equal(cancelled, active + 4, 'Cancelled (9 chars) crosses a 4-byte XDR boundary');
});

test('entry size is fixed width regardless of the amounts stored', () => {
  const small = byteLength(streamEntryXdr({ deposit: 1n, withdrawn: 0n }));
  const huge = byteLength(streamEntryXdr({ deposit: (1n << 100n) - 1n, withdrawn: 999_999_999n }));
  assert.equal(small, huge, 'deposit/withdrawn are always i128 in XDR');
  assert.equal(small, MEASURED_ENTRY_BYTES.stream);
});

test('sender/recipient addresses are recoverable from the entry', () => {
  const value = entryValueScVal(streamEntryXdr({ id: 1 }));
  const native = scValToNative(value) as Record<string, unknown>;
  assert.equal(native['sender'], ADDR_A);
  assert.equal(native['recipient'], ADDR_B);
  assert.equal(Address.fromString(ADDR_A).toString(), ADDR_A);
});
