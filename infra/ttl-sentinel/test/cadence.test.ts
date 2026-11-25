import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CadenceMeter, formatDuration } from '../src/cadence.js';
import { FASTEST_CREDIBLE_LEDGER_SECONDS, TARGET_LEDGER_SECONDS } from '../src/constants.js';

test('defaults: 1 s floor, 5 s target', () => {
  const m = new CadenceMeter();
  assert.equal(m.floorSec, FASTEST_CREDIBLE_LEDGER_SECONDS);
  assert.equal(m.targetSec, TARGET_LEDGER_SECONDS);
  assert.equal(m.stats().measuredSecPerLedger, null);
});

test('measures seconds per ledger from advancing samples', () => {
  const m = new CadenceMeter();
  m.record(1_000, 0);
  m.record(1_100, 500_000); // 100 ledgers in 500 s
  assert.equal(m.stats().measuredSecPerLedger, 5);
  assert.equal(m.stats().sampleCount, 2);
});

test('ignores non-advancing and out-of-order samples', () => {
  const m = new CadenceMeter();
  m.record(1_000, 0);
  m.record(1_000, 1_000); // same ledger: carries no cadence information
  m.record(900, 2_000); // backwards
  m.record(1_100, 500_000); // 100 ledgers in 500 s
  assert.equal(m.stats().sampleCount, 2);
  assert.equal(m.stats().measuredSecPerLedger, 5);
});

test('sampled cadence is clamped to the credible floor', () => {
  const m = new CadenceMeter();
  m.record(1_000, 0);
  m.record(2_000, 100); // 0.1 s/ledger is below the 1 s protocol floor
  assert.equal(m.stats().measuredSecPerLedger, 1);
});

test('worst-case ledgers per wall interval uses the fastest credible cadence', () => {
  const m = new CadenceMeter();
  // 5 min of scanning at 1 s/ledger = 300 ledgers — the number schedule math must use.
  assert.equal(m.maxLedgersInWallSeconds(300), 300);
  assert.equal(m.maxLedgersInWallSeconds(3_600), 3_600);
  assert.equal(m.maxLedgersInWallSeconds(0), 0);
  assert.throws(() => m.maxLedgersInWallSeconds(-1), />= 0/);
});

test('ETAs use the requested cadence mode', () => {
  const m = new CadenceMeter();
  m.record(1_000, 0);
  m.record(1_100, 500_000); // measured 5 s
  assert.equal(m.secondsForLedgers(1_000, 'fastest'), 1_000);
  assert.equal(m.secondsForLedgers(1_000, 'target'), 5_000);
  assert.equal(m.secondsForLedgers(1_000, 'measured'), 5_000);
});

test('measured mode falls back to the target before samples exist', () => {
  const m = new CadenceMeter();
  assert.equal(m.secondsForLedgers(100, 'measured'), 500);
});

test('formatDuration renders compact human durations', () => {
  assert.equal(formatDuration(1_000_000), '11d13h');
  assert.equal(formatDuration(86_400), '1d0h');
  assert.equal(formatDuration(3_600 + 120), '1h2m');
  assert.equal(formatDuration(90), '1m');
  assert.equal(formatDuration(9), '9s');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), 'n/a');
});
