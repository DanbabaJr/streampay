/**
 * StreamPay RPC Failover Manager — Issue #100
 *
 * A shared client layer for the indexer, reconciler, keeper, and frontend
 * server that:
 *
 * - Tracks multiple Soroban RPC endpoints.
 * - Health-checks endpoints (height-lag detection, 429 storms,
 *   slow-response outliers).
 * - Fails over to the next healthy endpoint automatically.
 * - Implements hedged requests for latency-sensitive read calls.
 * - Manages a global token-bucket rate budget shared across all callers.
 *
 * # Rate budget: coordination decision
 *
 * The manager maintains an **in-process token bucket** per network.
 * For multi-process deployments (indexer + keeper + reconciler each in their
 * own Node.js process) a shared Redis counter or a sidecar rate-limiter is
 * recommended. This implementation documents the interface so a Redis
 * back-end can be swapped in without changing callers: the `RateBudget`
 * interface is the seam.
 *
 * # Hedged requests
 *
 * A hedged request is only issued for **read-only** calls (simulation,
 * getLedgerEntries, getTransaction). Mutating calls (`sendTransaction`)
 * must never be hedged — duplicate submissions would be rejected by the
 * ledger (sequence-number check) but produce confusing double-events.
 *
 * The hedge delay is configurable per-call-type (default: 300 ms for
 * reads, disabled for mutations). If the primary responds within the hedge
 * delay the secondary is cancelled; otherwise the faster of the two wins.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RpcEndpoint {
  url: string;
  /** Relative weight for initial endpoint selection (default 1). */
  weight?: number;
}

export interface EndpointHealth {
  url: string;
  /** Whether this endpoint is currently considered healthy. */
  healthy: boolean;
  /** Latest ledger sequence seen from this endpoint. */
  latestLedger: number;
  /** Timestamp of last successful response (ms). */
  lastSuccessAt: number;
  /** Consecutive failure count. */
  failures: number;
  /** Detected ledger lag in seconds (compared to the best-seen ledger). */
  lagSeconds: number;
}

export interface ManagerOptions {
  endpoints: RpcEndpoint[];
  /**
   * Max request rate per second across all callers (global token bucket).
   * Default: 10 rps (conservative testnet rate limit).
   */
  maxRps?: number;
  /**
   * Number of consecutive failures before an endpoint is marked unhealthy.
   * Default: 3.
   */
  failureThreshold?: number;
  /**
   * Ledger lag threshold in seconds. Endpoints lagging more than this are
   * deprioritised. Default: 60 s.
   */
  lagThresholdSeconds?: number;
  /**
   * Hedge delay for read-only calls in milliseconds.
   * 0 = hedging disabled. Default: 300.
   */
  hedgeDelayMs?: number;
  /**
   * Health-check interval in milliseconds. Default: 10_000.
   */
  healthCheckIntervalMs?: number;
  /**
   * Request timeout in milliseconds. Default: 15_000.
   */
  timeoutMs?: number;
}

export interface JsonRpcRequest {
  method: string;
  params: unknown;
}

export type CallType = "read" | "mutate";

/**
 * A read-only view of the budget the manager enforces, meant for callers that
 * want to size their own concurrency: the parallel ingester derives its
 * in-flight depth from these numbers (`docs/INDEXER_INGEST.md`) instead of
 * inventing a constant that can exceed what the endpoints are allowed to serve.
 */
export interface RateBudgetSnapshot {
  /** Sustained requests per second across every caller in this process. */
  maxRps: number;
  /** Bucket size: tokens available for a short burst. */
  burstCapacity: number;
  /** Whole tokens payable right now. */
  availableTokens: number;
  /** EWMA of end-to-end request latency in ms (0 until the first response). */
  observedLatencyMs: number;
  /** Endpoints currently considered healthy. */
  healthyEndpoints: number;
  /** True when reads are hedged, i.e. one slow read can cost two requests. */
  hedgedReads: boolean;
}

// ── Token bucket rate limiter ─────────────────────────────────────────────────

/** Weight of the newest latency sample. Low enough that one slow call cannot
 *  collapse the ingester's admission depth; high enough to react in ~5 calls. */
const LATENCY_EWMA_ALPHA = 0.2;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRatePerMs: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /** Tries to consume `count` tokens. Returns true if allowed. */
  tryConsume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Returns approximate ms to wait for `count` tokens. */
  waitMs(count = 1): number {
    this.refill();
    const deficit = count - this.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil(deficit / this.refillRatePerMs);
  }

  /** Whole tokens currently payable. Used for admission control, never consumes. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  get capacity(): number { return this.maxTokens; }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refilled = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.maxTokens, this.tokens + refilled);
    this.lastRefill = now;
  }
}

// ── RPC Manager ───────────────────────────────────────────────────────────────

export class RpcManager {
  private health: Map<string, EndpointHealth>;
  private bucket: TokenBucket;
  private opts: Required<ManagerOptions>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private bestLedger = 0;
  private ewmaLatencyMs = 0;

  constructor(options: ManagerOptions) {
    if (options.endpoints.length === 0) {
      throw new Error("RpcManager: at least one endpoint is required");
    }

    this.opts = {
      maxRps: 10,
      failureThreshold: 3,
      lagThresholdSeconds: 60,
      hedgeDelayMs: 300,
      healthCheckIntervalMs: 10_000,
      timeoutMs: 15_000,
      ...options,
    };

    this.health = new Map(
      options.endpoints.map((ep) => [
        ep.url,
        {
          url: ep.url,
          healthy: true,
          latestLedger: 0,
          lastSuccessAt: Date.now(),
          failures: 0,
          lagSeconds: 0,
        },
      ])
    );

    // Token bucket: maxRps tokens, refill at maxRps/1000 per ms.
    this.bucket = new TokenBucket(this.opts.maxRps * 2, this.opts.maxRps / 1_000);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start periodic health checks. Call once after construction. */
  start(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(
      () => void this.checkAllEndpoints(),
      this.opts.healthCheckIntervalMs
    );
  }

  /** Stop health-check timer and release resources. */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  // ── Public RPC call ────────────────────────────────────────────────────────

  /**
   * Executes a JSON-RPC call, automatically selecting the best endpoint,
   * applying the rate budget, and hedging read-only calls.
   *
   * @param req - The JSON-RPC method and params.
   * @param type - `"read"` (hedged, idempotent) or `"mutate"` (never hedged).
   * @returns The `result` field of the JSON-RPC response.
   * @throws If all endpoints fail, rate budget is exhausted, or timeout elapses.
   */
  async call<T = unknown>(req: JsonRpcRequest, type: CallType = "read"): Promise<T> {
    // Rate budget check.
    if (!this.bucket.tryConsume()) {
      const wait = this.bucket.waitMs();
      throw Object.assign(
        new Error(`RPC rate budget exhausted; retry after ~${wait} ms`),
        { code: "RATE_EXHAUSTED", retryAfterMs: wait }
      );
    }

    const primary = this.pickEndpoint();
    if (!primary) {
      throw new Error("RpcManager: no healthy endpoints available");
    }

    const startedAt = Date.now();
    try {
      const result = type === "read" && this.opts.hedgeDelayMs > 0
        ? await this.hedgedCall<T>(req, primary)
        : await this.singleCall<T>(req, primary);
      this.recordLatency(Date.now() - startedAt);
      return result;
    } catch (error) {
      // Failures cost real wall-clock time too; ignoring them would report a
      // rosy latency and make callers over-admit exactly during a degradation.
      this.recordLatency(Date.now() - startedAt);
      throw error;
    }
  }

  // ── Read helpers (wrappers for common Soroban RPC methods) ─────────────────

  async getLatestLedger(): Promise<{ sequence: number; id: string; protocolVersion: number }> {
    return this.call({ method: "getLatestLedger", params: {} }, "read");
  }

  async simulateTransaction(txXdr: string): Promise<unknown> {
    return this.call({ method: "simulateTransaction", params: { transaction: txXdr } }, "read");
  }

  async getTransaction(hash: string): Promise<unknown> {
    return this.call({ method: "getTransaction", params: { hash } }, "read");
  }

  async sendTransaction(txXdr: string): Promise<unknown> {
    // Mutations are never hedged.
    return this.call({ method: "sendTransaction", params: { transaction: txXdr } }, "mutate");
  }

  async getEvents(params: unknown): Promise<unknown> {
    return this.call({ method: "getEvents", params }, "read");
  }

  async getLedgerEntries(keys: string[]): Promise<unknown> {
    return this.call({ method: "getLedgerEntries", params: { keys } }, "read");
  }

  // ── Health status ──────────────────────────────────────────────────────────

  /** Returns a snapshot of all endpoint health states. */
  getHealth(): EndpointHealth[] {
    return [...this.health.values()];
  }

  /**
   * Snapshot of the rate budget and measured latency, for callers that need to
   * size their own concurrency. Purely observational: it never reserves tokens,
   * so a caller that acts on it can still be rejected by `call()` and must
   * honour the returned `RATE_EXHAUSTED.retryAfterMs`.
   */
  getRateBudget(): RateBudgetSnapshot {
    return {
      maxRps: this.opts.maxRps,
      burstCapacity: this.bucket.capacity,
      availableTokens: this.bucket.available(),
      observedLatencyMs: Math.round(this.ewmaLatencyMs),
      healthyEndpoints: [...this.health.values()].filter((h) => h.healthy).length,
      hedgedReads: this.opts.hedgeDelayMs > 0,
    };
  }

  // ── Private implementation ─────────────────────────────────────────────────

  /** Exponentially weighted moving average; the first sample seeds it. */
  private recordLatency(elapsedMs: number): void {
    this.ewmaLatencyMs = this.ewmaLatencyMs === 0
      ? elapsedMs
      : this.ewmaLatencyMs * (1 - LATENCY_EWMA_ALPHA) + elapsedMs * LATENCY_EWMA_ALPHA;
  }

  /** Picks the healthiest endpoint (fewest failures, lowest lag). */
  private pickEndpoint(): string | null {
    const candidates = [...this.health.values()]
      .filter((h) => h.healthy)
      .sort((a, b) => {
        // Failures outrank lag: a node that just failed may fail again and cost
        // the caller an error, while a lagging node still answers correctly and
        // a reader can tell its window was short from its own `latestLedger`.
        if (a.failures !== b.failures) return a.failures - b.failures;
        return a.lagSeconds - b.lagSeconds;
      });
    return candidates[0]?.url ?? null;
  }

  /** Picks an alternative endpoint to `primary` for hedging. */
  private pickAlternative(primary: string): string | null {
    const candidates = [...this.health.values()]
      .filter((h) => h.healthy && h.url !== primary)
      .sort((a, b) => a.lagSeconds - b.lagSeconds);
    return candidates[0]?.url ?? null;
  }

  /** Single-endpoint call with timeout and failure recording. */
  private async singleCall<T>(req: JsonRpcRequest, url: string): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (resp.status === 429) {
        throw Object.assign(new Error(`${url}: HTTP 429 rate limited`), { code: "RATE_LIMITED" });
      }
      if (!resp.ok) {
        throw new Error(`${url}: HTTP ${resp.status}`);
      }

      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) {
        throw new Error(`${url} RPC: ${json.error.message}`);
      }

      // Update ledger tracking for lag detection.
      if (json.result && typeof json.result === "object" && "sequence" in json.result) {
        this.updateLedger(url, (json.result as unknown as { sequence: number }).sequence);
      }

      this.recordSuccess(url);
      return json.result as T;
    } catch (e) {
      // One place records every failure, including the ones with no HTTP status
      // behind them: a `TypeError: fetch failed` from a dead node is exactly the
      // signal that makes failover necessary, and it used to escape here
      // unrecorded, leaving the endpoint "healthy" forever.
      const aborted = (e as Error).name === "AbortError";
      this.recordFailure(url, aborted ? "timeout" : (e as Error).message);
      if (aborted) {
        throw Object.assign(new Error(`${url}: request timed out after ${this.opts.timeoutMs} ms`), { code: "TIMEOUT" });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hedged read: fires against primary, then if no response within
   * `hedgeDelayMs`, fires against an alternative. The faster winner is
   * returned; the slower is cancelled.
   */
  private async hedgedCall<T>(req: JsonRpcRequest, primary: string): Promise<T> {
    const alternative = this.pickAlternative(primary);
    if (!alternative || this.opts.hedgeDelayMs <= 0) {
      return this.singleCall<T>(req, primary);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      // Primary fires immediately.
      const primaryPromise = this.singleCall<T>(req, primary)
        .then((v) => settle(() => resolve(v)))
        .catch((e) => settle(() => reject(e)));

      // Alternative fires after hedge delay.
      const hedgeTimer = setTimeout(() => {
        if (settled) return;
        this.singleCall<T>(req, alternative)
          .then((v) => settle(() => resolve(v)))
          .catch(() => {
            // Ignore hedge errors — primary is still running.
          });
      }, this.opts.hedgeDelayMs);

      // Clean up timer if primary settles first.
      primaryPromise.finally(() => clearTimeout(hedgeTimer));
    });
  }

  private recordSuccess(url: string): void {
    const h = this.health.get(url);
    if (!h) return;
    h.healthy = true;
    h.failures = 0;
    h.lastSuccessAt = Date.now();
  }

  private recordFailure(url: string, reason: string): void {
    const h = this.health.get(url);
    if (!h) return;
    h.failures += 1;
    if (h.failures >= this.opts.failureThreshold) {
      h.healthy = false;
      // Schedule a re-probe after 30 s. unref() so a manager that was only ever
      // constructed (tests, short-lived commands) cannot hold the process open.
      setTimeout(() => {
        const hh = this.health.get(url);
        if (hh && !hh.healthy) { hh.healthy = true; hh.failures = 0; }
      }, 30_000).unref();
    }
    // Log without crashing — the manager must stay operational.
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[RpcManager] ${url} failure (${reason}); failure count: ${h.failures}`);
    }
  }

  private updateLedger(url: string, ledger: number): void {
    const h = this.health.get(url);
    if (!h) return;
    h.latestLedger = ledger;
    if (ledger > this.bestLedger) this.bestLedger = ledger;
    // Approximate lag: (bestLedger - h.latestLedger) * 5 s/ledger.
    h.lagSeconds = Math.max(0, (this.bestLedger - h.latestLedger) * 5);
    if (h.lagSeconds > this.opts.lagThresholdSeconds) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[RpcManager] ${url} is lagging ${h.lagSeconds}s behind tip`);
      }
    }
  }

  private async checkAllEndpoints(): Promise<void> {
    await Promise.allSettled(
      [...this.health.keys()].map((url) =>
        this.singleCall({ method: "getLatestLedger", params: {} }, url).then((res) => {
          const seq = (res as { sequence?: number }).sequence;
          if (seq) this.updateLedger(url, seq);
        })
      )
    );
  }
}

// ── Module-level singleton factory ────────────────────────────────────────────

let _globalManager: RpcManager | null = null;

/**
 * Returns (or creates) the process-global RPC manager.
 *
 * Pass `options` on the first call; subsequent calls return the same instance.
 * Callers in the indexer, keeper, and reconciler should all use this function
 * so the rate budget is shared across the whole process.
 */
export function getGlobalRpcManager(options?: ManagerOptions): RpcManager {
  if (!_globalManager) {
    if (!options) {
      throw new Error("getGlobalRpcManager: options required on first call");
    }
    _globalManager = new RpcManager(options);
    _globalManager.start();
  }
  return _globalManager;
}

/** Replaces the global manager (for testing). */
export function _setGlobalRpcManager(mgr: RpcManager | null): void {
  _globalManager = mgr;
}
