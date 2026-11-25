import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { StreamStore } from "../store.js";
import type { DecodedEvent, EventValue } from "../types.js";
import { RegionWatermarkTracker } from "./watermarks.js";
import { FreshnessReadRouter, NoFreshRegionError } from "./router.js";
import { DeliveryLeaderElector, LeaseLostError, type DeliveryLease } from "./leader.js";
import { compareRegions, foldStream, projectionRoot, reconcileRegion } from "./convergence.js";

const SENDER = "G" + "A".repeat(55);
const RECIPIENT = "G" + "B".repeat(55);
const TOKEN = "C" + "C".repeat(55);

const stores: StreamStore[] = [];
function newStore(): StreamStore {
  const store = new StreamStore(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function decoded(id: string, ledger: number, name: string, data: Record<string, EventValue>, streamId: string | null = "1"): DecodedEvent {
  return {
    id,
    pagingToken: id,
    ledger,
    ledgerClosedAt: `2026-01-01T00:${String(ledger).padStart(2, "0")}:00Z`,
    contractId: "C" + "A".repeat(55),
    name,
    streamId,
    data,
  };
}

function history(): DecodedEvent[] {
  return [
    decoded("ev-10", 10, "stream_created", {
      sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: "1000",
      start_time: "1704067200", end_time: "1704153600", cancelable: true,
    }),
    decoded("ev-11", 11, "withdrawn", { recipient: RECIPIENT, amount: "100", withdrawn_total: "100" }),
    decoded("ev-12", 12, "stream_topped_up", { sender: SENDER, amount: "500", new_deposit: "1500" }),
    decoded("ev-14", 14, "stream_cancelled", { cancelled_by: SENDER, recipient_amount: "300", sender_amount: "700" }),
  ];
}

function ingestAll(store: StreamStore, events: readonly DecodedEvent[]): void {
  for (const event of events) store.ingest(event);
}

test("regions report monotonic watermarks and expose the consistency-lag metric", () => {
  const tracker = new RegionWatermarkTracker([
    { id: "us-east", priority: 1 },
    { id: "eu-west", priority: 2 },
    { id: "ap-south", priority: 3 },
  ]);
  tracker.report("us-east", 100);
  tracker.report("eu-west", 97);
  tracker.report("ap-south", 90);

  assert.equal(tracker.tip(), 100);
  assert.deepEqual(tracker.lags(), { "ap-south": 10, "eu-west": 3, "us-east": 0 });
  assert.equal(tracker.maxLag(), 10);

  // A late/duplicate report never rewinds a region.
  assert.equal(tracker.report("us-east", 95).watermark, 100);

  const metrics = tracker.renderMetrics();
  assert.match(metrics, /^streampay_region_ledger_watermark\{region="us-east"\} 100$/m);
  assert.match(metrics, /^streampay_region_consistency_lag_ledgers\{region="eu-west"\} 3$/m);
  assert.match(metrics, /^streampay_region_healthy\{region="ap-south"\} 1$/m);
  tracker.markUnhealthy("ap-south");
  assert.match(tracker.renderMetrics(), /^streampay_region_healthy\{region="ap-south"\} 0$/m);
  assert.equal(tracker.tip(), 100, "health gates eligibility, not the tip the lag is measured against");
});

test("reads go to the freshest healthy region, deterministically", () => {
  const tracker = new RegionWatermarkTracker([
    { id: "us-east", priority: 1, endpoint: "https://use.streampay.test" },
    { id: "eu-west", priority: 2, endpoint: "https://euw.streampay.test" },
    { id: "ap-south", priority: 3 },
  ]);
  tracker.report("us-east", 100);
  tracker.report("eu-west", 99);
  tracker.report("ap-south", 80);
  const router = new FreshnessReadRouter(tracker, { maxLagLedgers: 5 });

  assert.equal(router.route().regionId, "us-east");
  assert.equal(router.route().endpoint, "https://use.streampay.test");

  // Equal freshness ties break on configured priority, not on insertion order.
  tracker.report("eu-west", 100);
  assert.equal(router.route().regionId, "us-east");

  // Region loss: the unhealthy region is skipped, the next-freshest takes over.
  tracker.markUnhealthy("us-east");
  assert.equal(router.route().regionId, "eu-west");

  // A read that must see ledger 100 is never routed to the lagging region.
  assert.equal(router.routeFor(100).regionId, "eu-west");
  tracker.markUnhealthy("eu-west");
  assert.throws(() => router.route(), NoFreshRegionError, "no fresh region means fail closed, not a stale read");
});

test("active-active regions converge once each folds the same journal", () => {
  const east = newStore();
  const west = newStore();
  const events = history();
  // East receives the topped-up event before the withdrawn one, so the
  // monotonic guard drops the late withdrawal there.
  ingestAll(east, [events[0], events[2], events[1], events[3]]);
  ingestAll(west, events);

  const before = compareRegions([
    { regionId: "us-east", streams: east.listAllStreams(), watermark: 14 },
    { regionId: "eu-west", streams: west.listAllStreams(), watermark: 14 },
  ]);
  assert.equal(before.converged, false);
  assert.deepEqual(before.divergentStreams, ["1"]);
  assert.equal(east.getStream("1")!.withdrawn, "300");
  assert.equal(west.getStream("1")!.withdrawn, "400");

  // The late event is still journalled, so the fold recovers it deterministically.
  const folded = foldStream(east, "1")!;
  assert.equal(folded.withdrawn, "400");
  assert.deepEqual(foldStream(west, "1"), folded);

  const repair = reconcileRegion(east);
  assert.deepEqual(repair.repaired, ["1"]);

  const after = compareRegions([
    { regionId: "us-east", streams: east.listAllStreams(), watermark: 14 },
    { regionId: "eu-west", streams: west.listAllStreams(), watermark: 14 },
  ]);
  assert.equal(after.converged, true);
  assert.deepEqual(after.divergentStreams, []);
  assert.equal(after.roots["us-east"], after.roots["eu-west"]);
  assert.equal(after.roots["us-east"], projectionRoot(west.listAllStreams()));
  assert.equal(after.maxWatermarkSkew, 0);

  // Re-running the repair is a no-op: convergence is a fixed point.
  assert.deepEqual(reconcileRegion(east).repaired, []);
});

test("a region that dies mid-ingest loses nothing it committed; reads follow the fresh survivor", () => {
  const survivor = newStore();
  const lost = newStore();
  const events = history();
  ingestAll(survivor, events);
  ingestAll(lost, events.slice(0, 3));

  const tracker = new RegionWatermarkTracker([
    { id: "us-east", priority: 1 },
    { id: "eu-west", priority: 2 },
  ]);
  tracker.report("us-east", 12);
  tracker.report("eu-west", 14);
  tracker.markUnhealthy("us-east");
  const router = new FreshnessReadRouter(tracker, { maxLagLedgers: 5 });

  // Read-your-writes routing: only the survivor has ledger 14.
  assert.equal(router.routeFor(14).regionId, "eu-west");
  assert.equal(survivor.getStream("1")!.status, "cancelled");
  assert.equal(survivor.listAllStreams().length, 1);

  // The survived region's projection is the full history: nothing committed was
  // lost with the other region.
  assert.deepEqual(reconcileRegion(survivor).repaired, []);
  const report = compareRegions([
    { regionId: "us-east", streams: lost.listAllStreams(), watermark: 12 },
    { regionId: "eu-west", streams: survivor.listAllStreams(), watermark: 14 },
  ]);
  assert.equal(report.converged, false, "the dead region is behind until it catches up");
  assert.deepEqual(report.divergentStreams, ["1"]);
  assert.equal(report.maxWatermarkSkew, 2);
});

test("one fenced delivery leader per subscription: failover never duplicates a webhook", () => {
  const store = newStore();
  store.outbox.createConsumer({ id: "sub-1", kind: "push", url: "https://hooks.streampay.test/events" });
  for (let i = 0; i < 5; i++) {
    store.ingest(decoded(`ev-${100 + i}`, 100 + i, "withdrawn", { recipient: RECIPIENT, amount: "1", withdrawn_total: String(i + 1) }));
  }

  let clock = Date.now();
  const elector = new DeliveryLeaderElector(store.db, { leaseMs: 1_000, now: () => clock });
  const delivered: string[] = [];
  const dispatch = (lease: DeliveryLease, limit: number): void => {
    for (const intentId of store.outbox.dueIntents("sub-1", limit, clock)) {
      elector.assertLeader(lease);
      const token = store.outbox.claimToken();
      const intent = store.outbox.claimIntent(intentId, token, clock);
      if (!intent) continue;
      delivered.push(intent.event_id);
      assert.equal(store.outbox.markDelivered(intentId, token), true);
    }
  };

  const east = elector.acquire("sub-1", "us-east")!;
  assert.equal(east.epoch, 1);
  assert.equal(elector.acquire("sub-1", "eu-west"), null, "a live lease is not stealable");
  dispatch(east, 2);
  assert.equal(delivered.length, 2);
  assert.equal(elector.renew(east), true);

  // The east region stalls past its lease; west takes over with a new epoch.
  clock += 2_000;
  const west = elector.acquire("sub-1", "eu-west")!;
  assert.equal(west.epoch, 2);
  assert.equal(elector.isLeader(east), false);
  assert.throws(() => dispatch(east, 10), LeaseLostError, "the stale leader is fenced out");
  dispatch(west, 10);

  assert.equal(delivered.length, 5, "exactly the five events, each delivered once");
  assert.equal(new Set(delivered).size, 5);
  assert.equal(elector.renew(east), false);

  // A voluntary release hands leadership over immediately, at the next epoch.
  assert.equal(elector.release(west), true);
  const next = elector.acquire("sub-1", "us-east")!;
  assert.equal(next.epoch, 3);
  assert.equal(elector.isLeader(next), true);
});
