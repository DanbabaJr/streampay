//! The headline test suite: fast-forward the ledger and prove the sentinel's
//! alert timing against the *true* worst-case cliffs.
//!
//! Ledger math used throughout (5 s cadence unless stated):
//! - scans every 3,000 s → 600 ledgers pass between scans (GAP)
//! - stream cliff: 200,000 ledgers (threshold); warn at 150,000; crit at 60,000
//! - never-extended cliff: 4,095 ledgers; warn at 3,000; crit at 1,200

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CadenceMeter } from '../src/cadence.js';
import { CLASS_CLIFFS, scheduleMargins } from '../src/cliff.js';
import { CONTRACT_TTL_EXTEND_LEDGERS } from '../src/constants.js';
import { project } from '../src/project.js';
import { FakeChain, Harness } from './fake-chain.js';

const SCAN_SEC = 3_000;
const CADENCE_SEC = 5;
const GAP = SCAN_SEC / CADENCE_SEC; // 600 ledgers between scans

test('stream: warn fires ~49k ledgers inside the 200k cliff, then crit, then expiry', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
  chain.createStream({ id: 1 }, 1_000_000);

  const first = await h.scan();
  const stream0 = first.projections.find((p) => p.id === 'stream:1');
  assert.equal(stream0?.severity, 'ok');
  assert.equal(stream0?.observedCliffLedgers, CONTRACT_TTL_EXTEND_LEDGERS, 'create extended the TTL to 500k');
  assert.equal(stream0?.remainingLedgers, 500_000);

  for (let i = 0; i < Math.ceil(500_000 / GAP) + 2; i++) {
    chain.advanceSeconds(SCAN_SEC, CADENCE_SEC);
    await h.scan();
  }

  const warn = h.eventsFor('stream:1', 'warn');
  const crit = h.eventsFor('stream:1', 'crit');
  const expired = h.eventsFor('stream:1', 'expired');

  assert.equal(warn.length, 1, 'exactly one warning');
  assert.equal(crit.length, 1, 'exactly one critical');
  assert.equal(expired.length, 1, 'exactly one expiry');

  // Each alert lands within one scan gap of its threshold (never later).
  assert.equal(warn[0]!.remainingLedgers, 149_600);
  assert.ok(warn[0]!.remainingLedgers <= 150_000 && warn[0]!.remainingLedgers > 150_000 - GAP);
  assert.equal(crit[0]!.remainingLedgers, 59_600);

  // The cliff margin: warn + worst-case scan gap still fits inside 200k.
  const margin = CLASS_CLIFFS.stream.worstCaseLedgers - (warn[0]!.remainingLedgers + GAP);
  assert.equal(margin, 49_800);

  // Strict ordering, and critical keeps ~59k ledgers (~3.4 days at 5 s) of lead.
  assert.ok(warn[0]!.atLedger < crit[0]!.atLedger && crit[0]!.atLedger < expired[0]!.atLedger);
  assert.equal(crit[0]!.remainingLedgers - GAP, 59_000);
  assert.equal(expired[0]!.remainingLedgers, 0);
  assert.equal(expired[0]!.atLedger, 1_500_400);
});

test('stream: an adversarially non-extending write leaves exactly the worst-case cliff', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
  chain.createStream({ id: 1 }, 1_000_000);
  await h.scan(); // capture the id high-water mark before the counter archives

  // Advance to remaining 250k, then write (a withdraw): remaining >= threshold,
  // so the contract's extend_ttl is a no-op and expiry does not move.
  chain.advanceLedgers(250_000, CADENCE_SEC);
  const before = chain.entryFor('stream:1')!;
  chain.writeStream(1, { withdrawn: 1n }, chain.ledger);
  const after = chain.entryFor('stream:1')!;
  assert.equal(after.liveUntil, before.liveUntil, 'a non-extending write must not move liveUntil');
  assert.equal(after.lastModified, chain.ledger);

  const observed = await h.scan();
  const p = observed.projections.find((x) => x.id === 'stream:1')!;
  assert.equal(p.observedCliffLedgers, 250_000, 'observed cliff = liveUntil - last write');
  assert.ok(p.observedCliffLedgers! >= CLASS_CLIFFS.stream.worstCaseLedgers);

  for (let i = 0; i < Math.ceil(250_000 / GAP) + 2; i++) {
    chain.advanceSeconds(SCAN_SEC, CADENCE_SEC);
    await h.scan();
  }
  assert.equal(h.eventsFor('stream:1', 'warn').length, 1);
  assert.equal(h.eventsFor('stream:1', 'crit').length, 1);
  assert.equal(h.eventsFor('stream:1', 'expired').length, 1);
});

test('stream: a write inside the cliff extends and resolves the alert', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
  chain.createStream({ id: 1 }, 1_000_000);
  await h.scan();

  chain.advanceLedgers(355_000, CADENCE_SEC); // remaining 145,000
  await h.scan();
  assert.equal(h.projectionFor('stream:1')?.severity, 'warn');
  await h.scan(); // steady state: deduped
  assert.equal(h.allEvents().filter((e) => e.id === 'stream:1').length, 1);

  for (let i = 0; i < 200 && h.projectionFor('stream:1')?.severity !== 'crit'; i++) {
    chain.advanceSeconds(SCAN_SEC, CADENCE_SEC);
    await h.scan();
  }
  assert.equal(h.projectionFor('stream:1')?.severity, 'crit');

  chain.writeStream(1, { withdrawn: 5n }, chain.ledger);
  assert.equal(chain.entryFor('stream:1')!.liveUntil, chain.ledger + CONTRACT_TTL_EXTEND_LEDGERS);

  const recovered = await h.scan();
  assert.equal(recovered.projections.find((p) => p.id === 'stream:1')?.severity, 'ok');
  const resolved = h.eventsFor('stream:1').filter((e) => e.action === 'resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.prevSeverity, 'crit');
});

test('never-extended entries alert on their own 4,095-ledger cliff, not on 200k', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
  chain.createStream({ id: 1 }, 1_000_000);

  for (let i = 0; i < 10; i++) {
    chain.advanceSeconds(SCAN_SEC, CADENCE_SEC);
    await h.scan();
  }
  const codeId = h.history[0]!.report.code!.id;
  assert.ok(codeId.startsWith('code:'), 'the Wasm code entry is discovered via the instance');

  for (const id of ['counter', 'instance', codeId]) {
    const warn = h.eventsFor(id, 'warn');
    const crit = h.eventsFor(id, 'crit');
    const expired = h.eventsFor(id, 'expired');
    assert.equal(warn.length, 1, `${id} should warn exactly once`);
    assert.equal(crit.length, 1, `${id} should go critical exactly once`);
    assert.equal(expired.length, 1, `${id} should expire exactly once`);
    assert.ok(warn[0]!.remainingLedgers <= 3_000 && warn[0]!.remainingLedgers > 3_000 - GAP, `${id} warn timing`);
    assert.ok(crit[0]!.remainingLedgers <= 1_200, `${id} crit timing`);
    assert.ok(warn[0]!.remainingLedgers + GAP < CLASS_CLIFFS.counter.worstCaseLedgers, `${id} inside cliff`);
  }
});

test('the 200k stream thresholds would mis-handle a fresh counter — classes must differ', () => {
  const cadence = new CadenceMeter({ floorSec: 1, targetSec: 5 });
  const counterObs = {
    id: 'counter',
    cls: 'counter' as const,
    liveUntilLedger: 1_004_095,
    lastModifiedLedger: 1_000_000,
  };
  const ctx = { nowLedger: 1_000_000, nowIso: 'now', cadence };

  const wrong = project(counterObs, { warnLedgers: 150_000, critLedgers: 60_000 }, ctx);
  const right = project(counterObs, { warnLedgers: 3_000, critLedgers: 1_200 }, ctx);
  assert.equal(wrong.severity, 'crit', 'stream thresholds would page on every fresh counter');
  assert.equal(right.severity, 'ok', 'the counter schedule treats creation-time TTL as healthy');
});

test('cadence: ledger-time alerting is cadence-independent; wall-clock ETA is not', async () => {
  const run = async (cadenceSec: number): Promise<{ warnLedger: number; spanMs: number }> => {
    const chain = new FakeChain({ startLedger: 1_000_000 });
    const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
    const startWall = chain.wallMs;
    chain.createStream({ id: 1 }, 1_000_000);
    await h.scan();
    let warnLedger = 0;
    for (let i = 0; i < Math.ceil(500_000 / (SCAN_SEC / cadenceSec)) + 2; i++) {
      chain.advanceSeconds(SCAN_SEC, cadenceSec);
      await h.scan();
      const warn = h.eventsFor('stream:1', 'warn')[0];
      if (warn && warnLedger === 0) warnLedger = warn.atLedger;
    }
    return { warnLedger, spanMs: chain.wallMs - startWall };
  };

  const slow = await run(5);
  const fast = await run(1);

  // Same ledger neighbourhood (within one scan's worth of ledgers)…
  assert.equal(slow.warnLedger, 1_350_400);
  assert.ok(Math.abs(fast.warnLedger - 1_350_000) <= SCAN_SEC, `fast warn at ${fast.warnLedger}`);
  // …but the identical ledger span takes ~5× less wall time at 1 s/ledger.
  const ratio = slow.spanMs / fast.spanMs;
  assert.ok(ratio > 4.5 && ratio < 5.5, `wall-time ratio ${ratio}`);

  // The schedule still beats the cliff at that fastest credible cadence.
  const margins = scheduleMargins('stream', 150_000, 60_000, SCAN_SEC, 1);
  assert.equal(margins.worstScanGapLedgers, SCAN_SEC);
  assert.equal(margins.warnMarginLedgers, 200_000 - 150_000 - SCAN_SEC);
  assert.ok(margins.warnMarginLedgers > 0);
});

test('missed scans: inside the cliff a resume still prevents; beyond it, detection only', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
  chain.createStream({ id: 1 }, 1_000_000);
  await h.scan();

  chain.advanceLedgers(349_000, CADENCE_SEC); // remaining 151,000 → still healthy
  await h.scan();
  chain.advanceLedgers(50_000, CADENCE_SEC); // sentinel outage
  const resumed = await h.scan();
  const p = resumed.projections.find((x) => x.id === 'stream:1')!;
  assert.equal(p.remainingLedgers, 101_000);
  assert.equal(p.severity, 'warn', 'still reclaimable — prevention survived the outage');

  const chain2 = new FakeChain({ startLedger: 5_000_000 });
  const h2 = new Harness(chain2, { scanIntervalSec: SCAN_SEC });
  chain2.createStream({ id: 1 }, 5_000_000);
  await h2.scan();
  chain2.advanceLedgers(199_000, CADENCE_SEC); // remaining 301,000
  await h2.scan();
  chain2.advanceLedgers(310_000, CADENCE_SEC); // outage crosses expiry
  const after = await h2.scan();
  assert.equal(after.projections.find((x) => x.id === 'stream:1')!.severity, 'expired');
  assert.equal(h2.eventsFor('stream:1', 'expired').length, 1, 'detected on resume');
  assert.equal(h2.eventsFor('stream:1', 'warn').length, 0, 'prevention was impossible: no warning was ever emitted');
});

test('an off-chain extension (the optional funded component) lifts a never-extended cliff', async () => {
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });
  chain.createStream({ id: 1 }, 1_000_000);
  await h.scan();

  for (let i = 0; i < 5; i++) {
    chain.advanceSeconds(SCAN_SEC, CADENCE_SEC);
    await h.scan();
  }
  assert.equal(h.eventsFor('counter', 'warn').length, 1, 'counter warned on its own cliff');

  // ExtendFootprintTTL, as the optional extender does with its own funded key.
  chain.extendOffchain('counter', CONTRACT_TTL_EXTEND_LEDGERS);
  const recovered = await h.scan();
  assert.equal(recovered.projections.find((p) => p.id === 'counter')!.severity, 'ok');
  assert.equal(h.eventsFor('counter').filter((e) => e.action === 'resolved').length, 1);

  const entry = chain.entryFor('counter')!;
  assert.equal(entry.liveUntil, chain.ledger + CONTRACT_TTL_EXTEND_LEDGERS);
  assert.equal(
    recovered.projections.find((p) => p.id === 'counter')!.observedCliffLedgers,
    entry.liveUntil - entry.lastModified,
  );
});
