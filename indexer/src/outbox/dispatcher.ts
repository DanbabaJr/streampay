import type { OutboxStore } from "./store.js";
import { outboxRetryDelayMs } from "./retry.js";
import type { OutboxTransport, TransportResult } from "./transport.js";
import type { OutboxMetrics } from "./metrics.js";

export interface OutboxDispatcherOptions {
  tickMs?: number;
  batchSize?: number;
  claimTimeoutMs?: number;
  maxDepth?: number;
  randomFn?: () => number;
}

export interface TickReport {
  reclaimed: number;
  delivered: number;
  retried: number;
  dead: number;
  stale: number;
  rejectedBackpressure: boolean;
}

/**
 * Drains outbox delivery intents with at-least-once semantics:
 * - claims are atomic per intent (guarded UPDATE), so duplicate dispatcher
 *   connections/processes never drain the same intent concurrently;
 * - in-flight claims that time out are reclaimed, so a dispatcher killed
 *   mid-delivery loses no intents;
 * - each active consumer gets its own per-tick rate budget, so one poison
 *   consumer cannot starve the others;
 * - terminal attempts dead-letter instead of blocking the queue head.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<TickReport> | null = null;

  constructor(
    private readonly store: OutboxStore,
    private readonly transport: OutboxTransport,
    private readonly metrics: OutboxMetrics,
    private readonly opts: OutboxDispatcherOptions = {}
  ) {}

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? 1000;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("Outbox dispatch tick failed:", err));
    }, tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Single non-reentrant tick; concurrent callers await the same run. */
  tick(): Promise<TickReport> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Drain everything due, ticking until quiet. Used by tests and startup catch-up. */
  async drainAll(maxTicks = 500): Promise<TickReport> {
    const total: TickReport = {
      reclaimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      stale: 0,
      rejectedBackpressure: false,
    };
    for (let i = 0; i < maxTicks; i++) {
      const report = await this.tick();
      total.reclaimed += report.reclaimed;
      total.delivered += report.delivered;
      total.retried += report.retried;
      total.dead += report.dead;
      total.stale += report.stale;
      total.rejectedBackpressure ||= report.rejectedBackpressure;
      if (report.delivered + report.retried + report.dead + report.reclaimed === 0) break;
    }
    return total;
  }

  private async runTick(): Promise<TickReport> {
    const nowMs = Date.now();
    const claimTimeoutMs = this.opts.claimTimeoutMs ?? 60_000;
    const batchSize = Math.max(1, this.opts.batchSize ?? 100);
    const report: TickReport = {
      reclaimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      stale: 0,
      rejectedBackpressure: false,
    };

    report.reclaimed = this.store.reclaimStale(claimTimeoutMs, nowMs);
    if (report.reclaimed > 0) this.metrics.observeReclaim(report.reclaimed);

    if (this.opts.maxDepth !== undefined) {
      const stats = this.store.stats();
      if (stats.depth.pending + stats.depth.in_flight >= this.opts.maxDepth) {
        this.metrics.observe("rejected_backpressure");
        report.rejectedBackpressure = true;
        this.metrics.sampleDepth(stats);
        return report;
      }
    }

    const tickSeconds = (this.opts.tickMs ?? 1000) / 1000;
    for (const consumer of this.store.listConsumers()) {
      if (consumer.status !== "active" || consumer.kind !== "push") continue;
      const budget =
        consumer.rate_limit_per_sec === null
          ? batchSize
          : Math.max(1, Math.min(batchSize, Math.floor(consumer.rate_limit_per_sec * tickSeconds)));
      const ids = this.store.dueIntents(consumer.id, budget, nowMs);
      for (const id of ids) {
        const claimToken = this.store.claimToken();
        const intent = this.store.claimIntent(id, claimToken, Date.now());
        if (!intent) {
          report.stale++;
          continue;
        }
        const consumerConfig = {
          id: consumer.id,
          url: consumer.url,
          secret: consumer.secret,
          max_attempts: consumer.max_attempts,
          rate_limit_per_sec: consumer.rate_limit_per_sec,
        };
        let result: TransportResult;
        try {
          result = await this.transport(intent, consumerConfig);
        } catch (err: unknown) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok) {
          if (this.store.markDelivered(intent.id, claimToken)) {
            report.delivered++;
            this.metrics.observe("delivered");
          }
        } else {
          const attempt = intent.attempts + 1;
          const delay = outboxRetryDelayMs(attempt + 1, this.opts.randomFn);
          const outcome = this.store.recordFailure(
            intent.id,
            claimToken,
            result.error ?? `HTTP ${result.status ?? "unknown"}`,
            consumer.max_attempts,
            Date.now() + delay
          );
          if (outcome === "dead") {
            report.dead++;
            this.metrics.observe("dead");
          } else if (outcome === "scheduled") {
            report.retried++;
            this.metrics.observe("retry");
          } else {
            report.stale++;
            this.metrics.observe("stale");
          }
        }
      }
    }

    this.metrics.sampleDepth(this.store.stats());
    return report;
  }
}
