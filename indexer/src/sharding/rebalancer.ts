/**
 * Online, checkpointed range rebalancer (issue #578).
 *
 * A rebalance moves one whole stream-id block (a `ShardMap` range) from a
 * source shard to a target shard:
 *
 *   1. **Copy** — streams in the range are copied from source to target in
 *      batches (streams, their events, their outbox journal rows and their
 *      outbox intents). Every copy is idempotent: events use
 *      `INSERT OR IGNORE` on the event id, outbox rows on `idempotency_key`,
 *      and stream rows use the same monotonic upsert as `StreamStore`
 *      (`excluded.last_ledger >= streams.last_ledger`), so re-copying a
 *      batch after a crash can neither duplicate nor rewind anything.
 *      After each batch the checkpoint is written durably (see below)
 *      *before* the next batch starts.
 *   2. **Catch-up** — the range is re-copied (up to 3 passes) until a pass
 *      inserts nothing new, so events ingested into the source while the
 *      copy was running are picked up.
 *   3. **Verify** — stream ids, event ids and per-stream `lastLedger` must
 *      match between source and target for the range. On mismatch the move
 *      fails *without* switching the map, so the source stays authoritative
 *      and no data is lost.
 *   4. **Switch** — the shard map override for the range flips to the
 *      target. This is the commit point: from here reads route to the target.
 *   5. **Delete** — the source copy is deleted. If the process dies between
 *      switch and delete, the resumed move sees status `switching` and
 *      finishes the delete; reads already route to the target, so the
 *      leftover source copy is invisible.
 *
 * Crash safety
 * ------------
 * The checkpoint lives in shard 0's `indexer_state` table
 * (`shard_move:<moveId>`), written through `ShardedStore.setState`, so it
 * survives a process restart on file-backed databases. A move interrupted
 * at any point resumes from `lastCopiedStreamId`: already-copied streams
 * are skipped, the rest are copied, and the move proceeds to switch/delete.
 * `resume(moveId)` / `resumeAllIncomplete()` are the recovery entry points.
 *
 * The whole move runs synchronously in one JS turn: no ingestion can
 * interleave between verify and switch, so the switch+delete window is
 * atomic in-process. A multi-process deployment would additionally need a
 * write fence for the moving range during that window — that is a
 * documented follow-up, not something this single-process indexer can
 * enforce (see README).
 *
 * Not moved: webhook deliveries and dead-letter rows. They are per-endpoint
 * dispatch state, not projections; moving them would risk duplicate sends,
 * and deleting them would lose pending deliveries. They stay on the source
 * shard, where their stored payload still lets them dispatch.
 */

import { ShardedStore, compareStreamIds } from "./sharded-store.js";

export type MoveStatus = "copying" | "switching" | "done" | "failed";

export interface MoveCheckpoint {
  moveId: string;
  rangeStart: string;
  rangeEnd: string;
  fromShard: number;
  toShard: number;
  status: MoveStatus;
  lastCopiedStreamId: string | null;
  streamsCopied: number;
  totalStreams: number;
  eventsCopied: number;
  totalEvents: number;
  updatedAt: string;
}

export interface RebalanceProgress {
  moveId: string;
  status: MoveStatus;
  rangesMoved: number;
  rangesTotal: number;
  streamsCopied: number;
  totalStreams: number;
  eventsCopied: number;
  totalEvents: number;
  lastCopiedStreamId: string | null;
  fromShard: number;
  toShard: number;
}

export interface MoveOptions {
  /** Streams copied per checkpointed batch. Default 5. */
  batchSize?: number;
  /**
   * Test/chaos hook: throw a simulated crash after this many batches have
   * been checkpointed in this invocation. The checkpoint is already durable
   * at that point, so `resume()` continues the move.
   */
  failAfterBatches?: number;
  /** Called after each batch is checkpointed. */
  onBatch?: () => void;
}

const STREAM_COLUMNS =
  "stream_id, sender, recipient, token, deposit, withdrawn, start_time, end_time, cancelable, status, cancelled_by, recipient_amount, sender_amount, refund_target, last_ledger, updated_at";

export class ShardRebalancer {
  constructor(private readonly store: ShardedStore) {}

  // ── Checkpoints (durable, on shard 0 / coordinator) ─────────────────────

  checkpoint(moveId: string): MoveCheckpoint | undefined {
    const raw = this.store.getState(`shard_move:${moveId}`);
    return raw ? (JSON.parse(raw) as MoveCheckpoint) : undefined;
  }

  listMoves(): string[] {
    const raw = this.store.getState("shard_move_ids");
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  progress(moveId: string): RebalanceProgress | undefined {
    const cp = this.checkpoint(moveId);
    if (!cp) return undefined;
    return {
      moveId: cp.moveId,
      status: cp.status,
      rangesMoved: cp.status === "done" ? 1 : 0,
      rangesTotal: 1,
      streamsCopied: cp.streamsCopied,
      totalStreams: cp.totalStreams,
      eventsCopied: cp.eventsCopied,
      totalEvents: cp.totalEvents,
      lastCopiedStreamId: cp.lastCopiedStreamId,
      fromShard: cp.fromShard,
      toShard: cp.toShard,
    };
  }

  private saveCheckpoint(cp: MoveCheckpoint): void {
    cp.updatedAt = new Date().toISOString();
    this.store.setState(`shard_move:${cp.moveId}`, JSON.stringify(cp));
    const ids = this.listMoves();
    if (!ids.includes(cp.moveId)) {
      this.store.setState("shard_move_ids", JSON.stringify([...ids, cp.moveId]));
    }
  }

  // ── Moves ────────────────────────────────────────────────────────────────

  /** Move one block; resumes an interrupted move with the same id. */
  startMove(rangeStart: bigint | number | string, toShard: number, opts: MoveOptions = {}): MoveCheckpoint {
    const start = BigInt(rangeStart);
    const map = this.store.shardMap;
    const end = start + map.rangeSize;
    const fromShard = map.shardForRangeStart(start);
    if (toShard < 0 || toShard >= map.shardCount) {
      throw new Error(`ShardRebalancer: target shard ${toShard} out of range`);
    }
    if (fromShard === toShard) {
      const cp = this.checkpoint(moveIdFor(start, fromShard, toShard)) ?? newCheckpoint(start, end, fromShard, toShard);
      cp.status = "done";
      this.saveCheckpoint(cp);
      return cp;
    }
    const moveId = moveIdFor(start, fromShard, toShard);
    const existing = this.checkpoint(moveId);
    if (existing?.status === "done") return existing;

    // Resuming a move that already switched: only the source delete is left.
    if (existing?.status === "switching") {
      this.deleteSourceCopy(existing);
      existing.status = "done";
      this.saveCheckpoint(existing);
      return existing;
    }

    const source = this.store.shardStore(fromShard);
    const target = this.store.shardStore(toShard);
    const cp: MoveCheckpoint =
      existing ?? newCheckpoint(start, end, fromShard, toShard);
    cp.status = "copying";
    const streamsInRange = source
      .listAllStreams()
      .filter((s) => map.rangeStartForStreamId(s.streamId) === start)
      .sort((a, b) => compareStreamIds(a.streamId, b.streamId));
    cp.totalStreams = streamsInRange.length;
    cp.totalEvents = countEvents(source, streamsInRange.map((s) => s.streamId));
    this.saveCheckpoint(cp);

    // Main copy pass, skipping streams already checkpointed as copied.
    const remaining = streamsInRange.filter(
      (s) => cp.lastCopiedStreamId === null || compareStreamIds(s.streamId, cp.lastCopiedStreamId) > 0
    );
    const batchSize = Math.max(1, opts.batchSize ?? 5);
    let batchesThisRun = 0;
    for (let i = 0; i < remaining.length; i += batchSize) {
      const batch = remaining.slice(i, i + batchSize);
      const copied = this.copyBatch(source, target, batch);
      cp.streamsCopied += batch.length;
      cp.eventsCopied += copied.eventsInBatch;
      cp.lastCopiedStreamId = batch[batch.length - 1]!.streamId;
      this.saveCheckpoint(cp);
      batchesThisRun += 1;
      opts.onBatch?.();
      if (opts.failAfterBatches !== undefined && batchesThisRun >= opts.failAfterBatches) {
        throw new Error(`simulated crash mid-rebalance after ${batchesThisRun} batch(es) of ${moveId}`);
      }
    }

    // Catch-up: re-copy until a pass inserts nothing new, so events that
    // landed on the source during the copy are not left behind.
    for (let pass = 0; pass < 3; pass++) {
      const fresh = this.copyBatch(source, target, streamsInRange);
      if (fresh.newEvents === 0 && fresh.newStreams === 0) break;
    }

    // Verify before the commit point: counts and ids must match exactly.
    const mismatch = this.verifyRange(source, target, start);
    if (mismatch) {
      cp.status = "failed";
      this.saveCheckpoint(cp);
      throw new Error(`rebalance ${moveId} failed verification: ${mismatch}`);
    }

    // Commit point, then delete the source copy.
    cp.status = "switching";
    this.saveCheckpoint(cp);
    map.moveRange(start, toShard);
    this.deleteSourceCopy(cp);
    cp.status = "done";
    this.saveCheckpoint(cp);
    return cp;
  }

  /** Resume one interrupted move (no-op when it is already done). */
  resume(moveId: string, opts: MoveOptions = {}): MoveCheckpoint {
    const cp = this.checkpoint(moveId);
    if (!cp) throw new Error(`ShardRebalancer.resume: unknown move ${moveId}`);
    if (cp.status === "done") return cp;
    return this.startMove(BigInt(cp.rangeStart), cp.toShard, opts);
  }

  /** Resume every move that is not done. Returns the final checkpoints. */
  resumeAllIncomplete(opts: MoveOptions = {}): MoveCheckpoint[] {
    const out: MoveCheckpoint[] = [];
    for (const moveId of this.listMoves()) {
      const cp = this.checkpoint(moveId);
      if (cp && cp.status !== "done") out.push(this.resume(moveId, opts));
    }
    return out;
  }

  // ── Copy / verify / delete ───────────────────────────────────────────────

  /**
   * Copy one batch of streams (rows, events, outbox journal + intents) to
   * the target. Idempotent: re-running it inserts nothing new.
   */
  private copyBatch(
    source: ReturnType<ShardedStore["shardStore"]>,
    target: ReturnType<ShardedStore["shardStore"]>,
    batch: Array<{ streamId: string }>
  ): { eventsInBatch: number; newEvents: number; newStreams: number } {
    const ids = batch.map((s) => s.streamId);
    let eventsInBatch = 0;
    let newEvents = 0;
    let newStreams = 0;
    if (ids.length === 0) return { eventsInBatch, newEvents, newStreams };

    const streamRows = source.db
      .prepare(`SELECT ${STREAM_COLUMNS} FROM streams WHERE stream_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Array<Record<string, unknown>>;
    const eventRows = source.db
      .prepare(
        `SELECT id, stream_id, name, ledger, ledger_closed_at, tx_hash, trace_id, span_id, payload FROM events WHERE stream_id IN (${ids.map(() => "?").join(",")}) ORDER BY ledger ASC, id ASC`
      )
      .all(...ids) as Array<Record<string, unknown>>;
    eventsInBatch = eventRows.length;
    const outboxRows = source.db
      .prepare(
        `SELECT seq, idempotency_key, event_id, stream_id, name, ledger, ledger_cursor, payload, ingested_at, retracted_at, retract_reason FROM outbox_events WHERE stream_id IN (${ids.map(() => "?").join(",")}) ORDER BY ledger ASC, event_id ASC`
      )
      .all(...ids) as Array<Record<string, unknown>>;
    const intentRows = source.db
      .prepare(
        `SELECT i.* FROM outbox_intents i JOIN outbox_events e ON e.seq = i.event_seq WHERE e.stream_id IN (${ids.map(() => "?").join(",")})`
      )
      .all(...ids) as Array<Record<string, unknown>>;

    target.db.transaction(() => {
      const upsertStream = target.db.prepare(
        `INSERT INTO streams(${STREAM_COLUMNS}) VALUES (${STREAM_COLUMNS.split(",").map(() => "?").join(",")})
         ON CONFLICT(stream_id) DO UPDATE SET sender=excluded.sender, recipient=excluded.recipient, token=excluded.token,
         deposit=excluded.deposit, withdrawn=excluded.withdrawn, start_time=excluded.start_time, end_time=excluded.end_time,
         cancelable=excluded.cancelable, status=excluded.status, cancelled_by=excluded.cancelled_by,
         recipient_amount=excluded.recipient_amount, sender_amount=excluded.sender_amount, refund_target=excluded.refund_target,
         last_ledger=excluded.last_ledger, updated_at=excluded.updated_at
         WHERE excluded.last_ledger >= streams.last_ledger`
      );
      for (const row of streamRows) {
        const res = upsertStream.run(
          row.stream_id, row.sender, row.recipient, row.token, row.deposit, row.withdrawn,
          row.start_time, row.end_time, row.cancelable, row.status, row.cancelled_by,
          row.recipient_amount, row.sender_amount, row.refund_target, row.last_ledger, row.updated_at
        );
        newStreams += res.changes;
      }
      const insertEvent = target.db.prepare(
        `INSERT OR IGNORE INTO events (id, stream_id, name, ledger, ledger_closed_at, tx_hash, trace_id, span_id, payload) VALUES (?,?,?,?,?,?,?,?,?)`
      );
      for (const row of eventRows) {
        newEvents += insertEvent.run(
          row.id, row.stream_id, row.name, row.ledger, row.ledger_closed_at,
          row.tx_hash, row.trace_id, row.span_id, row.payload
        ).changes;
      }
      // Outbox seqs are per-database, so the target assigns its own; the
      // source->target seq map below re-points the intents at them.
      const seqByKey = new Map<string, number>();
      const insertOutbox = target.db.prepare(
        `INSERT OR IGNORE INTO outbox_events (idempotency_key, event_id, stream_id, name, ledger, ledger_cursor, payload, ingested_at, retracted_at, retract_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      const selectSeq = target.db.prepare("SELECT seq FROM outbox_events WHERE idempotency_key = ?");
      for (const row of outboxRows) {
        insertOutbox.run(
          row.idempotency_key, row.event_id, row.stream_id, row.name, row.ledger,
          row.ledger_cursor, row.payload, row.ingested_at, row.retracted_at, row.retract_reason
        );
        const found = selectSeq.get(row.idempotency_key) as { seq: number } | undefined;
        if (found) seqByKey.set(String(row.idempotency_key), found.seq);
      }
      const sourceSeqToTarget = new Map<number, number>();
      for (const row of outboxRows) {
        const targetSeq = seqByKey.get(String(row.idempotency_key));
        if (targetSeq !== undefined) sourceSeqToTarget.set(Number(row.seq), targetSeq);
      }
      const insertIntent = target.db.prepare(
        `INSERT OR IGNORE INTO outbox_intents (idempotency_key, consumer_id, event_seq, event_id, state, attempts, next_retry_at, claimed_at, claim_token, delivered_at, dead_reason, last_error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const row of intentRows) {
        const targetSeq = sourceSeqToTarget.get(Number(row.event_seq));
        if (targetSeq === undefined) continue;
        insertIntent.run(
          row.idempotency_key, row.consumer_id, targetSeq, row.event_id, row.state,
          row.attempts, row.next_retry_at, row.claimed_at, row.claim_token,
          row.delivered_at, row.dead_reason, row.last_error, row.created_at
        );
      }
    })();
    return { eventsInBatch, newEvents, newStreams };
  }

  /** Stream/event/lastLedger equality for a range, or a mismatch description. */
  private verifyRange(
    source: ReturnType<ShardedStore["shardStore"]>,
    target: ReturnType<ShardedStore["shardStore"]>,
    start: bigint
  ): string | null {
    const map = this.store.shardMap;
    const inRange = (id: string): boolean => map.rangeStartForStreamId(id) === start;
    const sourceStreams = source.listAllStreams().filter((s) => inRange(s.streamId));
    const targetStreams = target.listAllStreams().filter((s) => inRange(s.streamId));
    const sourceIds = new Set(sourceStreams.map((s) => s.streamId));
    const targetIds = new Set(targetStreams.map((s) => s.streamId));
    if (sourceIds.size !== targetIds.size || [...sourceIds].some((id) => !targetIds.has(id))) {
      return `stream ids differ (source ${sourceIds.size}, target ${targetIds.size})`;
    }
    for (const s of sourceStreams) {
      const t = targetStreams.find((x) => x.streamId === s.streamId);
      if (!t || t.lastLedger !== s.lastLedger) {
        return `stream ${s.streamId} lastLedger differs (source ${s.lastLedger}, target ${t?.lastLedger})`;
      }
    }
    const eventIds = (store: ReturnType<ShardedStore["shardStore"]>): Set<string> => {
      const rows = store.db.prepare("SELECT id, stream_id FROM events").all() as Array<{ id: string; stream_id: string }>;
      return new Set(rows.filter((r) => inRange(r.stream_id)).map((r) => r.id));
    };
    const se = eventIds(source);
    const te = eventIds(target);
    if (se.size !== te.size || [...se].some((id) => !te.has(id))) {
      return `event ids differ (source ${se.size}, target ${te.size})`;
    }
    return null;
  }

  /** Delete the range's copy from the source shard (idempotent). */
  private deleteSourceCopy(cp: MoveCheckpoint): void {
    const source = this.store.shardStore(cp.fromShard);
    const target = this.store.shardStore(cp.toShard);
    const start = BigInt(cp.rangeStart);
    const ids = target
      .listAllStreams()
      .filter((s) => this.store.shardMap.rangeStartForStreamId(s.streamId) === start)
      .map((s) => s.streamId);
    source.db.transaction(() => {
      for (const id of ids) {
        source.db
          .prepare("DELETE FROM outbox_intents WHERE event_id IN (SELECT event_id FROM outbox_events WHERE stream_id = ?)")
          .run(id);
        source.db.prepare("DELETE FROM outbox_events WHERE stream_id = ?").run(id);
        source.db.prepare("DELETE FROM events WHERE stream_id = ?").run(id);
        source.db.prepare("DELETE FROM streams WHERE stream_id = ?").run(id);
      }
    })();
  }
}

function moveIdFor(start: bigint, fromShard: number, toShard: number): string {
  return `move-${start}-${fromShard}-to-${toShard}`;
}

function newCheckpoint(start: bigint, end: bigint, fromShard: number, toShard: number): MoveCheckpoint {
  return {
    moveId: moveIdFor(start, fromShard, toShard),
    rangeStart: start.toString(),
    rangeEnd: end.toString(),
    fromShard,
    toShard,
    status: "copying",
    lastCopiedStreamId: null,
    streamsCopied: 0,
    totalStreams: 0,
    eventsCopied: 0,
    totalEvents: 0,
    updatedAt: new Date().toISOString(),
  };
}

function countEvents(
  store: ReturnType<ShardedStore["shardStore"]>,
  streamIds: string[]
): number {
  if (streamIds.length === 0) return 0;
  const row = store.db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id IN (${streamIds.map(() => "?").join(",")})`)
    .get(...streamIds) as { n: number };
  return row.n;
}
