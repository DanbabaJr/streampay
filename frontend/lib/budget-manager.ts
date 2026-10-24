/**
 * Shared RPC Budget Manager (Issue #56)
 *
 * Enforces per-client rate budgets and tracks upstream Soroban RPC node
 * call limits to prevent rate bans. Supports 429 Retry-After handling
 * and honest stale-cache fallback when budgets are exhausted.
 */

export interface BudgetDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
  reason?: "client_limit" | "node_rpc_limit";
}

export interface CachedStreamState {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  withdrawn: bigint;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
  asOfLedger: number;
  asOfTimestamp: number;
  fetchedAt: number;
}

export interface BudgetManagerOptions {
  /** Maximum requests allowed per client window. Default: 60 */
  clientLimit?: number;
  /** Client rate window in seconds. Default: 60 */
  clientWindowSeconds?: number;
  /** Maximum RPC calls allowed across all clients per node window. Default: 120 */
  nodeRpcLimit?: number;
  /** Node RPC window in seconds. Default: 60 */
  nodeRpcWindowSeconds?: number;
  /** Maximum stale age in seconds allowed for fallback. Default: 300 (5 mins) */
  maxStaleAgeSeconds?: number;
}

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

export class RpcBudgetManager {
  private clientLimit: number;
  private clientWindowSeconds: number;
  private nodeRpcLimit: number;
  private nodeRpcWindowSeconds: number;
  private maxStaleAgeSeconds: number;

  private clientBuckets = new Map<string, RateBucket>();
  private nodeRpcBucket: RateBucket;
  private snapshotCache = new Map<string, CachedStreamState>();

  constructor(options: BudgetManagerOptions = {}) {
    this.clientLimit = options.clientLimit ?? 60;
    this.clientWindowSeconds = options.clientWindowSeconds ?? 60;
    this.nodeRpcLimit = options.nodeRpcLimit ?? 120;
    this.nodeRpcWindowSeconds = options.nodeRpcWindowSeconds ?? 60;
    this.maxStaleAgeSeconds = options.maxStaleAgeSeconds ?? 300;

    this.nodeRpcBucket = {
      tokens: this.nodeRpcLimit,
      lastRefill: -1,
    };
  }

  private refillBucket(
    bucket: RateBucket,
    maxLimit: number,
    windowSeconds: number,
    now: number
  ): void {
    if (bucket.lastRefill < 0) {
      bucket.lastRefill = now;
      return;
    }
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
    const refillRate = maxLimit / windowSeconds;
    bucket.tokens = Math.min(maxLimit, bucket.tokens + elapsedSeconds * refillRate);
    bucket.lastRefill = now;
  }

  /**
   * Check and consume client budget.
   */
  public consumeClientBudget(clientId: string, cost = 1, now = Date.now()): BudgetDecision {
    let bucket = this.clientBuckets.get(clientId);
    if (!bucket) {
      bucket = { tokens: this.clientLimit, lastRefill: now };
      this.clientBuckets.set(clientId, bucket);
    } else {
      this.refillBucket(bucket, this.clientLimit, this.clientWindowSeconds, now);
    }

    if (bucket.tokens < cost) {
      const refillRate = this.clientLimit / this.clientWindowSeconds;
      const needed = cost - bucket.tokens;
      const retryAfter = Math.max(1, Math.ceil(needed / refillRate));
      return {
        allowed: false,
        remaining: Math.max(0, Math.floor(bucket.tokens)),
        retryAfterSeconds: retryAfter,
        reason: "client_limit",
      };
    }

    bucket.tokens -= cost;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
    };
  }

  /**
   * Check and consume shared upstream Soroban RPC node budget.
   * Every RPC call triggered by this API draws from this shared budget.
   */
  public consumeNodeRpcBudget(cost = 1, now = Date.now()): BudgetDecision {
    this.refillBucket(
      this.nodeRpcBucket,
      this.nodeRpcLimit,
      this.nodeRpcWindowSeconds,
      now
    );

    if (this.nodeRpcBucket.tokens < cost) {
      const refillRate = this.nodeRpcLimit / this.nodeRpcWindowSeconds;
      const needed = cost - this.nodeRpcBucket.tokens;
      const retryAfter = Math.max(1, Math.ceil(needed / refillRate));
      return {
        allowed: false,
        remaining: Math.max(0, Math.floor(this.nodeRpcBucket.tokens)),
        retryAfterSeconds: retryAfter,
        reason: "node_rpc_limit",
      };
    }

    this.nodeRpcBucket.tokens -= cost;
    return {
      allowed: true,
      remaining: Math.floor(this.nodeRpcBucket.tokens),
    };
  }

  /**
   * Store a stream state snapshot in transient cache for stale fallback.
   */
  public storeSnapshot(streamId: string, state: CachedStreamState): void {
    this.snapshotCache.set(streamId, state);
  }

  /**
   * Retrieve a cached stream snapshot if still within acceptable stale threshold.
   */
  public getStaleSnapshot(
    streamId: string,
    now = Math.floor(Date.now() / 1000)
  ): CachedStreamState | null {
    const cached = this.snapshotCache.get(streamId);
    if (!cached) return null;
    const age = now - Math.floor(cached.fetchedAt / 1000);
    if (age > this.maxStaleAgeSeconds) {
      return null;
    }
    return cached;
  }

  /**
   * Reset all state (useful for tests).
   */
  public reset(): void {
    this.clientBuckets.clear();
    this.nodeRpcBucket = {
      tokens: this.nodeRpcLimit,
      lastRefill: -1,
    };
    this.snapshotCache.clear();
  }
}

// Global shared singleton instance for the API server
export const globalRpcBudgetManager = new RpcBudgetManager();
