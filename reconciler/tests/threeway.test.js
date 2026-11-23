import test from "node:test";
import assert from "node:assert/strict";
import { ThreeWayReconciler } from "../src/engine/threeway.js";
import { DivergenceSuppressor } from "../src/engine/suppression.js";

function state(streamId, options = {}) {
  return {
    streamId,
    ledger: options.ledger ?? 1000,
    timestamp: new Date(2026, 10, 21, 12, 0, 0).toISOString(),
    data: {
      deposit: options.deposit ?? "1000",
      withdrawn: options.withdrawn ?? "100",
      status: options.status ?? "Active",
    },
  };
}

function snapshot(source, states, options = {}) {
  return {
    source,
    available: options.available ?? true,
    asOfLedger: options.asOfLedger ?? 1000,
    fetchedAt: new Date(2026, 10, 21, 12, 0, 1).toISOString(),
    error: options.error,
    states,
  };
}

function reconcile({ rpc, horizon, projection, options = {} }) {
  const reconciler = new ThreeWayReconciler({
    tolerance: { absolute: 0, relativePpm: 0 },
    maxLagLedgers: 5,
    now: () => Date.parse("2026-11-21T12:00:02Z"),
    ...options,
  });
  return reconciler.reconcile({
    streamIds: options.streamIds ?? ["1"],
    asOfLedger: options.asOfLedger,
    snapshots: [rpc, horizon, projection].filter(Boolean),
  });
}

test("three agreeing sources produce a clean three-way verdict", () => {
  const shared = [state("1")];
  const report = reconcile({
    rpc: snapshot("rpc", shared),
    horizon: snapshot("horizon", shared),
    projection: snapshot("projection", shared),
  });
  assert.equal(report.mode, "three_way");
  assert.equal(report.verdict, "clean");
  assert.equal(report.clean, true);
  assert.equal(report.summary.inSync, 1);
  assert.equal(report.diagnoses.length, 0);
  assert.deepEqual(report.coverage.comparedSources, ["rpc", "horizon", "projection"]);
});

test("projection-only divergence is attributed to the projection layer", () => {
  const rpc = [state("1", { withdrawn: "500" })];
  const report = reconcile({
    rpc: snapshot("rpc", rpc),
    horizon: snapshot("horizon", rpc),
    projection: snapshot("projection", [state("1", { withdrawn: "200" })]),
  });
  assert.equal(report.verdict, "divergent");
  assert.equal(report.diagnoses.length, 1);
  const diagnosis = report.diagnoses[0];
  assert.equal(diagnosis.suspectedLayer, "projection");
  assert.equal(diagnosis.owner, "indexer-projection");
  assert.equal(diagnosis.checkType, "stream_balance");
  assert.deepEqual(diagnosis.disagreeingPairs, ["horizon↔projection", "rpc↔projection"]);
  assert.equal(diagnosis.confidence, "high");
  assert.equal(diagnosis.evidence.sources.projection.data.withdrawn, "200");
});

test("horizon-only divergence is attributed to the horizon chain read", () => {
  const agreed = [state("1", { deposit: "900" })];
  const report = reconcile({
    rpc: snapshot("rpc", agreed),
    horizon: snapshot("horizon", [state("1", { deposit: "1000" })]),
    projection: snapshot("projection", agreed),
  });
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0].suspectedLayer, "chain_read_horizon");
  assert.equal(report.diagnoses[0].owner, "horizon-operator");
});

test("rpc-only divergence is attributed to the rpc chain read", () => {
  const agreed = [state("1", { deposit: "900" })];
  const report = reconcile({
    rpc: snapshot("rpc", [state("1", { deposit: "1000" })]),
    horizon: snapshot("horizon", agreed),
    projection: snapshot("projection", agreed),
  });
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0].suspectedLayer, "chain_read_rpc");
  assert.equal(report.diagnoses[0].owner, "rpc-operator");
});

test("all three pairwise disagreements are routed to triage", () => {
  const report = reconcile({
    rpc: snapshot("rpc", [state("1", { withdrawn: "100" })]),
    horizon: snapshot("horizon", [state("1", { withdrawn: "200" })]),
    projection: snapshot("projection", [state("1", { withdrawn: "300" })]),
  });
  assert.equal(report.diagnoses.length, 1);
  const diagnosis = report.diagnoses[0];
  assert.equal(diagnosis.suspectedLayer, "unknown");
  assert.equal(diagnosis.owner, "on-call-triage");
  assert.deepEqual(diagnosis.disagreeingPairs, [
    "horizon↔projection",
    "rpc↔horizon",
    "rpc↔projection",
  ]);
  assert.equal(diagnosis.confidence, "low");
});

test("missing projection record with agreeing chain sources is an ingestion fault", () => {
  const shared = [state("1")];
  const report = reconcile({
    rpc: snapshot("rpc", shared),
    horizon: snapshot("horizon", shared),
    projection: snapshot("projection", []),
  });
  assert.equal(report.diagnoses.length, 1);
  const diagnosis = report.diagnoses[0];
  assert.equal(diagnosis.checkType, "missing_record");
  assert.equal(diagnosis.suspectedLayer, "ingestion");
  assert.equal(diagnosis.owner, "indexer-ingest");
  assert.equal(diagnosis.severity, "critical");
  assert.equal(diagnosis.evidence.sources.projection.present, false);
});

test("missing horizon record with agreeing rpc and projection is a horizon read fault", () => {
  const shared = [state("1")];
  const report = reconcile({
    rpc: snapshot("rpc", shared),
    horizon: snapshot("horizon", []),
    projection: snapshot("projection", shared),
  });
  assert.equal(report.diagnoses[0].suspectedLayer, "chain_read_horizon");
  assert.equal(report.diagnoses[0].severity, "warning");
});

test("rounding tolerance absorbs sub-threshold amount differences", () => {
  const report = reconcile({
    rpc: snapshot("rpc", [state("1", { withdrawn: "100" })]),
    horizon: snapshot("horizon", [state("1", { withdrawn: "100" })]),
    projection: snapshot("projection", [state("1", { withdrawn: "100.0000001" })]),
    options: { tolerance: { absolute: 2, relativePpm: 0 } },
  });
  assert.equal(report.verdict, "clean");
  assert.equal(report.summary.tolerated, 1);
  assert.equal(report.diagnoses.length, 0);
});

test("a small ledger lag is reported as within-lag, not a divergence", () => {
  const report = reconcile({
    rpc: snapshot("rpc", [state("1", { withdrawn: "500", ledger: 1000 })], { asOfLedger: 1000 }),
    horizon: snapshot("horizon", [state("1", { withdrawn: "400", ledger: 997 })], { asOfLedger: 997 }),
    projection: snapshot("projection", [state("1", { withdrawn: "500", ledger: 1000 })], { asOfLedger: 1000 }),
  });
  assert.equal(report.diagnoses.length, 0);
  assert.equal(report.summary.withinLag, 1);
  assert.equal(report.verdict, "clean");
});

test("a source far behind the pinned ledger is excluded and degrades the verdict", () => {
  const shared = [state("1")];
  const report = reconcile({
    rpc: snapshot("rpc", shared, { asOfLedger: 1000 }),
    horizon: snapshot("horizon", shared, { asOfLedger: 900 }),
    projection: snapshot("projection", shared, { asOfLedger: 1000 }),
  });
  assert.equal(report.mode, "degraded_two_way");
  assert.equal(report.clean, false);
  assert.equal(report.verdict, "clean_degraded");
  assert.ok(report.caveats.some((caveat) => caveat.includes("behind_as_of")));
  assert.deepEqual(report.coverage.comparedSources, ["rpc", "projection"]);
});

test("source-down degrades to two-way without claiming a clean bill", () => {
  const shared = [state("1")];
  const report = reconcile({
    rpc: snapshot("rpc", shared),
    horizon: snapshot("horizon", shared),
    projection: snapshot("projection", [], { available: false, error: "connection refused", asOfLedger: null }),
  });
  assert.equal(report.mode, "degraded_two_way");
  assert.equal(report.clean, false);
  assert.equal(report.verdict, "clean_degraded");
  assert.ok(report.caveats.some((caveat) => caveat.includes("Degraded to two-way")));
  assert.equal(report.diagnoses.length, 0);
});

test("two-way disagreement cannot be attributed and routes to triage", () => {
  const report = reconcile({
    rpc: snapshot("rpc", [state("1", { withdrawn: "500" })]),
    horizon: snapshot("horizon", [state("1", { withdrawn: "200" })]),
    projection: snapshot("projection", [], { available: false, asOfLedger: null }),
  });
  assert.equal(report.mode, "degraded_two_way");
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0].suspectedLayer, "unknown");
  assert.equal(report.diagnoses[0].owner, "on-call-triage");
  assert.equal(report.diagnoses[0].confidence, "low");
  assert.equal(report.clean, false);
});

test("fewer than two aligned sources never yields a clean verdict", () => {
  const report = reconcile({
    rpc: snapshot("rpc", [state("1")]),
    horizon: snapshot("horizon", [], { available: false, asOfLedger: null }),
    projection: snapshot("projection", [], { available: false, asOfLedger: null }),
  });
  assert.equal(report.mode, "insufficient_sources");
  assert.equal(report.verdict, "insufficient_coverage");
  assert.equal(report.clean, false);
  assert.equal(report.diagnoses.length, 0);
});

test("repeated diagnoses are suppressed during the cooldown and recorded", () => {
  let now = Date.parse("2026-11-21T12:00:00Z");
  const suppressor = new DivergenceSuppressor({
    cooldownMs: 60_000,
    now: () => now,
  });
  const reconciler = new ThreeWayReconciler({
    suppressor,
    now: () => now,
    tolerance: { absolute: 0, relativePpm: 0 },
  });
  const snapshots = [
    snapshot("rpc", [state("1", { withdrawn: "500" })]),
    snapshot("horizon", [state("1", { withdrawn: "500" })]),
    snapshot("projection", [state("1", { withdrawn: "200" })]),
  ];
  const first = reconciler.reconcile({ streamIds: ["1"], snapshots });
  now += 10_000;
  const second = reconciler.reconcile({ streamIds: ["1"], snapshots });
  assert.equal(first.diagnoses.length, 1);
  assert.equal(second.diagnoses.length, 0);
  assert.equal(second.suppressed.length, 1);
  assert.equal(second.suppressed[0].reason, "cooldown");
  assert.equal(second.verdict, "divergent");
  assert.equal(second.clean, false);
});

test("flapping divergences are suppressed after repeated clear/reappear cycles", () => {
  let now = Date.parse("2026-11-21T12:00:00Z");
  const suppressor = new DivergenceSuppressor({
    cooldownMs: 0,
    flapWindowMs: 60_000,
    flapThreshold: 2,
    now: () => now,
  });
  const reconciler = new ThreeWayReconciler({ suppressor, now: () => now });
  const bad = [
    snapshot("rpc", [state("1", { withdrawn: "500" })]),
    snapshot("horizon", [state("1", { withdrawn: "500" })]),
    snapshot("projection", [state("1", { withdrawn: "200" })]),
  ];
  const good = [
    snapshot("rpc", [state("1", { withdrawn: "500" })]),
    snapshot("horizon", [state("1", { withdrawn: "500" })]),
    snapshot("projection", [state("1", { withdrawn: "500" })]),
  ];
  reconciler.reconcile({ streamIds: ["1"], snapshots: bad });
  now += 1000;
  reconciler.reconcile({ streamIds: ["1"], snapshots: good });
  now += 1000;
  reconciler.reconcile({ streamIds: ["1"], snapshots: bad });
  now += 1000;
  reconciler.reconcile({ streamIds: ["1"], snapshots: good });
  now += 1000;
  const report = reconciler.reconcile({ streamIds: ["1"], snapshots: bad });
  assert.equal(report.diagnoses.length, 0);
  assert.equal(report.suppressed.length, 1);
  assert.equal(report.suppressed[0].reason, "flapping");
});
