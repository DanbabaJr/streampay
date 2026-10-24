//! Sentinel Metrics Registry for Prometheus / Monitoring Surface (Issue #219).

import type { PlannerMetrics } from './planner.js';

export class SentinelMetricsRegistry {
  private scheduleLag: number = 0;
  private burnVsBudgetRatio: number = 0;
  private quarantinedAccountsTotal: number = 0;
  private totalScheduledTotal: number = 0;
  private lastBatchSizes: number[] = [];
  private dailyBurnProjectionStroops: bigint = 0n;

  updateFromPlanner(metrics: PlannerMetrics): void {
    this.scheduleLag = metrics.scheduleLagLedgers;
    this.burnVsBudgetRatio = metrics.burnVsBudgetRatio;
    this.quarantinedAccountsTotal = metrics.quarantinedCount;
    this.totalScheduledTotal += metrics.scheduledEntries;
    this.lastBatchSizes = [...metrics.batchSizes];
    this.dailyBurnProjectionStroops = metrics.dailyBurnProjectionStroops;
  }

  exportMetrics(): string {
    const lines: string[] = [
      '# HELP streampay_sentinel_schedule_lag_ledgers Lag between earliest expiring entry and threshold in ledgers',
      '# TYPE streampay_sentinel_schedule_lag_ledgers gauge',
      `streampay_sentinel_schedule_lag_ledgers ${this.scheduleLag}`,
      '',
      '# HELP streampay_sentinel_burn_vs_budget_ratio Ratio of daily projected rent burn against budget ceiling',
      '# TYPE streampay_sentinel_burn_vs_budget_ratio gauge',
      `streampay_sentinel_burn_vs_budget_ratio ${this.burnVsBudgetRatio}`,
      '',
      '# HELP streampay_sentinel_quarantined_accounts Total number of accounts currently quarantined due to failure limits',
      '# TYPE streampay_sentinel_quarantined_accounts gauge',
      `streampay_sentinel_quarantined_accounts ${this.quarantinedAccountsTotal}`,
      '',
      '# HELP streampay_sentinel_scheduled_entries_total Cumulative count of TTL entries scheduled for extension',
      '# TYPE streampay_sentinel_scheduled_entries_total counter',
      `streampay_sentinel_scheduled_entries_total ${this.totalScheduledTotal}`,
      '',
      '# HELP streampay_sentinel_daily_burn_projection_stroops Projected 24-hour rent burn in Stroops',
      '# TYPE streampay_sentinel_daily_burn_projection_stroops gauge',
      `streampay_sentinel_daily_burn_projection_stroops ${this.dailyBurnProjectionStroops}`,
    ];

    if (this.lastBatchSizes.length > 0) {
      lines.push(
        '',
        '# HELP streampay_sentinel_last_batch_size Entries packed into each transaction batch in the most recent planning cycle',
        '# TYPE streampay_sentinel_last_batch_size gauge',
      );
      this.lastBatchSizes.forEach((size, idx) => {
        lines.push(`streampay_sentinel_last_batch_size{batch="${idx}"} ${size}`);
      });
    }

    return lines.join('\n') + '\n';
  }
}

export const defaultSentinelMetrics = new SentinelMetricsRegistry();
