import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CadenceMeter } from '../src/cadence.js';
import { defaultConfig } from '../src/config.js';
import { CONTRACT_ID } from './fixtures.js';
import { RPC_MAX_LEDGER_KEYS } from '../src/constants.js';
import { Scanner } from '../src/scanner.js';
import { emptyState } from '../src/state.js';
import { FakeChain } from './fake-chain.js';
import { counterEntryXdr } from './fixtures.js';

function scannerFor(chain: FakeChain, opts: { monitorContractEntries?: boolean; maxStreams?: number } = {}): Scanner {
  const cfg = defaultConfig({
    contractId: CONTRACT_ID,
    monitorContractEntries: opts.monitorContractEntries ?? true,
    maxStreams: opts.maxStreams ?? 100_000,
  });
  return new Scanner({ rpc: chain, cfg, state: emptyState(), cadence: new CadenceMeter({}) });
}

test('enumerates streams by counter and reads TTLs, sizes and status', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  chain.createStream({ id: 1, status: 'Active' }, 1_000_000);
  chain.createStream({ id: 2, status: 'Cancelled' }, 1_000_000);

  const { report, projections } = await scannerFor(chain).scan();

  assert.equal(report.counter.present, true);
  assert.equal(report.counter.nextId, 3);
  assert.equal(report.streams.enumerated, 2);
  assert.equal(report.streams.present, 2);
  assert.deepEqual(report.streams.missingIds, []);
  assert.equal(report.streams.entries[0]?.stream?.status, 'Active');
  assert.equal(report.streams.entries[1]?.stream?.status, 'Cancelled');
  // Representative size is the max observed: `Cancelled` (9-char symbol) pads
  // 4 bytes longer than `Active`.
  assert.equal(report.sizes.stream, 508);
  assert.equal(report.sizes.index, 148);
  assert.equal(report.sizes.counter, 92);
  assert.equal(report.sizes.instance, 96);
  assert.equal(report.sizes.code, 120_000);

  assert.equal(projections.find((p) => p.id === 'stream:1')?.severity, 'ok');
  assert.equal(projections.find((p) => p.id === 'counter')?.remainingLedgers, 4095);
  assert.equal(projections.find((p) => p.id === 'instance')?.cls, 'instance');
});

test('archived stream entries are reported missing rather than silently skipped', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const cfg = defaultConfig({ contractId: CONTRACT_ID });
  const state = emptyState();
  chain.createStream({ id: 1 }, 1_000_000);
  chain.advanceLedgers(300_000, 5);
  chain.createStream({ id: 2 }, chain.ledger);
  await new Scanner({ rpc: chain, cfg, state, cadence: new CadenceMeter({}) }).scan(); // cache both ids

  // Jump past stream 1's TTL (and the 4095-ledger counter): stream 2 lives on.
  chain.advanceLedgers(300_000, 5);
  const { report, projections } = await new Scanner({ rpc: chain, cfg, state, cadence: new CadenceMeter({}) }).scan();

  assert.equal(report.usedCounterFallback, true, 'the counter archives long before the streams do');
  // Cached high-water mark (2) plus the bounded probe run (200).
  assert.equal(report.streams.enumerated, 2 + 200);
  assert.equal(report.streams.present, 1);
  assert.deepEqual(report.streams.missingIds, [1]);
  assert.equal(projections.find((p) => p.id === 'stream:1')?.severity, 'expired');
  assert.equal(projections.find((p) => p.id === 'stream:2')?.severity, 'ok');
});

test('keys are chunked to the 200-key RPC limit', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  for (let id = 1; id <= 250; id++) chain.createStream({ id }, 1_000_000);
  await scannerFor(chain).scan();
  assert.ok(chain.batchSizes.length > 0);
  for (const size of chain.batchSizes) {
    assert.ok(size <= RPC_MAX_LEDGER_KEYS, `batch of ${size} keys exceeds the RPC limit`);
  }
  // 250 streams must have been requested in at least two pages.
  assert.ok(chain.batchSizes.filter((s) => s === RPC_MAX_LEDGER_KEYS).length >= 1);
});

test('a missing counter falls back to the cached high-water mark and flags itself', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  chain.createStream({ id: 1 }, 1_000_000);
  chain.createStream({ id: 2 }, 1_000_000);

  const cfg = defaultConfig({ contractId: CONTRACT_ID });
  const state = emptyState();
  const first = await new Scanner({ rpc: chain, cfg, state, cadence: new CadenceMeter({}) }).scan();
  assert.equal(first.report.usedCounterFallback, false);
  assert.equal(state.maxStreamId, 2);

  // The counter archives (never extended) while the streams live on.
  chain.entries.set(chain.counterKeyB64, {
    xdr: counterEntryXdr(3),
    liveUntil: chain.ledger + 1,
    lastModified: chain.ledger,
  });
  chain.advanceLedgers(2, 5);
  assert.ok(chain.entryFor('counter')!.liveUntil <= chain.ledger, 'counter is archived');

  const second = await new Scanner({ rpc: chain, cfg, state, cadence: new CadenceMeter({}) }).scan();
  assert.equal(second.report.usedCounterFallback, true);
  assert.equal(second.report.counter.present, false);
  assert.equal(second.report.counter.nextId, null);
  assert.equal(second.report.streams.enumerated, 2 + 200, 'cached ids plus a bounded discovery probe');
  assert.equal(second.report.streams.present, 2);
  assert.deepEqual(second.report.streams.missingIds, [], 'speculative ids beyond the cached range are not "missing"');
  assert.equal(second.projections.find((p) => p.id === 'counter')?.severity, 'expired');
});

test('index keys are probed for every address seen (and remembered)', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  chain.createStream({ id: 1 }, 1_000_000);
  const cfg = defaultConfig({ contractId: CONTRACT_ID });
  const state = emptyState();
  const { report } = await new Scanner({ rpc: chain, cfg, state, cadence: new CadenceMeter({}) }).scan();

  // Two addresses × (sender list + recipient list) = 4 index keys.
  assert.equal(report.indexes.length, 4, 'sender + recipient index per address');
  assert.ok(report.indexes.every((i) => i.cls === 'index'));
  assert.equal(report.indexes.filter((i) => i.present).length, 2, 'only one list per address was written');
  assert.equal(state.addresses.length, 2);
  // A second scan reuses the cached addresses even if a stream entry vanishes.
  chain.entries.delete(chain.counterKeyB64);
  const again = await new Scanner({ rpc: chain, cfg, state, cadence: new CadenceMeter({}) }).scan();
  assert.equal(again.report.indexes.length, 4);
});

test('contract instance/code monitoring can be disabled', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  chain.createStream({ id: 1 }, 1_000_000);
  const { report, projections } = await scannerFor(chain, { monitorContractEntries: false }).scan();
  assert.equal(report.instance, null);
  assert.equal(report.code, null);
  assert.equal(projections.some((p) => p.cls === 'instance'), false);
});

test('maxStreams clamps enumeration (safety valve)', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  for (let id = 1; id <= 5; id++) chain.createStream({ id }, 1_000_000);
  const { report } = await scannerFor(chain, { maxStreams: 2 }).scan();
  assert.equal(report.streams.enumerated, 2);
  assert.equal(report.counter.nextId, 6);
});
