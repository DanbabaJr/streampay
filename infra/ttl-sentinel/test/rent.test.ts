import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LEDGERS_PER_30_DAY_MONTH,
  PERSISTENT_RENT_RATE_DENOMINATOR,
  RENT_STATE_TARGET_BYTES,
} from '../src/constants.js';
import {
  codeRentStroops,
  extensionOverheadStroops,
  projectMonthlyRent,
  rentFeePer1Kb,
  rentStroops,
  stroopsToXlm,
} from '../src/rent.js';
import { MEASURED_ENTRY_BYTES, estimateIndexBytes } from '../src/sizes.js';

test('the rent curve follows the CAP-0066 / fees.rs shape', () => {
  // Floor dominates below 2 GB of live state.
  assert.equal(rentFeePer1Kb(0n), 1000n);
  assert.equal(rentFeePer1Kb(1_000_000_000n), 1000n);
  assert.equal(rentFeePer1Kb(2_000_000_000n), 1000n);
  // Ramps to the high rate at the 3 GB target…
  assert.equal(rentFeePer1Kb(2_500_000_000n), 5500n);
  assert.equal(rentFeePer1Kb(RENT_STATE_TARGET_BYTES), 10_000n);
  // …then grows by the 5000× growth factor per unit past the target.
  assert.equal(rentFeePer1Kb(4_000_000_000n), 45_010_000n);
  assert.throws(() => rentFeePer1Kb(-1n), />= 0/);
});

test('rent formula is the exact fees.rs expression (rounded up)', () => {
  const monthly = BigInt(LEDGERS_PER_30_DAY_MONTH);
  assert.equal(monthly, 518_400n);

  // ceil(504 × 1000 × 518400 / (1024 × 1215)) = 210000 stroops exactly
  const floor = rentStroops(BigInt(MEASURED_ENTRY_BYTES.stream), monthly, 1000n);
  assert.equal(floor, 210_000n);
  assert.equal(stroopsToXlm(floor), '0.021');

  const ceiling = rentStroops(BigInt(MEASURED_ENTRY_BYTES.stream), monthly, 10_000n);
  assert.equal(ceiling, 2_100_000n);
  assert.equal(stroopsToXlm(ceiling), '0.21');

  // Rent scales linearly with size, ledgers and fee — no compounding.
  assert.equal(rentStroops(400n, monthly, 1000n) * 2n, rentStroops(800n, monthly, 1000n));
  assert.equal(rentStroops(400n, monthly, 1000n), rentStroops(400n, monthly * 2n, 1000n) / 2n);

  // Denominator is the persistent rate (1215), not temporary (2430).
  assert.equal(PERSISTENT_RENT_RATE_DENOMINATOR, 1215n);
});

test('code entries pay a third of the computed rent', () => {
  const monthly = BigInt(LEDGERS_PER_30_DAY_MONTH);
  const full = rentStroops(120_000n, monthly, 1000n);
  assert.equal(codeRentStroops(120_000n, monthly, 1000n), (full + 2n) / 3n);
  assert.equal(stroopsToXlm(codeRentStroops(120_000n, monthly, 1000n)), '1.6666667');
});

test('every extension also pays the 48-byte TTL-entry write', () => {
  // ceil(48 × 3500 / 1024) = 165 stroops
  assert.equal(extensionOverheadStroops(), 165n);
  assert.equal(extensionOverheadStroops(3500n, 100n), 265n);
});

test('stroopsToXlm renders 7-decimal amounts', () => {
  assert.equal(stroopsToXlm(10_000_000n), '1');
  assert.equal(stroopsToXlm(1n), '0.0000001');
  assert.equal(stroopsToXlm(12_345_678n), '1.2345678');
  assert.equal(stroopsToXlm(0n), '0');
  assert.equal(stroopsToXlm(-5_000_000n), '-0.5');
});

test('monthly projection at current scale is linear in stream count', () => {
  const sizes = { stream: MEASURED_ENTRY_BYTES.stream, index: estimateIndexBytes(1), counter: 92, instance: 96, code: 120_000 };
  const one = projectMonthlyRent({ counts: { stream: 1, index: 2, counter: 1, instance: 1, code: 1 }, sizes });
  const hundred = projectMonthlyRent({ counts: { stream: 100, index: 200, counter: 1, instance: 1, code: 1 }, sizes });

  const streamRowOne = one.rows.find((r) => r.cls === 'stream');
  const streamRowHundred = hundred.rows.find((r) => r.cls === 'stream');
  assert.ok(streamRowOne && streamRowHundred);
  assert.equal(streamRowOne.monthlyXlmAtFloor, '0.021');
  assert.equal(streamRowHundred.monthlyXlmAtFloor, '2.1');
  assert.equal(hundred.perStreamMonthlyXlmAtState, streamRowOne.monthlyXlmAtState);

  // Fixed code rent dominates a small deployment; per-stream rent overtakes it
  // as scale grows (the crossover the pricing/dust work cares about).
  const codeOne = one.rows.find((r) => r.cls === 'code');
  const codeHundred = hundred.rows.find((r) => r.cls === 'code');
  assert.ok(codeOne && codeHundred);
  assert.ok(Number(codeOne.monthlyXlmAtFloor) > Number(streamRowOne.monthlyXlmAtFloor));
  assert.ok(Number(codeHundred.monthlyXlmAtFloor) < Number(streamRowHundred.monthlyXlmAtFloor));
});

test('the projection exposes floor, per-state and ceiling columns', () => {
  const p = projectMonthlyRent({
    counts: { stream: 10 },
    sizes: { stream: 504 },
    stateSizeBytes: RENT_STATE_TARGET_BYTES,
  });
  assert.equal(p.feePer1KbAtFloor, '1000');
  assert.equal(p.feePer1KbAtState, '10000');
  assert.equal(p.feePer1KbAtCeiling, '10000');
  assert.equal(p.rows[0]?.monthlyXlmAtFloor, '0.21');
  assert.equal(p.rows[0]?.monthlyXlmAtState, '2.1');
});

test('zero-count classes are omitted and totals stay coherent', () => {
  const p = projectMonthlyRent({ counts: { stream: 0, counter: 1 }, sizes: { stream: 504, counter: 92 } });
  assert.deepEqual(
    p.rows.map((r) => r.cls),
    ['counter'],
  );
  assert.equal(p.perStreamMonthlyXlmAtState, '0', 'no live streams → no marginal cost');
  assert.equal(p.totalXlmAtFloor, p.rows[0]?.monthlyXlmAtFloor);
});
