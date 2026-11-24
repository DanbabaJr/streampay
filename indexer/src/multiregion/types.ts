/** Health as reported by a region's own heartbeat / readiness probe. */
export type RegionHealth = "healthy" | "degraded" | "unhealthy";

export interface RegionConfig {
  /** Stable region id, e.g. `us-east-1`. Never derived from a hostname. */
  id: string;
  /** Lower wins a tie when two regions are equally fresh. */
  priority?: number;
  /** Read endpoint the router hands back to callers. */
  endpoint?: string;
}

export interface RegionStatus {
  regionId: string;
  health: RegionHealth;
  /** Highest ledger whose projection this region has committed. */
  watermark: number;
  /** Local clock (ms) of the last report. */
  updatedAt: number;
}

/** Healthy regions serve reads; degraded serve only when nothing healthier is fresh. */
export const REGION_HEALTHY = "healthy" as const;
