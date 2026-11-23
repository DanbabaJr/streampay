import test from "node:test";
import assert from "node:assert/strict";
import {
  ReconciliationEngine,
  calculateAccrualFloorEpsilon,
  computeAmountDiff,
  parseAmountToBaseUnits,
} from "../dist/engine/diff.js";
import { AlertingService } from "../dist/alerting.js";

// Mock alerting service that captures logs and webhooks
class MockAlertingService {
  constructor() {
    this.logs = [];
    this.webhooks = [];
    this.roundings = [];
  }

  log(level, message, details) {
    this.logs.push({ level, message, details });
  }

  recordRounding(divergence) {
    this.roundings.push(divergence);
  }

  async dispatchWebhook(divergence) {
    this.webhooks.push({
      data: {
        alert: {
          type: "stream_divergence",
          severity: divergence.severity,
          classification: divergence.classification,
          timestamp: divergence.detectedAt,
          source: "reconciler",
          data: {
            streamId: divergence.streamId,
            divergenceType: divergence.checkType,
            classification: divergence.classification,
            horizonState: divergence.indexedValue,
            sorobanState: divergence.onChainValue,
          },
        },
        metadata: {
          version: "1.0.0",
          environment: "testnet",
          reconcilerId: "primary-001",
        },
      }
    });
    return { success: true, status: 200 };
  }
}

// Helper to create stream states
function createStreamState(streamId, options) {
  return {
    streamId,
    ledger: options.ledger ?? 100000,
    timestamp: new Date(Date.now() - (options.ledger ?? 100000) * 1000).toISOString(),
    data: {
      deposit: options.deposit ?? "1000",
      withdrawn: options.withdrawn ?? "100",
      status: options.status ?? "Active",
    },
  };
}

test("ReconciliationEngine detects perfectly in-sync states", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const stream1 = createStreamState("1", { deposit: "1000", withdrawn: "250" });
  const stream2 = createStreamState("2", { deposit: "5000", withdrawn: "1500" });

  const result = await engine.reconcile(
    [stream1, stream2],
    [stream1, stream2]
  );

  assert.equal(result.totalChecked, 2);
  assert.equal(result.inSync, 2);
  assert.equal(result.withinLagWindow, 0);
  assert.equal(result.divergences.length, 0);
});

test("ReconciliationEngine flags within-lag-window inconsistencies as non-divergent", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000, // 30 seconds
    alertingService: mockAlerting
  });

  const recentLedger = 100000;
  
  const horizonState = createStreamState("1", {
    deposit: "1000",
    withdrawn: "200",
    ledger: recentLedger,
  });

  // Soroban state is slightly newer (within lag window)
  const sorobanState = createStreamState("1", {
    deposit: "1000",
    withdrawn: "210", // Small difference
    ledger: recentLedger + 1,
  });

  const result = await engine.reconcile([horizonState], [sorobanState]);

  assert.equal(result.inSync, 0);
  assert.equal(result.withinLagWindow, 1);
  assert.equal(result.divergences.length, 0);
});

test("ReconciliationEngine detects true divergence outside lag window", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const oldLedger = 90000;
  const newLedger = 100000;

  // Horizon data is stale (100 ledgers = ~1.7 minutes on testnet)
  const horizonState = createStreamState("1", {
    deposit: "1000",
    withdrawn: "500",
    ledger: oldLedger,
  });

  // Soroban has current data but different values
  const sorobanState = createStreamState("1", {
    deposit: "1000",
    withdrawn: "200", // Significant difference
    ledger: newLedger,
  });

  const result = await engine.reconcile([horizonState], [sorobanState]);

  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].streamId, "1");
  assert.equal(result.divergences[0].checkType, "stream_balance");
  assert.equal(result.divergences[0].severity, "critical");
  assert.equal(result.divergences[0].indexedValue.data.withdrawn, "500");
  assert.equal(result.divergences[0].onChainValue.data.withdrawn, "200");
});

test("ReconciliationEngine triggers webhook on critical divergence", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const horizonState = createStreamState("42", {
    deposit: "1000",
    withdrawn: "1000",
    ledger: 90000,
  });

  const sorobanState = createStreamState("42", {
    deposit: "5000",
    withdrawn: "0",
    ledger: 100000,
  });

  await engine.reconcile([horizonState], [sorobanState]);

  // Webhook should have been dispatched
  assert.equal(mockAlerting.webhooks.length, 1);
  assert.equal(mockAlerting.webhooks[0].data.alert.type, "stream_divergence");
  assert.equal(mockAlerting.webhooks[0].data.alert.severity, "critical");
});

test("ReconciliationEngine handles missing stream (index corruption)", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const stream1 = createStreamState("1", { deposit: "1000", withdrawn: "100" });

  // Stream exists in Horizon but not in Soroban
  const result = await engine.reconcile([stream1], []);

  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].streamId, "1");
  assert.equal(result.divergences[0].checkType, "missing_record");
  assert.equal(result.divergences[0].severity, "critical");
  assert.equal(result.divergences[0].indexedValue.streamId, "1");
  assert.equal(result.divergences[0].onChainValue.streamId, "N/A");
});

test("ReconciliationEngine handles stream-only in Soroban (warning)", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const stream1 = createStreamState("1", { deposit: "1000", withdrawn: "100" });

  // Stream exists in Soroban but not in Horizon
  const result = await engine.reconcile([], [stream1]);

  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].streamId, "1");
  assert.equal(result.divergences[0].checkType, "missing_record");
  assert.equal(result.divergences[0].severity, "warning");
});

test("ReconciliationEngine handles malformed/missing deposit field", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  // One stream has different deposit values (with ledger gap to trigger divergence)
  const stream1 = createStreamState("1", { deposit: "1000", withdrawn: "100", ledger: 90000 });

  const sorobanStream = createStreamState("1", { deposit: "5000", ledger: 100000 });

  const result = await engine.reconcile([stream1], [sorobanStream]);

  // Should detect deposit mismatch as critical divergence
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].checkType, "stream_balance");
});

test("ReconciliationEngine handles status-only divergence", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const horizonStream = createStreamState("1", {
    deposit: "1000",
    withdrawn: "100",
    status: "Active",
    ledger: 90000,
  });

  const sorobanStream = createStreamState("1", {
    deposit: "1000",
    withdrawn: "100",
    status: "Cancelled",
    ledger: 100000,
  });

  const result = await engine.reconcile([horizonStream], [sorobanStream]);

  // Status mismatch should be detected
  assert.ok(result.divergences.length >= 1);
});

test("ReconciliationEngine reports correct ledger gap", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const stream1 = createStreamState("1", { ledger: 100000 });
  const stream2 = createStreamState("2", { ledger: 99000 });

  const result = await engine.reconcile([stream1, stream2], []);

  assert.ok(result.ledgerGap >= 999); // At least 1000 ledger gap
});

test("ReconciliationEngine produces structured logs", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting
  });

  const stream1 = createStreamState("1", { deposit: "100", withdrawn: "10" });
  const stream2 = createStreamState("1", { deposit: "100", withdrawn: "10" });

  await engine.reconcile([stream1], [stream2]);

  // Should have logged the reconciliation
  const summaryLog = mockAlerting.logs.find(l => l.message.includes("complete"));
  assert.ok(summaryLog, "Should have logged reconciliation summary");
  assert.ok(summaryLog.details.totalChecked === 1);
});

test("ReconciliationEngine classifies within-epsilon integer rounding as rounding_within_epsilon without webhook", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting,
  });

  // Past lag window (1000 ledgers difference) so time lag does not mask divergence
  const horizonState = createStreamState("10", {
    deposit: "1000",
    withdrawn: "100",
    ledger: 90000,
  });

  // Soroban state differs by 1 stroop (accrual floor error for discrete integer base units)
  const sorobanState = createStreamState("10", {
    deposit: "1000",
    withdrawn: "101",
    ledger: 100000,
  });

  const result = await engine.reconcile([horizonState], [sorobanState]);

  assert.equal(result.totalChecked, 1);
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].streamId, "10");
  assert.equal(result.divergences[0].checkType, "stream_balance");
  assert.equal(result.divergences[0].classification, "rounding_within_epsilon");
  assert.equal(result.divergences[0].severity, "warning");
  assert.equal(result.roundingWithinTolerance, 1);
  assert.equal(result.realDivergences, 0);

  // Crucial: Webhook MUST NOT be dispatched for rounding within epsilon
  assert.equal(mockAlerting.webhooks.length, 0);
  assert.equal(mockAlerting.roundings.length, 1);
  assert.equal(mockAlerting.roundings[0].classification, "rounding_within_epsilon");
});

test("ReconciliationEngine classifies within-epsilon decimal rounding as rounding_within_epsilon", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting,
    defaultDecimals: 7, // Standard Stellar Asset Contract 7 decimals
  });

  const horizonState = createStreamState("20", {
    deposit: "100.0000000",
    withdrawn: "50.0000000",
    ledger: 90000,
  });

  // Exactly 10^-7 (1 stroop) sub-ledger rounding difference between views
  const sorobanState = createStreamState("20", {
    deposit: "100.0000000",
    withdrawn: "50.0000001",
    ledger: 100000,
  });

  const result = await engine.reconcile([horizonState], [sorobanState]);

  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].classification, "rounding_within_epsilon");
  assert.equal(result.divergences[0].severity, "warning");
  assert.equal(result.roundingWithinTolerance, 1);
  assert.equal(result.realDivergences, 0);

  // No webhook dispatched
  assert.equal(mockAlerting.webhooks.length, 0);
  assert.equal(mockAlerting.roundings.length, 1);
});

test("ReconciliationEngine classifies beyond-epsilon difference as value_mismatch and triggers webhook", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting,
  });

  const horizonState = createStreamState("30", {
    deposit: "1000",
    withdrawn: "100",
    ledger: 90000,
  });

  // Differs by 2 stroops (> epsilon = 1), representing true conservation divergence
  const sorobanState = createStreamState("30", {
    deposit: "1000",
    withdrawn: "102",
    ledger: 100000,
  });

  const result = await engine.reconcile([horizonState], [sorobanState]);

  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].streamId, "30");
  assert.equal(result.divergences[0].classification, "value_mismatch");
  assert.equal(result.divergences[0].severity, "critical");
  assert.equal(result.roundingWithinTolerance, 0);
  assert.equal(result.realDivergences, 1);

  // True conservation divergence MUST dispatch webhook alert
  assert.equal(mockAlerting.webhooks.length, 1);
  assert.equal(mockAlerting.webhooks[0].data.alert.data.classification, "value_mismatch");
  assert.equal(mockAlerting.roundings.length, 0);
});

test("ReconciliationEngine classifies decimal beyond-epsilon difference as value_mismatch", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting,
    defaultDecimals: 7,
  });

  const horizonState = createStreamState("40", {
    deposit: "100.0000000",
    withdrawn: "50.0000000",
    ledger: 90000,
  });

  // Differs by 5 stroops (0.0000005 > 10^-7 = 0.0000001)
  const sorobanState = createStreamState("40", {
    deposit: "100.0000000",
    withdrawn: "50.0000005",
    ledger: 100000,
  });

  const result = await engine.reconcile([horizonState], [sorobanState]);

  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].classification, "value_mismatch");
  assert.equal(result.divergences[0].severity, "critical");
  assert.equal(result.roundingWithinTolerance, 0);
  assert.equal(result.realDivergences, 1);

  assert.equal(mockAlerting.webhooks.length, 1);
  assert.equal(mockAlerting.webhooks[0].data.alert.data.classification, "value_mismatch");
});

test("ReconciliationEngine handles mixed batches: exact, within-epsilon, and beyond-epsilon", async () => {
  const mockAlerting = new MockAlertingService();
  const engine = new ReconciliationEngine({
    consistencyWindowMs: 30000,
    alertingService: mockAlerting,
    defaultDecimals: 7,
  });

  const oldLedger = 90000;
  const newLedger = 100000;

  // Stream 1: Exact match
  const h1 = createStreamState("1", { deposit: "1000", withdrawn: "100", ledger: newLedger });
  const s1 = createStreamState("1", { deposit: "1000", withdrawn: "100", ledger: newLedger });

  // Stream 2: Within-epsilon decimal rounding difference (delta = 10^-7)
  const h2 = createStreamState("2", { deposit: "50.0000000", withdrawn: "10.0000000", ledger: oldLedger });
  const s2 = createStreamState("2", { deposit: "50.0000000", withdrawn: "10.0000001", ledger: newLedger });

  // Stream 3: Beyond-epsilon real divergence (delta = 50)
  const h3 = createStreamState("3", { deposit: "1000", withdrawn: "300", ledger: oldLedger });
  const s3 = createStreamState("3", { deposit: "1000", withdrawn: "350", ledger: newLedger });

  // Stream 4: Within-epsilon integer rounding difference (delta = 1 stroop)
  const h4 = createStreamState("4", { deposit: "5000", withdrawn: "1000", ledger: oldLedger });
  const s4 = createStreamState("4", { deposit: "5000", withdrawn: "1001", ledger: newLedger });

  const result = await engine.reconcile([h1, h2, h3, h4], [s1, s2, s3, s4]);

  assert.equal(result.totalChecked, 4);
  assert.equal(result.inSync, 1);
  assert.equal(result.withinLagWindow, 0);
  assert.equal(result.roundingWithinTolerance, 2);
  assert.equal(result.realDivergences, 1);
  assert.equal(result.divergences.length, 3);

  // Webhook is dispatched ONLY for Stream 3 (the real divergence)
  assert.equal(mockAlerting.webhooks.length, 1);
  assert.equal(mockAlerting.webhooks[0].data.alert.data.streamId, "3");
  assert.equal(mockAlerting.webhooks[0].data.alert.data.classification, "value_mismatch");

  // Roundings list contains both rounding cases
  assert.equal(mockAlerting.roundings.length, 2);
  const roundedStreamIds = mockAlerting.roundings.map(r => r.streamId).sort();
  assert.deepEqual(roundedStreamIds, ["2", "4"]);
});

test("AlertingService suppresses webhooks for rounding_within_epsilon and records metrics", async () => {
  const alerting = new AlertingService({
    consistencyWindowMs: 30000,
    logLevel: "ERROR",
    serviceName: "streampay-reconciler",
    environment: "testnet",
    reconcilerId: "test-001",
    // No webhookUrl needed because rounding is suppressed before dispatch
  });

  const roundingDivergence = {
    streamId: "99",
    checkType: "stream_balance",
    severity: "warning",
    classification: "rounding_within_epsilon",
    indexedValue: { withdrawn: "100" },
    onChainValue: { withdrawn: "101" },
    detectedAt: new Date().toISOString(),
    delta: "1",
    toleranceEpsilon: "1",
  };

  const dispatchResult = await alerting.dispatchWebhook(roundingDivergence);
  assert.equal(dispatchResult.success, true);
  assert.equal(dispatchResult.message, "Suppressed: rounding within epsilon");

  const metrics = alerting.getMetrics();
  assert.equal(metrics.roundingWithinToleranceCount, 1);
  assert.equal(metrics.realDivergenceCount, 0);
  assert.equal(metrics.webhooksDispatchedCount, 0);
});

test("calculateAccrualFloorEpsilon and parseAmountToBaseUnits accurately model floor semantics without magic constants", () => {
  // Standard Stellar Asset Contract (7 decimals): epsilon is 1 stroop (10^-7 tokens)
  const epsSac = calculateAccrualFloorEpsilon(7, 1);
  assert.equal(epsSac, 1n);

  // Asset with 2 decimals (e.g. fiat cents): epsilon is 1 cent
  const epsCents = calculateAccrualFloorEpsilon(2, 1);
  assert.equal(epsCents, 1n);

  // Decimal parsing matches integer base units
  const parsed1 = parseAmountToBaseUnits("100.0000001", 7);
  const parsed2 = parseAmountToBaseUnits("100.0000000", 7);
  assert.equal(parsed1 - parsed2, 1n);

  const diff = computeAmountDiff("100.0000000", "100.0000001", 7);
  assert.equal(diff, 1n);
});