import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { ThreeWayReconciler } from "../src/engine/threeway.js";
import {
  HealGateError,
  ProposalStore,
  proposeHeals,
} from "../src/heal/proposals.js";
import { computeStateRoot } from "../src/heal/merkle.js";
import { previewScope, targetMap } from "../src/heal/dryrun.js";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";

function state(streamId, options = {}) {
  return {
    streamId,
    ledger: options.ledger ?? 1000,
    timestamp: "2026-11-21T12:00:00.000Z",
    data: {
      deposit: options.deposit ?? "1000",
      withdrawn: options.withdrawn ?? "500",
      status: options.status ?? "Active",
    },
  };
}

function snapshot(source, states, asOfLedger = 1000) {
  return {
    source,
    available: true,
    asOfLedger,
    fetchedAt: "2026-11-21T12:00:01.000Z",
    states,
  };
}

function projectionRecord(streamId, options = {}) {
  return state(streamId, options);
}

function buildReport(streamIds = ["1"]) {
  const chain = streamIds.map((id) => state(id, { withdrawn: "500" }));
  const projection = streamIds.map((id) => state(id, { withdrawn: "200" }));
  const reconciler = new ThreeWayReconciler({
    now: () => Date.parse("2026-11-21T12:00:02Z"),
    tolerance: { absolute: 0, relativePpm: 0 },
  });
  return reconciler.reconcile({
    streamIds,
    snapshots: [
      snapshot("rpc", chain),
      snapshot("horizon", chain),
      snapshot("projection", projection),
    ],
  });
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey,
  };
}

function approvalFor(proposal, signer, pair, at) {
  return {
    signer,
    publicKey: pair.publicKey,
    proposalHash: proposal.hash,
    signature: sign(null, Buffer.from(proposal.hash, "utf8"), pair.privateKey).toString("base64"),
    at,
  };
}

function setup(streamIds = ["1"]) {
  let now = Date.parse("2026-11-21T12:00:10Z");
  const events = [];
  const alice = keypair();
  const bob = keypair();
  const store = new ProposalStore({
    now: () => now,
    timelockMs: 60_000,
    ttlMs: 3_600_000,
    requiredSignatures: 2,
    governanceSigners: { alice: alice.publicKey, bob: bob.publicKey },
    maxScope: 25,
    onEvent: (event, proposal) => events.push({ event, id: proposal.id }),
  });
  const records = streamIds.flatMap((id) => [
    projectionRecord(id, { withdrawn: "200" }),
  ]);
  const report = buildReport(streamIds);
  return {
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
    },
    store,
    events,
    alice,
    bob,
    records,
    report,
  };
}

test("a projection divergence produces a scoped rebuild proposal with a dry-run preview", () => {
  const context = setup();
  const { proposals, skipped } = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  });
  assert.equal(skipped.length, 0);
  assert.equal(proposals.length, 1);
  const proposal = proposals[0];
  assert.equal(proposal.action.type, "rebuild_record");
  assert.deepEqual(proposal.action.scope.streamIds, ["1"]);
  assert.equal(proposal.dryRun.changes.length, 1);
  assert.equal(proposal.dryRun.changes[0].before.data.withdrawn, "200");
  assert.equal(proposal.dryRun.changes[0].after.data.withdrawn, "500");
  assert.notEqual(proposal.dryRun.beforeRoot, proposal.dryRun.afterRoot);
  assert.equal(proposal.status, "proposed");
  assert.ok(context.events.some((event) => event.event === "proposal.created"));
});

test("proposals are deduplicated per open divergence", () => {
  const context = setup();
  const first = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  });
  const second = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  });
  assert.equal(context.store.list().length, 1);
  assert.equal(first.proposals[0].id, second.proposals[0].id);
});

test("chain-read and ambiguous layers never generate a heal proposal", () => {
  const chain = [state("1")];
  const reconciler = new ThreeWayReconciler({
    now: () => Date.parse("2026-11-21T12:00:02Z"),
  });
  const report = reconciler.reconcile({
    streamIds: ["1"],
    snapshots: [
      snapshot("rpc", [state("1", { withdrawn: "999" })]),
      snapshot("horizon", chain),
      snapshot("projection", chain),
    ],
  });
  assert.equal(report.diagnoses[0].suspectedLayer, "chain_read_rpc");
  const store = new ProposalStore({ now: () => Date.parse("2026-11-21T12:00:10Z") });
  const result = proposeHeals({ report, records: [projectionRecord("1")], store, contractId: CONTRACT });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.skipped[0].reason, "no_safe_heal_for_layer");
});

test("degraded mode fails closed and generates no proposals", () => {
  const reconciler = new ThreeWayReconciler({ now: () => Date.parse("2026-11-21T12:00:02Z") });
  const report = reconciler.reconcile({
    streamIds: ["1"],
    snapshots: [
      snapshot("rpc", [state("1", { withdrawn: "500" })]),
      snapshot("horizon", [state("1", { withdrawn: "200" })]),
      { source: "projection", available: false, asOfLedger: null, states: [] },
    ],
  });
  const store = new ProposalStore({ now: () => 1 });
  const result = proposeHeals({ report, records: [projectionRecord("1")], store, contractId: CONTRACT });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.skipped[0].reason, "degraded_mode_fail_closed");
});

test("an unapproved proposal can never execute", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.advance(60_000);
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: context.records,
      writeRecord: async () => {},
      at: context.now,
    }),
    (error) => error instanceof HealGateError && error.code === "NOT_APPROVED"
  );
});

test("the governance timelock blocks early execution", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  assert.equal(context.store.get(proposal.id).status, "approved");
  context.advance(30_000);
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: context.records,
      writeRecord: async () => {},
      at: context.now,
    }),
    (error) => error instanceof HealGateError && error.code === "TIMELOCK_ACTIVE"
  );
});

test("forged, duplicate and unauthorized approvals are rejected", () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];

  const mallory = keypair();
  assert.throws(
    () => context.store.approve(proposal.id, approvalFor(proposal, "alice", mallory, context.now)),
    (error) => error.code === "INVALID_SIGNATURE"
  );
  assert.throws(
    () => context.store.approve(proposal.id, {
      ...approvalFor(proposal, "alice", context.alice, context.now),
      proposalHash: "00".repeat(32),
    }),
    (error) => error.code === "HASH_MISMATCH"
  );
  assert.throws(
    () => context.store.approve(proposal.id, approvalFor(proposal, "mallory", mallory, context.now)),
    (error) => error.code === "UNAUTHORIZED_SIGNER"
  );

  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  assert.throws(
    () => context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now)),
    (error) => error.code === "DUPLICATE_SIGNER"
  );
});

test("an expired proposal never executes, even with valid approvals", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  context.now = Date.parse(proposal.expiresAt) + 1000;
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: context.records,
      writeRecord: async () => {},
      at: context.now,
    }),
    (error) => error.code === "EXPIRED"
  );
  assert.equal(context.store.get(proposal.id).status, "expired");
});

test("a veto prevents execution", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  context.store.veto(proposal.id, { signer: "alice", at: context.now });
  context.advance(60_000);
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: context.records,
      writeRecord: async () => {},
      at: context.now,
    }),
    (error) => error.code === "VETOED"
  );
});

test("execution is scoped, reproduces the dry-run root, and logs before/after roots", async () => {
  const context = setup(["1", "2"]);
  const unrelated = projectionRecord("99", { withdrawn: "7" });
  const records = [...context.records, unrelated];
  const proposal = proposeHeals({
    report: context.report,
    records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));

  const written = new Map(records.map((record) => [record.streamId, record]));
  context.advance(60_000);
  const result = await context.store.execute(proposal.id, {
    records,
    writeRecord: async (after) => written.set(after.streamId, after),
    at: context.now,
  });

  assert.equal(result.executed, true);
  assert.equal(result.beforeRoot, proposal.dryRun.beforeRoot);
  assert.equal(result.afterRoot, proposal.dryRun.afterRoot);
  assert.equal(written.get("1").data.withdrawn, "500");
  assert.equal(written.get("2").data.withdrawn, "200");
  assert.equal(written.get("99").data.withdrawn, "7");

  const manual = new Map(records.map((record) => [record.streamId, record]));
  for (const change of proposal.dryRun.changes) manual.set(change.streamId, change.after);
  assert.equal(
    computeStateRoot([...manual.values()], CONTRACT),
    proposal.dryRun.afterRoot
  );

  const executedAudit = context.store.get(proposal.id).audit.find((entry) => entry.event === "executed");
  assert.equal(executedAudit.beforeRoot, proposal.dryRun.beforeRoot);
  assert.equal(executedAudit.afterRoot, proposal.dryRun.afterRoot);
  assert.deepEqual(executedAudit.governanceAction.approvals, ["alice", "bob"]);
  assert.ok(context.events.some((event) => event.event === "proposal.executed"));
});

test("re-executing an executed proposal is a no-op", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  let writes = 0;
  context.advance(60_000);
  await context.store.execute(proposal.id, {
    records: context.records,
    writeRecord: async () => { writes += 1; },
    at: context.now,
  });
  const retry = await context.store.execute(proposal.id, {
    records: context.records,
    writeRecord: async () => { writes += 1; },
    at: context.now,
  });
  assert.equal(retry.executed, false);
  assert.equal(retry.idempotent, true);
  assert.equal(writes, 1);
});

test("a stale dry run is rejected instead of overwriting newer projection state", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  const moved = [projectionRecord("1", { withdrawn: "350" })];
  context.advance(60_000);
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: moved,
      writeRecord: async () => {},
      at: context.now,
    }),
    (error) => error.code === "STALE_PREVIEW"
  );
});

test("tampered approvals are re-verified at execution time", async () => {
  const context = setup();
  const proposal = proposeHeals({
    report: context.report,
    records: context.records,
    store: context.store,
    contractId: CONTRACT,
  }).proposals[0];
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  const stored = context.store.get(proposal.id);
  stored.governance.approvals[0].signature = Buffer.from("forged").toString("base64");
  context.advance(60_000);
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: context.records,
      writeRecord: async () => {},
      at: context.now,
    }),
    (error) => error.code === "INVALID_SIGNATURE"
  );
});

test("a partially failed execution resumes without rewriting checkpointed records", async () => {
  const context = setup(["1", "2"]);
  const scope = { streamIds: ["1", "2"] };
  const preview = previewScope({
    records: context.records,
    targets: targetMap([
      state("1", { withdrawn: "500" }),
      state("2", { withdrawn: "500" }),
    ]),
    scope,
    contractId: CONTRACT,
  });
  const proposal = context.store.propose({
    diagnosis: { id: "combined-divergence", recordId: "1", checkType: "stream_balance" },
    action: { type: "rebuild_record", scope, reason: "test" },
    dryRun: preview,
    contractId: CONTRACT,
  });
  assert.equal(proposal.dryRun.changes.length, 2);
  context.store.approve(proposal.id, approvalFor(proposal, "alice", context.alice, context.now));
  context.store.approve(proposal.id, approvalFor(proposal, "bob", context.bob, context.now));
  context.advance(60_000);

  const writes = [];
  await assert.rejects(
    context.store.execute(proposal.id, {
      records: context.records,
      writeRecord: async (after) => {
        if (after.streamId === "2") throw new Error("projection write failed");
        writes.push(after.streamId);
      },
      at: context.now,
    }),
    /projection write failed/
  );
  assert.deepEqual(writes, ["1"]);
  assert.equal(context.store.get(proposal.id).status, "executing");

  const resumed = await context.store.execute(proposal.id, {
    records: context.records,
    writeRecord: async (after) => { writes.push(after.streamId); },
    at: context.now,
  });
  assert.equal(resumed.executed, true);
  assert.deepEqual(writes, ["1", "2"]);
  assert.equal(resumed.afterRoot, proposal.dryRun.afterRoot);
});

test("preview refuses to change records outside the declared scope", () => {
  const targets = new Map([
    ["1", state("1", { withdrawn: "500" })],
    ["2", state("2", { withdrawn: "500" })],
  ]);
  const preview = previewScope({
    records: [
      projectionRecord("1", { withdrawn: "200" }),
      projectionRecord("2", { withdrawn: "200" }),
    ],
    targets,
    scope: { streamIds: ["1"] },
    contractId: CONTRACT,
  });
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].streamId, "1");
  assert.equal(preview.changes[0].after.data.withdrawn, "500");

  const store = new ProposalStore({ now: () => 1 });
  assert.throws(
    () => store.propose({
      diagnosis: { id: "d1", recordId: "1" },
      action: { type: "rebuild_record", scope: { streamIds: ["1"] } },
      dryRun: {
        ...preview,
        changes: [{ ...preview.changes[0], streamId: "2" }],
      },
      contractId: CONTRACT,
    }),
    (error) => error.code === "SCOPE_VIOLATION"
  );
});

test("targetMap accepts arrays, maps and objects", () => {
  const fromArray = targetMap([state("1")]);
  assert.equal(fromArray.get("1").streamId, "1");
  const fromObject = targetMap({ 1: state("1") });
  assert.equal(fromObject.get("1").streamId, "1");
});
