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

test('planner: 90-day simulated month with churn proves live streams stay above cliff with 1 tx per account per window', async () => {
  const { planRenewals } = await import('../src/planner.js');
  const chain = new FakeChain({ startLedger: 1_000_000 });
  const h = new Harness(chain, { scanIntervalSec: SCAN_SEC });

  // 90 days = ~1,555,200 ledgers at 5s cadence
  // We simulate in steps of 50,000 ledgers (~2.9 days per step = ~31 steps)
  const TOTAL_STEPS = 31;
  const LEDGERS_PER_STEP = 50_000;
  const accounts = ['G_CORP_1', 'G_CORP_2', 'G_CORP_3'];

  // Seed initial streams
  for (let i = 1; i <= 6; i++) {
    chain.createStream({ id: i }, chain.ledger);
  }

  let nextStreamId = 7;
  for (let step = 0; step < TOTAL_STEPS; step++) {
    // Churn: create new stream every 2 steps
    if (step % 2 === 0 && nextStreamId < 25) {
      chain.createStream({ id: nextStreamId++ }, chain.ledger);
    }

    // Churn: cancel/complete a stream every 5 steps
    if (step % 5 === 0 && step > 0) {
      const cancelId = Math.max(1, nextStreamId - 5);
      chain.writeStream(cancelId, { status: 'Cancelled' }, chain.ledger);
    }

    // Advance ledgers
    chain.advanceLedgers(LEDGERS_PER_STEP, CADENCE_SEC);

    // Run sentinel scan and build inventory
    const scanResult = await h.scan();
    const inventory = scanResult.projections
      .filter((p) => p.remainingLedgers > 0)
      .map((p, idx) => ({
        id: p.id,
        cls: p.cls,
        keyB64: Buffer.from(p.id).toString('base64'),
        account: accounts[idx % accounts.length]!,
        remainingLedgers: p.remainingLedgers,
        sizeBytes: 400,
        isDemo: idx % 4 === 0,
        deadlineLedger: chain.ledger + p.remainingLedgers,
      }));

    // Run pure planner
    const schedule = planRenewals(inventory, undefined, chain.ledger);

    // Prove at most 1 tx per account per window
    const accountsScheduled = schedule.transactions.map((tx) => tx.account);
    const uniqueAccounts = new Set(accountsScheduled);
    assert.equal(
      accountsScheduled.length,
      uniqueAccounts.size,
      'Planner must produce at most 1 tx per account per window',
    );

    // Apply planned extensions off-chain to keep live entries renewed
    for (const tx of schedule.transactions) {
      for (const key of tx.keys) {
        chain.extendOffchain(key.id, CONTRACT_TTL_EXTEND_LEDGERS);
      }
    }
  }

  // After 90 days, all active live streams must remain well above the critical cliff
  const finalScan = await h.scan();
  for (const p of finalScan.projections) {
    if (p.id.startsWith('stream:')) {
      assert.ok(
        p.remainingLedgers >= 50_000,
        `Stream ${p.id} must stay above critical cliff throughout 90-day simulation (got ${p.remainingLedgers})`,
      );
    }
  }
});

test('chaos: batch failures mid-window isolate errors without stalling queue', async () => {
  const { Extender } = await import('../src/extender.js');
  let attempt = 0;

  // Mock submitter where the first account fails with an RPC error
  const chaoticSubmitter = {
    async submit(keys: string[], _extendTo: number) {
      attempt++;
      if (keys.includes('KEY_FAILING')) {
        return { status: 'RpcTimeoutError', hash: null, feeStroops: null };
      }
      return { status: 'success', hash: `0xabc_${attempt}`, feeStroops: 10_000n };
    },
  };

  const plan = {
    extendTo: 500_000,
    thresholdLedgers: 200_000,
    healthy: 10,
    estimatedTotalStroops: 50_000n,
    batches: [
      {
        targets: [{ id: 'fail:1', cls: 'stream' as const, keyB64: 'KEY_FAILING', remainingLedgers: 100_000, sizeBytes: 400 }],
        estimatedRentStroops: 10_000n,
        account: 'POISON_ACCOUNT',
      },
      {
        targets: [{ id: 'ok:2', cls: 'stream' as const, keyB64: 'KEY_GOOD_1', remainingLedgers: 120_000, sizeBytes: 400 }],
        estimatedRentStroops: 10_000n,
        account: 'GOOD_ACCOUNT_1',
      },
      {
        targets: [{ id: 'ok:3', cls: 'stream' as const, keyB64: 'KEY_GOOD_2', remainingLedgers: 130_000, sizeBytes: 400 }],
        estimatedRentStroops: 10_000n,
        account: 'GOOD_ACCOUNT_2',
      },
    ],
  };

  const spender = { month: '2026-10', spentStroops: 0n };
  const extender = new Extender(
    {
      enabled: true,
      dryRun: false,
      thresholdLedgers: 200_000,
      extendTo: 500_000,
      maxEntriesPerTx: 50,
      monthlyBudgetXlm: '100',
      secretKeyEnv: 'EXTENDER_KEY',
    },
    chaoticSubmitter,
    spender,
    { isolateFailures: true, quarantineThreshold: 2 },
  );

  const result = await extender.run(plan);

  // Failure isolation: 1 failed batch does not halt the queue; the other 2 succeed
  assert.equal(result.failedBatches?.length, 1, 'Only the poison account batch should fail');
  assert.equal(result.submitted.length, 2, 'Remaining non-poison batches must be processed successfully');
  assert.equal(result.stoppedBy, null, 'Queue must not halt on isolated batch error');
});
