import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLASS_CLIFFS,
  assertScheduleSafety,
  bestCaseCliffLedgers,
  creationCliffLedgers,
  scheduleMargins,
  worstCaseCliffLedgers,
} from '../src/cliff.js';
import { defaultConfig } from '../src/config.js';
import { CONTRACT_TTL_EXTEND_LEDGERS, CONTRACT_TTL_THRESHOLD_LEDGERS, MIN_PERSISTENT_ENTRY_TTL } from '../src/constants.js';

test('worst-case cliff is the threshold, best case the extend target', () => {
  assert.equal(worstCaseCliffLedgers(200_000, 500_000), 200_000);
  assert.equal(bestCaseCliffLedgers(200_000, 500_000), 500_000);
  assert.throws(() => worstCaseCliffLedgers(500_000, 200_000), /must exceed threshold/);
  assert.throws(() => bestCaseCliffLedgers(1, 1), /must exceed threshold/);
});

test('never-extended classes are bound by min_persistent_entry_ttl - 1', () => {
  assert.equal(creationCliffLedgers(), MIN_PERSISTENT_ENTRY_TTL - 1);
  assert.equal(CLASS_CLIFFS.counter.worstCaseLedgers, 4095);
  assert.equal(CLASS_CLIFFS.instance.worstCaseLedgers, 4095);
  assert.equal(CLASS_CLIFFS.code.worstCaseLedgers, 4095);
  assert.equal(CLASS_CLIFFS.counter.extendedOnChain, false);
  assert.equal(CLASS_CLIFFS.instance.extendedOnChain, false);
  assert.equal(CLASS_CLIFFS.code.extendedOnChain, false);
});

test('extended classes reflect the contract constants', () => {
  assert.equal(CLASS_CLIFFS.stream.worstCaseLedgers, CONTRACT_TTL_THRESHOLD_LEDGERS);
  assert.equal(CLASS_CLIFFS.stream.bestCaseLedgers, CONTRACT_TTL_EXTEND_LEDGERS);
  assert.equal(CLASS_CLIFFS.index.worstCaseLedgers, CONTRACT_TTL_THRESHOLD_LEDGERS);
  assert.equal(CLASS_CLIFFS.stream.extendedOnChain, true);
  assert.equal(CLASS_CLIFFS.index.extendedOnChain, true);
});

/**
 * The derivation, replayed: a write extends only when remaining < threshold,
 * to `now + extendTo`. Two invariants must hold for every write sequence:
 *  1. after any write, at least `threshold` ledgers remain (worst case), and
 *  2. the tight worst case is reachable — a write at `remaining == threshold`
 *     extends nothing and leaves exactly `threshold`.
 */
test('write-sequence replay: the 200k worst-case is an invariant and tight', () => {
  const threshold = 200_000;
  const extendTo = 500_000;

  // Deterministic pseudo-random write intervals, some longer than the window.
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  let ledger = 1_000_000;
  let liveUntil = ledger + MIN_PERSISTENT_ENTRY_TTL - 1;
  // Account for the creation write (put_stream extends immediately).
  liveUntil = ledger + extendTo;

  for (let i = 0; i < 5_000; i++) {
    ledger += Math.floor(rand() * 400_000);
    const remaining = liveUntil - ledger;
    if (remaining <= 0) break;
    if (remaining < threshold) liveUntil = ledger + extendTo;
    const after = liveUntil - ledger;
    assert.ok(after >= threshold, `post-write remaining ${after} must be >= ${threshold}`);
    assert.ok(after <= extendTo, `post-write remaining ${after} must be <= ${extendTo}`);
  }

  // Tight worst case: reaching `remaining == threshold` exactly allows a
  // non-extending write that leaves exactly the cliff.
  const writeLedger = 2_000_000;
  liveUntil = writeLedger + threshold; // last extending write long ago
  const remaining = liveUntil - writeLedger;
  assert.equal(remaining, threshold, 'non-extending write at the boundary leaves exactly the cliff');
  liveUntil = remaining < threshold ? writeLedger + extendTo : liveUntil;
  assert.equal(liveUntil - writeLedger, threshold);
});

test('default schedule beats every class cliff at the fastest credible cadence', () => {
  const cfg = defaultConfig();
  const margins = assertScheduleSafety(cfg.schedules, cfg.scanIntervalSec, cfg.floorLedgerSec);

  // Streams: 150k warn + 300-ledger worst scan gap fits inside 200k with 49.7k to spare.
  assert.equal(margins.stream.worstScanGapLedgers, 300);
  assert.equal(margins.stream.warnMarginLedgers, 200_000 - 150_000 - 300);
  // Never-extended classes: far tighter, hence their own thresholds.
  assert.equal(margins.counter.worstScanGapLedgers, 300);
  assert.equal(margins.counter.warnMarginLedgers, 4095 - 3_000 - 300);
  assert.equal(margins.counter.critLeadLedgers, 1_200 - 300);
  for (const m of Object.values(margins)) {
    assert.ok(m.warnMarginLedgers > 0, `${m.cls} warn margin must be positive`);
    assert.ok(m.critLeadLedgers > 0, `${m.cls} crit lead must be positive`);
  }
});

test('an unsafe schedule is rejected (warn would fire outside the cliff)', () => {
  const unsafe = { ...defaultConfig().schedules, counter: { warnLedgers: 3_900, critLedgers: 100 } };
  assert.throws(() => assertScheduleSafety(unsafe, 300, 1), /schedule unsafe for counter/);
  // A schedule that would apply the 200k stream threshold to the 4095-ledger
  // counter cannot even be expressed: warn must stay below the cliff.
  assert.throws(() => scheduleMargins('counter', 150_000, 60_000, 300, 1), /warn/);
});

test('scheduleMargins rejects inverted thresholds', () => {
  assert.throws(() => scheduleMargins('stream', 1_000, 2_000, 300, 1), /must exceed crit/);
});
