import type { RegionConfig, RegionHealth, RegionStatus } from "./types.js";

/**
 * Per-region ledger watermarks. Each active-active region ingests the chain on
 * its own, so the only cross-region fact worth trusting is "which ledger has
 * this region projected". Every region reports its watermark + health; the
 * tracker derives the tip and the cross-region consistency lag from them.
 *
 * Watermarks are monotonic per region: a late or replayed report never moves a
 * region backwards, so the lag metric cannot flicker because of report order.
 */
export class RegionWatermarkTracker {
  private readonly configs = new Map<string, RegionConfig>();
  private readonly statuses = new Map<string, RegionStatus>();

  constructor(regions: readonly RegionConfig[] = []) {
    for (const region of regions) this.configs.set(region.id, { ...region });
  }

  register(region: RegionConfig): void {
    this.configs.set(region.id, { ...region });
  }

  /** Records a region's committed watermark and health. */
  report(regionId: string, watermark: number, health: RegionHealth = "healthy", at = Date.now()): RegionStatus {
    if (!Number.isSafeInteger(watermark) || watermark < 0) {
      throw new RangeError(`watermark must be a non-negative integer ledger (got ${watermark})`);
    }
    const previous = this.statuses.get(regionId);
    const status: RegionStatus = {
      regionId,
      health,
      watermark: previous ? Math.max(previous.watermark, watermark) : watermark,
      updatedAt: at,
    };
    this.statuses.set(regionId, status);
    return status;
  }

  /** Marks a region unhealthy without losing the watermark it last reported. */
  markUnhealthy(regionId: string, at = Date.now()): RegionStatus | undefined {
    const previous = this.statuses.get(regionId);
    if (!previous) return undefined;
    return this.report(regionId, previous.watermark, "unhealthy", at);
  }

  markHealthy(regionId: string, at = Date.now()): RegionStatus | undefined {
    const previous = this.statuses.get(regionId);
    if (!previous) return undefined;
    return this.report(regionId, previous.watermark, "healthy", at);
  }

  get(regionId: string): RegionStatus | undefined {
    return this.statuses.get(regionId);
  }

  priority(regionId: string): number {
    return this.configs.get(regionId)?.priority ?? Number.MAX_SAFE_INTEGER;
  }

  endpoint(regionId: string): string | undefined {
    return this.configs.get(regionId)?.endpoint;
  }

  /** Every region that has reported, ordered by id for stable output. */
  all(): RegionStatus[] {
    return [...this.statuses.values()].sort((a, b) => (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));
  }

  /**
   * Chain tip as observed anywhere: the highest watermark any region reports,
   * including an unhealthy one. Lag is measured against this, so a region that is
   * the last to be healthy does not become "fresh" by having nobody to compare to.
   */
  tip(): number {
    let tip = 0;
    for (const status of this.statuses.values()) tip = Math.max(tip, status.watermark);
    return tip;
  }

  /** How far behind the tip a region is, in ledgers. */
  lag(regionId: string): number {
    const status = this.statuses.get(regionId);
    if (!status) throw new RangeError(`unknown region ${regionId}`);
    return Math.max(0, this.tip() - status.watermark);
  }

  /** Lag per reported region, keyed by id and ordered the same way. */
  lags(): Record<string, number> {
    const tip = this.tip();
    const out: Record<string, number> = {};
    for (const status of this.all()) {
      out[status.regionId] = Math.max(0, tip - status.watermark);
    }
    return out;
  }

  maxLag(): number {
    return Object.values(this.lags()).reduce((max, lag) => Math.max(max, lag), 0);
  }

  /**
   * Prometheus exposition for the two cross-region series: the per-region
   * ledger watermark and the consistency lag derived from it, plus health.
   */
  renderMetrics(): string {
    const lines: string[] = [];
    for (const status of this.all()) {
      const label = `{region="${status.regionId}"}`;
      lines.push(`streampay_region_ledger_watermark${label} ${status.watermark}`);
      lines.push(`streampay_region_consistency_lag_ledgers${label} ${this.lag(status.regionId)}`);
      lines.push(`streampay_region_healthy${label} ${status.health === "unhealthy" ? 0 : 1}`);
    }
    return lines.join("\n");
  }
}
