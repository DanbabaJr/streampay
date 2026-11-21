/**
 * Sharded store (issue #578): one `StreamStore` (one SQLite database) per
 * shard, with a routing layer on top.
 *
 * Routing
 * -------
 * Every event is routed by its stream id through the `ShardMap`, so a single
 * stream's events always land in the same shard, in ledger order, and a shard
 * boundary can never split a stream. Stream-less events (`streamId === null`)
 * go to the designated shard 0 (`STREAMLESS_SHARD`); they touch no
 * projection, exactly as in the single-node store.
 *
 * Ordering / gap detection
 * ------------------------
 * Each shard reuses `StreamStore`'s own guarantees verbatim: `INSERT OR
 * IGNORE` on the event id (duplicate deliveries are journalled once) and the
 * monotonic projection (`excluded.last_ledger >= streams.last_ledger`), so a
 * late or out-of-order event can never rewind a stream. On top of that the
 * sharded store keeps one `IngestSequencer` (seeded from the merged
 * `maxLedgerByStream()` of all shards, so a restart measures "late" against
 * durable truth) and classifies every ingested event through it — the same
 * ledger-gap signal the single-node pipeline reports (#117 / #483), now
 * across shards. `ingestPage` groups a page by shard *without reordering
 * within a shard*, so per-stream ledger order inside a page is preserved.
 *
 * Cross-shard reads
 * -----------------
 * Single-stream reads (`getStream`, `getStreamHistory`, per-stream outbox
 * replay) route to exactly one shard. Address portfolios
 * (`listAddress`, `listStreamsByRecipient`, `listAllStreams`) fan out to all
 * shards, dedup by stream id (keeping the highest `lastLedger` — the copy a
 * rebalance may transiently leave on two shards), and merge in one stable
 * order: numeric stream ids ascending, then non-numeric ids
 * lexicographically. That total order is what makes the paged cursor stable:
 * a cursor is just the last stream id returned, and re-reading the same
 * cursor returns the same page.
 *
 * `getEventsAfter` merges the per-shard event journals in `(ledger, id)`
 * order and dedups by event id, so a consumer resuming from a `lastEventId`
 * sees the same global order no matter which shard the event lives on.
 *
 * Exactly-once outbox
 * -------------------
 * Outbox rows are journalled inside the same per-shard transaction as their
 * event (`OutboxStore.enqueueWithinTransaction`, `idempotency_key` unique),
 * so exactly-once holds per shard. Cross-shard merges (`listOutboxEvents`)
 * dedup by `idempotency_key` (== event id), so a row copied by a rebalance
 * that is still visible on both shards is delivered once.
 *
 * Global state
 * ------------
 * This store implements the pipeline's `IngestSink` (`ingestPage`,
 * `getState`, `setState`, `maxLedgerByStream`), so `IngestPipeline` can run
 * unchanged on top of it. Global keys (`cursor`, `lastLedger`,
 * `ingest_ledger`, …) live on shard 0, the coordinator shard; per-shard
 * lag is measured from `maxLedgerByStream()`, not from those keys, because
 * `ingestPage` records the same `lastLedger` on every shard it touches.
 */

import { StreamStore, type IngestSummary } from "../store.js";
import { IngestSequencer, type SequencerMetrics } from "../ingest/sequencer.js";
import { ShardMap, STREAMLESS_SHARD, parseNumericStreamId } from "./shard-map.js";
import type { DecodedEvent, Stream } from "../types.js";
import type { OutboxEventRow } from "../outbox/types.js";

export interface ShardedStoreOptions {
  shardCount?: number;
  /** Ids per contiguous block. Default 1000 (see ShardMap). */
  rangeSize?: bigint | number;
  /** One SQLite path per shard; `:memory:` entries are allowed. */
  paths?: string[];
  /** Shorthand for paths: `<basePath>-shard-<i>.sqlite`. */
  basePath?: string;
  /** A pre-built map (e.g. restored from `ShardMap.toJSON()`). */
  shardMap?: ShardMap;
}

/** One page of an address portfolio, with a stable opaque cursor. */
export interface AddressPage {
  streams: Stream[];
  /** Cursor for the next page, or `null` when this page is the last. */
  nextCursor: string | null;
}

export interface ShardCounts {
  shard: number;
  streams: number;
  events: number;
  outboxEvents: number;
}

/** Total order for stream ids: numeric ascending, then non-numeric lexicographically. */
export function compareStreamIds(a: string, b: string): number {
  const na = parseNumericStreamId(a);
  const nb = parseNumericStreamId(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Opaque cursor for `listAddressPaged`: base64url of the last stream id. */
export function encodeAddressCursor(lastStreamId: string): string {
  return Buffer.from(JSON.stringify({ lastStreamId }), "utf8").toString("base64url");
}

export function decodeAddressCursor(cursor: string): string {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { lastStreamId?: unknown };
  if (typeof parsed.lastStreamId !== "string") throw new Error("invalid address cursor");
  return parsed.lastStreamId;
}

export type ShardedEventRow = ReturnType<StreamStore["getEventsAfter"]>[number];

export class ShardedStore {
  readonly shardMap: ShardMap;
  readonly shards: StreamStore[];
  private readonly sequencer: IngestSequencer;

  constructor(opts: ShardedStoreOptions = {}) {
    const shardCount = opts.shardCount ?? 4;
    this.shardMap = opts.shardMap ?? new ShardMap({ shardCount, rangeSize: opts.rangeSize });
    if (this.shardMap.shardCount !== shardCount) {
      throw new Error(
        `ShardedStore: shardMap has ${this.shardMap.shardCount} shards, expected ${shardCount}`
      );
    }
    const paths = opts.paths ??
      (opts.basePath
        ? Array.from({ length: shardCount }, (_, i) => `${opts.basePath}-shard-${i}.sqlite`)
        : Array.from({ length: shardCount }, () => ":memory:"));
    if (paths.length !== shardCount) {
      throw new Error(`ShardedStore: ${paths.length} paths for ${shardCount} shards`);
    }
    this.shards = paths.map((path) => new StreamStore(path));
    // Seed the sequencer from durable state so restarts measure "late"
    // against what is already committed, per shard-merged stream.
    this.sequencer = new IngestSequencer(this.maxLedgerByStream());
  }

  close(): void {
    for (const shard of this.shards) shard.close();
  }

  /** Shard owning a stream id (`null` -> the designated stream-less shard). */
  shardForStreamId(id: string | null): number {
    return this.shardMap.shardForStreamId(id);
  }

  /** The `StreamStore` backing one shard. Used by the rebalancer/metrics. */
  shardStore(index: number): StreamStore {
    const store = this.shards[index];
    if (!store) throw new Error(`ShardedStore: no shard ${index}`);
    return store;
  }

  // ── Ingestion ────────────────────────────────────────────────────────────

  /** Route one event to its shard and ingest it. Returns the shard index. */
  ingest(event: DecodedEvent): number {
    this.sequencer.classify(event);
    const shard = this.shardForStreamId(event.streamId);
    this.shards[shard]!.ingest(event);
    return shard;
  }

  /**
   * Ingest a page, grouped by shard with per-shard order preserved (the
   * input order within each shard's slice is the input order, so a stream's
   * events stay in ledger order). Returns the merged summary.
   */
  ingestPage(events: DecodedEvent[], cursor: string | undefined, latestLedger: number): IngestSummary {
    const grouped = new Map<number, DecodedEvent[]>();
    for (const event of events) {
      this.sequencer.classify(event);
      const shard = this.shardForStreamId(event.streamId);
      const list = grouped.get(shard);
      if (list) list.push(event);
      else grouped.set(shard, [event]);
    }
    const summary: IngestSummary = { seen: events.length, inserted: 0, duplicates: 0, projectionSkips: 0 };
    for (const [shard, slice] of grouped) {
      const part = this.shards[shard]!.ingestPage(slice, cursor, latestLedger);
      summary.inserted += part.inserted;
      summary.duplicates += part.duplicates;
      summary.projectionSkips += part.projectionSkips;
    }
    return summary;
  }

  /** Per-stream ordering / ledger-gap signal, across all shards. */
  sequencerMetrics(): SequencerMetrics {
    return this.sequencer.metrics();
  }

  // ── IngestSink (global state lives on shard 0, the coordinator) ─────────

  getState(key: string): string | undefined {
    return this.shards[STREAMLESS_SHARD]!.getState(key);
  }

  setState(key: string, value: string): void {
    this.shards[STREAMLESS_SHARD]!.setState(key, value);
  }

  /** Highest projected ledger per stream, merged across shards (max wins). */
  maxLedgerByStream(): Map<string, number> {
    const merged = new Map<string, number>();
    for (const shard of this.shards) {
      for (const [streamId, ledger] of shard.maxLedgerByStream()) {
        const current = merged.get(streamId);
        if (current === undefined || ledger > current) merged.set(streamId, ledger);
      }
    }
    return merged;
  }

  // ── Single-stream reads (routed) ─────────────────────────────────────────

  getStream(id: string): Stream | undefined {
    return this.shards[this.shardForStreamId(id)]!.getStream(id);
  }

  getStreamHistory(streamId: string): ReturnType<StreamStore["getStreamHistory"]> {
    return this.shards[this.shardForStreamId(streamId)]!.getStreamHistory(streamId);
  }

  /** Per-stream outbox replay: routed to the stream's shard, seq-ordered. */
  replayOutbox(streamId: string, afterSeq: number, limit: number): ReturnType<StreamStore["outbox"]["replayEvents"]> {
    return this.shards[this.shardForStreamId(streamId)]!.outbox.replayEvents(streamId, afterSeq, limit);
  }

  // ── Cross-shard reads (fan out, dedup, stable merge) ─────────────────────

  private mergeStreams(rows: Stream[][]): Stream[] {
    const byId = new Map<string, Stream>();
    for (const row of rows.flat()) {
      const current = byId.get(row.streamId);
      if (!current || row.lastLedger > current.lastLedger) byId.set(row.streamId, row);
    }
    return [...byId.values()].sort((a, b) => compareStreamIds(a.streamId, b.streamId));
  }

  listAddress(address: string): Stream[] {
    return this.mergeStreams(this.shards.map((s) => s.listAddress(address)));
  }

  listStreamsByRecipient(recipient: string): Stream[] {
    return this.mergeStreams(this.shards.map((s) => s.listStreamsByRecipient(recipient)));
  }

  listAllStreams(): Stream[] {
    return this.mergeStreams(this.shards.map((s) => s.listAllStreams()));
  }

  /**
   * Paged address portfolio. Pages are slices of the same total order
   * `listAddress` returns, so a cursor handed out before a rebalance still
   * addresses the same position afterwards, and re-reading a cursor returns
   * the same page.
   */
  listAddressPaged(address: string, opts: { limit?: number; cursor?: string | null } = {}): AddressPage {
    const limit = Math.max(1, opts.limit ?? 50);
    const all = this.listAddress(address);
    let start = 0;
    if (opts.cursor) {
      const last = decodeAddressCursor(opts.cursor);
      start = all.findIndex((s) => compareStreamIds(s.streamId, last) > 0);
      if (start === -1) return { streams: [], nextCursor: null };
    }
    const page = all.slice(start, start + limit);
    const nextCursor =
      start + page.length < all.length && page.length > 0
        ? encodeAddressCursor(page[page.length - 1]!.streamId)
        : null;
    return { streams: page, nextCursor };
  }

  /**
   * Events after `lastEventId` in global `(ledger, id)` order. With a
   * `streamId` this routes to one shard; otherwise it merges every shard's
   * journal, dedups by event id, and returns the next 250 — the same
   * contract as `StreamStore.getEventsAfter`, across shards.
   */
  getEventsAfter(lastEventId: string, address?: string, streamId?: string): ShardedEventRow[] {
    if (streamId !== undefined) {
      return this.shards[this.shardForStreamId(streamId)]!.getEventsAfter(lastEventId, address, streamId);
    }
    const merged = new Map<string, ShardedEventRow>();
    for (const shard of this.shards) {
      const rows = shard.db
        .prepare("SELECT id, stream_id, name, ledger, ledger_closed_at, payload FROM events ORDER BY ledger ASC, id ASC")
        .all() as Array<{ id: string; stream_id: string | null; name: string; ledger: number; ledger_closed_at: string; payload: string }>;
      for (const r of rows) {
        if (merged.has(r.id)) continue;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(r.payload) as Record<string, unknown>;
        } catch {}
        const stream = r.stream_id === null ? undefined : this.getStream(r.stream_id);
        merged.set(r.id, {
          id: r.id,
          streamId: r.stream_id ?? "",
          name: r.name,
          ledger: r.ledger,
          ledgerClosedAt: r.ledger_closed_at,
          payload: parsed,
          stream,
        });
      }
    }
    const sorted = [...merged.values()].sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const at = sorted.findIndex((e) => e.id === lastEventId);
    if (at === -1) return [];
    const out: ShardedEventRow[] = [];
    for (const row of sorted.slice(at + 1, at + 1 + 250)) {
      if (address && row.stream && row.stream.sender !== address && row.stream.recipient !== address) continue;
      out.push(row);
    }
    return out;
  }

  /** All outbox journal rows across shards, deduped by idempotency key. */
  listOutboxEvents(): OutboxEventRow[] {
    const byKey = new Map<string, OutboxEventRow>();
    for (const shard of this.shards) {
      const rows = shard.db
        .prepare("SELECT * FROM outbox_events WHERE retracted_at IS NULL ORDER BY ledger ASC, event_id ASC")
        .all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const key = String(r.idempotency_key);
        if (byKey.has(key)) continue;
        byKey.set(key, {
          seq: Number(r.seq),
          idempotency_key: key,
          event_id: String(r.event_id),
          stream_id: r.stream_id === null ? null : String(r.stream_id),
          name: String(r.name),
          ledger: Number(r.ledger),
          ledger_cursor: String(r.ledger_cursor),
          payload: parsePayload(r.payload),
          ingested_at: String(r.ingested_at),
          retracted_at: (r.retracted_at as string | null) ?? null,
          retract_reason: (r.retract_reason as string | null) ?? null,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => a.ledger - b.ledger || (a.event_id < b.event_id ? -1 : 1));
  }

  /** Per-shard stream/event/outbox counts (rebalance verification input). */
  counts(): ShardCounts[] {
    return this.shards.map((shard, i) => ({
      shard: i,
      streams: count(shard, "streams"),
      events: count(shard, "events"),
      outboxEvents: count(shard, "outbox_events"),
    }));
  }

  /** Every event id in the system, for no-loss / no-duplication checks. */
  allEventIds(): Set<string> {
    const ids = new Set<string>();
    for (const shard of this.shards) {
      const rows = shard.db.prepare("SELECT id FROM events").all() as Array<{ id: string }>;
      for (const r of rows) ids.add(r.id);
    }
    return ids;
  }
}

function count(shard: StreamStore, table: string): number {
  return (shard.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
