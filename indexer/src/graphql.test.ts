import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { StreamStore } from "./store.js";
import { createApp } from "./index.js";
import { redactStream } from "./redaction.js";
import type { DecodedEvent, Stream } from "./types.js";
import {
  GRAPHQL_SDL,
  STREAM_FIELD_MAP,
  streamTypeFields,
  PERSISTED_QUERY_IDS,
  parseGraphQLQuery,
  queryDepth,
  queryComplexity,
  validatePersistedQueries,
  PerTenantRateLimiter,
  GraphQLExecutionError,
  executePersistedQuery,
  MAX_DEPTH,
  MAX_COMPLEXITY,
} from "./graphql/index.js";

const SENDER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SENDER_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const RECIPIENT = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const OTHER = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";

function seedStore(): StreamStore {
  const store = new StreamStore(":memory:");
  const created = (id: string, streamId: string, sender: string, recipient: string, deposit: bigint, start: bigint, end: bigint): DecodedEvent => ({
    id, pagingToken: id, ledger: 10, ledgerClosedAt: "2026-01-01T00:00:00Z", contractId: "C",
    name: "stream_created", streamId,
    data: { sender, recipient, token: TOKEN, deposit, start_time: start, end_time: end, cancelable: true },
  });
  store.ingestPage([
    created("e-1", "1", SENDER_A, RECIPIENT, 1000n, 1000n, 2000n),
    created("e-2", "2", SENDER_B, RECIPIENT, 2000n, 1000n, 3000n),
    created("e-3", "3", SENDER_A, OTHER, 500n, 1000n, 2000n),
  ], "3", 12);
  store.ingest({
    id: "e-4", pagingToken: "4", ledger: 11, ledgerClosedAt: "2026-01-01T00:01:00Z", contractId: "C",
    name: "withdrawn", streamId: "1",
    data: { recipient: RECIPIENT, amount: 100n, withdrawn_total: 100n },
  });
  return store;
}

interface HttpResult { status: number; text: string; data: any }

function request(port: number, method: string, path: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let data: any = text;
          try { data = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode ?? 0, text, data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer<T>(store: StreamStore, graphqlOptions: any, fn: (port: number) => Promise<T>): Promise<T> {
  const app = createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, graphqlOptions);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const gql = (port: number, queryId: string, variables: Record<string, unknown> = {}, tenant = "default") =>
  request(port, "POST", "/graphql", { queryId, variables, tenant });

test("GET /graphql/schema serves the SDL", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const res = await request(port, "GET", "/graphql/schema");
      assert.equal(res.status, 200);
      assert.match(res.text, /type Stream \{/);
      assert.match(res.text, /type Query \{/);
      assert.equal(res.text, GRAPHQL_SDL);
    });
  } finally { store.close(); }
});

test("contract: GetStream matches REST /streams/:id for the same fixture", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const rest = await request(port, "GET", "/streams/1");
      assert.equal(rest.status, 200);
      const gqlRes = await gql(port, "GetStream", { id: "1" });
      assert.equal(gqlRes.status, 200, JSON.stringify(gqlRes.data));
      const g = gqlRes.data.data.stream;
      // Every scalar field GraphQL returned equals the REST row.
      for (const [key, value] of Object.entries(g)) {
        assert.deepEqual(value, (rest.data as Record<string, unknown>)[key] ?? null, `field ${key}`);
      }
      assert.equal(g.streamId, "1");
      assert.equal(g.sender, SENDER_A);
      assert.equal(g.deposit, "1000");
      assert.equal(g.withdrawn, "100");
      // Field selection: GetStream does not ask for forecast, so it is absent.
      assert.equal("forecast" in g, false);
      // Unknown stream -> null, not an error.
      const missing = await gql(port, "GetStream", { id: "999" });
      assert.equal(missing.data.data.stream, null);
    });
  } finally { store.close(); }
});

test("contract: GetStreamsByRecipient matches REST /streams?recipient=", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const rest = await request(port, "GET", `/streams?recipient=${RECIPIENT}`);
      const gqlRes = await gql(port, "GetStreamsByRecipient", { recipient: RECIPIENT });
      assert.equal(gqlRes.status, 200);
      const nodes = gqlRes.data.data.streamsByRecipient.edges.map((e: any) => e.node);
      assert.equal(nodes.length, rest.data.length);
      assert.deepEqual(nodes.map((n: any) => n.streamId), rest.data.map((s: any) => s.streamId));
      for (let i = 0; i < nodes.length; i++) {
        assert.equal(nodes[i].sender, rest.data[i].sender);
        assert.equal(nodes[i].deposit, rest.data[i].deposit);
      }
      assert.equal(gqlRes.data.data.streamsByRecipient.totalCount, 2);
    });
  } finally { store.close(); }
});

test("contract: GetStreamHistory matches REST /streams/:id/history", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const rest = await request(port, "GET", "/streams/1/history");
      const gqlRes = await gql(port, "GetStreamHistory", { streamId: "1" });
      assert.equal(gqlRes.status, 200);
      const nodes = gqlRes.data.data.streamHistory.edges.map((e: any) => e.node);
      assert.equal(nodes.length, rest.data.length);
      assert.deepEqual(nodes.map((n: any) => n.eventType), rest.data.map((r: any) => r.event_type));
      assert.deepEqual(nodes.map((n: any) => n.ledger), rest.data.map((r: any) => r.ledger));
      assert.deepEqual(nodes.map((n: any) => n.id), rest.data.map((r: any) => r.id));
    });
  } finally { store.close(); }
});

test("contract: GetAddressStreams matches REST /address/:addr/streams", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const rest = await request(port, "GET", `/address/${RECIPIENT}/streams`);
      const gqlRes = await gql(port, "GetAddressStreams", { address: RECIPIENT });
      assert.equal(gqlRes.status, 200);
      const addr = gqlRes.data.data.address;
      assert.equal(addr.address, RECIPIENT);
      assert.equal(addr.streamCount, rest.data.count);
      assert.deepEqual(
        addr.streams.edges.map((e: any) => e.node.streamId).sort(),
        rest.data.streams.map((s: any) => s.streamId).sort()
      );
    });
  } finally { store.close(); }
});

test("cursor pagination is stable across pages (offset cursors)", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 5; i++) {
        const res = await gql(port, "GetStreamsByRecipient", { recipient: RECIPIENT, first: 1, after });
        const conn = res.data.data.streamsByRecipient;
        assert.equal(conn.edges.length, 1);
        seen.push(conn.edges[0].node.streamId);
        if (!conn.pageInfo.hasNextPage) {
          assert.equal(conn.pageInfo.nextCursor, null);
          break;
        }
        after = conn.pageInfo.nextCursor;
      }
      assert.deepEqual(seen, ["1", "2"]);
    });
  } finally { store.close(); }
});

test("streamEvents reuses the outbox seq cursor like REST /streams/:id/events", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const rest = await request(port, "GET", "/streams/1/events?after=0&limit=100");
      const gqlRes = await gql(port, "GetStreamEvents", { streamId: "1", first: 1 });
      assert.equal(gqlRes.status, 200);
      const conn = gqlRes.data.data.streamEvents;
      assert.equal(conn.edges.length, 1);
      assert.equal(conn.pageInfo.hasNextPage, true);
      const seqCursor = conn.pageInfo.nextCursor;
      assert.equal(typeof seqCursor, "string");
      // The cursor is the outbox seq, so REST accepts it as `after`.
      const restPage2 = await request(port, "GET", `/streams/1/events?after=${seqCursor}&limit=100`);
      const gqlPage2 = await gql(port, "GetStreamEvents", { streamId: "1", first: 10, after: seqCursor });
      const nodes2 = gqlPage2.data.data.streamEvents.edges.map((e: any) => e.node);
      assert.equal(nodes2.length, 1);
      assert.equal(gqlPage2.data.data.streamEvents.pageInfo.hasNextPage, false);
      assert.equal(restPage2.data.events.length, nodes2.length);
      assert.equal(restPage2.data.events[0].event_id, nodes2[0].id);
      assert.equal(rest.data.events.length, 2);
    });
  } finally { store.close(); }
});

test("forecast math: linear streamed, floored, from deposit/start/end/withdrawn", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      // Stream 1: deposit 1000, start 1000, end 2000, withdrawn 100, active.
      // At 1500: accrued = 1000*500/1000 = 500, available = 400, rate = 1/s.
      const res = await gql(port, "GetForecast", { streamId: "1", at: 1500 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.data.forecast, {
        streamId: "1", accrued: "500", available: "400",
        projectedTotal: "1000", ratePerSecond: "1", secondsRemaining: 500, asOf: 1500,
      });
      // Before start: nothing accrued. After end: full deposit.
      const before = await gql(port, "GetForecast", { streamId: "1", at: 500 });
      assert.equal(before.data.data.forecast.accrued, "0");
      const after = await gql(port, "GetForecast", { streamId: "1", at: 5000 });
      assert.equal(after.data.data.forecast.accrued, "1000");
      assert.equal(after.data.data.forecast.secondsRemaining, 0);
    });
  } finally { store.close(); }
});

test("relations: sender/recipient Address nodes and nested events", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const res = await gql(port, "GetStreamWithRelations", { id: "1" });
      assert.equal(res.status, 200);
      const s = res.data.data.stream;
      assert.equal(s.senderAddress.address, SENDER_A);
      assert.equal(s.senderAddress.streamCount, 2);
      assert.equal(s.recipientAddress.address, RECIPIENT);
      assert.equal(s.events.totalCount, 2);
      assert.deepEqual(s.events.edges.map((e: any) => e.node.eventType), ["stream_created", "withdrawn"]);
    });
  } finally { store.close(); }
});

test("persisted queries only: unknown ids, ad-hoc text and GET are rejected", async () => {
  const store = seedStore();
  try {
    await withServer(store, undefined, async (port) => {
      const unknown = await gql(port, "NoSuchQuery", {});
      assert.equal(unknown.status, 400);
      assert.match(unknown.data.errors[0].message, /unknown persisted query/);

      const adhoc = await request(port, "POST", "/graphql", { query: "{ stream(id: \"1\") { id } }" });
      assert.equal(adhoc.status, 400);
      assert.match(adhoc.data.errors[0].message, /ad-hoc/);

      const missing = await request(port, "POST", "/graphql", { variables: {} });
      assert.equal(missing.status, 400);
      assert.match(missing.data.errors[0].message, /queryId is required/);

      const get = await request(port, "GET", "/graphql");
      assert.equal(get.status, 400);
      assert.match(get.data.errors[0].message, /ad-hoc/);
    });
  } finally { store.close(); }
});

test("depth and complexity limits reject over-budget queries", () => {
  const store = seedStore();
  try {
    // Every allowlisted query is inside the limits.
    const validated = validatePersistedQueries();
    assert.equal(validated.length, PERSISTED_QUERY_IDS.length);
    for (const v of validated) {
      assert.ok(v.depth <= MAX_DEPTH, `${v.queryId} depth ${v.depth}`);
      assert.ok(v.complexity <= MAX_COMPLEXITY, `${v.queryId} complexity ${v.complexity}`);
    }
    // A deeply nested selection exceeds the depth limit.
    const deep = parseGraphQLQuery(`{ a { b { c { d { e { f { g } } } } } } }`);
    assert.ok(queryDepth(deep.selections) > MAX_DEPTH);
    assert.throws(
      () => executePersistedQuery("GetStream", { id: "1" }, { store, maxDepth: 1 }),
      (err: unknown) => err instanceof GraphQLExecutionError && /depth/.test(err.message)
    );
    assert.throws(
      () => executePersistedQuery("GetStream", { id: "1" }, { store, maxComplexity: 1 }),
      (err: unknown) => err instanceof GraphQLExecutionError && /complexity/.test(err.message)
    );
    assert.ok(queryComplexity(parseGraphQLQuery(`{ stream(id: "1") { id } }`).selections) >= 1);
  } finally { store.close(); }
});

test("per-tenant rate budget: token bucket exhausts and 429s", async () => {
  const limiter = new PerTenantRateLimiter(10, 0);
  assert.equal(limiter.tryConsume("t1", 6).allowed, true);
  assert.equal(limiter.tryConsume("t1", 6).allowed, false);
  assert.equal(limiter.tryConsume("other-tenant", 6).allowed, true);

  const store = seedStore();
  try {
    // GetStream costs 19 complexity units; a 20-unit budget allows exactly one.
    await withServer(store, { rateLimiter: new PerTenantRateLimiter(20, 0) }, async (port) => {
      const first = await gql(port, "GetStream", { id: "1" }, "tenant-a");
      assert.equal(first.status, 200);
      const second = await gql(port, "GetStream", { id: "1" }, "tenant-a");
      assert.equal(second.status, 429);
      assert.match(second.data.errors[0].message, /rate budget exhausted/);
      assert.equal(typeof second.data.retryAfter, "number");
      // A different tenant still has its own budget.
      const other = await gql(port, "GetStream", { id: "1" }, "tenant-b");
      assert.equal(other.status, 200);
    });
  } finally { store.close(); }
});

test("redaction regression (#487): GraphQL redacts exactly like the shared helper", async () => {
  const store = seedStore();
  try {
    const restStream: Stream = store.getStream("1")!;
    const expected = redactStream(restStream, true);
    assert.equal(expected.sender, "GAAAAAAA...");
    assert.equal(expected.recipient, "GCCCCCCC...");
    // Redaction off leaves the record unchanged.
    assert.deepEqual(redactStream(restStream, false), restStream);

    await withServer(store, { redactAddresses: true }, async (port) => {
      // REST itself is unchanged by the GraphQL option (current default).
      const rest = await request(port, "GET", "/streams/1");
      assert.equal(rest.data.sender, SENDER_A);
      const gqlRes = await gql(port, "GetStream", { id: "1" });
      assert.equal(gqlRes.status, 200);
      const g = gqlRes.data.data.stream;
      // GraphQL output equals the shared helper applied to the REST row.
      assert.equal(g.sender, expected.sender);
      assert.equal(g.recipient, expected.recipient);
      assert.equal(g.token, expected.token);
      assert.equal(g.deposit, expected.deposit);
      // No full address leaks anywhere in the redacted response.
      assert.equal(JSON.stringify(g).includes(SENDER_A), false);
      assert.equal(JSON.stringify(g).includes(RECIPIENT), false);
    });
  } finally { store.close(); }
});

test("webhook subscriptions expose no secret; redaction masks the URL", async () => {
  const store = seedStore();
  const ep = store.webhooks.createEndpoint({ url: "https://api.example.com/hooks/secret-token", events: ["stream_created"] });
  try {
    await withServer(store, { redactAddresses: true }, async (port) => {
      const res = await gql(port, "ListWebhookSubscriptions", {});
      assert.equal(res.status, 200);
      const subs = res.data.data.webhookSubscriptions;
      assert.equal(subs.length, 1);
      assert.equal(subs[0].id, ep.id);
      assert.equal(subs[0].url, "https://api.example.com/***");
      assert.deepEqual(subs[0].events, ["stream_created"]);
      assert.equal(JSON.stringify(subs).includes("secret"), false);
      assert.equal(JSON.stringify(subs).includes(ep.secret), false);
    });
  } finally { store.close(); }
});

test("freshness gate: every Stream field in the SDL exists on the Stream projection", () => {
  const store = seedStore();
  try {
    const sample = store.getStream("1")!;
    const fields = streamTypeFields();
    assert.ok(fields.length > 0);
    const relations = new Set(["senderAddress", "recipientAddress", "events", "forecast"]);
    for (const field of fields) {
      if (relations.has(field)) continue;
      const key = STREAM_FIELD_MAP[field];
      assert.ok(key, `SDL Stream field ${field} has no projection mapping`);
      assert.ok(key in sample, `Stream projection is missing key ${key} for SDL field ${field}`);
    }
    // And the gate is two-way: every mapped projection key is in the SDL.
    for (const field of Object.keys(STREAM_FIELD_MAP)) {
      assert.ok(fields.includes(field), `SDL is missing Stream field ${field}`);
    }
  } finally { store.close(); }
});
