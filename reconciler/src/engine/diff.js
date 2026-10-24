//! Core reconciliation engine that compares Horizon and Soroban stream states
//! and detects divergences outside the consistency lag window.

import type {
  StreamState,
  DivergenceRecord,
  ReconciliationResult,
  ReaderConfig,
} from "./types.js";
import { AlertingService } from "../alerting.js";

export interface ReconciliationEngineConfig {
  consistencyWindowMs: number; // Acceptable lag between data sources
  alertOnLagThreshold?: number; // Alert when lag exceeds this (default: 2 * window)
  alertingService: AlertingService;
}

export class ReconciliationEngine {
  private config: ReconciliationEngineConfig;
  private alerting: AlertingService;

  constructor(config: ReconciliationEngineConfig) {
    this.config = config;
    this.alerting = config.alertingService;
  }

  /**
   * Reconcile two sets of stream states and detect divergences.
   * 
   * @param horizonStates - Stream states from Horizon (classic-bridge effects)
   * @param sorobanStates - Stream states from Soroban RPC (contract state)
   * @returns ReconciliationResult with detected divergences
   */
  async reconcile(
    horizonStates: StreamState[],
    sorobanStates: StreamState[]
  ): Promise<ReconciliationResult> {
    const startTime = Date.now();
    
    // Create maps for efficient lookup
    const horizonMap = new Map(horizonStates.map(s => [s.streamId, s]));
    const sorobanMap = new Map(sorobanStates.map(s => [s.streamId, s]));
    
    // Get all unique stream IDs from both sources
    const allStreamIds = new Set([
      ...horizonStates.map(s => s.streamId),
      ...sorobanStates.map(s => s.streamId),
    ]);
    
    const divergences: DivergenceRecord[] = [];
    let inSyncCount = 0;
    let withinLagCount = 0;
    
    for (const streamId of allStreamIds) {
      const horizonState = horizonMap.get(streamId);
      const sorobanState = sorobanMap.get(streamId);
      
      // Case 1: Stream exists in both sources
      if (horizonState && sorobanState) {
        const result = await this.compareStates(horizonState, sorobanState);
        if (result === null) {
          inSyncCount++;
        } else if (result === "lag") {
          withinLagCount++;
        } else {
          divergences.push(result);
        }
      } 
      // Case 2: Stream exists only in Horizon (missing from Soroban)
      else if (horizonState && !sorobanState) {
        divergences.push(this.createDivergenceRecord(
          streamId,
          "missing_record",
          "critical",
          { streamId: horizonState.streamId, ledger: horizonState.ledger },
          { streamId: sorobanState?.streamId ?? "N/A", ledger: sorobanState?.ledger ?? 0 },
          horizonState.ledger,
          0 // Soroban lag is infinite, but we'll use 0 as placeholder
        ));
      } 
      // Case 3: Stream exists only in Soroban (missing from Horizon)
      else if (!horizonState && sorobanState) {
        divergences.push(this.createDivergenceRecord(
          streamId,
          "missing_record",
          "warning", // Less critical - might be indexing delay
          { streamId: horizonState?.streamId ?? "N/A", ledger: horizonState?.ledger ?? 0 },
          { streamId: sorobanState.streamId, ledger: sorobanState.ledger },
          0, // Horizon lag is infinite
          sorobanState.ledger
        ));
      }
    }
    
    const ledgerGap = this.calculateLedgerGap(horizonStates, sorobanStates);
    
    // Dispatch webhooks for critical divergences
    for (const divergence of divergences) {
      if (divergence.severity === "critical") {
        await this.alerting.dispatchWebhook(divergence);
      }
    }
    
    // Log reconciliation summary
    this.alerting.log("INFO", `Reconciliation complete`, {
      totalChecked: allStreamIds.size,
      inSync: inSyncCount,
      withinLagWindow: withinLagCount,
      divergences: divergences.length,
      ledgerGap,
      durationMs: Date.now() - startTime,
    });
    
    return {
      totalChecked: allStreamIds.size,
      inSync: inSyncCount,
      withinLagWindow: withinLagCount,
      divergences,
      timestamp: new Date().toISOString(),
      ledgerGap,
    };
  }

  /**
   * Compare two stream states and determine if they match, are within lag window, or diverge.
   * 
   * @returns null if in sync, "lag" if within acceptable lag window, or DivergenceRecord if diverged
   */
  private async compareStates(
    h: StreamState,
    s: StreamState
  ): Promise<null | "lag" | DivergenceRecord> {
    // Check if the essential stream data matches
    const depositMatch = h.data.deposit === s.data.deposit;
    const withdrawnMatch = h.data.withdrawn === s.data.withdrawn;
    const statusMatch = h.data.status === s.data.status;
    
    if (depositMatch && withdrawnMatch && statusMatch) {
      return null; // Perfect match
    }
    
    // Calculate ledger lag between sources
    const horizonAgeMs = Date.now() - new Date(h.timestamp).getTime();
    const sorobanAgeMs = Date.now() - new Date(s.timestamp).getTime();
    
    // The consistency window applies to how stale each source can be
    // If both sources are stale but agree, that's still within window conceptually
    // We're more concerned about when they disagree AND are fresh
    
    const timeDiffMs = Math.abs(new Date(h.timestamp).getTime() - new Date(s.timestamp).getTime());
    
    // If the disagreement is due to reasonable propagation delay, treat as lag
    if (timeDiffMs <= this.config.consistencyWindowMs) {
      // Log as warning for monitoring but don't treat as actionable divergence
      this.alerting.log("WARN", `Stream ${h.streamId} shows lag-induced divergence`, {
        horizonLedger: h.ledger,
        sorobanLedger: s.ledger,
        timeDiffMs,
        consistencyWindowMs: this.config.consistencyWindowMs,
        horizonData: h.data,
        sorobanData: s.data,
      });
      return "lag";
    }
    
    // Determine which field(s) caused the mismatch
    const mismatchedFields: Record<string, boolean> = {
      deposit: !depositMatch,
      withdrawn: !withdrawnMatch,
      status: !statusMatch,
    };
    
    // Check if this looks like a corruption vs expected lag
    const severity: "warning" | "critical" = 
      (mismatchedFields.deposit || mismatchedFields.withdrawn) 
        ? "critical" 
        : "warning"; // Status-only mismatch might be less critical
    
    return this.createDivergenceRecord(
      h.streamId,
      "stream_balance",
      severity,
      {
        streamId: h.streamId,
        ledger: h.ledger,
        timestamp: h.timestamp,
        data: h.data,
      },
      {
        streamId: s.streamId,
        ledger: s.ledger,
        timestamp: s.timestamp,
        data: s.data,
      },
      h.ledger,
      s.ledger
    );
  }

  /**
   * Create a divergence record for logging and alerting.
   */
  private createDivergenceRecord(
    streamId: string,
    checkType: DivergenceRecord["checkType"],
    severity: DivergenceRecord["severity"],
    indexedValue: Record<string, unknown>,
    onChainValue: Record<string, unknown>,
    horizonLedger: number,
    sorobanLedger: number
  ): DivergenceRecord {
    return {
      streamId,
      checkType,
      severity,
      indexedValue,
      onChainValue,
      horizonLagMs: horizonLedger > 0 ? Date.now() - horizonLedger * 1000 : undefined,
      sorobanLagMs: sorobanLedger > 0 ? Date.now() - sorobanLedger * 1000 : undefined,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Calculate the ledger gap between Horizon and Soroban sources.
   */
  private calculateLedgerGap(
    horizonStates: StreamState[],
    sorobanStates: StreamState[]
  ): number {
    const getLatestLedger = (states: StreamState[]): number => {
      if (states.length === 0) return 0;
      return Math.max(...states.map(s => s.ledger));
    };
    
    const horizonLatest = getLatestLedger(horizonStates);
    const sorobanLatest = getLatestLedger(sorobanStates);
    
    return Math.abs(horizonLatest - sorobanLatest);
  }

  /**
   * Start continuous reconciliation polling.
   */
  async startContinuousReconciliation(
    horizonReader: { pollStreams: (ids: string[]) => Promise<StreamState[]>; healthCheck: () => Promise<{ healthy: boolean }> },
    sorobanReader: { pollStreams: (ids: string[]) => Promise<StreamState[]>; healthCheck: () => Promise<{ healthy: boolean }> },
    streamIds: string[],
    options: { 
      initialDelayMs?: number; 
      healthCheckIntervalMs?: number;
      onError?: (error: Error) => void;
    } = {}
  ): Promise<void> {
    const {
      initialDelayMs = 0,
      healthCheckIntervalMs = 30_000,
      onError = (err) => console.error("Reconciliation error:", err),
    } = options;
    
    // Initial delay
    if (initialDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }
    
    // Start health check interval
    let lastHealthCheck = 0;
    const healthCheckLoop = setInterval(async () => {
      try {
        const [hHealth, sHealth] = await Promise.all([
          horizonReader.healthCheck(),
          sorobanReader.healthCheck(),
        ]);
        
        if (!hHealth.healthy || !sHealth.healthy) {
          this.alerting.log("WARN", "One or more readers unhealthy", {
            horizonHealthy: hHealth.healthy,
            sorobanHealthy: sHealth.healthy,
            horizonError: hHealth.error,
            sorobanError: sHealth.error,
          });
        }
      } catch (err) {
        this.alerting.log("ERROR", "Health check failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, healthCheckIntervalMs);
    
    try {
      while (true) {
        const loopStart = Date.now();
        
        try {
          // Poll both sources
          const [horizonStates, sorobanStates] = await Promise.all([
            horizonReader.pollStreams(streamIds),
            sorobanReader.pollStreams(streamIds),
          ]);
          
          // Perform reconciliation
          await this.reconcile(horizonStates, sorobanStates);
          
          // Calculate sleep time to maintain poll interval
          const elapsed = Date.now() - loopStart;
          const sleepTime = Math.max(0, this.config.consistencyWindowMs - elapsed);
          
          await new Promise(resolve => setTimeout(resolve, sleepTime));
        } catch (err) {
          onError(err);
          // Continue looping despite errors
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally {
      clearInterval(healthCheckLoop);
    }
  }
}

// Re-export types for consumers
export type { ReconciliationEngineConfig };
export type { StreamState, DivergenceRecord, ReconciliationResult } from "./types.js";