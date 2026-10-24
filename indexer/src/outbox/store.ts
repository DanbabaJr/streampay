import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { DecodedEvent } from "../types.js";
import type {
  OutboxConsumer,
  OutboxConsumerKind,
  OutboxEventRow,
  OutboxIntent,
  OutboxReplayPage,
  OutboxStats,
  OutboxState,
  RetractResult,
} from "./types.js";

const OUTBOX_STATES: readonly OutboxState[] = ["pending", "in_flight", "delivered", "dead"];

export interface NewOutboxEvent {
  id: string;
  name: string;
  /** null for the events the registry declares no stream for. */
  streamId: string | null;
  ledger: number;
  ledgerCursor: string;
  payload: Record<string, unknown>;
}

export class OutboxStore {
  private readonly insertEvent;
  private readonly selectActiveConsumers;
  private readonly insertIntent;

  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL,
        stream_id TEXT,
        name TEXT NOT NULL,
        ledger INTEGER NOT NULL,
        ledger_cursor TEXT NOT NULL,
        payload TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        retracted_at TEXT,
        retract_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_events_stream_seq ON outbox_events(stream_id, seq);
      CREATE INDEX IF NOT EXISTS idx_outbox_events_ledger ON outbox_events(ledger);

      CREATE TABLE IF NOT EXISTS outbox_consumers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('push', 'pull')),
        url TEXT,
        secret TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 8,
        rate_limit_per_sec REAL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        consumer_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL REFERENCES outbox_events(seq),
        event_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        claim_token TEXT,
        delivered_at TEXT,
        dead_reason TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_intents_due ON outbox_intents(state, consumer_id, next_retry_at, id);
      CREATE INDEX IF NOT EXISTS idx_outbox_intents_event ON outbox_intents(event_seq);
    `);

    this.insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO outbox_events
       (idempotency_key, event_id, stream_id, name, ledger, ledger_cursor, payload, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.selectActiveConsumers = this.db.prepare(
      "SELECT * FROM outbox_consumers WHERE status = 'active' ORDER BY created_at ASC, id ASC"
    );
    this.insertIntent = this.db.prepare(
      `INSERT OR IGNORE INTO outbox_intents
       (idempotency_key, consumer_id, event_seq, event_id, state, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    );
  }

  /**
   * MUST be called inside the caller's ingestion transaction: writes the
   * event journal row and one delivery intent per active consumer atomically.
   */
  enqueueWithinTransaction(event: NewOutboxEvent): void {
    const now = new Date().toISOString();
    const inserted = this.insertEvent.run(
      event.id,
      event.id,
      event.streamId,
      event.name,
      event.ledger,
      event.ledgerCursor,
      JSON.stringify(event.payload, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      now
    );
    if (inserted.changes === 0) return;

    const seq = Number(inserted.lastInsertRowid);
    const nowMs = Date.now();
    for (const consumer of this.listConsumers()) {
      // Pull consumers replay from the journal itself via the cursor endpoint;
      // only push channels get delivery-intent rows.
      if (consumer.status !== "active" || consumer.kind !== "push") continue;
      this.insertIntent.run(
        `${consumer.id}:${event.id}`,
        consumer.id,
        seq,
        event.id,
        nowMs,
        now
      );
    }
  }

  createConsumer(params: {
    id?: string;
    kind: OutboxConsumerKind;
    url?: string | null;
    secret?: string | null;
    max_attempts?: number;
    rate_limit_per_sec?: number | null;
  }): OutboxConsumer {
    const id = params.id ?? `obc_${randomBytes(8).toString("hex")}`;
    const existing = this.db.prepare("SELECT id FROM outbox_consumers WHERE id = ?").get(id);
    if (existing) throw new Error(`outbox consumer ${id} already exists`);
    if (params.kind === "push" && !params.url) throw new Error("push consumers require a url");
    const consumer: OutboxConsumer = {
      id,
      kind: params.kind,
      url: params.kind === "push" ? String(params.url) : null,
      secret: params.secret ?? null,
      max_attempts: Math.max(1, Math.floor(params.max_attempts ?? 8)),
      rate_limit_per_sec: params.rate_limit_per_sec ?? null,
      status: "active",
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO outbox_consumers (id, kind, url, secret, max_attempts, rate_limit_per_sec, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        consumer.id,
        consumer.kind,
        consumer.url,
        consumer.secret,
        consumer.max_attempts,
        consumer.rate_limit_per_sec,
        consumer.status,
        consumer.created_at
      );
    return consumer;
  }

  getConsumer(id: string): OutboxConsumer | undefined {
    const row = this.db.prepare("SELECT * FROM outbox_consumers WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toConsumer(row) : undefined;
  }

  listConsumers(): OutboxConsumer[] {
    const rows = this.db
      .prepare("SELECT * FROM outbox_consumers ORDER BY created_at ASC, id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toConsumer(r));
  }

  setConsumerStatus(id: string, status: "active" | "disabled"): boolean {
    const res = this.db.prepare("UPDATE outbox_consumers SET status = ? WHERE id = ?").run(status, id);
    return res.changes > 0;
  }

  deleteConsumer(id: string): boolean {
    const res = this.db.prepare("DELETE FROM outbox_consumers WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // ---------- dispatcher primitives (all transitions guarded, idempotent) ----------

  /** Pending intents due for this consumer, seq-ordered, excluding in-flight consumers backlog. */
  dueIntents(consumerId: string, limit: number, nowMs: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM outbox_intents
         WHERE state = 'pending' AND consumer_id = ? AND next_retry_at <= ?
         ORDER BY event_seq ASC LIMIT ?`
      )
      .all(consumerId, nowMs, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Atomic claim: only succeeds while the row is still pending, so a second
   * dispatcher (duplicate connection, another process) can never drain the
   * same intent concurrently. Returns the claimed snapshot or undefined.
   */
  claimIntent(intentId: number, claimToken: string, nowMs: number): OutboxIntent | undefined {
    const res = this.db
      .prepare(
        `UPDATE outbox_intents
         SET state = 'in_flight', claimed_at = ?, claim_token = ?
         WHERE id = ? AND state = 'pending'`
      )
      .run(nowMs, claimToken, intentId);
    if (res.changes !== 1) return undefined;
    return this.getIntent(intentId);
  }

  claimToken(): string {
    return randomBytes(12).toString("hex");
  }

  markDelivered(intentId: number, claimToken: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE outbox_intents
         SET state = 'delivered', delivered_at = ?, dead_reason = NULL, last_error = NULL,
             claimed_at = NULL, claim_token = NULL
         WHERE id = ? AND state = 'in_flight' AND claim_token = ?`
      )
      .run(new Date().toISOString(), intentId, claimToken);
    return res.changes === 1;
  }

  /**
   * Failure transition for a claimed intent. Terminal attempts dead-letter it;
   * otherwise the intent returns to pending with caller-computed nextRetryAt.
   * A stale claim token (intent already reclaimed) makes this a no-op so a
   * resurrected dispatcher cannot corrupt another dispatcher's bookkeeping.
   */
  recordFailure(
    intentId: number,
    claimToken: string,
    error: string,
    maxAttempts: number,
    nextRetryAt: number
  ): "scheduled" | "dead" | "stale" {
    const current = this.db
      .prepare("SELECT attempts FROM outbox_intents WHERE id = ? AND state = 'in_flight' AND claim_token = ?")
      .get(intentId, claimToken) as { attempts: number } | undefined;
    if (!current) return "stale";
    const attempts = current.attempts + 1;
    if (attempts >= maxAttempts) {
      this.db
        .prepare(
          `UPDATE outbox_intents
           SET state = 'dead', attempts = ?, dead_reason = 'max_attempts', last_error = ?,
               claimed_at = NULL, claim_token = NULL, delivered_at = NULL
           WHERE id = ?`
        )
        .run(attempts, error, intentId);
      return "dead";
    }
    this.db
      .prepare(
        `UPDATE outbox_intents
         SET state = 'pending', attempts = ?, last_error = ?, next_retry_at = ?,
             claimed_at = NULL, claim_token = NULL
         WHERE id = ?`
      )
      .run(attempts, error, nextRetryAt, intentId);
    return "scheduled";
  }

  /** Crash recovery: return in_flight intents whose claim timed out to pending. */
  reclaimStale(claimTimeoutMs: number, nowMs: number): number {
    const res = this.db
      .prepare(
        `UPDATE outbox_intents
         SET state = 'pending', claimed_at = NULL, claim_token = NULL,
             last_error = COALESCE(last_error, 'claim_timeout_reclaim')
         WHERE state = 'in_flight' AND claimed_at IS NOT NULL AND claimed_at <= ?`
      )
      .run(nowMs - claimTimeoutMs);
    return res.changes;
  }

  /** Manual dead-letter replay: reset to pending for immediate re-dispatch. */
  replayIntent(intentId: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE outbox_intents
         SET state = 'pending', next_retry_at = 0, dead_reason = NULL, last_error = NULL,
             claimed_at = NULL, claim_token = NULL
         WHERE id = ? AND state = 'dead'`
      )
      .run(intentId);
    return res.changes === 1;
  }

  // ---------- reorg safety ----------

  /**
   * Retract every journal event committed after `ledger` (exclusive). Pending
   * and in-flight intents are dead-lettered; delivered intents keep their
   * delivered state but their event rows carry a retraction tombstone that
   * replay consumers can reconcile against. Coordinated by the dual-read
   * reconciliation service via POST /api/outbox/retract.
   */
  retractAfterLedger(ledger: number, reason: string): RetractResult {
    return this.db.transaction((): RetractResult => {
      const now = new Date().toISOString();
      const events = this.db
        .prepare(
          "UPDATE outbox_events SET retracted_at = ?, retract_reason = ? WHERE ledger > ? AND retracted_at IS NULL"
        )
        .run(now, reason, ledger);
      const intents = this.db
        .prepare(
          `UPDATE outbox_intents
           SET state = 'dead', dead_reason = 'reorg_retracted', claimed_at = NULL, claim_token = NULL
           WHERE state IN ('pending', 'in_flight')
             AND event_seq IN (SELECT seq FROM outbox_events WHERE retracted_at IS NOT NULL)`
        )
        .run();
      return { events_retracted: events.changes, intents_retracted: intents.changes };
    })();
  }

  // ---------- replay / observability queries ----------

  /** Cursor-based replay feed: monotonic seq, oldest-first, retracted rows excluded. */
  replayEvents(streamId: string, afterSeq: number, limit: number): OutboxReplayPage {
    const rows = this.db
      .prepare(
        `SELECT seq, idempotency_key, event_id, stream_id, name, ledger, ledger_cursor, payload, ingested_at
         FROM outbox_events
         WHERE stream_id = ? AND seq > ? AND retracted_at IS NULL
         ORDER BY seq ASC LIMIT ?`
      )
      .all(streamId, afterSeq, limit) as Array<Record<string, unknown>>;
    const events = rows.map((r) => ({
      seq: Number(r.seq),
      idempotency_key: String(r.idempotency_key),
      event_id: String(r.event_id),
      stream_id: r.stream_id === null || r.stream_id === undefined ? null : String(r.stream_id),
      name: String(r.name),
      ledger: Number(r.ledger),
      ledger_cursor: String(r.ledger_cursor),
      payload: this.parsePayload(r.payload),
      ingested_at: String(r.ingested_at),
    }));
    return {
      events,
      next_cursor: events.length > 0 ? events[events.length - 1].seq : null,
    };
  }

  getEventBySeq(seq: number): OutboxEventRow | undefined {
    const row = this.db.prepare("SELECT * FROM outbox_events WHERE seq = ?").get(seq) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      seq: Number(row.seq),
      idempotency_key: String(row.idempotency_key),
      event_id: String(row.event_id),
      stream_id: row.stream_id === null || row.stream_id === undefined ? null : String(row.stream_id),
      name: String(row.name),
      ledger: Number(row.ledger),
      ledger_cursor: String(row.ledger_cursor),
      payload: this.parsePayload(row.payload),
      ingested_at: String(row.ingested_at),
      retracted_at: (row.retracted_at as string) ?? null,
      retract_reason: (row.retract_reason as string) ?? null,
    };
  }

  getIntent(id: number): OutboxIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT i.*, e.stream_id, e.name, e.ledger, e.payload
         FROM outbox_intents i JOIN outbox_events e ON e.seq = i.event_seq
         WHERE i.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toIntent(row) : undefined;
  }

  listIntents(filter: { state?: OutboxState; consumerId?: string; limit: number }): OutboxIntent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.state) {
      conditions.push("i.state = ?");
      params.push(filter.state);
    }
    if (filter.consumerId) {
      conditions.push("i.consumer_id = ?");
      params.push(filter.consumerId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT i.*, e.stream_id, e.name, e.ledger, e.payload
         FROM outbox_intents i JOIN outbox_events e ON e.seq = i.event_seq
         ${where} ORDER BY i.id ASC LIMIT ?`
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.toIntent(r));
  }

  stats(): OutboxStats {
    const depth = { pending: 0, in_flight: 0, delivered: 0, dead: 0 } as Record<OutboxState, number>;
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM outbox_intents GROUP BY state")
      .all() as Array<{ state: string; n: number }>;
    for (const r of rows) {
      if (OUTBOX_STATES.includes(r.state as OutboxState)) depth[r.state as OutboxState] = r.n;
    }
    const oldest = this.db
      .prepare("SELECT MIN(created_at) AS t FROM outbox_intents WHERE state = 'pending'")
      .get() as { t: string | null };
    const maxSeq = this.db.prepare("SELECT MAX(seq) AS m FROM outbox_events").get() as { m: number | null };
    const eventCount = this.db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get() as { n: number };
    return {
      events: eventCount.n,
      depth,
      oldestPendingAgeMs: oldest.t === null ? 0 : Math.max(0, Date.now() - Date.parse(oldest.t)),
      maxSeq: maxSeq.m ?? 0,
    };
  }

  private parsePayload(raw: unknown): Record<string, unknown> {
    try {
      return JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private toConsumer(row: Record<string, unknown>): OutboxConsumer {
    return {
      id: String(row.id),
      kind: row.kind as OutboxConsumerKind,
      url: (row.url as string) ?? null,
      secret: (row.secret as string) ?? null,
      max_attempts: Number(row.max_attempts),
      rate_limit_per_sec: row.rate_limit_per_sec === null ? null : Number(row.rate_limit_per_sec),
      status: row.status as "active" | "disabled",
      created_at: String(row.created_at),
    };
  }

  private toIntent(row: Record<string, unknown>): OutboxIntent {
    return {
      id: Number(row.id),
      event_seq: Number(row.event_seq),
      consumer_id: String(row.consumer_id),
      idempotency_key: String(row.idempotency_key),
      state: row.state as OutboxState,
      attempts: Number(row.attempts),
      next_retry_at: Number(row.next_retry_at),
      claimed_at: row.claimed_at === null ? null : Number(row.claimed_at),
      claim_token: (row.claim_token as string) ?? null,
      delivered_at: (row.delivered_at as string) ?? null,
      dead_reason: (row.dead_reason as string) ?? null,
      last_error: (row.last_error as string) ?? null,
      created_at: String(row.created_at),
      event_id: String(row.event_id),
      stream_id: row.stream_id === null || row.stream_id === undefined ? null : String(row.stream_id),
      name: String(row.name),
      ledger: Number(row.ledger),
      payload: this.parsePayload(row.payload),
    };
  }
}

export function newOutboxEventFromDecoded(event: DecodedEvent, fallbackCursor: string): NewOutboxEvent {
  return {
    id: event.id,
    name: event.name,
    streamId: event.streamId,
    ledger: event.ledger,
    ledgerCursor: event.pagingToken || fallbackCursor,
    payload: event.data,
  };
}
