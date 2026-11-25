import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planRenewals, type KeyFootprintItem } from '../src/planner.js';
import { DEFAULT_PLANNER_POLICY, type PlannerPolicyConfig } from '../src/planner-policy.js';

function createMockInventory(): KeyFootprintItem[] {
  return [
    {
      id: 'stream:1',
      cls: 'stream',
      keyB64: 'AAAAAQ==',
      account: 'G_SENDER_A',
      remainingLedgers: 120_000,
      sizeBytes: 400,
      isDemo: false,
      deadlineLedger: 1_120_000,
    },
    {
      id: 'stream:2',
      cls: 'stream',
      keyB64: 'AAAAAg==',
      account: 'G_SENDER_A',
      remainingLedgers: 150_000,
      sizeBytes: 400,
      isDemo: false,
      deadlineLedger: 1_150_000,
    },
    {
      id: 'stream:3',
      cls: 'stream',
      keyB64: 'AAAAAw==',
      account: 'G_SENDER_B',
      remainingLedgers: 90_000,
      sizeBytes: 400,
      isDemo: true, // Demo stream
      deadlineLedger: 1_090_000,
    },
    {
      id: 'stream:4',
      cls: 'stream',
      keyB64: 'AAAABA==',
      account: 'G_SENDER_C',
      remainingLedgers: 180_000,
      sizeBytes: 400,
      isDemo: false,
      deadlineLedger: 1_180_000,
    },
    {
      id: 'stream:healthy',
      cls: 'stream',
      keyB64: 'AAAAIQ==',
      account: 'G_SENDER_D',
      remainingLedgers: 450_000, // Healthy, > threshold
      sizeBytes: 400,
      isDemo: false,
      deadlineLedger: 1_450_000,
    },
  ];
}

test('planner: filters healthy entries and clusters candidates inside cliff', () => {
  const inventory = createMockInventory();
  const schedule = planRenewals(inventory, DEFAULT_PLANNER_POLICY, 1_000_000);

  // stream:healthy is omitted since 450k > 200k threshold
  assert.equal(schedule.metrics.totalCandidates, 4);
  assert.equal(schedule.metrics.scheduledEntries, 4);
});

test('planner: targets exactly one transaction per account per planning window', () => {
  const inventory = createMockInventory();
  const schedule = planRenewals(inventory, DEFAULT_PLANNER_POLICY, 1_000_000);

  // G_SENDER_A has 2 keys (stream:1 and stream:2), but they must be packed into 1 transaction
  const txsForA = schedule.transactions.filter((tx) => tx.account === 'G_SENDER_A');
  assert.equal(txsForA.length, 1, 'Account G_SENDER_A must receive exactly one tx');
  assert.equal(txsForA[0]!.keys.length, 2, 'Both keys for account A must be packed in that tx');
});

test('planner: prioritizes paid streams over demo streams', () => {
  const inventory = createMockInventory();
  const schedule = planRenewals(inventory, DEFAULT_PLANNER_POLICY, 1_000_000);

  // Even though stream:3 (demo) has the lowest remaining ledgers (90k vs 120k/180k),
  // paid streams (G_SENDER_A, G_SENDER_C) are scheduled ahead of demo streams
  assert.equal(schedule.transactions[0]!.isDemo, false, 'First transaction must be paid stream');
  assert.equal(schedule.transactions[1]!.isDemo, false, 'Second transaction must be paid stream');
  assert.equal(schedule.transactions[2]!.isDemo, true, 'Demo stream scheduled after paid streams');
  assert.equal(schedule.transactions[2]!.account, 'G_SENDER_B');
});

test('planner: ties between streams of the same tier break by oldest deadline', () => {
  const inventory = createMockInventory();
  const schedule = planRenewals(inventory, DEFAULT_PLANNER_POLICY, 1_000_000);

  // Between paid accounts G_SENDER_A (min remaining: 120k) and G_SENDER_C (min remaining: 180k),
  // A has an older deadline and must be scheduled before C
  assert.equal(schedule.transactions[0]!.account, 'G_SENDER_A');
  assert.equal(schedule.transactions[1]!.account, 'G_SENDER_C');
});

test('planner: enforces rent-cost budget and sheds demo streams when budget binds', () => {
  const inventory = createMockInventory();
  // Constrain daily budget so only paid transactions fit
  const constrainedPolicy: PlannerPolicyConfig = {
    ...DEFAULT_PLANNER_POLICY,
    dailyBurnLimitStroops: 45_000n, // tight budget (~45k Stroops: enough for paid accounts A and C, but not demo B)
    treasuryStroops: 45_000n,
    degradationPolicy: 'expire-demo-first',
  };

  const schedule = planRenewals(inventory, constrainedPolicy, 1_000_000);

  // Under budget pressure, demo stream (G_SENDER_B) is shed first
  assert.ok(schedule.transactions.every((tx) => !tx.isDemo), 'Only paid streams should be scheduled');
  assert.ok(
    schedule.deferredEntries.some((d) => d.id === 'stream:3'),
    'Demo stream should be in deferredEntries',
  );
});

test('planner: isolates failures and quarantines poison accounts', () => {
  const inventory = createMockInventory();
  const state = {
    quarantinedAccounts: new Set(['G_SENDER_C']), // G_SENDER_C quarantined
  };

  const schedule = planRenewals(inventory, DEFAULT_PLANNER_POLICY, 1_000_000, 500_000, 200_000, 1000n, state);

  // G_SENDER_C is excluded from scheduled transactions and deferred
  assert.ok(schedule.transactions.every((tx) => tx.account !== 'G_SENDER_C'));
  assert.ok(schedule.deferredEntries.some((d) => d.account === 'G_SENDER_C'));
  assert.equal(schedule.metrics.quarantinedCount, 1);
});

test('planner: computes WASH-hours and triggers alarm when burn threshold is exceeded', () => {
  const inventory = createMockInventory();
  const alarmPolicy: PlannerPolicyConfig = {
    ...DEFAULT_PLANNER_POLICY,
    dailyBurnLimitStroops: 100_000n, // very low limit so utilization exceeds alarm threshold
    alarmThresholdPct: 50,
  };

  const schedule = planRenewals(inventory, alarmPolicy, 1_000_000);

  assert.ok(schedule.metrics.projectedWashHours > 0);
  assert.equal(schedule.metrics.alarmTriggered, true, 'Alarm must fire when burn exceeds threshold');
});
