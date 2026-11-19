//! Service entrypoint for the dual-read reconciliation daemon.
//! Orchestrates Horizon + Soroban readers, diff engine, and alerting.

import { ReconciliationEngine } from "./engine/diff.js";
import { HorizonReader } from "./readers/horizon.js";
import { SorobanRpcReader } from "./readers/soroban.js";
import { AlertingService } from "./alerting.js";
import type { StreamState } from "./types.js";

const SERVICE_NAME = "streampay-reconciler";

// Parse configuration from environment
function loadConfig(): {
  horizonUrl: string;
  sorobanRpcUrl: string;
  webhookUrl?: string;
  consistencyWindowMs: number;
  pollIntervalMs: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  contractId?: string;
  environment: string;
  reconcilerId: string;
} {
  const logLevel = (process.env.LOG_LEVEL || "INFO") as "DEBUG" | "INFO" | "WARN" | "ERROR";
  const consistencyWindowMs = parseInt(process.env.CONSISTENCY_WINDOW_MS || "30000", 10);
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
  const environment = process.env.ENVIRONMENT || "testnet";
  const reconcilerId = process.env.RECONCILER_ID || "primary-001";

  return {
    horizonUrl: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org/rpc",
    webhookUrl: process.env.WEBHOOK_URL || undefined,
    consistencyWindowMs,
    pollIntervalMs,
    logLevel,
    contractId: process.env.CONTRACT_ID,
    environment,
    reconcilerId,
  };
}

/**
 * Get the list of stream IDs to monitor.
 * In production, this would come from the indexer dashboard or a config file.
 */
function getMonitoredStreamIds(): string[] {
  const ids = process.env.STREAM_IDS;
  if (!ids) return [];
  return ids.split(",").map(id => id.trim()).filter(Boolean);
}

export async function createReconcilerService() {
  const config = loadConfig();

  // Validate required config
  if (!config.horizonUrl) {
    throw new Error("HORIZON_URL is required");
  }
  if (!config.sorobanRpcUrl) {
    throw new Error("SOROBAN_RPC_URL is required");
  }

  // Initialize readers
  const horizonReader = new HorizonReader({
    url: config.horizonUrl,
    token: process.env.HORIZON_API_TOKEN || undefined,
    pollIntervalMs: config.pollIntervalMs,
  });

  const sorobanReader = new SorobanRpcReader({
    url: config.sorobanRpcUrl,
    token: process.env.SOROBAN_RPC_TOKEN || undefined,
    pollIntervalMs: config.pollIntervalMs,
    contractId: config.contractId || "unknown",
  });

  // Initialize alerting service
  const alerting = new AlertingService({
    webhookUrl: config.webhookUrl,
    consistencyWindowMs: config.consistencyWindowMs,
    logLevel: config.logLevel,
    serviceName: SERVICE_NAME,
    environment: config.environment,
    reconcilerId: config.reconcilerId,
  });

  // Initialize reconciliation engine
  const engine = new ReconciliationEngine({
    consistencyWindowMs: config.consistencyWindowMs,
    alertingService: alerting,
  });

  // Health check both readers on startup
  const [hHealth, sHealth] = await Promise.all([
    horizonReader.healthCheck(),
    sorobanReader.healthCheck(),
  ]);

  alerting.log("INFO", "Reconciler service starting", {
    horizonHealthy: hHealth.healthy,
    sorobanHealthy: sHealth.healthy,
    horizonError: hHealth.error,
    sorobanError: sHealth.error,
    consistencyWindowMs: config.consistencyWindowMs,
    pollIntervalMs: config.pollIntervalMs,
    environment: config.environment,
    reconcilerId: config.reconcilerId,
    monitoredStreams: getMonitoredStreamIds().length,
  });

  return {
    horizonReader,
    sorobanReader,
    engine,
    alerting,
    config,
  };
}

/**
 * Run a single reconciliation cycle (useful for testing or manual invocation).
 */
export async function runCycle(
  horizonReader: HorizonReader,
  sorobanReader: SorobanRpcReader,
  engine: ReconciliationEngine,
  alerting: AlertingService,
  streamIds: string[]
): Promise<void> {
  const [horizonStates, sorobanStates] = await Promise.all([
    horizonReader.pollStreams(streamIds),
    sorobanReader.pollStreams(streamIds),
  ]);

  const result = await engine.reconcile(horizonStates, sorobanStates);

  alerting.log("INFO", "Reconciliation cycle complete", {
    totalChecked: result.totalChecked,
    inSync: result.inSync,
    withinLagWindow: result.withinLagWindow,
    divergences: result.divergences.length,
    ledgerGap: result.ledgerGap,
    timestamp: result.timestamp,
  });

  return result;
}

// Entrypoint when run directly
if (process.argv[1]?.endsWith("index.js")) {
  (async () => {
    try {
      const service = await createReconcilerService();
      const streamIds = getMonitoredStreamIds();

      alerting: service.alerting.log("INFO", "Reconciler service ready", {
        monitoredStreams: streamIds.length,
      });

      // Start continuous reconciliation
      await service.engine.startContinuousReconciliation(
        service.horizonReader,
        service.sorobanReader,
        streamIds,
        {
          initialDelayMs: 1000,
          healthCheckIntervalMs: 30000,
        }
      );
    } catch (err) {
      console.error("[streampay-reconciler] Fatal error:", err);
      process.exit(1);
    }
  })();
}

export type { StreamState };