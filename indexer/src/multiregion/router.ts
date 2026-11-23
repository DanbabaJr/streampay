import type { RegionWatermarkTracker } from "./watermarks.js";

export interface ReadTarget {
  regionId: string;
  watermark: number;
  lag: number;
  endpoint?: string;
}

export class NoFreshRegionError extends Error {
  constructor(readonly requiredLedger: number, readonly maxLagLedgers: number) {
    super(`no healthy region is fresh enough for ledger ${requiredLedger} (max lag ${maxLagLedgers})`);
    this.name = "NoFreshRegionError";
  }
}

export interface FreshnessRouterOptions {
  /**
   * How many ledgers behind the tip a region may be and still take reads.
   * A region past this bound is not "behind", it is untrustworthy for reads.
   */
  maxLagLedgers?: number;
}

/**
 * Freshness-based read routing across active-active regions.
 *
 * A read goes to the freshest healthy region — lowest lag first, then configured
 * priority, then region id — so the choice is deterministic for a given set of
 * watermarks (no round-robin, no random tie-break). Regions that are unhealthy
 * or further behind than `maxLagLedgers` never receive reads; when no region
 * qualifies the router fails closed instead of serving stale state silently.
 */
export class FreshnessReadRouter {
  private readonly maxLagLedgers: number;

  constructor(
    private readonly tracker: RegionWatermarkTracker,
    options: FreshnessRouterOptions = {},
  ) {
    this.maxLagLedgers = options.maxLagLedgers ?? 5;
  }

  /** Freshest healthy region for a read that has no ledger requirement. */
  route(): ReadTarget {
    return this.routeFor(0);
  }

  /**
   * Freshest healthy region whose projection is at or past `requiredLedger`
   * (read-your-writes / monotonic reads) and within the lag bound.
   */
  routeFor(requiredLedger: number): ReadTarget {
    const tip = this.tracker.tip();
    const candidates = this.tracker
      .all()
      .filter((status) => status.health === "healthy")
      .filter((status) => status.watermark >= requiredLedger)
      .map((status) => ({
        regionId: status.regionId,
        watermark: status.watermark,
        lag: Math.max(0, tip - status.watermark),
        endpoint: this.tracker.endpoint(status.regionId),
      }))
      .filter((candidate) => candidate.lag <= this.maxLagLedgers)
      .sort((a, b) => {
        if (a.lag !== b.lag) return a.lag - b.lag;
        const priority = this.tracker.priority(a.regionId) - this.tracker.priority(b.regionId);
        if (priority !== 0) return priority;
        return a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0;
      });

    const target = candidates[0];
    if (!target) throw new NoFreshRegionError(requiredLedger, this.maxLagLedgers);
    return target;
  }
}
