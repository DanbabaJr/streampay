import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import type { DecodedEvent, Stream } from "./types.js";
import { EVENT_KEYS } from "./generated/events.js";
import { WebhookStore } from "./webhooks/store.js";
import { OutboxStore, newOutboxEventFromDecoded } from "./outbox/store.js";
import { globalIndexerTracer, traceCorrelationRegistry } from "./telemetry.js";

export interface IngestSummary {
  /** Events handed to the store for this page. */
  seen: number;
  /** Events whose id was new (the outbox/webhook/projection work happened). */
  inserted: number;
  /** Events already journalled — a duplicate delivery, not an error. */
  duplicates: number;
  /** Projection writes suppressed because the row is already ahead. */
  projectionSkips: number;
}

export class StreamStore extends EventEmitter {
  readonly db: Database.Database;
  readonly webhooks: WebhookStore;
  readonly outbox: OutboxStore;

  constructor(path: string) {
    super();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        stream_id TEXT PRIMARY KEY, sender TEXT, recipient TEXT, token TEXT,
        deposit TEXT, withdrawn TEXT NOT NULL DEFAULT '0', start_time TEXT,
        end_time TEXT, cancelable INTEGER, status TEXT NOT NULL DEFAULT 'active',
        cancelled_by TEXT, recipient_amount TEXT, sender_amount TEXT,
        refund_target TEXT,
        last_ledger INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS streams_sender ON streams(sender, stream_id);
      CREATE INDEX IF NOT EXISTS streams_recipient ON streams(recipient, stream_id);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, stream_id TEXT, name TEXT NOT NULL,
        ledger INTEGER NOT NULL, ledger_closed_at TEXT NOT NULL,
        tx_hash TEXT, trace_id TEXT, span_id TEXT, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_stream ON events(stream_id, ledger);
      CREATE TABLE IF NOT EXISTS indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN tx_hash TEXT;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN trace_id TEXT;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN span_id TEXT;");
    } catch {}
    // Refund routing (#204): the address the unstreamed remainder is paid to,
    // when it is not the stream's sender. A database created before this column
    // gets it added on open; `NULL` means "unrouted — the sender is paid".
    try {
      this.db.exec("ALTER TABLE streams ADD COLUMN refund_target TEXT;");
    } catch {}
    this.webhooks = new WebhookStore(this.db);
    this.outbox = new OutboxStore(this.db);
    this.allowNullStreamId();
  }

  /**
   * `stream_id` is nullable in the four event journals. The registry declares a
   * stream for only part of its events, and an event without one now carries
   * `null` rather than a value lifted from its first positional topic. SQLite
   * cannot drop a NOT NULL constraint in place, so a database built before this
   * change is rebuilt table-by-table — definition, rows and indexes included.
   * A fresh database already matches and skips the work.
   */
  private allowNullStreamId(): void {
    for (const table of ["events", "outbox_events", "webhook_deliveries", "webhook_dead_letter"]) {
      // Table names are this list's own constants, never caller input.
      const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>;
      const column = columns.find((c) => c.name === "stream_id");
      if (!column?.notnull) continue;

      const { sql: recorded } = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string };
      const indexes = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
        .all(table) as Array<{ sql: string }>;
      const temporary = `${table}_allow_null_stream_id`;

      this.db.transaction(() => {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${temporary}`);
        this.db.exec(recorded.replace(/stream_id\s+TEXT\s+NOT NULL/i, "stream_id TEXT"));
        this.db.exec(`INSERT INTO ${table} SELECT * FROM ${temporary}`);
        this.db.exec(`DROP TABLE ${temporary}`);
        for (const index of indexes) this.db.exec(index.sql);
      })();
    }
  }

  close(): void { this.db.close(); }
  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM indexer_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO indexer_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  ingest(event: DecodedEvent): void {
    const outcome = this.db.transaction(() => this.ingestWithinTransaction(event, event.pagingToken))();
    // #225: `/events/stream` (SSE) listeners are notified only after the write has
    // committed, so a listener that reads back through the store sees this event,
    // and a throwing listener cannot roll the ingestion transaction back.
    if (!outcome.duplicate) this.emit("event", event, this.streamForEvent(event));
  }

  /**
   * Commits one page of events inside a single transaction, so the event
   * journal, the outbox intents and the stream projections either all exist or
   * none do — the invariant the parallel ingester relies on when it replays a
   * window after a crash.
   */
  ingestPage(events: DecodedEvent[], cursor: string | undefined, latestLedger: number): IngestSummary {
    const summary: IngestSummary = { seen: events.length, inserted: 0, duplicates: 0, projectionSkips: 0 };
    const journalled: DecodedEvent[] = [];
    this.db.transaction(() => {
      for (const event of events) {
        const outcome = this.ingestWithinTransaction(event, cursor ?? event.pagingToken);
        if (outcome.duplicate) summary.duplicates += 1;
        else {
          summary.inserted += 1;
          journalled.push(event);
          if (outcome.projectionSkipped) summary.projectionSkips += 1;
        }
      }
      if (cursor) this.setState("cursor", cursor);
      this.setState("lastLedger", String(latestLedger));
    })();
    // Same rule as `ingest`: one notification per newly journalled event, after the
    // page transaction has committed. A replayed page reports duplicates and stays
    // silent, so an SSE client cannot see the same event twice from a window retry.
    for (const event of journalled) this.emit("event", event, this.streamForEvent(event));
    return summary;
  }

  /** The stream row an event concerns; `undefined` for stream-less events. */
  private streamForEvent(event: DecodedEvent): Stream | undefined {
    return event.streamId === null ? undefined : this.getStream(event.streamId);
  }

  private ingestWithinTransaction(event: DecodedEvent, ledgerCursor: string): { duplicate: boolean; projectionSkipped: boolean } {
    // A stream-less event has no `stream.id` to report; the attribute is
    // omitted rather than filled with a placeholder.
    const streamAttributes: Record<string, string | number> = {
      "event.name": event.name,
      "ledger.sequence": event.ledger,
      "soroban.tx_hash": event.txHash || "unknown",
    };
    if (event.streamId !== null) streamAttributes["stream.id"] = event.streamId;

    const ingestSpan = globalIndexerTracer.startSpan("indexer.ingest_event", {
      kind: "CONSUMER",
      attributes: streamAttributes,
    });

    // Check correlation registry for the asynchronous event seam (linking originating claim trace)
    const linkedContext =
      event.linkedSpanContext ||
      (event.txHash ? traceCorrelationRegistry.get(event.txHash) : null) ||
      traceCorrelationRegistry.getByStream(event.streamId);

    if (linkedContext) {
      ingestSpan.addLink({
        context: linkedContext,
        attributes: {
          "link.relationship": "ledger_event_continuation",
          "event.name": event.name,
          "ledger.sequence": event.ledger,
          "soroban.tx_hash": event.txHash || "unknown",
        },
      });
    }

    event.traceId = ingestSpan.context.traceId;
    event.spanId = ingestSpan.context.spanId;

    try {
      const dbSpan = globalIndexerTracer.startSpan("indexer.db_write", {
        parent: ingestSpan,
        kind: "INTERNAL",
        attributes: {
          "db.system": "sqlite",
          ...streamAttributes,
        },
      });

      const inserted = this.db.prepare(`INSERT OR IGNORE INTO events
        (id, stream_id, name, ledger, ledger_closed_at, tx_hash, trace_id, span_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.id,
          event.streamId,
          event.name,
          event.ledger,
          event.ledgerClosedAt,
          event.txHash ?? null,
          event.traceId ?? null,
          event.spanId ?? null,
          JSON.stringify(event.data, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)
        );

      if (inserted.changes === 0) {
        dbSpan.end();
        ingestSpan.setStatus("OK");
        ingestSpan.end();
        return { duplicate: true, projectionSkipped: false };
      }

      // Transactional outbox: the delivery-intent journal is committed in the
      // same transaction as the event row, so intents can never be lost.
      // Deliberately NOT wrapped in try/catch — any failure must roll back the
      // whole ingestion transaction.
      this.outbox.enqueueWithinTransaction(newOutboxEventFromDecoded(event, ledgerCursor));

      // Queue webhook deliveries for subscribers
      try {
        this.webhooks.queueDeliveriesForEvent({
          id: event.id,
          name: event.name,
          streamId: event.streamId,
          ledgerClosedAt: event.ledgerClosedAt,
          data: event.data as Record<string, unknown>,
        });
      } catch (err) {
        console.error("Failed to queue webhook delivery for event:", err);
      }

      const d = event.data;
      // The projection is keyed by stream id, so it runs only for the events the
      // registry says are about a stream. A stream-less event is journalled,
      // retracted-safe, dispatched to subscribers by name — and touches no
      // `streams` row, because it has no stream to touch.
      if (event.streamId === null) {
        dbSpan.setStatus("OK");
        dbSpan.end();
        ingestSpan.setStatus("OK");
        return { duplicate: false, projectionSkipped: true };
      }
      const existing = this.db.prepare("SELECT * FROM streams WHERE stream_id = ?").get(event.streamId) as Record<string, unknown> | undefined;
      const get = (key: string): string | null => d[key] === undefined || d[key] === null ? null : String(d[key]);
      const patch: Partial<Stream & { cancelled_by?: string | null; recipient_amount?: string | null; sender_amount?: string | null }> = {
        lastLedger: event.ledger,
        updatedAt: event.ledgerClosedAt,
      };

      switch (event.name) {
        // Registry-known event keys (schemas/events/registry.json), via the
        // generated table so a renamed key fails typecheck here.
        case EVENT_KEYS.StreamCreated:
          Object.assign(patch, {
            sender: get("sender"),
            recipient: get("recipient"),
            token: get("token"),
            deposit: get("deposit"),
            startTime: get("start_time"),
            endTime: get("end_time"),
            cancelable: Boolean(d.cancelable),
            status: "active",
            withdrawn: "0",
          });
          break;
        case EVENT_KEYS.Withdrawn:
          patch.withdrawn = get("withdrawn_total") ?? (existing?.withdrawn as string | undefined) ?? "0";
          break;
        case EVENT_KEYS.StreamToppedUp:
          patch.deposit = get("new_deposit") ?? (existing?.deposit as string | undefined) ?? null;
          break;
        case EVENT_KEYS.StreamCancelled: {
          patch.status = "cancelled";
          patch.cancelled_by = get("cancelled_by") ?? (existing?.cancelled_by as string | undefined) ?? null;
          patch.recipient_amount = get("recipient_amount") ?? (existing?.recipient_amount as string | undefined) ?? null;
          patch.sender_amount = get("sender_amount") ?? (existing?.sender_amount as string | undefined) ?? null;
          if (patch.recipient_amount) {
            const prevWithdrawn = BigInt((existing?.withdrawn as string) ?? "0");
            patch.withdrawn = (prevWithdrawn + BigInt(patch.recipient_amount)).toString();
          }
          break;
        }
        case "stream_paused": patch.status = "paused"; break;
        case "stream_resumed": patch.status = "active"; break;
        // Refund routing changes only where the unstreamed remainder is paid.
        // Accrual, the recipient and the sender role are untouched, so nothing
        // else in the row is patched — and the routing is not a discoverable
        // role, so it never enters `listAddress`.
        case "stream_refund_target_changed":
          patch.refund_target = get("new_target");
          break;
        // The event is still journalled; only the projection ignores it.
        default:
          dbSpan.setStatus("OK");
          dbSpan.end();
          ingestSpan.setStatus("OK");
          return { duplicate: false, projectionSkipped: false };
      }

      const current = existing ?? {};
      const row = {
        stream_id: event.streamId,
        sender: patch.sender ?? current.sender ?? null,
        recipient: patch.recipient ?? current.recipient ?? null,
        token: patch.token ?? current.token ?? null,
        deposit: patch.deposit ?? current.deposit ?? null,
        withdrawn: patch.withdrawn ?? current.withdrawn ?? "0",
        start_time: patch.startTime ?? current.start_time ?? null,
        end_time: patch.endTime ?? current.end_time ?? null,
        cancelable: patch.cancelable === undefined ? current.cancelable ?? null : Number(patch.cancelable),
        status: patch.status ?? current.status ?? "active",
        cancelled_by: patch.cancelled_by ?? current.cancelled_by ?? null,
        recipient_amount: patch.recipient_amount ?? current.recipient_amount ?? null,
        sender_amount: patch.sender_amount ?? current.sender_amount ?? null,
        refund_target: patch.refund_target ?? current.refund_target ?? null,
        last_ledger: event.ledger,
        updated_at: event.ledgerClosedAt,
      };

      // Monotonic projection: `WHERE excluded.last_ledger >= streams.last_ledger`
      // makes the upsert a no-op for an event older than the state already
      // committed for this stream, so an out-of-order or late delivery can never
      // rewind status/deposit/withdrawn. Events in the same ledger as the
      // current state still apply (>=), because one ledger can hold several
      // events for one stream and they must land in order within it.
      const upsert = this.db.prepare(`INSERT INTO streams(stream_id,sender,recipient,token,deposit,withdrawn,start_time,end_time,cancelable,status,cancelled_by,recipient_amount,sender_amount,refund_target,last_ledger,updated_at)
        VALUES(@stream_id,@sender,@recipient,@token,@deposit,@withdrawn,@start_time,@end_time,@cancelable,@status,@cancelled_by,@recipient_amount,@sender_amount,@refund_target,@last_ledger,@updated_at)
        ON CONFLICT(stream_id) DO UPDATE SET sender=excluded.sender, recipient=excluded.recipient, token=excluded.token,
        deposit=excluded.deposit, withdrawn=excluded.withdrawn, start_time=excluded.start_time, end_time=excluded.end_time,
        cancelable=excluded.cancelable, status=excluded.status, cancelled_by=excluded.cancelled_by,
        recipient_amount=excluded.recipient_amount, sender_amount=excluded.sender_amount, refund_target=excluded.refund_target,
        last_ledger=excluded.last_ledger, updated_at=excluded.updated_at
        WHERE excluded.last_ledger >= streams.last_ledger`).run(row);

      dbSpan.setStatus("OK");
      dbSpan.end();
      ingestSpan.setStatus("OK");
      return { duplicate: false, projectionSkipped: upsert.changes === 0 };
    } catch (err) {
      ingestSpan.recordException(err);
      ingestSpan.setStatus("ERROR", String(err));
      throw err;
    } finally {
      ingestSpan.end();
    }
  }

  /**
   * Highest ledger already projected per stream. The ingester seeds its
   * in-memory sequencer with this after a restart so "late event" is measured
   * against durable truth, not against an empty map.
   */
  maxLedgerByStream(): Map<string, number> {
    const rows = this.db.prepare("SELECT stream_id, last_ledger FROM streams").all() as Array<{ stream_id: string; last_ledger: number }>;
    return new Map(rows.map((row) => [row.stream_id, Number(row.last_ledger)]));
  }

  getStream(id: string): Stream | undefined {
    const row = this.db.prepare("SELECT * FROM streams WHERE stream_id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toStream(row) : undefined;
  }

  listAddress(address: string): Stream[] {
    return (this.db.prepare("SELECT * FROM streams WHERE sender = ? OR recipient = ? ORDER BY CAST(stream_id AS INTEGER) DESC").all(address, address) as Record<string, unknown>[]).map((row) => this.toStream(row));
  }
  listAllStreams(): Stream[] {
    return (this.db.prepare("SELECT * FROM streams ORDER BY CAST(stream_id AS INTEGER) ASC").all() as Record<string, unknown>[]).map((row) => this.toStream(row));
  }

  listStreamsByRecipient(recipient: string): Stream[] {
    return (this.db.prepare("SELECT * FROM streams WHERE recipient = ? ORDER BY CAST(stream_id AS INTEGER) ASC").all(recipient) as Record<string, unknown>[]).map((row) => this.toStream(row));
  }

  getStreamHistory(streamId: string): Array<{ id: string; stream_id: string; event_type: string; ledger: number; ledger_closed_at: string; tx_hash?: string | null; trace_id?: string | null; span_id?: string | null; payload: unknown }> {
    return (this.db.prepare("SELECT id, stream_id, name as event_type, ledger, ledger_closed_at, tx_hash, trace_id, span_id, payload FROM events WHERE stream_id = ? ORDER BY ledger ASC, id ASC").all(streamId) as Array<{ id: string; stream_id: string; event_type: string; ledger: number; ledger_closed_at: string; tx_hash: string | null; trace_id: string | null; span_id: string | null; payload: string }>).map((row) => {
      let parsed = row.payload;
      try { parsed = JSON.parse(row.payload); } catch {}
      return { ...row, payload: parsed };
    });
  }

  getEventsAfter(
    lastEventId: string,
    address?: string,
    streamId?: string
  ): Array<{
    id: string;
    streamId: string;
    name: string;
    ledger: number;
    ledgerClosedAt: string;
    payload: Record<string, unknown>;
    stream?: Stream;
  }> {
    const target = this.db.prepare("SELECT rowid FROM events WHERE id = ?").get(lastEventId) as { rowid: number } | undefined;
    if (!target) return [];

    let query = "SELECT id, stream_id, name, ledger, ledger_closed_at, payload FROM events WHERE rowid > ?";
    const params: (string | number)[] = [target.rowid];

    if (streamId) {
      query += " AND stream_id = ?";
      params.push(streamId);
    }

    query += " ORDER BY rowid ASC LIMIT 250";

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      stream_id: string;
      name: string;
      ledger: number;
      ledger_closed_at: string;
      payload: string;
    }>;

    const results: Array<{
      id: string;
      streamId: string;
      name: string;
      ledger: number;
      ledgerClosedAt: string;
      payload: Record<string, unknown>;
      stream?: Stream;
    }> = [];

    for (const r of rows) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(r.payload); } catch {}
      const st = this.getStream(r.stream_id);
      if (address && st && st.sender !== address && st.recipient !== address) {
        continue;
      }
      results.push({
        id: r.id,
        streamId: r.stream_id,
        name: r.name,
        ledger: r.ledger,
        ledgerClosedAt: r.ledger_closed_at,
        payload: parsed,
        stream: st,
      });
    }

    return results;
  }

  private toStream(row: Record<string, unknown>): Stream {
    return {
      id: String(row.stream_id),
      streamId: String(row.stream_id),
      sender: row.sender as string | null,
      recipient: row.recipient as string | null,
      token: row.token as string | null,
      deposit: row.deposit as string | null,
      withdrawn: String(row.withdrawn),
      startTime: row.start_time as string | null,
      endTime: row.end_time as string | null,
      cancelable: row.cancelable === null ? null : Boolean(row.cancelable),
      status: String(row.status),
      cancelled_by: (row.cancelled_by as string | null) ?? undefined,
      recipient_amount: (row.recipient_amount as string | null) ?? undefined,
      sender_amount: (row.sender_amount as string | null) ?? undefined,
      // null == unrouted: the cancel refund goes to the sender.
      refund_target: (row.refund_target as string | null) ?? undefined,
      lastLedger: Number(row.last_ledger),
      updatedAt: String(row.updated_at),
    };
  }
}
