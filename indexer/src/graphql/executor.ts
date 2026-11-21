/**
 * Persisted-query executor (#576).
 *
 * Only allowlisted queries run (see `persisted.ts`); the executor parses
 * the allowlisted text with the minimal parser, checks depth/complexity,
 * charges the per-tenant rate budget, then resolves fields straight from
 * the existing projection store — the same `StreamStore` methods the REST
 * routes use (`getStream`, `listStreamsByRecipient`, `listAddress`,
 * `getStreamHistory`, `outbox.replayEvents`, `webhooks.listEndpoints`).
 * There is no second data path to drift.
 */
import type { StreamStore } from "../store.js";
import type { Stream } from "../types.js";
import { sanitizeAddress } from "../privacy.js";
import { redactStream, redactEvent, redactWebhookEndpoint, type StreamHistoryRow } from "../redaction.js";
import { getPersistedQuery, PERSISTED_QUERIES } from "./persisted.js";
import { parseGraphQLQuery, resolveArgs, queryDepth, queryComplexity, type FieldNode } from "./parser.js";

export const MAX_DEPTH = 5;
export const MAX_COMPLEXITY = 80;
/** Default per-tenant budget: 600 complexity units per minute, refilled steadily. */
export const DEFAULT_RATE_CAPACITY = 600;
export const DEFAULT_RATE_REFILL_PER_SECOND = 10;

export class GraphQLExecutionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Token bucket, one bucket per tenant. */
export class PerTenantRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedMs: number }>();
  constructor(
    private readonly capacity: number = DEFAULT_RATE_CAPACITY,
    private readonly refillPerSecond: number = DEFAULT_RATE_REFILL_PER_SECOND
  ) {}

  tryConsume(tenant: string, cost: number): { allowed: boolean; retryAfterSeconds: number } {
    const nowMs = Date.now();
    const bucket = this.buckets.get(tenant) ?? { tokens: this.capacity, updatedMs: nowMs };
    const refilled = Math.min(
      this.capacity,
      bucket.tokens + ((nowMs - bucket.updatedMs) / 1000) * this.refillPerSecond
    );
    if (refilled < cost) {
      this.buckets.set(tenant, { tokens: refilled, updatedMs: nowMs });
      const deficit = cost - refilled;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.refillPerSecond)) };
    }
    this.buckets.set(tenant, { tokens: refilled - cost, updatedMs: nowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Test helper: how many tokens a tenant has right now (after refill). */
  tokensFor(tenant: string): number {
    const bucket = this.buckets.get(tenant);
    return bucket ? bucket.tokens : this.capacity;
  }
}

// ── Forecast math ────────────────────────────────────────────────────────────
// Mirrors `computeAccruedAt` in frontend/lib/accrual.ts (and the Soroban
// `streamed_at` it mirrors): linear streamed = deposit * elapsed / duration,
// floored, clamped to [0, deposit]. Kept here in BigInt so the indexer does
// not depend on the frontend bundle.

export interface Forecast {
  streamId: string;
  accrued: string;
  available: string;
  projectedTotal: string;
  ratePerSecond: string;
  secondsRemaining: number;
  asOf: number;
}

export function computeForecast(stream: Stream, atSeconds: number): Forecast {
  const deposit = BigInt(stream.deposit ?? "0");
  const withdrawn = BigInt(stream.withdrawn ?? "0");
  const start = stream.startTime === null ? 0 : Number(stream.startTime);
  const end = stream.endTime === null ? 0 : Number(stream.endTime);
  const duration = end - start;
  const active = stream.status.toLowerCase() === "active";
  let accrued = 0n;
  if (duration > 0 && deposit > 0n) {
    const elapsed = Math.min(Math.max(atSeconds - start, 0), duration);
    accrued = (deposit * BigInt(elapsed)) / BigInt(duration);
    if (accrued > deposit) accrued = deposit;
  }
  const available = active ? (accrued > withdrawn ? accrued - withdrawn : 0n) : 0n;
  return {
    streamId: stream.streamId,
    accrued: accrued.toString(),
    available: available.toString(),
    projectedTotal: deposit.toString(),
    ratePerSecond: duration > 0 && active ? (deposit / BigInt(duration)).toString() : "0",
    secondsRemaining: active ? Math.max(0, end - atSeconds) : 0,
    asOf: atSeconds,
  };
}

// ── Cursor pagination ────────────────────────────────────────────────────────
// Offset cursors are opaque base64url `offset:<n>` tokens, stable because the
// underlying store listings have a fixed order (recipient ASC, address DESC
// by numeric stream id, history by ledger). Outbox event connections reuse
// the outbox `seq` cursor directly — the same cursor REST
// `GET /streams/:id/events?after=<seq>` returns as `next_cursor`.

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const m = /^offset:(\d+)$/.exec(decoded);
    if (!m) throw new Error("invalid cursor");
    return Number(m[1]);
  } catch {
    throw new GraphQLExecutionError("after must be a valid pagination cursor", 400);
  }
}

function parseFirst(first: unknown, def = 50): number {
  if (first === undefined || first === null) return def;
  const n = Number(first);
  if (!Number.isInteger(n) || n < 1) throw new GraphQLExecutionError("first must be a positive integer", 400);
  return Math.min(n, 100);
}

interface Page<T> {
  edges: Array<{ node: T; cursor: string }>;
  nodes: T[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; nextCursor: string | null };
}

function paginateOffset<T>(items: T[], first: number, after: string | undefined): Page<T> {
  const offset = decodeOffsetCursor(after);
  const slice = items.slice(offset, offset + first);
  const nextOffset = offset + slice.length;
  return {
    edges: slice.map((node, i) => ({ node, cursor: encodeOffsetCursor(offset + i) })),
    nodes: slice,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: nextOffset < items.length,
      nextCursor: nextOffset < items.length ? encodeOffsetCursor(nextOffset) : null,
    },
  };
}

// ── Executor ─────────────────────────────────────────────────────────────────

export interface ExecutorOptions {
  store: StreamStore;
  /** When true, Stellar addresses are truncated via the shared redaction (#487). */
  redactAddresses?: boolean;
  /** Wall-clock seconds for forecasts; defaults to now. */
  nowSeconds?: number;
  maxDepth?: number;
  maxComplexity?: number;
  rateLimiter?: PerTenantRateLimiter;
  tenant?: string;
}

export interface GraphQLExecutionResult {
  data: Record<string, unknown>;
}

interface Ctx {
  store: StreamStore;
  redactAddresses: boolean;
  nowSeconds: number;
}

type Node = Record<string, unknown> & { __typename: string };

function streamNode(stream: Stream, ctx: Ctx): Node {
  const redacted = redactStream(stream, ctx.redactAddresses);
  return {
    __typename: "Stream",
    id: redacted.id ?? redacted.streamId,
    streamId: redacted.streamId,
    sender: redacted.sender,
    recipient: redacted.recipient,
    token: redacted.token,
    deposit: redacted.deposit,
    withdrawn: redacted.withdrawn,
    startTime: redacted.startTime,
    endTime: redacted.endTime,
    cancelable: redacted.cancelable,
    status: redacted.status,
    cancelledBy: redacted.cancelled_by ?? null,
    recipientAmount: redacted.recipient_amount ?? null,
    senderAmount: redacted.sender_amount ?? null,
    refundTarget: redacted.refund_target ?? null,
    lastLedger: redacted.lastLedger,
    updatedAt: redacted.updatedAt,
    __stream: redacted,
  };
}

function addressNode(address: string, streams: Stream[], ctx: Ctx): Node {
  return { __typename: "Address", address: redactAddressValue(address, ctx), __streams: streams, __ctx: ctx };
}

function redactAddressValue(address: string, ctx: Ctx): string {
  // Same shared rule as redactStream: sanitizeAddress, 8-char prefix (#487).
  return ctx.redactAddresses ? sanitizeAddress(address) : address;
}

function historyEventNode(row: StreamHistoryRow, ctx: Ctx): Node {
  const redacted = redactEvent(row, ctx.redactAddresses);
  return {
    __typename: "Event",
    id: redacted.id,
    streamId: redacted.stream_id,
    eventType: redacted.event_type,
    ledger: redacted.ledger,
    ledgerClosedAt: redacted.ledger_closed_at,
    txHash: redacted.tx_hash ?? null,
    seq: null,
    payload: typeof redacted.payload === "string" ? redacted.payload : JSON.stringify(redacted.payload ?? null),
  };
}

function outboxEventNode(row: {
  seq: number;
  event_id: string;
  stream_id: string | null;
  name: string;
  ledger: number;
  ingested_at: string;
  payload: Record<string, unknown>;
}, ctx: Ctx): Node {
  const payload = redactEvent(
    { id: row.event_id, stream_id: row.stream_id ?? "", event_type: row.name, ledger: row.ledger, ledger_closed_at: row.ingested_at, payload: row.payload },
    ctx.redactAddresses
  );
  return {
    __typename: "Event",
    id: row.event_id,
    streamId: row.stream_id,
    eventType: row.name,
    ledger: row.ledger,
    ledgerClosedAt: row.ingested_at,
    txHash: null,
    seq: row.seq,
    payload: JSON.stringify(payload.payload ?? null),
  };
}

function forecastNode(forecast: Forecast): Node {
  return { __typename: "Forecast", ...forecast };
}

function resolveStreamFields(node: Node, selections: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const stream = node.__stream as Stream;
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, {});
    switch (field.name) {
      case "senderAddress":
        out[key] = stream.sender
          ? resolveAddressFields(addressNode(stream.sender, ctx.store.listAddress(stream.sender), ctx), field.selections ?? [], ctx)
          : null;
        break;
      case "recipientAddress":
        out[key] = stream.recipient
          ? resolveAddressFields(addressNode(stream.recipient, ctx.store.listAddress(stream.recipient), ctx), field.selections ?? [], ctx)
          : null;
        break;
      case "events": {
        const page = paginateOffset(
          ctx.store.getStreamHistory(stream.streamId).map((row) => historyEventNode(row, ctx)),
          parseFirst(args.first, 50),
          args.after as string | undefined
        );
        out[key] = resolveConnectionFields(page, field.selections ?? [], ctx, (n, s) => resolveEventFields(n as Node, s));
        break;
      }
      case "forecast": {
        const at = typeof args.at === "number" ? args.at : ctx.nowSeconds;
        out[key] = resolveForecastFields(forecastNode(computeForecast(stream, at)), field.selections ?? []);
        break;
      }
      default:
        if (!(field.name in node)) throw new GraphQLExecutionError(`unknown field '${field.name}' on Stream`, 400);
        out[key] = node[field.name];
    }
  }
  return out;
}

function resolveAddressFields(node: Node, selections: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const streams = node.__streams as Stream[];
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, {});
    switch (field.name) {
      case "address":
        out[key] = node.address;
        break;
      case "streamCount":
        out[key] = streams.length;
        break;
      case "streams": {
        const page = paginateOffset(
          streams.map((s) => streamNode(s, ctx)),
          parseFirst(args.first, 50),
          args.after as string | undefined
        );
        out[key] = resolveConnectionFields(page, field.selections ?? [], ctx, (n, s) => resolveStreamFields(n as Node, s, ctx));
        break;
      }
      default:
        throw new GraphQLExecutionError(`unknown field '${field.name}' on Address`, 400);
    }
  }
  return out;
}

function resolveEventFields(node: Node, selections: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (!(field.name in node)) throw new GraphQLExecutionError(`unknown field '${field.name}' on Event`, 400);
    out[key] = node[field.name];
  }
  return out;
}

function resolveForecastFields(node: Node, selections: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (!(field.name in node)) throw new GraphQLExecutionError(`unknown field '${field.name}' on Forecast`, 400);
    out[key] = node[field.name];
  }
  return out;
}

function resolveConnectionFields<T>(
  page: Page<T>,
  selections: FieldNode[],
  ctx: Ctx,
  resolveNode: (node: T, selections: FieldNode[]) => Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case "totalCount":
        out[key] = page.totalCount;
        break;
      case "nodes":
        out[key] = page.nodes.map((n) => resolveNode(n, field.selections ?? []));
        break;
      case "edges":
        out[key] = page.edges.map((edge) => {
          const edgeOut: Record<string, unknown> = {};
          for (const ef of field.selections ?? []) {
            if (ef.name === "cursor") edgeOut[ef.alias ?? "cursor"] = edge.cursor;
            else if (ef.name === "node") edgeOut[ef.alias ?? "node"] = resolveNode(edge.node, ef.selections ?? []);
            else throw new GraphQLExecutionError(`unknown field '${ef.name}' on edge`, 400);
          }
          return edgeOut;
        });
        break;
      case "pageInfo": {
        const pi: Record<string, unknown> = {};
        for (const pf of field.selections ?? []) {
          if (pf.name === "hasNextPage") pi[pf.alias ?? pf.name] = page.pageInfo.hasNextPage;
          else if (pf.name === "nextCursor") pi[pf.alias ?? pf.name] = page.pageInfo.nextCursor;
          else throw new GraphQLExecutionError(`unknown field '${pf.name}' on PageInfo`, 400);
        }
        out[key] = pi;
        break;
      }
      default:
        throw new GraphQLExecutionError(`unknown field '${field.name}' on connection`, 400);
    }
  }
  return out;
}

function resolveRootField(field: FieldNode, variables: Record<string, unknown>, ctx: Ctx): unknown {
  const args = resolveArgs(field.args, variables);
  switch (field.name) {
    case "stream": {
      const id = args.id;
      if (typeof id !== "string" || !/^\d+$/.test(id)) return null;
      const stream = ctx.store.getStream(id);
      return stream ? resolveStreamFields(streamNode(stream, ctx), field.selections ?? [], ctx) : null;
    }
    case "streamsByRecipient": {
      const recipient = String(args.recipient ?? "");
      const page = paginateOffset(
        ctx.store.listStreamsByRecipient(recipient).map((s) => streamNode(s, ctx)),
        parseFirst(args.first, 50),
        args.after as string | undefined
      );
      return resolveConnectionFields(page, field.selections ?? [], ctx, (n, s) => resolveStreamFields(n as Node, s, ctx));
    }
    case "streamsByAddress": {
      const address = String(args.address ?? "");
      const page = paginateOffset(
        ctx.store.listAddress(address).map((s) => streamNode(s, ctx)),
        parseFirst(args.first, 50),
        args.after as string | undefined
      );
      return resolveConnectionFields(page, field.selections ?? [], ctx, (n, s) => resolveStreamFields(n as Node, s, ctx));
    }
    case "address": {
      const address = String(args.address ?? "");
      const streams = ctx.store.listAddress(address);
      return resolveAddressFields(addressNode(address, streams, ctx), field.selections ?? [], ctx);
    }
    case "streamHistory": {
      const streamId = String(args.streamId ?? "");
      const page = paginateOffset(
        ctx.store.getStreamHistory(streamId).map((row) => historyEventNode(row, ctx)),
        parseFirst(args.first, 50),
        args.after as string | undefined
      );
      return resolveConnectionFields(page, field.selections ?? [], ctx, (n, s) => resolveEventFields(n as Node, s));
    }
    case "streamEvents": {
      // Reuses the outbox seq cursor: `after` is the last seen seq, exactly
      // as REST `GET /streams/:id/events?after=<seq>` takes it.
      const streamId = String(args.streamId ?? "");
      const first = parseFirst(args.first, 100);
      const afterRaw = args.after;
      const afterSeq = afterRaw === undefined || afterRaw === null || afterRaw === "" ? 0 : Number(afterRaw);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw new GraphQLExecutionError("after must be a non-negative integer seq cursor", 400);
      }
      const replay = ctx.store.outbox.replayEvents(streamId, afterSeq, first);
      const nodes = replay.events.map((row) => outboxEventNode(row, ctx));
      const nextCursor = replay.next_cursor === null ? null : String(replay.next_cursor);
      const page: Page<Node> = {
        edges: nodes.map((node) => ({ node, cursor: String((node as Node).seq) })),
        nodes,
        totalCount: nodes.length,
        pageInfo: {
          hasNextPage: nodes.length === first && nextCursor !== null,
          nextCursor: nodes.length === first ? nextCursor : null,
        },
      };
      return resolveConnectionFields(page, field.selections ?? [], ctx, (n, s) => resolveEventFields(n as Node, s));
    }
    case "forecast": {
      const streamId = String(args.streamId ?? "");
      const stream = ctx.store.getStream(streamId);
      if (!stream) return null;
      const at = typeof args.at === "number" ? args.at : ctx.nowSeconds;
      return resolveForecastFields(forecastNode(computeForecast(stream, at)), field.selections ?? []);
    }
    case "webhookSubscriptions": {
      const endpoints = ctx.store.webhooks.listEndpoints();
      // GraphQL field names are camelCase; the store row is snake_case.
      const fieldMap: Record<string, string> = { createdAt: "created_at", updatedAt: "updated_at" };
      return endpoints.map((ep) => {
        const redacted = redactWebhookEndpoint(ep, ctx.redactAddresses);
        const out: Record<string, unknown> = {};
        for (const f of field.selections ?? []) {
          const key = f.alias ?? f.name;
          const rowKey = fieldMap[f.name] ?? f.name;
          if (!(rowKey in redacted)) throw new GraphQLExecutionError(`unknown field '${f.name}' on WebhookSubscription`, 400);
          out[key] = redacted[rowKey as keyof typeof redacted];
        }
        return out;
      });
    }
    default:
      throw new GraphQLExecutionError(`unknown root field '${field.name}'`, 400);
  }
}

/**
 * Execute one persisted query. Throws `GraphQLExecutionError` for unknown
 * ids, depth/complexity violations and rate-budget exhaustion; the HTTP
 * handler maps those to 400/429.
 */
export function executePersistedQuery(
  queryId: string,
  variables: Record<string, unknown> = {},
  options: ExecutorOptions
): GraphQLExecutionResult {
  const queryText = getPersistedQuery(queryId);
  if (!queryText) {
    throw new GraphQLExecutionError(`unknown persisted query: ${queryId}`, 400);
  }
  const parsed = parseGraphQLQuery(queryText);
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxComplexity = options.maxComplexity ?? MAX_COMPLEXITY;
  const depth = queryDepth(parsed.selections);
  if (depth > maxDepth) {
    throw new GraphQLExecutionError(`query depth ${depth} exceeds limit ${maxDepth}`, 400);
  }
  const complexity = queryComplexity(parsed.selections);
  if (complexity > maxComplexity) {
    throw new GraphQLExecutionError(`query complexity ${complexity} exceeds limit ${maxComplexity}`, 400);
  }
  if (options.rateLimiter) {
    const tenant = options.tenant ?? "default";
    const result = options.rateLimiter.tryConsume(tenant, Math.max(1, complexity));
    if (!result.allowed) {
      throw new GraphQLExecutionError(
        `rate budget exhausted for tenant ${tenant}; retry after ${result.retryAfterSeconds}s`,
        429
      );
    }
  }
  const ctx: Ctx = {
    store: options.store,
    redactAddresses: options.redactAddresses ?? false,
    nowSeconds: options.nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  const data: Record<string, unknown> = {};
  for (const field of parsed.selections) {
    data[field.alias ?? field.name] = resolveRootField(field, variables, ctx);
  }
  return { data };
}

/** Validate every allowlisted query against the limits (used at boot and in tests). */
export function validatePersistedQueries(
  maxDepth: number = MAX_DEPTH,
  maxComplexity: number = MAX_COMPLEXITY
): Array<{ queryId: string; depth: number; complexity: number }> {
  return Object.entries(PERSISTED_QUERIES).map(([queryId, text]) => {
    const parsed = parseGraphQLQuery(text);
    const depth = queryDepth(parsed.selections);
    const complexity = queryComplexity(parsed.selections);
    if (depth > maxDepth) throw new GraphQLExecutionError(`persisted query ${queryId} depth ${depth} exceeds limit ${maxDepth}`, 400);
    if (complexity > maxComplexity) throw new GraphQLExecutionError(`persisted query ${queryId} complexity ${complexity} exceeds limit ${maxComplexity}`, 400);
    return { queryId, depth, complexity };
  });
}
