import type { OutboxStats } from "./types.js";

export type DispatchOutcome = "delivered" | "retry" | "dead" | "stale" | "rejected_backpressure";

/**
 * Reduce a consumer/webhook URL to a low-cardinality label value (the host,
 * lowercased) so the destination breakdown stays safe to export. Anything that
 * is not a valid URL is bucketed as `unknown` rather than leaking a raw string.
 */
export function destinationHost(url: string | null | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

/**
 * Prometheus text-exposition metrics for the outbox, following the hand
 * rolled exposition style of infra/indexer (no client dependency).
 * Counters accumulate in-process; depth/lag are snapshotted at scrape time
 * from the store. The divergence alarm fires when total intent depth grows
 * monotonically across `alarmWindow` consecutive samples and exceeds
 * `alarmMinDepth` — i.e. the drain is falling behind ingestion without bound.
 */
export class OutboxMetrics {
  private readonly counters: Partial<Record<DispatchOutcome, number>> = {};
  private readonly byDestination: Map<string, Partial<Record<DispatchOutcome, number>>> = new Map();
  private reclaims = 0;
  private retracts = 0;
  private readonly depthHistory: number[] = [];
  private readonly alarmWindow: number;
  private readonly alarmMinDepth: number;
  private alarmActive = false;

  constructor(opts: { alarmWindow?: number; alarmMinDepth?: number } = {}) {
    this.alarmWindow = opts.alarmWindow ?? 8;
    this.alarmMinDepth = opts.alarmMinDepth ?? 1_000;
  }

  observe(outcome: DispatchOutcome, n = 1): void {
    this.counters[outcome] = (this.counters[outcome] ?? 0) + n;
  }

  /**
   * Second, additive breakdown of dispatch outcomes keyed by the destination
   * host (the webhook/consumer endpoint). Mirrors `observe` but never replaces
   * it: `streampay_outbox_dispatch_total` stays the unlabelled aggregate so
   * existing dashboards/alerts are unaffected. This feeds the per-destination
   * webhook delivery-success panel.
   */
  observeDelivery(destination: string | null | undefined, outcome: DispatchOutcome, n = 1): void {
    const host = destinationHost(destination);
    const bucket = this.byDestination.get(host) ?? {};
    bucket[outcome] = (bucket[outcome] ?? 0) + n;
    this.byDestination.set(host, bucket);
  }

  observeReclaim(n: number): void {
    this.reclaims += n;
  }

  observeRetract(events: number, intents: number): void {
    this.retracts += events;
    if (intents > 0) this.observe("dead", intents);
  }

  /** Feed one depth sample per dispatcher tick; returns alarm state. */
  sampleDepth(stats: OutboxStats): boolean {
    const depth = stats.depth.pending + stats.depth.in_flight;
    this.depthHistory.push(depth);
    if (this.depthHistory.length > this.alarmWindow + 1) this.depthHistory.shift();
    if (this.depthHistory.length <= this.alarmWindow) {
      this.alarmActive = false;
      return this.alarmActive;
    }
    let strictlyGrowing = true;
    const tail = this.depthHistory.slice(this.depthHistory.length - this.alarmWindow - 1);
    for (let i = 1; i < tail.length; i++) {
      if (tail[i] <= tail[i - 1]) {
        strictlyGrowing = false;
        break;
      }
    }
    this.alarmActive = strictlyGrowing && depth > this.alarmMinDepth;
    return this.alarmActive;
  }

  isAlarmActive(): boolean {
    return this.alarmActive;
  }

  render(stats: OutboxStats): string {
    const lines: string[] = [];
    const push = (help: string, type: string, name: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) {
        lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
      }
    };

    push(
      "Outbox delivery intents by state.",
      "gauge",
      "streampay_outbox_depth",
      (Object.keys(stats.depth) as Array<keyof OutboxStats["depth"]>).map((s) => [
        `state="${s}"`,
        stats.depth[s],
      ])
    );
    push("Age of the oldest pending outbox intent in seconds.", "gauge", "streampay_outbox_lag_seconds", [
      ["", stats.oldestPendingAgeMs / 1000],
    ]);
    push("Monotonic outbox event sequence high-water mark.", "gauge", "streampay_outbox_max_seq", [
      ["", stats.maxSeq],
    ]);
    push("Ingested outbox events in the journal.", "gauge", "streampay_outbox_events", [["", stats.events]]);
    push(
      "Outbox dispatch outcomes.",
      "counter",
      "streampay_outbox_dispatch_total",
      (Object.keys(this.counters) as DispatchOutcome[]).map((k) => [`outcome="${k}"`, this.counters[k] ?? 0])
    );
    const outcomeOrder: DispatchOutcome[] = ["delivered", "retry", "dead", "stale", "rejected_backpressure"];
    push(
      "Outbox dispatch outcomes partitioned by destination host (webhook delivery success per endpoint).",
      "counter",
      "streampay_outbox_delivery_total",
      [...this.byDestination.keys()]
        .sort()
        .flatMap((host) =>
          outcomeOrder
            .filter((o) => this.byDestination.get(host)?.[o] !== undefined)
            .map((o) => [`destination="${host}",outcome="${o}"`, this.byDestination.get(host)![o]!] as [string, number])
        )
    );
    push("Outbox claims reclaimed after dispatcher crash/timeout.", "counter", "streampay_outbox_reclaims_total", [
      ["", this.reclaims],
    ]);
    push("Outbox events retracted by reorg reconciliation.", "counter", "streampay_outbox_retracted_total", [
      ["", this.retracts],
    ]);
    push(
      "1 when outbox depth grows monotonically across the alarm window (divergence alarm).",
      "gauge",
      "streampay_outbox_divergence_alarm",
      [["", this.alarmActive ? 1 : 0]]
    );
    return `${lines.join("\n")}\n`;
  }
}
