/**
 * Shard map for horizontal sharding by stream-id range (issue #578).
 *
 * Stream ids are numeric (`u64` on chain, e.g. `"7"`). The id space is cut
 * into contiguous blocks of `rangeSize` ids — `[0, rangeSize)`,
 * `[rangeSize, 2*rangeSize)`, … — and blocks are assigned round-robin to
 * shards: block `k` belongs to shard `k % shardCount` by default. A block is
 * therefore a *range*, and a single stream id belongs to exactly one block,
 * so a shard boundary can never split a single stream's event order.
 *
 * The rebalancer moves whole blocks: it records an override
 * `rangeStart -> shard` for a block, and `shardForStreamId` consults the
 * override first. The default assignment is pure arithmetic, so a fresh
 * process with the same `shardCount`/`rangeSize` computes the same map
 * without any stored state; only moves need persisting (the rebalancer
 * checkpoints them durably — see `rebalancer.ts`).
 *
 * Non-numeric stream ids (e.g. the `batch_withdraw_summary` event, which the
 * contract publishes keyed by a recipient address) have no numeric range.
 * They are hashed with FNV-1a and the hash is treated as a numeric id, so
 * they are still deterministic and still land on exactly one shard.
 *
 * Stream-less events (`streamId === null`) have no id at all. They are
 * routed to the designated shard, {@link STREAMLESS_SHARD} (shard 0), by
 * `ShardedStore` — the map itself never sees them.
 */

/** Designated shard for stream-less events (`streamId === null`). */
export const STREAMLESS_SHARD = 0;

export interface ShardRange {
  /** Inclusive start of the block. */
  start: bigint;
  /** Exclusive end of the block (`start + rangeSize`). */
  end: bigint;
  shard: number;
}

export interface ShardMapOptions {
  /** Number of shards. Must be >= 1. */
  shardCount: number;
  /** Ids per contiguous block. Must be >= 1. Default 1000. */
  rangeSize?: bigint | number;
  /** Pre-existing block overrides, as `[rangeStart, shard]` pairs. */
  overrides?: Iterable<readonly [bigint, number]>;
}

/** Parse a decimal stream id, or `null` when it is not a plain integer. */
export function parseNumericStreamId(id: string): bigint | null {
  if (!/^\d+$/.test(id)) return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

/** FNV-1a 64-bit hash, for deterministic placement of non-numeric ids. */
export function hashStreamId(id: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < id.length; i++) {
    hash ^= BigInt(id.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

export class ShardMap {
  readonly shardCount: number;
  readonly rangeSize: bigint;
  /** Block overrides recorded by the rebalancer: rangeStart -> shard. */
  private readonly overrides = new Map<string, number>();

  constructor(opts: ShardMapOptions) {
    if (!Number.isInteger(opts.shardCount) || opts.shardCount < 1) {
      throw new Error(`ShardMap: shardCount must be a positive integer, got ${opts.shardCount}`);
    }
    const rangeSize = BigInt(opts.rangeSize ?? 1000n);
    if (rangeSize < 1n) throw new Error(`ShardMap: rangeSize must be >= 1, got ${rangeSize}`);
    this.shardCount = opts.shardCount;
    this.rangeSize = rangeSize;
    if (opts.overrides) {
      for (const [start, shard] of opts.overrides) this.setOverride(start, shard);
    }
  }

  /** Default shard for a block start, before overrides. */
  defaultShardForRangeStart(start: bigint): number {
    if (start < 0n) throw new Error(`ShardMap: range start must be >= 0, got ${start}`);
    return Number((start / this.rangeSize) % BigInt(this.shardCount));
  }

  /** Inclusive start of the block containing a numeric id. */
  rangeStartForNumericId(id: bigint): bigint {
    if (id < 0n) throw new Error(`ShardMap: stream id must be >= 0, got ${id}`);
    return (id / this.rangeSize) * this.rangeSize;
  }

  /** Block containing a stream id (numeric ids use their value, others their hash). */
  rangeForStreamId(id: string): ShardRange {
    const numeric = parseNumericStreamId(id);
    const start = this.rangeStartForNumericId(numeric ?? hashStreamId(id));
    return { start, end: start + this.rangeSize, shard: this.shardForRangeStart(start) };
  }

  /** Start of the block containing a stream id. */
  rangeStartForStreamId(id: string): bigint {
    return this.rangeForStreamId(id).start;
  }

  /** Shard owning a block, honouring rebalancer overrides. */
  shardForRangeStart(start: bigint): number {
    const override = this.overrides.get(start.toString());
    return override ?? this.defaultShardForRangeStart(start);
  }

  /** Shard owning a stream id. `null` (stream-less) maps to {@link STREAMLESS_SHARD}. */
  shardForStreamId(id: string | null): number {
    if (id === null) return STREAMLESS_SHARD;
    return this.rangeForStreamId(id).shard;
  }

  /**
   * Record that a whole block moved to another shard. The caller must have
   * copied the block's data first — the map switch is the commit point of a
   * rebalance (see `rebalancer.ts`).
   */
  moveRange(start: bigint, toShard: number): void {
    this.assertShard(toShard);
    if (start < 0n || start % this.rangeSize !== 0n) {
      throw new Error(`ShardMap.moveRange: ${start} is not a block start (rangeSize ${this.rangeSize})`);
    }
    if (this.defaultShardForRangeStart(start) === toShard) this.overrides.delete(start.toString());
    else this.overrides.set(start.toString(), toShard);
  }

  /** Alias for `moveRange`, for callers that think in overrides. */
  setOverride(start: bigint, shard: number): void {
    this.moveRange(start, shard);
  }

  /** Drop a recorded override, restoring the default assignment for a block. */
  clearOverride(start: bigint): void {
    this.overrides.delete(start.toString());
  }

  /** Current overrides, as `[rangeStart, shard]` pairs sorted by range start. */
  listOverrides(): Array<readonly [bigint, number]> {
    return [...this.overrides.entries()]
      .map(([start, shard]) => [BigInt(start), shard] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** Serialisable form: enough to rebuild an identical map. */
  toJSON(): { shardCount: number; rangeSize: string; overrides: Array<[string, number]> } {
    return {
      shardCount: this.shardCount,
      rangeSize: this.rangeSize.toString(),
      overrides: this.listOverrides().map(([start, shard]) => [start.toString(), shard]),
    };
  }

  static fromJSON(json: { shardCount: number; rangeSize: string; overrides: Array<[string, number]> }): ShardMap {
    return new ShardMap({
      shardCount: json.shardCount,
      rangeSize: BigInt(json.rangeSize),
      overrides: json.overrides.map(([start, shard]) => [BigInt(start), shard] as const),
    });
  }

  private assertShard(shard: number): void {
    if (!Number.isInteger(shard) || shard < 0 || shard >= this.shardCount) {
      throw new Error(`ShardMap: shard ${shard} out of range [0, ${this.shardCount})`);
    }
  }
}
