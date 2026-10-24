//! Pure Ledger Planner for TTL Sentinel (Issue #219).
//!
//! Provides footprint cliff analysis, batched renewal grouping with single-tx-per-account
//! guarantees, rent-cost budget modeling, priority scheduling, and failure quarantine.

import { rentStroops, extensionOverheadStroops } from './rent.js';
import type { EntryClass } from './cliff.js';
import type { PlannerPolicyConfig } from './planner-policy.js';
import { DEFAULT_PLANNER_POLICY } from './planner-policy.js';

export interface KeyFootprintItem {
  id: string;
  cls: EntryClass;
  keyB64: string;
  account: string;
  remainingLedgers: number;
  sizeBytes: number;
  isDemo?: boolean;
  deadlineLedger?: number;
}

export interface PlannedRenewalTx {
  txIndex: number;
  account: string;
  keys: KeyFootprintItem[];
  estimatedRentStroops: bigint;
  targetLedgers: number;
  isDemo: boolean;
  urgencyScore: number;
}

export interface PlannerMetrics {
  totalCandidates: number;
  scheduledEntries: number;
  deferredCount: number;
  quarantinedCount: number;
  estimatedTotalStroops: bigint;
  dailyBurnProjectionStroops: bigint;
  budgetUtilizationPct: number;
  burnVsBudgetRatio: number;
  alarmTriggered: boolean;
  scheduleLagLedgers: number;
  batchSizes: number[];
  projectedWashHours: number;
}

export interface RenewalSchedule {
  windowLedgers: number;
  transactions: PlannedRenewalTx[];
  deferredEntries: KeyFootprintItem[];
  quarantinedAccounts: string[];
  metrics: PlannerMetrics;
}

export interface PlannerState {
  accountLastTxLedger?: Record<string, number>;
  accountFailureCounts?: Record<string, number>;
  quarantinedAccounts?: Set<string> | string[];
}

/**
 * Pure Ledger Planner: computes a deterministic renewal schedule for the current window.
 */
export function planRenewals(
  inventory: KeyFootprintItem[],
  policy: PlannerPolicyConfig = DEFAULT_PLANNER_POLICY,
  currentLedger: number = 1_000_000,
  extendTo: number = 500_000,
  thresholdLedgers: number = 200_000,
  feePer1Kb: bigint = 1000n,
  state: PlannerState = {},
): RenewalSchedule {
  const quarantinedSet = new Set<string>(
    state.quarantinedAccounts
      ? Array.isArray(state.quarantinedAccounts)
        ? state.quarantinedAccounts
        : Array.from(state.quarantinedAccounts)
      : [],
  );

  // Filter candidates below renewal threshold
  const candidates = inventory.filter(
    (item) => item.remainingLedgers <= thresholdLedgers && item.remainingLedgers < extendTo,
  );

  // Group candidates by account and filter out quarantined accounts
  const accountGroups = new Map<string, KeyFootprintItem[]>();
  const deferredEntries: KeyFootprintItem[] = [];
  let quarantinedCount = 0;

  for (const item of candidates) {
    if (quarantinedSet.has(item.account)) {
      deferredEntries.push(item);
      quarantinedCount++;
      continue;
    }

    // Check account window rate limiting (at most 1 tx per account per planning window)
    const lastTx = state.accountLastTxLedger?.[item.account];
    if (lastTx !== undefined && currentLedger - lastTx < policy.windowLedgers) {
      deferredEntries.push(item);
      continue;
    }

    const group = accountGroups.get(item.account) ?? [];
    group.push(item);
    accountGroups.set(item.account, group);
  }

  // Build transaction candidates per account
  const txCandidates: PlannedRenewalTx[] = [];
  let txSeq = 0;

  for (const [account, items] of accountGroups.entries()) {
    // Sort items within account: oldest deadline first (smallest remaining ledgers)
    items.sort((a, b) => a.remainingLedgers - b.remainingLedgers);

    // Chunk account items up to maxEntriesPerTx
    // For single-tx-per-account guarantee per window, take the top priority chunk
    const chunk = items.slice(0, policy.maxEntriesPerTx);
    const overflow = items.slice(policy.maxEntriesPerTx);
    deferredEntries.push(...overflow);

    let rent = 0n;
    let minRemaining = Infinity;
    let anyDemo = true;

    for (const item of chunk) {
      const ledgersAdded = BigInt(Math.max(0, extendTo - item.remainingLedgers));
      const size = BigInt(item.sizeBytes || 400);
      rent += rentStroops(size, ledgersAdded, feePer1Kb);
      if (item.remainingLedgers < minRemaining) minRemaining = item.remainingLedgers;
      if (!item.isDemo) anyDemo = false;
    }
    rent += extensionOverheadStroops() * BigInt(chunk.length);

    txCandidates.push({
      txIndex: txSeq++,
      account,
      keys: chunk,
      estimatedRentStroops: rent,
      targetLedgers: extendTo,
      isDemo: anyDemo,
      // Urgency score: lower remaining ledgers = higher urgency
      urgencyScore: minRemaining === Infinity ? 0 : minRemaining,
    });
  }

  // Priority scheduling:
  // 1. Paid streams (isDemo === false) before Demo streams (isDemo === true)
  // 2. Oldest deadline tie-break (urgencyScore ascending)
  txCandidates.sort((a, b) => {
    if (a.isDemo !== b.isDemo) {
      return a.isDemo ? 1 : -1; // Paid first
    }
    return a.urgencyScore - b.urgencyScore; // Oldest deadline first
  });

  // Budget model enforcement:
  // Ledgers in 24 hours at 5s cadence = 17,280 ledgers
  const LEDGERS_PER_DAY = 17_280n;
  const scheduledTxs: PlannedRenewalTx[] = [];
  let accumulatedSpend = 0n;

  for (const tx of txCandidates) {
    const projectedSpend = accumulatedSpend + tx.estimatedRentStroops;

    // Check budget limits
    const exceedsTreasury = projectedSpend > policy.treasuryStroops;
    const exceedsDaily = projectedSpend > policy.dailyBurnLimitStroops;

    if (exceedsTreasury || exceedsDaily) {
      if (policy.degradationPolicy === 'expire-demo-first') {
        if (tx.isDemo) {
          // Shed demo transaction under budget pressure
          deferredEntries.push(...tx.keys);
          continue;
        } else if (projectedSpend <= policy.treasuryStroops) {
          // Allow paid stream if within absolute treasury
          scheduledTxs.push(tx);
          accumulatedSpend += tx.estimatedRentStroops;
          continue;
        }
      }
      deferredEntries.push(...tx.keys);
      continue;
    }

    scheduledTxs.push(tx);
    accumulatedSpend += tx.estimatedRentStroops;
  }

  // Daily burn projection based on window scale:
  // Daily projection = (accumulatedSpend / windowLedgers) * LEDGERS_PER_DAY
  const windowBig = BigInt(Math.max(1, policy.windowLedgers));
  const dailyBurnProjection = (accumulatedSpend * LEDGERS_PER_DAY) / windowBig;

  const budgetRatio =
    policy.dailyBurnLimitStroops > 0n
      ? Number((dailyBurnProjection * 1000n) / policy.dailyBurnLimitStroops) / 1000
      : 0;

  const budgetUtilizationPct = Math.min(100, budgetRatio * 100);
  const alarmTriggered = budgetUtilizationPct >= policy.alarmThresholdPct;

  // Compute schedule lag (difference between earliest candidate expiry and renewal threshold)
  const earliestExpiry = Math.min(
    ...candidates.map((c) => c.remainingLedgers),
    thresholdLedgers,
  );
  const scheduleLagLedgers = Math.max(0, thresholdLedgers - earliestExpiry);

  const scheduledEntriesCount = scheduledTxs.reduce((sum, tx) => sum + tx.keys.length, 0);
  const batchSizes = scheduledTxs.map((tx) => tx.keys.length);

  // 1 WASH-hour = rent for 1KB state for 720 ledgers (~1 hour at 5s)
  const washHourCostStroops = Number(rentStroops(1024n, 720n, feePer1Kb));
  const projectedWashHours =
    washHourCostStroops > 0 ? Number(accumulatedSpend) / washHourCostStroops : 0;

  return {
    windowLedgers: policy.windowLedgers,
    transactions: scheduledTxs,
    deferredEntries,
    quarantinedAccounts: Array.from(quarantinedSet),
    metrics: {
      totalCandidates: candidates.length,
      scheduledEntries: scheduledEntriesCount,
      deferredCount: deferredEntries.length,
      quarantinedCount,
      estimatedTotalStroops: accumulatedSpend,
      dailyBurnProjectionStroops: dailyBurnProjection,
      budgetUtilizationPct: Number(budgetUtilizationPct.toFixed(1)),
      burnVsBudgetRatio: Number(budgetRatio.toFixed(3)),
      alarmTriggered,
      scheduleLagLedgers,
      batchSizes,
      projectedWashHours: Number(projectedWashHours.toFixed(1)),
    },
  };
}
