//! Core reconciliation engine that compares Horizon and Soroban stream states
//! and detects divergences outside the consistency lag window.

import type {
  StreamState,
  DivergenceRecord,
  DivergenceClassification,
  ReconciliationResult,
} from "../types.js";
import { AlertingService } from "../alerting.js";

/**
 * Accrual Floor Tolerance Derivation:
 *
 * References:
 * - docs/ARCHITECTURE.md §3 ("Accrual math"):
 *     "streamed(t) = deposit * elapsed / duration, floored"
 *     "Rounding never benefits the sender. Floor division means a partial
 *     second is never counted as streamed... The floor dust accumulates to the
 *     recipient, not the sender — verified by the property test (partial withdrawals ≤ full-window accrual)."
 * - docs/adr/0004-floor-per-second-accrual.md ("ADR 0004: Floor-Per-Second Accrual Math"):
 *     "Option 1: Floored integer division (deposit * elapsed / duration, rounded down)...
 *     ensures that a partial second is never counted as streamed. The recipient can only withdraw
 *     tokens that have fully matured."
 * - docs/I18N.md §3 ("The Stellar trap: 7 decimals and floating point"):
 *     Stellar Asset Contracts (SAC) standard defaults to 7 decimals (1 token = 10^7 stroops).
 *
 * Mathematical Justification:
 * In Soroban's `streamed_at` pure function, linear accrual is computed using integer floor division:
 *     streamed = floor((deposit * elapsed) / duration)
 * The truncation remainder r = (deposit * elapsed) % duration strictly satisfies 0 <= r < duration.
 * Therefore, the maximum unaccumulated floor dust at any instant is strictly less than
 * 1 smallest indivisible base unit:
 *     epsilon_base = 1 base unit (stroop)
 *
 * In decimal token representation (where amount is in human-readable token units with `decimals` d):
 *     1 token unit = 10^d base units => epsilon_decimal = 10^(-d)
 *
 * Sub-ledger rounding differences between Horizon indexed effects (which may reflect off-chain
 * continuous calculations or slight rounding differences across bridge effects) and Soroban's
 * on-chain contract state cannot exceed this single-unit floor threshold for a standard single rate segment.
 *
 * When maxDiff <= epsilon, the divergence is classified as "rounding_within_epsilon" (benign floor dust),
 * preventing unnecessary operator paging while recording the event in observability metrics.
 * Any difference > epsilon represents a genuine conservation violation ("value_mismatch") and triggers
 * a critical alert and webhook dispatch.
 */

export function parseAmountToBaseUnits(amountStr: string, decimals: number = 7): bigint {
  const trimmed = String(amountStr).trim();
  if (trimmed.includes(".")) {
    const [wholePart, fracPart = ""] = trimmed.split(".");
    const negative = wholePart.startsWith("-");
    const absWhole = negative ? wholePart.slice(1) : wholePart;
    const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
    const baseVal = BigInt(absWhole || "0") * (10n ** BigInt(decimals)) + BigInt(paddedFrac || "0");
    return negative ? -baseVal : baseVal;
  }
  return BigInt(trimmed || "0");
}

export function computeAmountDiff(hStr: string, sStr: string, decimals: number = 7): bigint {
  const hTrim = String(hStr).trim();
  const sTrim = String(sStr).trim();
  const isDecimal = hTrim.includes(".") || sTrim.includes(".");

  if (isDecimal) {
    const hBase = parseAmountToBaseUnits(hTrim, decimals);
    const sBase = parseAmountToBaseUnits(sTrim, decimals);
    return hBase > sBase ? hBase - sBase : sBase - hBase;
  }

  const hInt = BigInt(hTrim || "0");
  const sInt = BigInt(sTrim || "0");
  return hInt > sInt ? hInt - sInt : sInt - hInt;
}

export function calculateAccrualFloorEpsilon(
  _decimals: number = 7,
  multiplier: number = 1
): bigint {
  return BigInt(Math.max(1, Math.floor(multiplier)));
}

export interface ReconciliationEngineConfig {
  consistencyWindowMs: number; // Acceptable lag between data sources
  alertOnLagThreshold?: number; // Alert when lag exceeds this (default: 2 * window)
  alertingService: AlertingService;
  defaultDecimals?: number; // Asset decimals, defaults to 7 (Stellar SAC standard)
  toleranceMultiplier?: number; // Multiplier on accrual floor epsilon, defaults to 1
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
    let roundingCount = 0;
    let realDivergenceCount = 0;
    
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
          if (result.classification === "rounding_within_epsilon") {
            roundingCount++;
          } else {
            realDivergenceCount++;
          }
          divergences.push(result);
        }
      } 
      // Case 2: Stream exists only in Horizon (missing from Soroban)
      else if (horizonState && !sorobanState) {
        realDivergenceCount++;
        divergences.push(this.createDivergenceRecord(
          streamId,
          "missing_record",
          "critical",
          "missing_record",
          { streamId: horizonState.streamId, ledger: horizonState.ledger },
          { streamId: sorobanState ? (sorobanState as StreamState).streamId : "N/A", ledger: sorobanState ? (sorobanState as StreamState).ledger : 0 },
          horizonState.ledger,
          0 // Soroban lag is infinite, but we'll use 0 as placeholder
        ));
      } 
      // Case 3: Stream exists only in Soroban (missing from Horizon)
      else if (!horizonState && sorobanState) {
        realDivergenceCount++;
        divergences.push(this.createDivergenceRecord(
          streamId,
          "missing_record",
          "warning", // Less critical - might be indexing delay
          "missing_record",
          { streamId: horizonState ? (horizonState as StreamState).streamId : "N/A", ledger: horizonState ? (horizonState as StreamState).ledger : 0 },
          { streamId: sorobanState.streamId, ledger: sorobanState.ledger },
          0, // Horizon lag is infinite
          sorobanState.ledger
        ));
      }
    }
    
    const ledgerGap = this.calculateLedgerGap(horizonStates, sorobanStates);
    
    // Dispatch webhooks ONLY for critical real divergences (never for rounding within epsilon).
    // One reconciliation pass is one de-duplication pass: a divergence pages once
    // it has persisted across the configured confirmation windows, and keys that
    // are absent this pass age towards resolution.
    (this.alerting as any).beginPass?.();
    try {
      for (const divergence of divergences) {
        if (
          divergence.severity === "critical" &&
          divergence.classification !== "rounding_within_epsilon"
        ) {
          await this.alerting.dispatchWebhook(divergence);
        } else if (divergence.classification === "rounding_within_epsilon") {
          if (typeof (this.alerting as any).recordRounding === "function") {
            (this.alerting as any).recordRounding(divergence);
          }
        }
      }
    } finally {
      (this.alerting as any).endPass?.();
    }
    
    // Log reconciliation summary
    this.alerting.log("INFO", `Reconciliation complete`, {
      totalChecked: allStreamIds.size,
      inSync: inSyncCount,
      withinLagWindow: withinLagCount,
      divergences: divergences.length,
      roundingWithinTolerance: roundingCount,
      realDivergences: realDivergenceCount,
      ledgerGap,
      durationMs: Date.now() - startTime,
    });
    
    return {
      totalChecked: allStreamIds.size,
      inSync: inSyncCount,
      withinLagWindow: withinLagCount,
      roundingWithinTolerance: roundingCount,
      realDivergences: realDivergenceCount,
      divergences,
      timestamp: new Date().toISOString(),
      ledgerGap,
      metrics: {
        roundingCount,
        divergenceCount: realDivergenceCount,
      },
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

    // If only status mismatched:
    if (mismatchedFields.status && !mismatchedFields.deposit && !mismatchedFields.withdrawn) {
      return this.createDivergenceRecord(
        h.streamId,
        "stream_status",
        "warning",
        "status_mismatch",
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

    // Balance mismatch: evaluate whether difference is within accrual floor rounding epsilon
    const decimals =
      (s.data as { decimals?: number }).decimals ??
      (h.data as { decimals?: number }).decimals ??
      this.config.defaultDecimals ??
      7;

    const multiplier = this.config.toleranceMultiplier ?? 1;
    const epsilon = calculateAccrualFloorEpsilon(decimals, multiplier);

    let maxDiff = 0n;
    try {
      const depositDiff = computeAmountDiff(h.data.deposit, s.data.deposit, decimals);
      const withdrawnDiff = computeAmountDiff(h.data.withdrawn, s.data.withdrawn, decimals);
      maxDiff = depositDiff > withdrawnDiff ? depositDiff : withdrawnDiff;
    } catch {
      // If parsing failed (e.g. malformed strings), treat as a value mismatch
      maxDiff = epsilon + 1n;
    }

    const isWithinTolerance = maxDiff <= epsilon;
    const classification: DivergenceClassification = isWithinTolerance
      ? "rounding_within_epsilon"
      : "value_mismatch";
    const severity: "warning" | "critical" = isWithinTolerance ? "warning" : "critical";

    return this.createDivergenceRecord(
      h.streamId,
      "stream_balance",
      severity,
      classification,
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
      s.ledger,
      maxDiff.toString(),
      epsilon.toString()
    );
  }

  /**
   * Create a divergence record for logging and alerting.
   */
  private createDivergenceRecord(
    streamId: string,
    checkType: DivergenceRecord["checkType"],
    severity: DivergenceRecord["severity"],
    classification: DivergenceClassification,
    indexedValue: Record<string, unknown>,
    onChainValue: Record<string, unknown>,
    horizonLedger: number,
    sorobanLedger: number,
    delta?: string,
    toleranceEpsilon?: string
  ): DivergenceRecord {
    return {
      streamId,
      checkType,
      severity,
      classification,
      indexedValue,
      onChainValue,
      horizonLagMs: horizonLedger > 0 ? Date.now() - horizonLedger * 1000 : undefined,
      sorobanLagMs: sorobanLedger > 0 ? Date.now() - sorobanLedger * 1000 : undefined,
      detectedAt: new Date().toISOString(),
      delta,
      toleranceEpsilon,
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
    horizonReader: { pollStreams: (ids: string[]) => Promise<StreamState[]>; healthCheck: () => Promise<{ healthy: boolean; error?: string }> },
    sorobanReader: { pollStreams: (ids: string[]) => Promise<StreamState[]>; healthCheck: () => Promise<{ healthy: boolean; error?: string }> },
    streamIds: string[],
    options: { 
      initialDelayMs?: number; 
      healthCheckIntervalMs?: number;
      onError?: (error: unknown) => void;
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
      } catch (err: unknown) {
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
        } catch (err: unknown) {
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
export type { StreamState, DivergenceRecord, ReconciliationResult } from "../types.js";
