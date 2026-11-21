// gRPC streaming transport tests (issue #579).
//
// A real HTTP/2 client (node:http2, no new dependency) talks to the real
// server: contract parity with REST for shared fixtures, backpressure
// (slow vs fast consumer), reconnect/resume with dedup, redaction,
// per-tenant limits / rate budgets, and the proto/registry freshness gate.

import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { StreamStore } from "./store.js";
import { createApp } from "./index.js";
import { decodeEvent } from "./decoder.js";
import type { DecodedEvent, RpcEvent } from "./types.js";
import { GrpcIndexerServer, RateBudget } from "./grpc/server.js";
import {
  decodeAckResponse,
  decodeGrpcFrames,
  decodeStreamEvent,
  encodeAckRequest,
  encodeGrpcFrame,
  encodeSubscribeRequest,
  type AckRequestMessage,
  type AckResponseMessage,
  type StreamEventMessage,
  type SubscribeRequestMessage,
} from "./grpc/codec.js";
import { ALL_CONTRACT_EVENT_NAMES } from "./generated/events.js";
import { redactPayload } from "./redaction.js";

const SENDER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const RECIPIENT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
const TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";

const SUBSCRIBE_PATH = "/streampay.indexer.v1.StreamPayIndexer/Subscribe";
const ACK_PATH = "/streampay.indexer.v1.StreamPayIndexer/Ack";

// ---------------------------------------------------------------------------
// Small test client helper (node:http2 only)
// ---------------------------------------------------------------------------

interface GrpcSubscription {
  events: StreamEventMessage[];
  arrivals: number[];
  subscriptionId: string | undefined;
  trailers: Promise<Record<string, string>>;
  close: () => void;
}

class GrpcTestClient {
  private readonly session: http2.ClientHttp2Session;

  constructor(port: number) {
    this.session = http2.connect(`http://127.0.0.1:${port}`);
    this.session.on("error", () => {});
  }

  subscribe(req: SubscribeRequestMessage): GrpcSubscription {
    const stream = this.session.request({
      ":path": SUBSCRIBE_PATH,
      ":method": "POST",
      "content-type": "application/grpc",
      te: "trailers",
      ...(req.tenant ? { "x-tenant-id": req.tenant } : {}),
    });
    const events: StreamEventMessage[] = [];
    const arrivals: number[] = [];
    let subscriptionId: string | undefined;
    let buffer: Buffer = Buffer.alloc(0);
    let trailersResolve: (headers: Record<string, string>) => void = () => {};
    const trailers = new Promise<Record<string, string>>((resolve) => {
      trailersResolve = resolve;
    });
    stream.on("response", (headers) => {
      subscriptionId = headers["x-subscription-id"] as string | undefined;
      // Trailers-only (error) responses carry grpc-status in the headers.
      if (headers["grpc-status"]) trailersResolve(headers as Record<string, string>);
    });
    stream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, rest } = decodeGrpcFrames(buffer);
      buffer = rest;
      for (const message of messages) {
        events.push(decodeStreamEvent(message));
        arrivals.push(Date.now());
      }
    });
    stream.on("error", () => {});
    stream.on("trailers", (headers) => trailersResolve(headers as Record<string, string>));
    stream.on("close", () => trailersResolve({ "grpc-status": "cancelled" }));
    stream.write(encodeGrpcFrame(encodeSubscribeRequest(req)));
    stream.end();
    return {
      events,
      arrivals,
      get subscriptionId() {
        return subscriptionId;
      },
      trailers,
      close: () => {
        try {
          stream.close();
        } catch {}
      },
    };
  }

  ack(req: AckRequestMessage): Promise<{ response: AckResponseMessage | undefined; trailers: Record<string, string> }> {
    return new Promise((resolve, reject) => {
      const stream = this.session.request({
        ":path": ACK_PATH,
        ":method": "POST",
        "content-type": "application/grpc",
        te: "trailers",
      });
      let buffer: Buffer = Buffer.alloc(0);
      let response: AckResponseMessage | undefined;
      let done = false;
      const finish = (trailers: Record<string, string>): void => {
        if (done) return;
        done = true;
        resolve({ response, trailers });
      };
      stream.on("response", (headers) => {
        if (headers["grpc-status"]) finish(headers as Record<string, string>);
      });
      stream.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const { messages, rest } = decodeGrpcFrames(buffer);
        buffer = rest;
        for (const message of messages) response = decodeAckResponse(message);
      });
      stream.on("trailers", (headers) => {
        finish(headers as Record<string, string>);
      });
      stream.on("close", () => finish({ "grpc-status": "cancelled" }));
      stream.on("error", reject);
      stream.write(encodeGrpcFrame(encodeAckRequest(req)));
      stream.end();
    });
  }

  /** Raw Subscribe with an arbitrary path, for error-path tests. */
  subscribeRaw(path: string, req: SubscribeRequestMessage): { trailers: Promise<Record<string, string>>; events: StreamEventMessage[] } {
    const stream = this.session.request({
      ":path": path,
      ":method": "POST",
      "content-type": "application/grpc",
      te: "trailers",
    });
    const events: StreamEventMessage[] = [];
    let buffer: Buffer = Buffer.alloc(0);
    let trailersResolve: (headers: Record<string, string>) => void = () => {};
    const trailers = new Promise<Record<string, string>>((resolve) => {
      trailersResolve = resolve;
    });
    stream.on("response", (headers) => {
      if (headers["grpc-status"]) trailersResolve(headers as Record<string, string>);
    });
    stream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, rest } = decodeGrpcFrames(buffer);
      buffer = rest;
      for (const message of messages) events.push(decodeStreamEvent(message));
    });
    stream.on("error", () => {});
    stream.on("trailers", (headers) => trailersResolve(headers as Record<string, string>));
    stream.on("close", () => trailersResolve({ "grpc-status": "cancelled" }));
    stream.write(encodeGrpcFrame(encodeSubscribeRequest(req)));
    stream.end();
    return { trailers, events };
  }

  close(): void {
    try {
      this.session.close();
    } catch {}
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fixtures / seeding
// ---------------------------------------------------------------------------

function fixturePath(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    join(here, "..", "..", "fixtures", "events-fixture.json"),
    join(here, "..", "fixtures", "events-fixture.json"),
    join(process.cwd(), "fixtures", "events-fixture.json"),
    join(process.cwd(), "indexer", "fixtures", "events-fixture.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cannot locate events-fixture.json");
}

function seedFromFixture(store: StreamStore): DecodedEvent[] {
  const fixtureEvents: RpcEvent[] = JSON.parse(readFileSync(fixturePath(), "utf8"));
  const decoded = fixtureEvents.map((event) => decodeEvent(event));
  store.ingestPage(decoded, "120", 120);
  return decoded;
}

function makeEvent(
  id: string,
  ledger: number,
  name: string,
  data: Record<string, unknown>,
  streamId = "1"
): DecodedEvent {
  return {
    id,
    pagingToken: String(ledger),
    ledger,
    ledgerClosedAt: `2026-01-01T00:${String(ledger % 60).padStart(2, "0")}:00Z`,
    contractId: "C123",
    name,
    streamId,
    data: data as DecodedEvent["data"],
  };
}

function seedStream(store: StreamStore, streamId: string, count: number): void {
  store.ingest(
    makeEvent(`evt-${streamId}-create`, 100, "stream_created", {
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      deposit: 1000n,
      start_time: 1n,
      end_time: 10n,
      cancelable: true,
    }, streamId)
  );
  for (let i = 1; i < count; i++) {
    store.ingest(
      makeEvent(`evt-${streamId}-w${i}`, 100 + i, "withdrawn", {
        recipient: RECIPIENT,
        amount: BigInt(i * 100),
        withdrawn_total: BigInt(i * 100),
      }, streamId)
    );
  }
}

async function startGrpc(
  store: StreamStore,
  options: ConstructorParameters<typeof GrpcIndexerServer>[1] = {}
): Promise<{ server: GrpcIndexerServer; port: number; client: GrpcTestClient }> {
  const server = new GrpcIndexerServer(store, options);
  const port = await server.listen(0);
  return { server, port, client: new GrpcTestClient(port) };
}

function fetchJson(url: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 200, data: JSON.parse(body) });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

test("protobuf codec round-trips every message type, including unknown fields", async () => {
  const { encodeStreamEvent } = await import("./grpc/codec.js");
  const event: StreamEventMessage = {
    seq: 42,
    eventId: "evt-1",
    streamId: "1",
    name: "stream_created",
    ledger: 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    payloadJson: JSON.stringify({ sender: SENDER, deposit: "1000" }),
    idempotencyKey: "evt-1",
    cursor: 42,
    redacted: true,
  };
  assert.deepEqual(decodeStreamEvent(encodeStreamEvent(event)), event);

  const sub: SubscribeRequestMessage = {
    streamId: "7",
    cursor: 3,
    initialCredit: 5,
    tenant: "acme",
    redactAddresses: true,
    eventNames: ["withdrawn", "stream_created"],
    limit: 9,
  };
  const { decodeSubscribeRequest } = await import("./grpc/codec.js");
  assert.deepEqual(decodeSubscribeRequest(encodeSubscribeRequest(sub)), sub);

  const ack: AckRequestMessage = { subscriptionId: "abc", tenant: "acme", streamId: "7", ackedSeq: 11, credit: 4 };
  const { decodeAckRequest, encodeAckResponse, decodeAckResponse } = await import("./grpc/codec.js");
  assert.deepEqual(decodeAckRequest(encodeAckRequest(ack)), ack);
  assert.deepEqual(decodeAckResponse(encodeAckResponse({ ackedSeq: 11, creditAvailable: 4, active: true })), {
    ackedSeq: 11,
    creditAvailable: 4,
    active: true,
  });

  // Frames split across DATA chunks must still decode, and an unknown
  // field (field 99, varint) must be skipped, not fail the decode.
  const frame = encodeGrpcFrame(encodeStreamEvent(event));
  const first = decodeGrpcFrames(frame.subarray(0, 3));
  assert.deepEqual(first.messages, []);
  const second = decodeGrpcFrames(Buffer.concat([first.rest, frame.subarray(3)]));
  assert.equal(second.messages.length, 1);
  assert.deepEqual(decodeStreamEvent(second.messages[0]), event);

  const unknownField = Buffer.from([0xf8, 0x06, 0x2a]); // tag field 99 varint, value 42
  const withUnknown = Buffer.concat([encodeStreamEvent(event), unknownField]);
  assert.deepEqual(decodeStreamEvent(withUnknown), event);
});

// ---------------------------------------------------------------------------
// Freshness gate: proto <-> registry <-> generated table
// ---------------------------------------------------------------------------

function locateFile(relative: string): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    join(here, "..", relative),
    join(here, "..", "..", "src", relative),
    join(process.cwd(), "src", relative),
    join(process.cwd(), "indexer", "src", relative),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${relative}`);
}

function loadRegistry(): {
  registry_version: number;
  events: Record<string, { event_key: string }>;
} {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    join(here, "..", "..", "schemas", "events", "registry.json"),
    join(here, "..", "..", "..", "schemas", "events", "registry.json"),
    join(process.cwd(), "schemas", "events", "registry.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
  }
  throw new Error("cannot locate schemas/events/registry.json");
}

test("proto/registry freshness gate: events.proto mirrors registry.json and generated/events.ts", () => {
  const proto = readFileSync(locateFile("grpc/events.proto"), "utf8");
  const registry = loadRegistry();

  // EventName enum values, in proto order.
  const enumBlock = proto.match(/enum EventName \{([\s\S]*?)\}/);
  assert.ok(enumBlock, "events.proto must declare enum EventName");
  const enumNames = [...enumBlock[1].matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(\d+);/gm)].map((m) => ({
    name: m[1],
    value: Number(m[2]),
  }));
  const protoKeys = enumNames
    .filter((e) => e.name !== "EVENT_NAME_UNSPECIFIED")
    .map((e) => e.name.toLowerCase());
  const registryKeys = Object.values(registry.events)
    .map((e) => e.event_key)
    .sort();
  assert.deepEqual(protoKeys, registryKeys, "proto EventName enum must list every registry event key");
  assert.deepEqual(protoKeys, [...ALL_CONTRACT_EVENT_NAMES].sort(), "proto enum must match generated/events.ts");
  assert.equal(registry.registry_version, 1);
  // Enum numbering is dense from 1 (0 is the proto3 unspecified value).
  assert.deepEqual(
    enumNames.filter((e) => e.name !== "EVENT_NAME_UNSPECIFIED").map((e) => e.value),
    registryKeys.map((_key, i) => i + 1)
  );

  // StreamEvent fields: number, proto type and name, in proto order.
  const messageBlock = proto.match(/message StreamEvent \{([\s\S]*?)\n\}/);
  assert.ok(messageBlock, "events.proto must declare message StreamEvent");
  const fields = [...messageBlock[1].matchAll(/^\s*(\w+)\s+(\w+)\s*=\s*(\d+);/gm)].map((m) => ({
    type: m[1],
    name: m[2],
    number: Number(m[3]),
  }));
  assert.deepEqual(fields, [
    { type: "uint64", name: "seq", number: 1 },
    { type: "string", name: "event_id", number: 2 },
    { type: "string", name: "stream_id", number: 3 },
    { type: "string", name: "name", number: 4 },
    { type: "uint64", name: "ledger", number: 5 },
    { type: "string", name: "ledger_closed_at", number: 6 },
    { type: "string", name: "payload_json", number: 7 },
    { type: "string", name: "idempotency_key", number: 8 },
    { type: "uint64", name: "cursor", number: 9 },
    { type: "bool", name: "redacted", number: 10 },
  ]);

  // The service contract itself.
  assert.match(proto, /service StreamPayIndexer/);
  assert.match(proto, /rpc Subscribe\(SubscribeRequest\) returns \(stream StreamEvent\)/);
  assert.match(proto, /rpc Ack\(AckRequest\) returns \(AckResponse\)/);
  assert.match(proto, /schemas\/events\/registry\.json/);
});

// ---------------------------------------------------------------------------
// Contract: gRPC payloads decode to the same records as REST
// ---------------------------------------------------------------------------

test("gRPC payloads decode to the same records as REST for shared fixtures", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedFromFixture(store);

    const app = createApp(store);
    const rest = http.createServer(app);
    await new Promise<void>((resolve) => rest.listen(0, resolve));
    const restPort = (rest.address() as { port: number }).port;
    const { server, client } = await startGrpc(store);
    try {
      const restEvents = (await fetchJson(`http://127.0.0.1:${restPort}/streams/1/events?after=0&limit=100`)).data as {
        events: Array<{
          seq: number;
          idempotency_key: string;
          event_id: string;
          stream_id: string | null;
          name: string;
          ledger: number;
          payload: Record<string, unknown>;
        }>;
        next_cursor: number | null;
      };
      const history = (await fetchJson(`http://127.0.0.1:${restPort}/streams/1/history`)).data as Array<{
        id: string;
        event_type: string;
        ledger: number;
        ledger_closed_at: string;
        payload: Record<string, unknown>;
      }>;
      assert.equal(restEvents.events.length, 4);
      assert.equal(history.length, 4);

      const sub = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 100,
        tenant: "contract",
        redactAddresses: false,
        eventNames: [],
        limit: 4,
      });
      await waitFor(() => sub.events.length >= 4, 5000, "gRPC contract events");
      assert.equal(sub.events.length, 4);

      for (let i = 0; i < 4; i++) {
        const grpcEvent = sub.events[i];
        const restEvent = restEvents.events[i];
        const historyEvent = history[i];
        assert.equal(grpcEvent.seq, restEvent.seq);
        assert.equal(grpcEvent.cursor, restEvent.seq);
        assert.equal(grpcEvent.eventId, restEvent.event_id);
        assert.equal(grpcEvent.idempotencyKey, restEvent.idempotency_key);
        assert.equal(grpcEvent.streamId, restEvent.stream_id);
        assert.equal(grpcEvent.name, restEvent.name);
        assert.equal(grpcEvent.ledger, restEvent.ledger);
        assert.equal(grpcEvent.ledgerClosedAt, historyEvent.ledger_closed_at);
        assert.equal(grpcEvent.eventId, historyEvent.id);
        assert.equal(grpcEvent.name, historyEvent.event_type);
        assert.deepEqual(JSON.parse(grpcEvent.payloadJson), restEvent.payload, "gRPC payload == REST /events payload");
        assert.deepEqual(JSON.parse(grpcEvent.payloadJson), historyEvent.payload, "gRPC payload == REST /history payload");
        assert.equal(grpcEvent.redacted, false);
      }
      const trailers = await Promise.race([
        sub.trailers,
        sleep(1000).then(() => ({ "grpc-status": "not-ended" })),
      ]);
      assert.equal(trailers["grpc-status"], "0", "limit-closed stream ends with grpc-status 0");
      sub.close();
    } finally {
      client.close();
      await server.close();
      await new Promise<void>((resolve) => rest.close(() => resolve()));
    }
  } finally {
    store.close();
  }
});

test("live events stream to a caught-up subscriber", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 2);
    const { server, client } = await startGrpc(store);
    try {
      const maxSeq = store.outbox.stats().maxSeq;
      const sub = client.subscribe({
        streamId: "1",
        cursor: maxSeq,
        initialCredit: 100,
        tenant: "live",
        redactAddresses: false,
        eventNames: [],
        limit: 0,
      });
      await sleep(100);
      assert.equal(sub.events.length, 0, "caught-up subscriber gets no replay");
      store.ingest(makeEvent("evt-1-live", 103, "withdrawn", {
        recipient: RECIPIENT,
        amount: 500n,
        withdrawn_total: 500n,
      }));
      await waitFor(() => sub.events.length >= 1, 5000, "live gRPC event");
      assert.equal(sub.events[0].eventId, "evt-1-live");
      assert.equal(sub.events[0].name, "withdrawn");
      sub.close();
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Backpressure: slow consumer vs fast consumer
// ---------------------------------------------------------------------------

test("backpressure: a slow consumer is paused without stalling ingestion or a fast consumer", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 10);
    const { server, client } = await startGrpc(store);
    try {
      // Fast consumer: full credit, gets everything.
      const fast = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 100,
        tenant: "fast",
        redactAddresses: false,
        eventNames: [],
        limit: 10,
      });
      await waitFor(() => fast.events.length >= 10, 5000, "fast consumer");
      assert.equal(fast.events.length, 10);

      // Slow consumer: only 2 credits, never acks (yet).
      const slow = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 2,
        tenant: "slow",
        redactAddresses: false,
        eventNames: [],
        limit: 0,
      });
      await waitFor(() => slow.events.length >= 2, 5000, "slow consumer first events");
      await sleep(500);
      assert.equal(slow.events.length, 2, "slow consumer stays at its credit, it is not force-fed");

      // Ingestion still works while the slow consumer is paused, and a
      // fresh fast consumer sees the new events.
      const ingestStart = Date.now();
      store.ingest(makeEvent("evt-1-w10", 110, "withdrawn", {
        recipient: RECIPIENT,
        amount: 1000n,
        withdrawn_total: 1000n,
      }));
      store.ingest(makeEvent("evt-1-w11", 111, "withdrawn", {
        recipient: RECIPIENT,
        amount: 1100n,
        withdrawn_total: 1100n,
      }));
      assert.ok(Date.now() - ingestStart < 2000, "ingest returns promptly with a paused subscriber");
      await sleep(300);
      assert.equal(slow.events.length, 2, "paused slow consumer still receives nothing new");

      const fast2 = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 100,
        tenant: "fast2",
        redactAddresses: false,
        eventNames: [],
        limit: 12,
      });
      await waitFor(() => fast2.events.length >= 12, 5000, "second fast consumer");
      assert.equal(fast2.events.length, 12);

      // Granting credit unpauses the slow consumer; it catches up.
      const subId = slow.subscriptionId;
      assert.ok(subId, "server reports the subscription id in response metadata");
      const ack = await client.ack({
        subscriptionId: subId,
        tenant: "slow",
        streamId: "1",
        ackedSeq: slow.events[slow.events.length - 1].seq,
        credit: 20,
      });
      assert.equal(ack.trailers["grpc-status"], "0");
      assert.equal(ack.response?.active, true);
      await waitFor(() => slow.events.length >= 12, 5000, "slow consumer after Ack credit");
      assert.equal(slow.events.length, 12);
      assert.deepEqual(
        slow.events.map((e) => e.seq),
        fast2.events.map((e) => e.seq),
        "slow consumer eventually gets the same ordered seqs"
      );
      slow.close();
      fast.close();
      fast2.close();
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});

test("rate budget throttles delivery instead of dropping events", () => {
  const budget = new RateBudget(2);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), false, "bucket is empty after its burst");
  assert.ok(budget.msUntilNextToken() > 0 && budget.msUntilNextToken() <= 500);
});

test("per-tenant rate budget delays, but does not drop, gRPC delivery", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 4);
    const { server, client } = await startGrpc(store, { maxEventsPerSecondPerTenant: 2 });
    try {
      const started = Date.now();
      const sub = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 100,
        tenant: "throttled",
        redactAddresses: false,
        eventNames: [],
        limit: 4,
      });
      await sleep(300);
      assert.ok(sub.events.length <= 2, `only the 2-token burst may arrive immediately, got ${sub.events.length}`);
      await waitFor(() => sub.events.length >= 4, 5000, "throttled delivery completes");
      const fourthAt = sub.arrivals[3] - started;
      assert.ok(fourthAt >= 700, `4th event should be rate-delayed, arrived after ${fourthAt}ms`);
      assert.equal(sub.events.length, 4);
      sub.close();
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Resume / dedup
// ---------------------------------------------------------------------------

test("reconnect resumes from the last acked cursor with dedup by seq", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 6);
    const { server, client } = await startGrpc(store);
    try {
      const first = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 100,
        tenant: "resume",
        redactAddresses: false,
        eventNames: [],
        limit: 0,
      });
      await waitFor(() => first.events.length >= 3, 5000, "first connection events");
      const ackedSeq = first.events[1].seq;
      const seenFirst = first.events.map((e) => e.seq);
      // Ack only the first two; the third was delivered but not acked.
      await client.ack({
        subscriptionId: first.subscriptionId ?? "",
        tenant: "resume",
        streamId: "1",
        ackedSeq,
        credit: 0,
      });
      first.close();
      await sleep(100);

      const second = client.subscribe({
        streamId: "1",
        cursor: ackedSeq,
        initialCredit: 100,
        tenant: "resume",
        redactAddresses: false,
        eventNames: [],
        limit: 4,
      });
      await waitFor(() => second.events.length >= 4, 5000, "resumed events");
      const seenSecond = second.events.map((e) => e.seq);
      // The unacked third event is redelivered (at-least-once) …
      assert.ok(seenSecond.includes(seenFirst[2]), "unacked event is redelivered on resume");
      // … but the acked prefix is not.
      assert.ok(!seenSecond.includes(seenFirst[0]) && !seenSecond.includes(seenFirst[1]));
      // Dedup by seq over both connections yields exactly the full set.
      const deduped = [...new Set([...seenFirst.slice(0, 3), ...seenSecond])].sort((a, b) => a - b);
      const allSeqs = store.outbox.replayEvents("1", 0, 100).events.map((e) => e.seq);
      assert.deepEqual(deduped, allSeqs);
      assert.equal(new Set(seenSecond).size, seenSecond.length, "no duplicates within the resumed stream");
      second.close();
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redaction truncates Stellar addresses identically via the shared helper, and only when enabled", async () => {
  assert.deepEqual(
    redactPayload({ sender: SENDER, amount: "100" }, false),
    { sender: SENDER, amount: "100" },
    "redaction off leaves the payload unchanged"
  );
  assert.deepEqual(redactPayload({ sender: SENDER, amount: "100" }, true), {
    sender: "CAAAAAAA...",
    amount: "100",
  });

  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 1);
    const { server, client } = await startGrpc(store);
    try {
      const redacted = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 10,
        tenant: "redact",
        redactAddresses: true,
        eventNames: [],
        limit: 1,
      });
      await waitFor(() => redacted.events.length >= 1, 5000, "redacted event");
      const payload = JSON.parse(redacted.events[0].payloadJson) as Record<string, unknown>;
      assert.equal(payload.sender, "CAAAAAAA...");
      assert.equal(payload.recipient, "CAAAAAAA...");
      assert.equal(redacted.events[0].redacted, true);
      assert.ok(!redacted.events[0].payloadJson.includes(SENDER), "full sender must not appear in a redacted stream");
      redacted.close();

      const plain = client.subscribe({
        streamId: "1",
        cursor: 0,
        initialCredit: 10,
        tenant: "plain",
        redactAddresses: false,
        eventNames: [],
        limit: 1,
      });
      await waitFor(() => plain.events.length >= 1, 5000, "plain event");
      const plainPayload = JSON.parse(plain.events[0].payloadJson) as Record<string, unknown>;
      assert.equal(plainPayload.sender, SENDER);
      assert.equal(plain.events[0].redacted, false);
      plain.close();
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Per-tenant limits and error paths
// ---------------------------------------------------------------------------

test("per-tenant subscription limit rejects the excess subscription with RESOURCE_EXHAUSTED", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 2);
    const { server, client } = await startGrpc(store, { maxSubscriptionsPerTenant: 2 });
    try {
      const a = client.subscribe({
        streamId: "1", cursor: 0, initialCredit: 1, tenant: "limited", redactAddresses: false, eventNames: [], limit: 0,
      });
      const b = client.subscribe({
        streamId: "1", cursor: 0, initialCredit: 1, tenant: "limited", redactAddresses: false, eventNames: [], limit: 0,
      });
      await waitFor(() => a.events.length >= 1 && b.events.length >= 1, 5000, "first two subscriptions");
      assert.equal(server.activeSubscriptions("limited"), 2);

      const rejected = client.subscribeRaw(SUBSCRIBE_PATH, {
        streamId: "1", cursor: 0, initialCredit: 1, tenant: "limited", redactAddresses: false, eventNames: [], limit: 0,
      });
      const trailers = await Promise.race([
        rejected.trailers,
        sleep(3000).then(() => ({ "grpc-status": "timeout" })),
      ]);
      assert.equal(trailers["grpc-status"], "8", "third concurrent subscription is RESOURCE_EXHAUSTED");
      assert.equal(rejected.events.length, 0);
      assert.equal(server.activeSubscriptions("limited"), 2);

      // Freeing a slot lets the next subscription in.
      a.close();
      await waitFor(() => server.activeSubscriptions("limited") === 1, 5000, "slot freed");
      const c = client.subscribe({
        streamId: "1", cursor: 0, initialCredit: 1, tenant: "limited", redactAddresses: false, eventNames: [], limit: 0,
      });
      await waitFor(() => c.events.length >= 1, 5000, "replacement subscription");
      assert.equal(server.activeSubscriptions("limited"), 2);
      b.close();
      c.close();
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});

test("invalid Subscribe requests fail with INVALID_ARGUMENT and unknown methods with UNIMPLEMENTED", async () => {
  const store = new StreamStore(":memory:");
  try {
    seedStream(store, "1", 1);
    const { server, client } = await startGrpc(store);
    try {
      const badStream = client.subscribeRaw(SUBSCRIBE_PATH, {
        streamId: "not-a-stream", cursor: 0, initialCredit: 1, tenant: "t", redactAddresses: false, eventNames: [], limit: 0,
      });
      assert.equal((await badStream.trailers)["grpc-status"], "3");

      const badEvent = client.subscribeRaw(SUBSCRIBE_PATH, {
        streamId: "1", cursor: 0, initialCredit: 1, tenant: "t", redactAddresses: false, eventNames: ["not_an_event"], limit: 0,
      });
      assert.equal((await badEvent.trailers)["grpc-status"], "3");

      const unknown = client.subscribeRaw("/streampay.indexer.v1.StreamPayIndexer/Nope", {
        streamId: "1", cursor: 0, initialCredit: 1, tenant: "t", redactAddresses: false, eventNames: [], limit: 0,
      });
      assert.equal((await unknown.trailers)["grpc-status"], "12");

      const ackMissing = await client.ack({
        subscriptionId: "does-not-exist", tenant: "t", streamId: "1", ackedSeq: 1, credit: 1,
      });
      assert.equal(ackMissing.trailers["grpc-status"], "5");
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    store.close();
  }
});
