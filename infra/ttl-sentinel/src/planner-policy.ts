//! Degradation and budget policy for the TTL Sentinel Ledger Planner (Issue #219).
//!
//! Provides explicit rules for rent expenditure, burn projections, and
//! prioritization/degradation when treasury constraints bind.

export type DegradationPolicy =
  | 'expire-demo-first'   // Loud default: demo streams shed first, protecting paid streams
  | 'oldest-deadline'     // Preserve streams with nearest expiry regardless of tier
  | 'proportional-shed'   // Shed low-value/low-duration streams proportionally
  | 'halt-all';           // Strict halt if budget is exceeded

export interface PlannerPolicyConfig {
  /** Size of the planning window in ledgers (e.g., 600 ledgers ~ 50 minutes at 5s). */
  windowLedgers: number;
  /** Max transactions submitted per account per window (target: 1). */
  maxTxsPerAccountPerWindow: number;
  /** Maximum ledger keys packed into a single ExtendFootprintTTL operation. */
  maxEntriesPerTx: number;
  /** Available treasury reserve in Stroops (1 XLM = 10,000,000 Stroops). */
  treasuryStroops: bigint;
  /** Daily burn budget ceiling in Stroops. */
  dailyBurnLimitStroops: bigint;
  /** Burn percentage that triggers an operational alarm (default: 85%). */
  alarmThresholdPct: number;
  /** Degradation strategy when budget projection exceeds available funds. */
  degradationPolicy: DegradationPolicy;
  /** Maximum retry attempts for failed batches before quarantine. */
  retryMaxAttempts: number;
  /** Consecutive failures threshold before account enters poison quarantine. */
  quarantineThreshold: number;
}

export const DEFAULT_PLANNER_POLICY: PlannerPolicyConfig = {
  windowLedgers: 600,
  maxTxsPerAccountPerWindow: 1,
  maxEntriesPerTx: 50,
  treasuryStroops: 10_000_000_000n, // 1,000 XLM
  dailyBurnLimitStroops: 500_000_000n, // 50 XLM / day
  alarmThresholdPct: 85,
  degradationPolicy: 'expire-demo-first',
  retryMaxAttempts: 3,
  quarantineThreshold: 3,
};
