/**
 * Sharding metrics (issue #578): per-shard lag and rebalance progress,
 * as a plain object and as Prometheus exposition text.
 *
 * Lag is measured against the highest projected ledger per shard
 * (`maxLedgerByStream()`), not against the global `lastLedger` state key —
 * that key is recorded on every shard a page touches, so it cannot tell
 * shards apart. When a tip ledger is supplied, `lag` is
 * `max(0, tipLedger - lastLedger)` per shard; without a tip, `lag` is
 * `null` and callers should compare `lastLedger` across shards (or against
 * the RPC tip they hold).
 */

import type { ShardedStore } from "./sharded-store.js";
import type { RebalanceProgress } from "./rebalancer.js";

export interface ShardLag {
  shard: number;
  streams: number;
  events: number;
  outboxEvents: number;
  /** Highest projected ledger on this shard, or 0 when it holds no streams. */
  lastLedger: number;
  /** Ledgers behind the supplied tip, or `null` when no tip was given. */
  lag: number | null;
}

export interface ShardingMetrics {
  shards: ShardLag[];
  totalStreams: number;
  totalEvents: number;
  /** Highest projected ledger across all shards. */
  maxLastLedger: number;
  rebalance: RebalanceProgress[];
}

export function collectShardingMetrics(
  store: ShardedStore,
  opts: { tipLedger?: number; rebalance?: RebalanceProgress[] } = {}
): ShardingMetrics {
  const counts = store.counts();
  const maxByShard = store.shards.map((shard) => {
    let max = 0;
    for (const ledger of shard.maxLedgerByStream().values()) max = Math.max(max, ledger);
    return max;
  });
  const shards: ShardLag[] = counts.map((c, i) => ({
    shard: c.shard,
    streams: c.streams,
    events: c.events,
    outboxEvents: c.outboxEvents,
    lastLedger: maxByShard[i] ?? 0,
    lag: opts.tipLedger === undefined ? null : Math.max(0, opts.tipLedger - (maxByShard[i] ?? 0)),
  }));
  return {
    shards,
    totalStreams: shards.reduce((n, s) => n + s.streams, 0),
    totalEvents: shards.reduce((n, s) => n + s.events, 0),
    maxLastLedger: shards.reduce((m, s) => Math.max(m, s.lastLedger), 0),
    rebalance: opts.rebalance ?? [],
  };
}

/** Prometheus-style text render of `collectShardingMetrics` output. */
export function renderShardingMetricsPrometheus(metrics: ShardingMetrics): string {
  const lines: string[] = [
    "# HELP streampay_shard_streams Streams projected on this shard",
    "# TYPE streampay_shard_streams gauge",
    ...metrics.shards.map((s) => `streampay_shard_streams{shard="${s.shard}"} ${s.streams}`),
    "# HELP streampay_shard_events Events journalled on this shard",
    "# TYPE streampay_shard_events gauge",
    ...metrics.shards.map((s) => `streampay_shard_events{shard="${s.shard}"} ${s.events}`),
    "# HELP streampay_shard_last_ledger Highest projected ledger on this shard",
    "# TYPE streampay_shard_last_ledger gauge",
    ...metrics.shards.map((s) => `streampay_shard_last_ledger{shard="${s.shard}"} ${s.lastLedger}`),
  ];
  if (metrics.shards.some((s) => s.lag !== null)) {
    lines.push(
      "# HELP streampay_shard_lag_ledgers Ledgers this shard is behind the tip",
      "# TYPE streampay_shard_lag_ledgers gauge",
      ...metrics.shards.map((s) => `streampay_shard_lag_ledgers{shard="${s.shard}"} ${s.lag ?? 0}`)
    );
  }
  for (const r of metrics.rebalance) {
    lines.push(
      `# HELP streampay_rebalance_events_copied Events copied for rebalance ${r.moveId}`,
      "# TYPE streampay_rebalance_events_copied gauge",
      `streampay_rebalance_events_copied{move="${r.moveId}"} ${r.eventsCopied}`,
      "# HELP streampay_rebalance_streams_copied Streams copied for rebalance",
      "# TYPE streampay_rebalance_streams_copied gauge",
      `streampay_rebalance_streams_copied{move="${r.moveId}"} ${r.streamsCopied}`
    );
  }
  return lines.join("\n") + "\n";
}
