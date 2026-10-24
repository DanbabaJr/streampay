import test from "node:test";
import assert from "node:assert/strict";
import { ReconciliationEngine } from "../dist/engine/diff.js";

// Mock alerting service that captures logs and webhooks
class MockAlertingService {
  constructor() {
    this.logs = [];
    this.webhooks = [];
  }

  log(level, message, details) {
    this.logs.push({ level, message, details });
  }

  async dispatchWebhook(divergence) {
    this.webhooks.push({
      data: {
        alert: {
          type: "stream_divergence",
          severity: divergence.severity,
          timestamp: divergence.detectedAt,
          source: "reconciler",
          data: {
            streamId: divergence.streamId,
            divergenceType: divergence.checkType,
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