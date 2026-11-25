// gRPC server-streaming transport for live event delivery (issue #579).
//
// Built on node:http2 only — no new dependency. The server implements the
// gRPC wire protocol (5-byte frame header, `application/grpc`, `grpc-status`
// trailers) well enough for a real HTTP/2 client to subscribe and decode
// frames, and it reuses the transactional outbox for at-least-once delivery:
//
//   * Subscribe replays `store.outbox.replayEvents(streamId, cursor, n)`
//     (seq-ordered, retracted rows excluded), then streams live events as
//     the store emits them. A subscription never blocks the store's
//     "event" emitter: the handler only schedules a drain.
//   * Backpressure is three layers deep: HTTP/2 flow control
//     (`stream.write()` returning false pauses until 'drain'),
//     application-level credit (initial_credit + Ack grants), and a
//     bounded per-subscription queue (default 100). A slow consumer
//     pauses its own subscription — its undelivered seq stays
//     un-advanced, so the next drain replays the same outbox rows —
//     while ingestion and other subscribers keep flowing.
//   * Resume/dedup: the client acks seqs with the unary Ack RPC and
//     reconnects with the last acked seq as `cursor`. Unacked events
//     are redelivered; clients dedup by `seq`/`event_id`.
//   * Per-tenant limits: max concurrent subscriptions per tenant and a
//     per-tenant token-bucket rate budget. Both are enforced here, not
//     in the client.
//   * Privacy: when the subscription asks for it, payloads are redacted
//     with the shared helper in `../redaction.ts` (sanitizeAddress).

import http2 from "node:http2";
import { randomBytes } from "node:crypto";
import type { StreamStore } from "../store.js";
import type { DecodedEvent, Stream } from "../types.js";
import { ALL_CONTRACT_EVENT_NAMES } from "../generated/events.js";
import {
  decodeAckRequest,
  decodeGrpcFrames,
  decodeSubscribeRequest,
  encodeAckResponse,
  encodeGrpcFrame,
  encodeStreamEvent,
  type AckRequestMessage,
  type StreamEventMessage,
  type SubscribeRequestMessage,
} from "./codec.js";
import { payloadWasRedacted, redactPayload } from "../redaction.js";

export const GRPC_SERVICE = "streampay.indexer.v1.StreamPayIndexer";
export const GRPC_SUBSCRIBE_PATH = `/${GRPC_SERVICE}/Subscribe`;
export const GRPC_ACK_PATH = `/${GRPC_SERVICE}/Ack`;

export const DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT = 5;
export const DEFAULT_MAX_EVENTS_PER_SECOND_PER_TENANT = 100;
export const DEFAULT_MAX_QUEUE_PER_SUBSCRIPTION = 100;
export const DEFAULT_CREDIT = 100;
export const DEFAULT_REPLAY_PAGE_SIZE = 50;
export const MAX_CREDIT = 10_000;

const GRPC_OK = "0";
const GRPC_INVALID_ARGUMENT = "3";
const GRPC_NOT_FOUND = "5";
const GRPC_RESOURCE_EXHAUSTED = "8";
const GRPC_UNIMPLEMENTED = "12";
const GRPC_INTERNAL = "13";

export interface GrpcServerOptions {
  /** Port to listen on when `listen()` is called without one (default 8788). */
  port?: number;
  /** Max concurrent subscriptions per tenant (default 5). */
  maxSubscriptionsPerTenant?: number;
  /** Per-tenant rate budget, events/second (default 100). */
  maxEventsPerSecondPerTenant?: number;
  /** Bounded queue per subscription, events (default 100). */
  maxQueuePerSubscription?: number;
  /** Credit granted when Subscribe omits initial_credit (default 100). */
  defaultCredit?: number;
  /** Outbox rows fetched per drain (default 50). */
  replayPageSize?: number;
}

export interface GrpcSubscriptionStats {
  id: string;
  tenant: string;
  streamId: string;
  /** Last seq enqueued for delivery (the resume cursor). */
  cursor: number;
  lastAckedSeq: number;
  credit: number;
  queueDepth: number;
  delivered: number;
  paused: boolean;
  closed: boolean;
}

export interface GrpcServerStats {
  activeSubscriptions: number;
  subscriptionsByTenant: Record<string, number>;
  totalDelivered: number;
}

/** Per-tenant token bucket: `ratePerSecond` tokens refill continuously. */
export class RateBudget {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSecond: number,
    nowMs = Date.now()
  ) {
    this.tokens = ratePerSecond;
    this.lastRefillMs = nowMs;
  }

  tokensAvailable(nowMs = Date.now()): number {
    this.refill(nowMs);
    return this.tokens;
  }

  tryConsume(nowMs = Date.now()): boolean {
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  msUntilNextToken(nowMs = Date.now()): number {
    this.refill(nowMs);
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
  }

  private refill(nowMs: number): void {
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.ratePerSecond, this.tokens + elapsedSec * this.ratePerSecond);
    this.lastRefillMs = nowMs;
  }
}

interface Subscription {
  id: string;
  tenant: string;
  streamId: string;
  cursor: number;
  lastAckedSeq: number;
  credit: number;
  queue: StreamEventMessage[];
  delivered: number;
  limitRemaining: number | null;
  eventNames: Set<string> | null;
  redact: boolean;
  stream: http2.ServerHttp2Stream;
  closed: boolean;
  writePaused: boolean;
  draining: boolean;
  drainTimer: NodeJS.Timeout | undefined;
  pausedCount: number;
}

export class GrpcIndexerServer {
  private readonly server: http2.Http2Server;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly byTenant = new Map<string, Set<string>>();
  private readonly budgets = new Map<string, RateBudget>();
  private readonly maxPerTenant: number;
  private readonly ratePerSecond: number;
  private readonly maxQueue: number;
  private readonly defaultCredit: number;
  private readonly replayPageSize: number;
  private readonly defaultPort: number;
  private totalDelivered = 0;
  private closed = false;
  private readonly ledgerClosedAtStmt: ReturnType<StreamStore["db"]["prepare"]>;

  constructor(
    private readonly store: StreamStore,
    options: GrpcServerOptions = {}
  ) {
    this.maxPerTenant = options.maxSubscriptionsPerTenant ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT;
    this.ratePerSecond = options.maxEventsPerSecondPerTenant ?? DEFAULT_MAX_EVENTS_PER_SECOND_PER_TENANT;
    this.maxQueue = options.maxQueuePerSubscription ?? DEFAULT_MAX_QUEUE_PER_SUBSCRIPTION;
    this.defaultCredit = options.defaultCredit ?? DEFAULT_CREDIT;
    this.replayPageSize = options.replayPageSize ?? DEFAULT_REPLAY_PAGE_SIZE;
    this.defaultPort = options.port ?? 8788;
    this.ledgerClosedAtStmt = this.store.db.prepare(
      "SELECT ledger_closed_at FROM events WHERE id = ?"
    );
    this.server = http2.createServer();
    this.server.on("stream", (stream, headers) => this.handleStream(stream, headers));
    this.server.on("sessionError", () => {
      // A single bad HTTP/2 session must not take the transport down.
    });
  }

  /** Start listening; resolves with the actual port (useful with port 0). */
  listen(port?: number): Promise<number> {
    const target = port ?? this.defaultPort;
    return new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(target, () => {
        const address = this.server.address();
        resolve(typeof address === "object" && address !== null ? address.port : target);
      });
    });
  }

  /** Stop accepting, end every subscription, and close the HTTP/2 server. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store.off("event", this.onStoreEvent);
    for (const sub of [...this.subscriptions.values()]) {
      this.endSubscription(sub, GRPC_OK, "");
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Sessions idle after their streams end still hold the server open;
      // force them closed rather than hanging shutdown on a dead client.
      setTimeout(() => {
        try {
          (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        } catch {}
        resolve();
      }, 500).unref();
    });
  }

  activeSubscriptions(tenant?: string): number {
    if (tenant === undefined) return this.subscriptions.size;
    return this.byTenant.get(tenant)?.size ?? 0;
  }

  subscriptionStats(): GrpcSubscriptionStats[] {
    return [...this.subscriptions.values()].map((sub) => ({
      id: sub.id,
      tenant: sub.tenant,
      streamId: sub.streamId,
      cursor: sub.cursor,
      lastAckedSeq: sub.lastAckedSeq,
      credit: sub.credit,
      queueDepth: sub.queue.length,
      delivered: sub.delivered,
      paused: sub.queue.length >= this.maxQueue || sub.credit <= 0 || sub.writePaused,
      closed: sub.closed,
    }));
  }

  stats(): GrpcServerStats {
    const byTenant: Record<string, number> = {};
    for (const [tenant, ids] of this.byTenant) byTenant[tenant] = ids.size;
    return { activeSubscriptions: this.subscriptions.size, subscriptionsByTenant: byTenant, totalDelivered: this.totalDelivered };
  }

  // -------------------------------------------------------------------------
  // HTTP/2 + gRPC framing
  // -------------------------------------------------------------------------

  private handleStream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    const path = String(headers[":path"] ?? "");
    if (path === GRPC_SUBSCRIBE_PATH) {
      this.handleSubscribe(stream, headers);
    } else if (path === GRPC_ACK_PATH) {
      this.handleAck(stream);
    } else {
      this.sendGrpcError(stream, false, GRPC_UNIMPLEMENTED, `unknown method ${path}`);
    }
  }

  /**
   * End a gRPC stream with a status. Node's core HTTP/2 stream has no
   * `addTrailers`: the stream must be responded to with
   * `waitForTrailers: true`, ended, and then `sendTrailers` is called from
   * the 'wantTrailers' event that `end()` triggers (the client signals
   * it wants trailers with `te: trailers`, which every gRPC client does).
   */
  private endGrpcStream(stream: http2.ServerHttp2Stream, code: string, message: string): void {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        stream.sendTrailers({ "grpc-status": code, "grpc-message": message });
      } catch {}
    };
    stream.once("wantTrailers", finish);
    try {
      stream.end();
    } catch {}
  }

  private sendGrpcError(
    stream: http2.ServerHttp2Stream,
    responded: boolean,
    code: string,
    message: string
  ): void {
    try {
      if (!responded) {
        // Trailers-only response: the status rides in the headers, so it
        // reaches the client even if it never asked for trailers.
        stream.respond({
          ":status": 200,
          "content-type": "application/grpc",
          "grpc-status": code,
          "grpc-message": message,
        });
        stream.end();
      } else {
        this.endGrpcStream(stream, code, message);
      }
    } catch {}
  }

  private handleAck(stream: http2.ServerHttp2Stream): void {
    let buffer: Buffer = Buffer.alloc(0);
    let responded = false;
    stream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
    });
    stream.on("end", () => {
      try {
        const { messages } = decodeGrpcFrames(buffer);
        if (messages.length === 0) {
          this.sendGrpcError(stream, responded, GRPC_INVALID_ARGUMENT, "Ack requires a request message");
          return;
        }
        const req = decodeAckRequest(messages[0]);
        const result = this.applyAck(req);
        if (!result) {
          this.sendGrpcError(stream, responded, GRPC_NOT_FOUND, "subscription not found");
          return;
        }
        responded = true;
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true }
        );
        stream.write(encodeGrpcFrame(encodeAckResponse(result)));
        this.endGrpcStream(stream, GRPC_OK, "");
      } catch (err) {
        this.sendGrpcError(stream, responded, GRPC_INTERNAL, err instanceof Error ? err.message : String(err));
      }
    });
    stream.on("error", () => {});
  }

  private applyAck(
    req: AckRequestMessage
  ): { ackedSeq: number; creditAvailable: number; active: boolean } | undefined {
    let sub: Subscription | undefined;
    if (req.subscriptionId) {
      sub = this.subscriptions.get(req.subscriptionId);
    } else if (req.streamId) {
      const tenant = req.tenant || "default";
      sub = [...this.subscriptions.values()].find(
        (candidate) => candidate.tenant === tenant && candidate.streamId === req.streamId
      );
    }
    if (!sub || sub.closed) return undefined;
    // Never ack past what this subscription has actually been handed.
    sub.lastAckedSeq = Math.max(sub.lastAckedSeq, Math.min(req.ackedSeq, sub.cursor));
    sub.credit = Math.min(MAX_CREDIT, sub.credit + req.credit);
    this.scheduleDrain(sub, 0);
    return { ackedSeq: sub.lastAckedSeq, creditAvailable: sub.credit, active: !sub.closed };
  }

  private handleSubscribe(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    let buffer: Buffer = Buffer.alloc(0);
    let sub: Subscription | undefined;
    let responded = false;

    const start = (req: SubscribeRequestMessage): void => {
      const tenant = req.tenant || String(headers["x-tenant-id"] ?? "") || "default";
      if (!/^\d+$/.test(req.streamId)) {
        this.sendGrpcError(stream, responded, GRPC_INVALID_ARGUMENT, "stream_id must be a numeric stream id");
        return;
      }
      if (tenant.length > 128) {
        this.sendGrpcError(stream, responded, GRPC_INVALID_ARGUMENT, "tenant is too long");
        return;
      }
      for (const name of req.eventNames) {
        if (!(ALL_CONTRACT_EVENT_NAMES as readonly string[]).includes(name)) {
          this.sendGrpcError(stream, responded, GRPC_INVALID_ARGUMENT, `unknown event name ${name}`);
          return;
        }
      }
      const tenantSubs = this.byTenant.get(tenant) ?? new Set<string>();
      if (tenantSubs.size >= this.maxPerTenant) {
        this.sendGrpcError(
          stream,
          responded,
          GRPC_RESOURCE_EXHAUSTED,
          `tenant ${tenant} has ${tenantSubs.size} concurrent subscriptions (max ${this.maxPerTenant})`
        );
        return;
      }

      sub = {
        id: randomBytes(8).toString("hex"),
        tenant,
        streamId: req.streamId,
        cursor: req.cursor,
        lastAckedSeq: req.cursor,
        credit: req.initialCredit > 0 ? Math.min(MAX_CREDIT, req.initialCredit) : this.defaultCredit,
        queue: [],
        delivered: 0,
        limitRemaining: req.limit > 0 ? req.limit : null,
        eventNames: req.eventNames.length > 0 ? new Set(req.eventNames) : null,
        redact: req.redactAddresses,
        stream,
        closed: false,
        writePaused: false,
        draining: false,
        drainTimer: undefined,
        pausedCount: 0,
      };
      this.subscriptions.set(sub.id, sub);
      tenantSubs.add(sub.id);
      this.byTenant.set(tenant, tenantSubs);
      if (this.subscriptions.size === 1) {
        this.store.on("event", this.onStoreEvent);
      }

      responded = true;
      try {
        stream.respond(
          {
            ":status": 200,
            "content-type": "application/grpc",
            "grpc-accept-encoding": "identity",
            "x-subscription-id": sub.id,
          },
          { waitForTrailers: true }
        );
      } catch {
        this.cleanupSubscription(sub);
        return;
      }
      this.scheduleDrain(sub, 0);
    };

    stream.on("data", (chunk: Buffer) => {
      if (sub) return; // server-streaming: only the first message is the request
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const { messages, rest } = decodeGrpcFrames(buffer);
        buffer = rest;
        if (messages.length > 0) start(decodeSubscribeRequest(messages[0]));
      } catch (err) {
        this.sendGrpcError(stream, responded, GRPC_INVALID_ARGUMENT, err instanceof Error ? err.message : String(err));
      }
    });
    stream.on("end", () => {
      if (!sub && !responded) {
        this.sendGrpcError(stream, responded, GRPC_INVALID_ARGUMENT, "Subscribe requires a request message");
      }
      // A client half-close is normal for server-streaming: the server
      // keeps streaming live events until the client cancels the stream.
    });
    stream.on("close", () => {
      if (sub) this.cleanupSubscription(sub);
    });
    stream.on("error", () => {
      if (sub) this.cleanupSubscription(sub);
    });
    stream.on("drain", () => {
      if (sub && !sub.closed) {
        sub.writePaused = false;
        this.scheduleDrain(sub, 0);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Delivery: outbox replay + live fan-out, never blocking ingestion
  // -------------------------------------------------------------------------

  /** Store "event" handler: schedule drains only — it never writes or waits. */
  private readonly onStoreEvent = (event: DecodedEvent, _stream?: Stream): void => {
    if (event.streamId === null) return;
    for (const sub of this.subscriptions.values()) {
      if (!sub.closed && sub.streamId === event.streamId) {
        this.scheduleDrain(sub, 0);
      }
    }
  };

  private scheduleDrain(sub: Subscription, delayMs: number): void {
    if (sub.closed || sub.drainTimer !== undefined) return;
    sub.drainTimer = setTimeout(() => {
      sub.drainTimer = undefined;
      this.pump(sub);
    }, delayMs);
    sub.drainTimer.unref();
  }

  /**
   * Flush the bounded queue, then refill it from the outbox. The loop only
   * advances `cursor` for rows it actually enqueues (or filters out), so a
   * paused subscription replays the same rows on the next drain — no loss,
   * no duplicates from the server side, and no blocking of other work.
   */
  private pump(sub: Subscription): void {
    if (sub.closed || sub.draining) return;
    sub.draining = true;
    try {
      for (;;) {
        // 1. Flush what is queued, honouring credit and the rate budget.
        while (sub.queue.length > 0 && sub.credit > 0) {
          if (sub.limitRemaining === 0) {
            this.endSubscription(sub, GRPC_OK, "");
            return;
          }
          const budget = this.budgetFor(sub.tenant);
          if (!budget.tryConsume()) {
            this.scheduleDrain(sub, budget.msUntilNextToken());
            return;
          }
          const event = sub.queue.shift()!;
          const ok = sub.stream.write(encodeGrpcFrame(encodeStreamEvent(event)));
          sub.credit -= 1;
          sub.delivered += 1;
          this.totalDelivered += 1;
          if (sub.limitRemaining !== null) sub.limitRemaining -= 1;
          if (!ok) {
            // The frame is buffered by the transport (not lost); stop
            // writing until HTTP/2 flow control says the stream drained.
            sub.writePaused = true;
            return;
          }
          if (sub.limitRemaining === 0) {
            this.endSubscription(sub, GRPC_OK, "");
            return;
          }
        }
        if (sub.queue.length > 0) return; // out of credit: wait for an Ack
        if (sub.credit <= 0) return;
        if (sub.limitRemaining === 0) {
          this.endSubscription(sub, GRPC_OK, "");
          return;
        }

        // 2. Refill from the outbox, seq-ordered from the last enqueued seq.
        let page;
        try {
          page = this.store.outbox.replayEvents(sub.streamId, sub.cursor, this.replayPageSize);
        } catch {
          return;
        }
        if (page.events.length === 0) return; // caught up: wait for live events
        let enqueued = 0;
        for (const row of page.events) {
          if (sub.eventNames && !sub.eventNames.has(row.name)) {
            sub.cursor = row.seq; // filtered rows are consumed, not re-fetched
            continue;
          }
          if (sub.queue.length >= this.maxQueue) {
            sub.pausedCount += 1;
            break;
          }
          sub.queue.push(this.toStreamEvent(row, sub.redact));
          sub.cursor = row.seq;
          enqueued += 1;
        }
        if (enqueued === 0) return;
        // Loop: flush the newly enqueued events (or stop on credit/rate).
      }
    } finally {
      sub.draining = false;
    }
  }

  private toStreamEvent(
    row: {
      seq: number;
      idempotency_key: string;
      event_id: string;
      stream_id: string | null;
      name: string;
      ledger: number;
      payload: Record<string, unknown>;
    },
    redact: boolean
  ): StreamEventMessage {
    let ledgerClosedAt = "";
    try {
      const found = this.ledgerClosedAtStmt.get(row.event_id) as { ledger_closed_at: string } | undefined;
      ledgerClosedAt = found?.ledger_closed_at ?? "";
    } catch {}
    const payload = redact ? redactPayload(row.payload, true) : row.payload;
    return {
      seq: row.seq,
      eventId: row.event_id,
      streamId: row.stream_id ?? "",
      name: row.name,
      ledger: row.ledger,
      ledgerClosedAt,
      payloadJson: JSON.stringify(payload, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      idempotencyKey: row.idempotency_key,
      cursor: row.seq,
      redacted: redact && payloadWasRedacted(row.payload),
    };
  }

  private budgetFor(tenant: string): RateBudget {
    let budget = this.budgets.get(tenant);
    if (!budget) {
      budget = new RateBudget(this.ratePerSecond);
      this.budgets.set(tenant, budget);
    }
    return budget;
  }

  private endSubscription(sub: Subscription, code: string, message: string): void {
    if (sub.closed) return;
    sub.closed = true;
    if (sub.drainTimer) {
      clearTimeout(sub.drainTimer);
      sub.drainTimer = undefined;
    }
    this.removeSubscription(sub);
    this.endGrpcStream(sub.stream, code, message);
  }

  private cleanupSubscription(sub: Subscription): void {
    if (sub.closed) return;
    sub.closed = true;
    if (sub.drainTimer) {
      clearTimeout(sub.drainTimer);
      sub.drainTimer = undefined;
    }
    this.removeSubscription(sub);
  }

  private removeSubscription(sub: Subscription): void {
    this.subscriptions.delete(sub.id);
    const tenantSubs = this.byTenant.get(sub.tenant);
    if (tenantSubs) {
      tenantSubs.delete(sub.id);
      if (tenantSubs.size === 0) this.byTenant.delete(sub.tenant);
    }
    if (this.subscriptions.size === 0) {
      this.store.off("event", this.onStoreEvent);
    }
  }
}

export function createGrpcServer(store: StreamStore, options: GrpcServerOptions = {}): GrpcIndexerServer {
  return new GrpcIndexerServer(store, options);
}
