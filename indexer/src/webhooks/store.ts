import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import type {
  WebhookEndpoint,
  WebhookDelivery,
  WebhookDeadLetterItem,
  WebhookAttemptRecord,
} from "./types.js";
import { calculateNextRetryDelay, isTerminalAttempt } from "./retry.js";

function nullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class WebhookStore {
  constructor(private readonly db: Database.Database) {
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        previous_secret TEXT,
        events TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        stream_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        status_code INTEGER,
        error TEXT,
        next_retry_at INTEGER NOT NULL,
        history TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status, next_retry_at);

      CREATE TABLE IF NOT EXISTS webhook_dead_letter (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        stream_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts_count INTEGER NOT NULL,
        last_error TEXT NOT NULL,
        last_status_code INTEGER,
        created_at TEXT NOT NULL,
        replayed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dlq_endpoint ON webhook_dead_letter(endpoint_id);
    `);
  }

  createEndpoint(params: {
    url: string;
    events: string[];
    secret?: string;
  }): WebhookEndpoint {
    const id = `wh_${randomBytes(12).toString("hex")}`;
    const secret = params.secret || `whsec_${randomBytes(24).toString("hex")}`;
    const now = new Date().toISOString();
    const endpoint: WebhookEndpoint = {
      id,
      url: params.url,
      secret,
      previous_secret: null,
      events: params.events.length === 0 ? ["*"] : params.events,
      status: "active",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO webhook_endpoints (id, url, secret, previous_secret, events, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        endpoint.id,
        endpoint.url,
        endpoint.secret,
        endpoint.previous_secret,
        JSON.stringify(endpoint.events),
        endpoint.status,
        endpoint.created_at,
        endpoint.updated_at
      );

    return endpoint;
  }

  rotateEndpointSecret(endpointId: string): { secret: string; previous_secret: string } {
    const ep = this.getEndpoint(endpointId);
    if (!ep) {
      throw new Error(`Webhook endpoint ${endpointId} not found`);
    }

    const newSecret = `whsec_${randomBytes(24).toString("hex")}`;
    const previousSecret = ep.secret;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE webhook_endpoints
         SET secret = ?, previous_secret = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(newSecret, previousSecret, now, endpointId);

    return { secret: newSecret, previous_secret: previousSecret };
  }

  getEndpoint(id: string): WebhookEndpoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM webhook_endpoints WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toEndpoint(row) : undefined;
  }

  listEndpoints(): WebhookEndpoint[] {
    const rows = this.db
      .prepare("SELECT * FROM webhook_endpoints ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toEndpoint(r));
  }

  deleteEndpoint(id: string): boolean {
    const result = this.db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private toEndpoint(row: Record<string, unknown>): WebhookEndpoint {
    let parsedEvents: string[] = ["*"];
    try {
      parsedEvents = JSON.parse(String(row.events));
    } catch {}
    return {
      id: String(row.id),
      url: String(row.url),
      secret: String(row.secret),
      previous_secret: (row.previous_secret as string) || null,
      events: parsedEvents,
      status: row.status as "active" | "disabled",
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  queueDeliveriesForEvent(event: {
    id: string;
    name: string;
    /** `null` for the events that are not about a stream; subscribers matching
     *  by event name still receive them, with the field present and null. */
    streamId: string | null;
    ledgerClosedAt: string;
    data: Record<string, unknown>;
  }): number {
    const endpoints = this.listEndpoints().filter((ep) => ep.status === "active");
    let queued = 0;
    const now = Date.now();

    for (const ep of endpoints) {
      const match =
        ep.events.includes("*") ||
        ep.events.includes(event.name);
      if (!match) continue;

      const deliveryId = `del_${randomBytes(12).toString("hex")}`;
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries
           (id, endpoint_id, event_id, stream_id, event_type, payload, attempt, status, next_retry_at, history, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, '[]', ?)`
        )
        .run(
          deliveryId,
          ep.id,
          event.id,
          event.streamId,
          event.name,
          JSON.stringify(event.data),
          now, // first attempt immediate
          new Date(now).toISOString()
        );
      queued++;
    }

    return queued;
  }

  getDueDeliveries(limit = 50): WebhookDelivery[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC LIMIT ?`
      )
      .all(now, limit) as Record<string, unknown>[];

    return rows.map((r) => this.toDelivery(r));
  }

  markDeliverySuccess(deliveryId: string, statusCode: number, durationMs: number): void {
    const d = this.getDelivery(deliveryId);
    if (!d) return;

    const record: WebhookAttemptRecord = {
      attempt: d.attempt,
      timestamp: Date.now(),
      status_code: statusCode,
      duration_ms: durationMs,
    };
    const newHistory = [...d.history, record];

    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'delivered', status_code = ?, history = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(statusCode, JSON.stringify(newHistory), new Date().toISOString(), deliveryId);
  }

  recordDeliveryFailure(
    deliveryId: string,
    statusCode: number | undefined,
    errorMessage: string,
    durationMs: number
  ): void {
    const d = this.getDelivery(deliveryId);
    if (!d) return;

    const record: WebhookAttemptRecord = {
      attempt: d.attempt,
      timestamp: Date.now(),
      status_code: statusCode,
      error: errorMessage,
      duration_ms: durationMs,
    };
    const newHistory = [...d.history, record];

    if (isTerminalAttempt(d.attempt)) {
      // Move to Dead-Letter Queue
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'dead_letter', status_code = ?, error = ?, history = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(
          statusCode ?? null,
          errorMessage,
          JSON.stringify(newHistory),
          new Date().toISOString(),
          deliveryId
        );

      const dlqId = `dlq_${randomBytes(12).toString("hex")}`;
      this.db
        .prepare(
          `INSERT INTO webhook_dead_letter
           (id, delivery_id, endpoint_id, event_id, stream_id, event_type, payload, attempts_count, last_error, last_status_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          dlqId,
          deliveryId,
          d.endpoint_id,
          d.event_id,
          d.stream_id,
          d.event_type,
          JSON.stringify(d.payload),
          d.attempt,
          errorMessage,
          statusCode ?? null,
          new Date().toISOString()
        );
    } else {
      // Schedule next retry with exponential backoff and jitter
      const nextAttempt = d.attempt + 1;
      const delayMs = calculateNextRetryDelay(nextAttempt);
      const nextRetryAt = Date.now() + delayMs;

      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET attempt = ?, status = 'pending', status_code = ?, error = ?, next_retry_at = ?, history = ?
           WHERE id = ?`
        )
        .run(
          nextAttempt,
          statusCode ?? null,
          errorMessage,
          nextRetryAt,
          JSON.stringify(newHistory),
          deliveryId
        );
    }
  }

  getDelivery(id: string): WebhookDelivery | undefined {
    const row = this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDelivery(row) : undefined;
  }

  listDeliveries(limit = 50): WebhookDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toDelivery(r));
  }

  listDLQ(limit = 50): WebhookDeadLetterItem[] {
    const rows = this.db
      .prepare("SELECT * FROM webhook_dead_letter ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toDLQ(r));
  }

  getDLQItem(id: string): WebhookDeadLetterItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM webhook_dead_letter WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDLQ(row) : undefined;
  }

  replayDLQItem(dlqId: string): boolean {
    const item = this.getDLQItem(dlqId);
    if (!item) return false;

    // Queue a fresh delivery
    const newDeliveryId = `del_${randomBytes(12).toString("hex")}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, endpoint_id, event_id, stream_id, event_type, payload, attempt, status, next_retry_at, history, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, '[]', ?)`
      )
      .run(
        newDeliveryId,
        item.endpoint_id,
        item.event_id,
        item.stream_id,
        item.event_type,
        JSON.stringify(item.payload),
        now,
        new Date(now).toISOString()
      );

    this.db
      .prepare("UPDATE webhook_dead_letter SET replayed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), dlqId);

    return true;
  }

  private toDelivery(row: Record<string, unknown>): WebhookDelivery {
    let payload = {};
    let history: WebhookAttemptRecord[] = [];
    try {
      payload = JSON.parse(String(row.payload));
    } catch {}
    try {
      history = JSON.parse(String(row.history));
    } catch {}

    return {
      id: String(row.id),
      endpoint_id: String(row.endpoint_id),
      event_id: String(row.event_id),
      stream_id: nullableId(row.stream_id),
      event_type: String(row.event_type),
      payload,
      attempt: Number(row.attempt),
      status: row.status as WebhookDelivery["status"],
      status_code: row.status_code !== null ? Number(row.status_code) : undefined,
      error: (row.error as string) || undefined,
      next_retry_at: Number(row.next_retry_at),
      history,
      created_at: String(row.created_at),
      completed_at: (row.completed_at as string) || undefined,
    };
  }

  private toDLQ(row: Record<string, unknown>): WebhookDeadLetterItem {
    let payload = {};
    try {
      payload = JSON.parse(String(row.payload));
    } catch {}

    return {
      id: String(row.id),
      delivery_id: String(row.delivery_id),
      endpoint_id: String(row.endpoint_id),
      event_id: String(row.event_id),
      stream_id: nullableId(row.stream_id),
      event_type: String(row.event_type),
      payload,
      attempts_count: Number(row.attempts_count),
      last_error: String(row.last_error),
      last_status_code: row.last_status_code !== null ? Number(row.last_status_code) : undefined,
      created_at: String(row.created_at),
      replayed_at: (row.replayed_at as string) || undefined,
    };
  }
}
