/**
 * Horizontal sharding by stream-id range (issue #578).
 *
 * - `ShardMap` — deterministic stream-id range -> shard assignment.
 * - `ShardedStore` — routing layer over one `StreamStore` per shard.
 * - `ShardRebalancer` — online, checkpointed range moves with crash resume.
 * - `collectShardingMetrics` / `renderShardingMetricsPrometheus` — per-shard
 *   lag and rebalance progress.
 */
export { ShardMap, STREAMLESS_SHARD, parseNumericStreamId, hashStreamId } from "./shard-map.js";
export type { ShardRange, ShardMapOptions } from "./shard-map.js";
export {
  ShardedStore,
  compareStreamIds,
  encodeAddressCursor,
  decodeAddressCursor,
} from "./sharded-store.js";
export type { ShardedStoreOptions, AddressPage, ShardCounts, ShardedEventRow } from "./sharded-store.js";
export { ShardRebalancer } from "./rebalancer.js";
export type { MoveCheckpoint, MoveStatus, RebalanceProgress, MoveOptions } from "./rebalancer.js";
export { collectShardingMetrics, renderShardingMetricsPrometheus } from "./metrics.js";
export type { ShardLag, ShardingMetrics } from "./metrics.js";
