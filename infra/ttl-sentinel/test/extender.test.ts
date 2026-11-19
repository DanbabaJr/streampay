import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Account, Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

import { defaultConfig, type ExtenderSection } from '../src/config.js';
import { CONTRACT_TTL_EXTEND_LEDGERS, CONTRACT_TTL_THRESHOLD_LEDGERS } from '../src/constants.js';
import {
  Extender,
  ExtenderDisabledError,
  buildExtendTransaction,
  buildExtensionPlan,
  formatPlanBudget,
  minResourceFeeStroops,
  monthKey,
  newSpenderState,
  readOnlyFootprint,
  xlmToStroops,
  type ExtendSubmitter,
  type ExtendTarget,
  type SubmitResult,
} from '../src/extender.js';
import { counterKey, keyToBase64, streamKey } from '../src/keys.js';
import { CONTRACT_ID } from './fixtures.js';

const target = (id: string, remainingLedgers: number, sizeBytes = 488): ExtendTarget => ({
  id,
  cls: id.startsWith('stream') ? 'stream' : 'counter',
  keyB64: keyToBase64(id.startsWith('stream') ? streamKey(CONTRACT_ID, Number(id.split(':')[1])) : counterKey(CONTRACT_ID)),
  remainingLedgers,
  sizeBytes,
});

const enabledCfg = (overrides: Partial<ExtenderSection> = {}): ExtenderSection => ({
  ...defaultConfig().extender,
  enabled: true,
  dryRun: false,
  monthlyBudgetXlm: '100',
  ...overrides,
});

test('the extender is off unless explicitly enabled — the core stays read-only', async () => {
  const extender = new Extender(defaultConfig().extender, { submit: () => Promise.reject(new Error('nope')) }, newSpenderState());
  await assert.rejects(
    () => extender.run({ extendTo: 500_000, thresholdLedgers: 200_000, batches: [], healthy: 0, estimatedTotalStroops: 0n }),
    (err: unknown) => err instanceof ExtenderDisabledError,
  );
  // The default config never carries a key requirement into scan paths.
  assert.equal(defaultConfig().extender.enabled, false);
  assert.equal(defaultConfig().extender.dryRun, true);
});

test('the plan takes only entries inside the threshold, most urgent first, chunked', () => {
  const plan = buildExtensionPlan(
    [
      target('stream:1', 199_000),
      target('stream:2', 20_000),
      target('stream:3', 400_000), // healthy
      target('counter', 1_000),
      target('stream:4', 500_000), // at extendTo: nothing to gain
    ],
    enabledCfg({ thresholdLedgers: CONTRACT_TTL_THRESHOLD_LEDGERS, extendTo: CONTRACT_TTL_EXTEND_LEDGERS, maxEntriesPerTx: 2 }),
  );

  assert.equal(plan.healthy, 2);
  assert.equal(plan.batches.length, 2);
  assert.deepEqual(
    plan.batches.flatMap((b) => b.targets.map((t) => t.id)),
    ['counter', 'stream:2', 'stream:1'],
  );
  assert.deepEqual(plan.batches.map((b) => b.targets.length), [2, 1]);
  assert.ok(plan.estimatedTotalStroops > 0n);
  assert.match(formatPlanBudget(plan), /XLM across 2 tx/);
});

test('plan estimates rent for exactly the ledgers each entry gains', () => {
  const cfg = enabledCfg({ thresholdLedgers: 200_000, extendTo: 500_000, maxEntriesPerTx: 10 });
  const plan = buildExtensionPlan([target('stream:1', 100_000, 488)], cfg, 1000n);
  const batch = plan.batches[0]!;
  // 400,000 ledgers added on a 488-byte entry at 1000 stroops/1KB, plus the
  // 48-byte TTL-entry write (ceil(48 × 3500 / 1024) = 165 stroops).
  const expected = BigInt(Math.ceil((488 * 1000 * 400_000) / (1024 * 1215))) + 165n;
  assert.equal(batch.estimatedRentStroops, expected);
});

test('dry-run reports the plan and submits nothing', async () => {
  const calls: string[][] = [];
  const submitter: ExtendSubmitter = {
    submit: (keys) => {
      calls.push(keys);
      return Promise.resolve({ status: 'PENDING', hash: 'x', feeStroops: 1n });
    },
  };
  const plan = buildExtensionPlan([target('stream:1', 100_000)], enabledCfg(), 1000n);
  const extender = new Extender(enabledCfg({ dryRun: true }), submitter, newSpenderState());
  const res = await extender.run(plan);

  assert.equal(res.dryRun, true);
  assert.equal(res.submitted.length, 0);
  assert.equal(res.planned.length, 1);
  assert.equal(calls.length, 0, 'nothing must reach the network in dry-run');
});

test('execute submits one transaction per batch and meters real fees', async () => {
  const seen: { keys: string[]; extendTo: number }[] = [];
  const submitter: ExtendSubmitter = {
    submit: (keys, extendTo) => {
      seen.push({ keys, extendTo });
      return Promise.resolve({ status: 'PENDING', hash: `hash-${seen.length}`, feeStroops: 4_000n });
    },
  };
  const plan = buildExtensionPlan(
    [target('stream:1', 100_000), target('stream:2', 150_000), target('counter', 1_000)],
    enabledCfg({ maxEntriesPerTx: 2 }),
    1000n,
  );
  const spender = newSpenderState();
  const res = await new Extender(enabledCfg(), submitter, spender).run(plan);

  assert.equal(res.submitted.length, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0]?.keys.length, 2);
  assert.equal(seen[0]?.extendTo, CONTRACT_TTL_EXTEND_LEDGERS);
  assert.equal(res.spentStroops, 8_000n, 'actual fees, not estimates');
  assert.equal(spender.spentStroops, 8_000n);
});

test('the monthly budget stops the run before overspending', async () => {
  const plan = buildExtensionPlan(
    [target('stream:1', 100_000), target('stream:2', 100_000), target('stream:3', 100_000)],
    enabledCfg({ maxEntriesPerTx: 1, monthlyBudgetXlm: '0.01' }),
    1000n,
  );
  assert.equal(plan.batches.length, 3);
  // 0.01 XLM = 100,000 stroops < one batch's ~157k stroops of rent.
  assert.ok(plan.estimatedTotalStroops > xlmToStroops('0.01'));
  assert.ok((plan.batches[0] as { estimatedRentStroops: bigint }).estimatedRentStroops > xlmToStroops('0.01'));

  const submitter: ExtendSubmitter = {
    submit: () => Promise.resolve({ status: 'PENDING', hash: 'h', feeStroops: 157_059n }),
  };
  const res = await new Extender(enabledCfg({ maxEntriesPerTx: 1, monthlyBudgetXlm: '0.01' }), submitter, newSpenderState()).run(plan);

  assert.equal(res.stoppedBy, 'budget');
  assert.equal(res.submitted.length, 0, 'first batch already exceeds the cap');
  assert.equal(res.planned.length, 3);
});

test('a failing submission stops the run instead of hammering the network', async () => {
  const plan = buildExtensionPlan([target('stream:1', 100_000), target('stream:2', 100_000)], enabledCfg({ maxEntriesPerTx: 1 }), 1000n);
  let calls = 0;
  const submitter: ExtendSubmitter = {
    submit: () => {
      calls++;
      return Promise.resolve({ status: 'ERROR', hash: null, feeStroops: null } satisfies SubmitResult);
    },
  };
  const res = await new Extender(enabledCfg({ maxEntriesPerTx: 1 }), submitter, newSpenderState()).run(plan);
  assert.equal(res.stoppedBy, 'submission-failed');
  assert.equal(calls, 1);
});

test('the spend meter resets when the UTC month changes', async () => {
  const spender = newSpenderState(new Date('2026-10-31T23:00:00Z'));
  spender.spentStroops = 5_000_000n;
  const plan = buildExtensionPlan([target('stream:1', 100_000)], enabledCfg(), 1000n);
  const extender = new Extender(enabledCfg(), { submit: () => Promise.resolve({ status: 'PENDING', hash: 'h', feeStroops: 1n }) }, spender, {
    now: () => new Date('2026-11-01T00:00:10Z'),
  });
  const res = await extender.run(plan);
  assert.equal(spender.month, '2026-11');
  assert.equal(res.spentStroops, 1n, 'previous month’s spend does not count');
  assert.equal(monthKey(new Date('2026-11-01T00:00:10Z')), '2026-11');
});

test('buildExtendTransaction attaches an ExtendFootprintTTL op over the read-only footprint', () => {
  const source = new Account(Keypair.random().publicKey(), '42');
  const keys = [keyToBase64(streamKey(CONTRACT_ID, 1)), keyToBase64(counterKey(CONTRACT_ID))];
  const tx = buildExtendTransaction(source, keys, CONTRACT_TTL_EXTEND_LEDGERS, 'Test SDF Network ; September 2015');

  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0]?.type, 'extendFootprintTtl');
  const op = tx.operations[0] as unknown as { extendTo: number };
  assert.equal(op.extendTo, CONTRACT_TTL_EXTEND_LEDGERS);

  const readOnly = readOnlyFootprint(tx);
  assert.equal(readOnly.length, 2, 'both keys must be in the read-only footprint');
  assert.equal(readOnly[0]?.toXDR('base64'), keys[0]);
  assert.equal(readOnly[1]?.toXDR('base64'), keys[1]);
  assert.equal(minResourceFeeStroops(tx), 0n, 'unsigned template carries no simulated fee yet');
});

test('xlmToStroops parses XLM amounts', () => {
  assert.equal(xlmToStroops('1'), 10_000_000n);
  assert.equal(xlmToStroops('0.5'), 5_000_000n);
  assert.equal(xlmToStroops('0.0000001'), 1n);
  assert.equal(xlmToStroops('12.3456789'), 123_456_789n);
});
