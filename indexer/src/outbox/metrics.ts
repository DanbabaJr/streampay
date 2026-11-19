import type { OutboxStats } from "./types.js";

export type DispatchOutcome = "delivered" | "retry" | "dead" | "stale" | "rejected_backpressure";

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
