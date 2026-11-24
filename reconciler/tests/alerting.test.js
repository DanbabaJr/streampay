import test from "node:test";
import assert from "node:assert/strict";
import { AlertingService, DivergenceAlertDedupe } from "../dist/alerting.js";
import { ReconciliationEngine } from "../dist/engine/diff.js";

const T0 = Date.parse("2026-11-24T12:00:00.000Z");

function divergence(streamId = "1", overrides = {}) {
  return {
    streamId,
    checkType: "stream_balance",
    severity: "critical",
    classification: "value_mismatch",
    indexedValue: { streamId, ledger: 1000, data: { deposit: "1000", withdrawn: "200", status: "Active" } },
    onChainValue: { streamId, ledger: 1000, data: { deposit: "1000", withdrawn: "500", status: "Active" } },
    horizonLagMs: 45_000,
    detectedAt: "2026-11-24T12:00:00.000Z",
    delta: "300",
    toleranceEpsilon: "1",
    ...overrides,
  };
}

function createService(dedupe = {}, metricsLogLevel = "ERROR") {
  let now = T0;
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    posts.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: "Alert delivered" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const alerting = new AlertingService({
    webhookUrl: "https://hooks.example.test/reconciler",
    consistencyWindowMs: 30_000,
    logLevel: metricsLogLevel,
    serviceName: "streampay-reconciler",
    environment: "testnet",
    reconcilerId: "test-001",
    dedupe: { confirmPasses: 2, resolvePasses: 2, reminderCadenceMs: 60_000, now: () => now, ...dedupe },
  });
  return {
    alerting,
    posts,
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("a persistent divergence alerts once, then only on the reminder cadence", async () => {
  const ctx = createService();
  try {
    // Pass 1: first observation, below the confirmation window.
    ctx.alerting.beginPass();
    let result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.match(result.message, /pending confirmation/);
    assert.equal(ctx.posts.length, 0);

    // Pass 2: it persisted, so it pages exactly once.
    ctx.alerting.beginPass();
    result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.equal(result.success, true);
    assert.equal(result.status, 200);
    assert.equal(ctx.posts.length, 1);
    assert.equal(ctx.posts[0].alert.type, "stream_divergence");

    // Pass 3: still diverging, no reminder due yet.
    ctx.alerting.beginPass();
    result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.match(result.message, /duplicate open divergence/);
    assert.equal(ctx.posts.length, 1);

    // Pass 4 after the reminder cadence: one reminder, same payload shape.
    ctx.advance(60_000);
    ctx.alerting.beginPass();
    result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.equal(result.status, 200);
    assert.equal(ctx.posts.length, 2);
    assert.deepEqual(ctx.posts[1], {
      ...ctx.posts[0],
      alert: { ...ctx.posts[0].alert, timestamp: ctx.posts[1].alert.timestamp },
    });

    const metrics = ctx.alerting.getMetrics();
    assert.equal(metrics.alertsEmittedCount, 2);
    assert.equal(metrics.alertsRemindedCount, 1);
    assert.equal(metrics.alertsSuppressedPendingCount, 1);
    assert.equal(metrics.alertsSuppressedDuplicateCount, 1);
    assert.equal(metrics.webhooksDispatchedCount, 2);
    assert.equal(metrics.realDivergenceCount, 4);
  } finally {
    ctx.restore();
  }
});

test("a flapping divergence never alerts", async () => {
  const ctx = createService({ confirmPasses: 2, resolvePasses: 2 });
  try {
    for (let pass = 0; pass < 12; pass++) {
      ctx.alerting.beginPass();
      if (pass % 2 === 0) {
        const result = await ctx.alerting.dispatchWebhook(divergence());
        assert.match(result.message, /pending confirmation/);
      }
      ctx.alerting.endPass();
      ctx.advance(5_000);
    }
    assert.equal(ctx.posts.length, 0);
    assert.equal(ctx.alerting.getMetrics().alertsEmittedCount, 0);
    assert.equal(ctx.alerting.getOpenDivergences().length, 0);
  } finally {
    ctx.restore();
  }
});

test("resolution clears state and a reopened divergence is a new alert", async () => {
  const ctx = createService({ confirmPasses: 2, resolvePasses: 2 });
  try {
    for (let pass = 0; pass < 2; pass++) {
      ctx.alerting.beginPass();
      await ctx.alerting.dispatchWebhook(divergence());
      ctx.alerting.endPass();
    }
    assert.equal(ctx.posts.length, 1);
    assert.equal(ctx.alerting.getOpenDivergences().length, 1);
    assert.equal(ctx.alerting.getOpenDivergences()[0].key, "1:stream_balance:value_mismatch");

    // One clean pass is not enough to resolve.
    ctx.alerting.beginPass();
    ctx.alerting.endPass();
    assert.equal(ctx.alerting.getOpenDivergences().length, 1);

    // The second clean pass resolves and drops the state.
    ctx.alerting.beginPass();
    ctx.alerting.endPass();
    assert.equal(ctx.alerting.getOpenDivergences().length, 0);

    // Reopened: it has to persist again, and then it pages as a fresh alert.
    ctx.alerting.beginPass();
    let result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.match(result.message, /pending confirmation/);
    assert.equal(ctx.posts.length, 1);

    ctx.alerting.beginPass();
    result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.equal(result.status, 200);
    assert.equal(ctx.posts.length, 2);

    const metrics = ctx.alerting.getMetrics();
    assert.equal(metrics.alertsEmittedCount, 2);
    assert.equal(metrics.alertsRemindedCount, 0);
  } finally {
    ctx.restore();
  }
});

test("confirmation and resolution windows are configurable", async () => {
  const ctx = createService({ confirmPasses: 4, resolvePasses: 3, reminderCadenceMs: 0 });
  try {
    for (let pass = 0; pass < 3; pass++) {
      ctx.alerting.beginPass();
      await ctx.alerting.dispatchWebhook(divergence());
      ctx.alerting.endPass();
    }
    assert.equal(ctx.posts.length, 0);

    ctx.alerting.beginPass();
    await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.equal(ctx.posts.length, 1);

    // Reminders disabled: it stays open and silent however long it persists.
    ctx.advance(3_600_000);
    ctx.alerting.beginPass();
    const result = await ctx.alerting.dispatchWebhook(divergence());
    ctx.alerting.endPass();
    assert.match(result.message, /duplicate open divergence/);
    assert.equal(ctx.posts.length, 1);

    // Two clean passes are not enough with resolvePasses = 3.
    for (let pass = 0; pass < 2; pass++) {
      ctx.alerting.beginPass();
      ctx.alerting.endPass();
    }
    assert.equal(ctx.alerting.getOpenDivergences().length, 1);

    ctx.alerting.beginPass();
    ctx.alerting.endPass();
    assert.equal(ctx.alerting.getOpenDivergences().length, 0);
  } finally {
    ctx.restore();
  }
});

test("state is per stream and per divergence key", async () => {
  const ctx = createService({ confirmPasses: 2, resolvePasses: 2, reminderCadenceMs: 0 });
  try {
    for (let pass = 0; pass < 2; pass++) {
      ctx.alerting.beginPass();
      await ctx.alerting.dispatchWebhook(divergence("1"));
      await ctx.alerting.dispatchWebhook(divergence("2"));
      await ctx.alerting.dispatchWebhook(divergence("1", { checkType: "stream_status", classification: "status_mismatch" }));
      ctx.alerting.endPass();
    }
    assert.equal(ctx.posts.length, 3);
    assert.deepEqual(
      ctx.alerting.getOpenDivergences().map((entry) => entry.key).sort(),
      [
        "1:stream_balance:value_mismatch",
        "1:stream_status:status_mismatch",
        "2:stream_balance:value_mismatch",
      ]
    );

    // Resolving stream 1's balance divergence leaves the other keys open.
    for (let pass = 0; pass < 2; pass++) {
      ctx.alerting.beginPass();
      await ctx.alerting.dispatchWebhook(divergence("2"));
      await ctx.alerting.dispatchWebhook(divergence("1", { checkType: "stream_status", classification: "status_mismatch" }));
      ctx.alerting.endPass();
    }
    assert.deepEqual(
      ctx.alerting.getOpenDivergences().map((entry) => entry.key).sort(),
      ["1:stream_status:status_mismatch", "2:stream_balance:value_mismatch"]
    );
  } finally {
    ctx.restore();
  }
});

test("the webhook payload shape is unchanged by de-duplication", async () => {
  const ctx = createService({ confirmPasses: 1, resolvePasses: 1, reminderCadenceMs: 0 });
  try {
    const record = divergence("777");
    ctx.alerting.beginPass();
    await ctx.alerting.dispatchWebhook(record);
    ctx.alerting.endPass();

    assert.equal(ctx.posts.length, 1);
    assert.deepEqual(ctx.posts[0], {
      alert: {
        type: "stream_divergence",
        severity: "critical",
        timestamp: record.detectedAt,
        source: "reconciler",
        data: {
          streamId: "777",
          divergenceType: "stream_balance",
          classification: "value_mismatch",
          delta: "300",
          toleranceEpsilon: "1",
          horizonState: record.indexedValue,
          sorobanState: record.onChainValue,
          lagMs: 45_000,
          consequence: "balance_mismatch",
        },
      },
      metadata: {
        version: "1.0.0",
        environment: "testnet",
        reconcilerId: "test-001",
      },
    });
  } finally {
    ctx.restore();
  }
});

test("rounding within epsilon never enters the divergence state", async () => {
  const ctx = createService();
  try {
    for (let pass = 0; pass < 5; pass++) {
      ctx.alerting.beginPass();
      await ctx.alerting.dispatchWebhook(
        divergence("8", { severity: "warning", classification: "rounding_within_epsilon" })
      );
      ctx.alerting.endPass();
    }
    assert.equal(ctx.posts.length, 0);
    assert.equal(ctx.alerting.getOpenDivergences().length, 0);
    assert.equal(ctx.alerting.getMetrics().roundingWithinToleranceCount, 5);
  } finally {
    ctx.restore();
  }
});

test("the legacy reconciliation engine opens and closes one pass per cycle", async () => {
  const ctx = createService({ confirmPasses: 2, resolvePasses: 1, reminderCadenceMs: 0 });
  try {
    const engine = new ReconciliationEngine({
      consistencyWindowMs: 30_000,
      alertingService: ctx.alerting,
    });

    const state = (streamId, withdrawn, ledger) => ({
      streamId,
      ledger,
      timestamp: new Date(ctx.now - ledger * 1000).toISOString(),
      data: { deposit: "1000", withdrawn, status: "Active" },
    });

    const horizon = [state("5", "200", 90_000)];
    const soroban = [state("5", "500", 100_000)];

    ctx.advance(1_000);
    await engine.reconcile(horizon, soroban);
    assert.equal(ctx.posts.length, 0);

    ctx.advance(1_000);
    await engine.reconcile(horizon, soroban);
    assert.equal(ctx.posts.length, 1);

    ctx.advance(1_000);
    await engine.reconcile(horizon, soroban);
    assert.equal(ctx.posts.length, 1);

    // Agreement for one pass resolves the open divergence.
    await engine.reconcile(soroban, soroban);
    assert.equal(ctx.alerting.getOpenDivergences().length, 0);
  } finally {
    ctx.restore();
  }
});

test("the de-duplicator is usable on its own", () => {
  let now = T0;
  const dedupe = new DivergenceAlertDedupe({
    confirmPasses: 2,
    resolvePasses: 1,
    reminderCadenceMs: 0,
    now: () => now,
  });
  const record = divergence("9");

  dedupe.beginPass();
  assert.equal(dedupe.observe(record).action, "suppress");
  dedupe.endPass();

  dedupe.beginPass();
  const decision = dedupe.observe(record);
  assert.equal(decision.action, "alert");
  assert.equal(decision.reason, "new");
  dedupe.endPass();

  dedupe.beginPass();
  assert.equal(dedupe.observe(record).action, "suppress");
  dedupe.endPass();

  dedupe.beginPass();
  dedupe.endPass();
  assert.equal(dedupe.size(), 0);

  now += 1_000;
  dedupe.beginPass();
  assert.equal(dedupe.observe(record).action, "suppress");
  dedupe.endPass();
  dedupe.beginPass();
  assert.equal(dedupe.observe(record).action, "alert");
});
