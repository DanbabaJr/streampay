//! Service entrypoint for the reconciliation daemon.
//! Runs a pinned three-way comparison across Soroban RPC, Horizon and the
//! indexer projection, and can emit governance-gated heal proposals.

import { ReconciliationEngine } from "./engine/diff.js";
import { ThreeWayReconciler } from "./engine/threeway.js";
import { DivergenceSuppressor } from "./engine/suppression.js";
import { HorizonReader } from "./readers/horizon.js";
import { SorobanRpcReader } from "./readers/soroban.js";
import { ProjectionReader } from "./readers/projection.js";
import { AlertingService } from "./alerting.js";
import {
  collectPinnedSnapshots,
  horizonAdapter,
  projectionAdapter,
  rpcAdapter,
} from "./sources/pinned.js";
import { ProposalStore, proposeHeals } from "./heal/proposals.js";
import type { StreamState, ReconciliationResult } from "./types.js";

const SERVICE_NAME = "streampay-reconciler";

export interface ReconcilerServiceConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  indexerUrl?: string;
  webhookUrl?: string;
  consistencyWindowMs: number;
  pollIntervalMs: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  contractId?: string;
  environment: string;
  reconcilerId: string;
  asOfMaxLagLedgers: number;
  tolerance: { absolute: number; relativePpm: number };
  suppressionCooldownMs: number;
  flapThreshold: number;
  alertConfirmPasses: number;
  alertResolvePasses: number;
  alertReminderMs: number;
  healEnabled: boolean;
  healTimelockMs: number;
  healTtlMs: number;
  healRequiredSignatures: number;
  healSigners: Record<string, string> | string[] | null;
  healMaxScope: number;
  healMaxLedgerRange: number;
}

export interface ReconcilerService {
  horizonReader: HorizonReader;
  sorobanReader: SorobanRpcReader;
  projectionReader: ProjectionReader;
  engine: ReconciliationEngine;
  threeWay: ThreeWayReconciler;
  proposalStore: ProposalStore;
  suppressor: DivergenceSuppressor;
  alerting: AlertingService;
  config: ReconcilerServiceConfig;
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSigners(raw: string | undefined): Record<string, string> | string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    // A malformed signer set must fail closed, not silently disable checks.
    throw new Error("HEAL_SIGNERS must be a JSON array or object");
  }
  throw new Error("HEAL_SIGNERS must be a JSON array or object");
}

// Parse configuration from environment
function loadConfig(): ReconcilerServiceConfig {
  const logLevel = (process.env.LOG_LEVEL || "INFO") as "DEBUG" | "INFO" | "WARN" | "ERROR";
  const consistencyWindowMs = parseInt(process.env.CONSISTENCY_WINDOW_MS || "30000", 10);
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
  const environment = process.env.ENVIRONMENT || "testnet";
  const reconcilerId = process.env.RECONCILER_ID || "primary-001";

  return {
    horizonUrl: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org/rpc",
    indexerUrl: process.env.INDEXER_URL || undefined,
    webhookUrl: process.env.WEBHOOK_URL || undefined,
    consistencyWindowMs,
    pollIntervalMs,
    logLevel,
    contractId: process.env.CONTRACT_ID,
    environment,
    reconcilerId,
    asOfMaxLagLedgers: parseInteger(process.env.AS_OF_MAX_LAG_LEDGERS, 5),
    tolerance: {
      absolute: parseInteger(process.env.ROUNDING_TOLERANCE_ABSOLUTE, 0),
      relativePpm: parseInteger(process.env.ROUNDING_TOLERANCE_PPM, 0),
    },
    suppressionCooldownMs: parseInteger(process.env.SUPPRESSION_COOLDOWN_MS, 300_000),
    flapThreshold: parseInteger(process.env.FLAP_THRESHOLD, 3),
    alertConfirmPasses: parseInteger(process.env.ALERT_CONFIRM_PASSES, 2),
    alertResolvePasses: parseInteger(process.env.ALERT_RESOLVE_PASSES, 2),
    alertReminderMs: parseInteger(process.env.ALERT_REMINDER_MS, 1_800_000),
    healEnabled: process.env.HEAL_PROPOSALS_ENABLED === "true",
    healTimelockMs: parseInteger(process.env.HEAL_TIMELOCK_MS, 86_400_000),
    healTtlMs: parseInteger(process.env.HEAL_TTL_MS, 172_800_000),
    healRequiredSignatures: parseInteger(process.env.HEAL_REQUIRED_SIGNATURES, 2),
    healSigners: parseSigners(process.env.HEAL_SIGNERS),
    healMaxScope: parseInteger(process.env.HEAL_MAX_SCOPE, 25),
    healMaxLedgerRange: parseInteger(process.env.HEAL_MAX_LEDGER_RANGE, 1000),
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

export async function createReconcilerService(): Promise<ReconcilerService> {
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
    dedupe: {
      confirmPasses: config.alertConfirmPasses,
      resolvePasses: config.alertResolvePasses,
      reminderCadenceMs: config.alertReminderMs,
    },
  });

  const projectionReader = new ProjectionReader({
    url: config.indexerUrl,
    token: process.env.INDEXER_API_TOKEN || undefined,
  });

  const suppressor = new DivergenceSuppressor({
    cooldownMs: config.suppressionCooldownMs,
    flapThreshold: config.flapThreshold,
  });

  const threeWay = new ThreeWayReconciler({
    tolerance: config.tolerance,
    maxLagLedgers: config.asOfMaxLagLedgers,
    suppressor,
  });

  const proposalStore = new ProposalStore({
    timelockMs: config.healTimelockMs,
    ttlMs: config.healTtlMs,
    requiredSignatures: config.healRequiredSignatures,
    governanceSigners: config.healSigners,
    maxScope: config.healMaxScope,
    maxLedgerRange: config.healMaxLedgerRange,
    onEvent: (event: string, proposal: { id?: string; status?: string; dryRun?: { beforeRoot?: string; afterRoot?: string }; execution?: unknown }) => {
      alerting.log("INFO", `Heal proposal ${event}`, {
        proposalId: proposal.id,
        status: proposal.status,
        beforeRoot: proposal.dryRun?.beforeRoot,
        afterRoot: proposal.dryRun?.afterRoot,
        execution: proposal.execution ?? null,
      });
    },
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
    projectionConfigured: projectionReader.available,
    consistencyWindowMs: config.consistencyWindowMs,
    pollIntervalMs: config.pollIntervalMs,
    asOfMaxLagLedgers: config.asOfMaxLagLedgers,
    healProposalsEnabled: config.healEnabled,
    environment: config.environment,
    reconcilerId: config.reconcilerId,
    monitoredStreams: getMonitoredStreamIds().length,
  });

  return {
    horizonReader,
    sorobanReader,
    projectionReader,
    engine,
    threeWay,
    proposalStore,
    suppressor,
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
): Promise<ReconciliationResult> {
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

/**
 * Run one pinned three-way cycle. A missing source produces a degraded report
 * rather than a clean verdict; heal proposals fail closed outside three-way.
 */
export async function runThreeWayCycle(
  service: ReconcilerService,
  streamIds: string[]
): Promise<{ report: any; proposals: any[]; skipped: any[] }> {
  const adapters: any[] = [
    rpcAdapter(service.sorobanReader),
    horizonAdapter(service.horizonReader),
  ];
  if (service.projectionReader.available) {
    adapters.push(projectionAdapter(service.projectionReader));
  }

  const { asOfLedger, snapshots } = await collectPinnedSnapshots({
    adapters,
    streamIds,
    asOfLedger: null,
  });

  const report = service.threeWay.reconcile({ snapshots, streamIds });

  service.alerting.beginPass();
  try {
    for (const diagnosis of report.diagnoses) {
      await service.alerting.dispatchDiagnosis(diagnosis, report);
    }
  } finally {
    service.alerting.endPass();
  }

  let proposals: any[] = [];
  let skipped: any[] = [];
  if (service.config.healEnabled && report.mode === "three_way") {
    const projectionSnapshot = snapshots.find(
      (snapshot: { source?: string }) => snapshot.source === "projection"
    );
    const records = projectionSnapshot?.available ? projectionSnapshot.states : [];
    const result = proposeHeals({
      report,
      records,
      store: service.proposalStore,
      contractId: service.config.contractId ?? "",
      maxLedgerRange: service.config.healMaxLedgerRange,
    });
    proposals = result.proposals;
    skipped = result.skipped;
  }

  service.alerting.log(
    report.verdict === "divergent" ? "ERROR" : "INFO",
    "Three-way reconciliation complete",
    {
      verdict: report.verdict,
      mode: report.mode,
      asOfLedger: report.asOfLedger ?? asOfLedger,
      checked: report.summary.checked,
      inSync: report.summary.inSync,
      tolerated: report.summary.tolerated,
      withinLag: report.summary.withinLag,
      divergent: report.summary.divergent,
      suppressed: report.summary.suppressed,
      byLayer: report.summary.byLayer,
      caveats: report.caveats,
      proposals: proposals.map((proposal) => proposal.id),
      skipped,
    }
  );

  return { report, proposals, skipped };
}

export async function runContinuousThreeWay(
  service: ReconcilerService,
  streamIds: string[]
): Promise<void> {
  const interval = service.config.pollIntervalMs;
  for (;;) {
    const started = Date.now();
    try {
      await runThreeWayCycle(service, streamIds);
    } catch (error) {
      service.alerting.log(
        "ERROR",
        "Three-way reconciliation cycle failed",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, interval - elapsed)));
  }
}

// Entrypoint when run directly
if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  (async () => {
    try {
      const service = await createReconcilerService();
      const streamIds = getMonitoredStreamIds();

      service.alerting.log("INFO", "Reconciler service ready", {
        monitoredStreams: streamIds.length,
      });

      await runContinuousThreeWay(service, streamIds);
    } catch (err: unknown) {
      console.error("[streampay-reconciler] Fatal error:", err);
      process.exit(1);
    }
  })();
}

export type { StreamState, ReconciliationResult };
