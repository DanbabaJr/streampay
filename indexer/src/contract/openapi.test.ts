/**
 * Contract tests for `indexer/openapi.json` (issue #480).
 *
 * Three layers, all wired into `npm test`:
 *
 * 1. Structural validation of the OpenAPI 3.1 document itself — required
 *    fields, unique operation ids, resolvable `$ref`s, declared path
 *    parameters, and no schema keyword the committed validator cannot check.
 *    This is the "linter" step, kept dependency-free.
 * 2. Type-drift checks: the `Stream`, `SseEvent` and `RpcEvent` component
 *    schemas are compared against the matching interfaces in `src/types.ts`
 *    using the TypeScript compiler API (already a devDependency).
 * 3. Route contracts: every documented operation is called against a real
 *    `createApp` server on an in-memory store, and its response body is
 *    validated against the schema for that status code. A route response that
 *    gains, loses or retypes a field fails here.
 *
 * Adding a path to the spec without exercising it in layer 3 fails the final
 * "exercises every documented operation" test.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Keypair, Networks } from "@stellar/stellar-sdk";

import { StreamStore } from "../store.js";
import { createApp, type IngestStats, type ProofConfig } from "../index.js";
import { decodeEvent } from "../decoder.js";
import type { RpcEvent, Stream } from "../types.js";
import { WasmPluginHost } from "../wasm/host.js";
import { PluginDispatcher } from "../wasm/dispatcher.js";
import { assertKnownKeywords, formatErrors, validateSchema, type JsonSchema } from "./validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates: string[], what: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate ${what}; looked at:\n${candidates.join("\n")}`);
}

const SPEC_PATH = firstExisting(
  [
    path.resolve(here, "../../openapi.json"),
    path.resolve(process.cwd(), "openapi.json"),
    path.resolve(process.cwd(), "indexer/openapi.json"),
  ],
  "indexer/openapi.json",
);

const TYPES_PATH = firstExisting(
  [
    path.resolve(here, "../../src/types.ts"),
    path.resolve(process.cwd(), "src/types.ts"),
    path.resolve(process.cwd(), "indexer/src/types.ts"),
  ],
  "indexer/src/types.ts",
);

const FIXTURE_PATH = firstExisting(
  [
    path.resolve(here, "../../fixtures/events-fixture.json"),
    path.resolve(process.cwd(), "fixtures/events-fixture.json"),
    path.resolve(process.cwd(), "indexer/fixtures/events-fixture.json"),
  ],
  "indexer/fixtures/events-fixture.json",
);

interface OpenApiDoc extends Record<string, unknown> {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Record<string, any>>>;
  components: {
    schemas: Record<string, JsonSchema>;
    parameters: Record<string, { name: string; in: string; required?: boolean }>;
    responses: Record<string, unknown>;
  };
}

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8")) as OpenApiDoc;
const root = spec as unknown as JsonSchema;

/** Map of operationId -> { path, method, operation }. */
const operations = new Map<string, { path: string; method: string; operation: Record<string, any> }>();
for (const [routePath, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!/^(get|post|put|patch|delete|head|options)$/.test(method)) continue;
    const operationId = (operation as Record<string, any>).operationId;
    assert.equal(typeof operationId, "string", `${method.toUpperCase()} ${routePath} has no operationId`);
    assert.equal(operations.has(operationId), false, `duplicate operationId ${operationId}`);
    operations.set(operationId, { path: routePath, method, operation: operation as Record<string, any> });
  }
}

function resolvePointer(ref: string): unknown {
  assert.ok(ref.startsWith("#/"), `only local refs are supported in this spec, got ${ref}`);
  let node: unknown = spec;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  return node;
}

function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

function operationParameters(operation: Record<string, any>): Array<{ name: string; in: string; required?: boolean }> {
  return ((operation.parameters ?? []) as Array<Record<string, any>>).map((parameter) =>
    parameter.$ref ? (resolvePointer(parameter.$ref) as { name: string; in: string; required?: boolean }) : parameter,
  ) as Array<{ name: string; in: string; required?: boolean }>;
}

/** Every operation invoked by the route tests, checked for completeness at the end. */
const exercised = new Set<string>();

function assertResponse(operationId: string, status: number, body: unknown): void {
  const entry = operations.get(operationId);
  assert.ok(entry, `no documented operation ${operationId}`);
  exercised.add(operationId);
  let response = entry.operation.responses?.[String(status)] as Record<string, any> | undefined;
  assert.ok(response, `${operationId} does not document a ${status} response`);
  if (typeof response.$ref === "string") {
    response = resolvePointer(response.$ref) as Record<string, any>;
  }
  const schema = response?.content?.["application/json"]?.schema as JsonSchema | undefined;
  assert.ok(schema, `${operationId} ${status} does not document an application/json schema`);
  const errors = validateSchema(schema, body, root);
  assert.deepEqual(errors, [], `${operationId} ${status} response drifted from openapi.json:\n${formatErrors(errors)}`);
}

function request(
  baseUrl: string,
  pathname: string,
  method = "GET",
  payload?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const url = new URL(baseUrl + pathname);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let json: unknown;
          try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Reads the first SSE `data:` frame, then drops the connection. */
function readFirstSseDataFrame(baseUrl: string, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no SSE data frame arrived; buffer was ${JSON.stringify(buffer)}`));
    }, 5000);
    timer.unref();
    const req = http.get(baseUrl + pathname, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const match = /(?:^|\n)data: (.+)\n/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          req.destroy();
          resolve(match[1]);
        }
      });
      res.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ── Layer 1: OpenAPI document structure ──────────────────────────────────────

describe("openapi.json (OpenAPI 3.1 read-API spec)", () => {
  it("is a structurally valid OpenAPI 3.1 document", () => {
    assert.match(spec.openapi, /^3\.1\.\d+$/);
    assert.equal(typeof spec.info?.title, "string");
    assert.equal(typeof spec.info?.version, "string");
    assert.ok(operations.size > 0, "spec documents no operations");

    const tags = new Set(((spec as unknown as { tags?: Array<{ name: string }> }).tags ?? []).map((tag) => tag.name));
    for (const [operationId, { path: routePath, method, operation }] of operations) {
      if (tags.size > 0) {
        for (const tag of operation.tags ?? []) {
          assert.ok(tags.has(tag), `${operationId} uses undeclared tag ${tag}`);
        }
      }
      assert.equal(typeof operation.summary, "string", `${operationId} has no summary`);

      const responses = operation.responses ?? {};
      const statuses = Object.keys(responses);
      assert.ok(statuses.length > 0, `${operationId} documents no responses`);
      for (const status of statuses) {
        const response = responses[status] as Record<string, unknown>;
        const resolved = response.$ref ? (resolvePointer(response.$ref as string) as Record<string, unknown>) : response;
        assert.equal(typeof resolved.description, "string", `${operationId} ${status} has no description`);
      }

      // Every `{param}` in the path must be declared as a required path parameter.
      const templateNames = [...routePath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const pathParameters = operationParameters(operation).filter((parameter) => parameter.in === "path");
      for (const name of templateNames) {
        const declared = pathParameters.find((parameter) => parameter.name === name);
        assert.ok(declared, `${method.toUpperCase()} ${routePath} does not declare path parameter ${name}`);
        assert.equal(declared.required, true, `${operationId} path parameter ${name} must be required`);
      }
      for (const parameter of pathParameters) {
        assert.ok(templateNames.includes(parameter.name), `${operationId} declares unused path parameter ${parameter.name}`);
      }
    }
  });

  it("resolves every $ref", () => {
    for (const ref of collectRefs(spec)) {
      assert.notEqual(resolvePointer(ref), undefined, `dangling $ref ${ref}`);
    }
  });

  it("uses only schema keywords the committed validator understands", () => {
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      assertKnownKeywords(schema, `#/components/schemas/${name}`);
    }
  });

  it("documents the read routes without documenting mutating ones", () => {
    for (const { method } of operations.values()) {
      assert.equal(method, "get", "the read-API spec must not document mutating routes");
    }
  });
});

// ── Layer 2: spec schemas vs src/types.ts ────────────────────────────────────

interface TsMember {
  name: string;
  optional: boolean;
  typeText: string;
}

function readInterfaces(filePath: string): Map<string, TsMember[]> {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const interfaces = new Map<string, TsMember[]>();
  sourceFile.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const members: TsMember[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      members.push({
        name: member.name.getText(sourceFile),
        optional: member.questionToken !== undefined,
        typeText: member.type?.getText(sourceFile) ?? "unknown",
      });
    }
    interfaces.set(node.name.text, members);
  });
  return interfaces;
}

/** Splits `A | B | C` on top-level pipes only (ignores pipes inside <>, (), []). */
function topLevelUnion(typeText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of typeText) {
    if ("<([{".includes(char)) depth += 1;
    if (">)]}".includes(char)) depth -= 1;
    if (char === "|" && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

function tsTypeAllowsNull(typeText: string): boolean {
  return topLevelUnion(typeText).some((part) => part === "null" || part === "any" || part === "unknown");
}

function schemaAllowsNull(schema: JsonSchema | undefined): boolean {
  if (schema === undefined || schema === true) return true;
  if (schema === false) return false;
  if (typeof schema.$ref === "string") return schemaAllowsNull(resolvePointer(schema.$ref) as JsonSchema);
  if ("const" in schema) return schema.const === null;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if (Array.isArray(schema.oneOf)) return (schema.oneOf as JsonSchema[]).some((sub) => schemaAllowsNull(sub));
  if (schema.type === undefined) return true;
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  return types.includes("null");
}

/** TS interface -> OpenAPI component schema. */
const TYPE_SCHEMA_MAP: Record<string, string> = {
  Stream: "Stream",
  StreamServerEvent: "SseEvent",
  RpcEvent: "RpcEvent",
};

/**
 * Documented deviations between a TypeScript interface and the wire format.
 * `StreamServerEvent.streamId` is typed `string`, but `formatSse` in
 * `src/index.ts` emits `null` for events the registry binds to no stream. The
 * spec describes what the route actually sends; the issue records the type
 * inconsistency so it can be fixed at the source.
 */
const NULLABILITY_DRIFT_ALLOWED: Record<string, string[]> = {
  SseEvent: ["streamId"],
};

describe("openapi.json component schemas", () => {
  it("match the response interfaces in src/types.ts", () => {
    const interfaces = readInterfaces(TYPES_PATH);
    for (const [interfaceName, schemaName] of Object.entries(TYPE_SCHEMA_MAP)) {
      const members = interfaces.get(interfaceName);
      assert.ok(members, `${TYPES_PATH} no longer declares interface ${interfaceName}`);
      const schema = spec.components.schemas[schemaName] as Record<string, any> | undefined;
      assert.ok(schema, `openapi.json is missing components.schemas.${schemaName}`);

      const typeNames = members.map((member) => member.name).sort();
      const schemaNames = Object.keys(schema.properties ?? {}).sort();
      assert.deepEqual(schemaNames, typeNames, `${schemaName} properties drifted from ${interfaceName}`);

      // Optional TS members serialize as omitted keys; required ones must be required.
      const typeRequired = members.filter((member) => !member.optional).map((member) => member.name).sort();
      const schemaRequired = [...((schema.required ?? []) as string[])].sort();
      assert.deepEqual(schemaRequired, typeRequired, `${schemaName} required list drifted from ${interfaceName}`);

      const allowed = new Set(NULLABILITY_DRIFT_ALLOWED[schemaName] ?? []);
      for (const member of members) {
        const propertySchema = (schema.properties ?? {})[member.name] as JsonSchema | undefined;
        if (allowed.has(member.name)) continue;
        assert.equal(
          schemaAllowsNull(propertySchema),
          tsTypeAllowsNull(member.typeText),
          `${schemaName}.${member.name} nullability drifted: types.ts says "${member.typeText}", ` +
            `openapi.json says ${JSON.stringify((propertySchema as Record<string, unknown>)?.type ?? propertySchema)}`,
        );
      }
    }
  });
});

// ── Layer 3: route contracts ─────────────────────────────────────────────────

describe("indexer read-API routes conform to openapi.json", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";
  let store: StreamStore;
  let server: http.Server;
  let baseUrl: string;
  let stream: Stream;
  let webhookEndpointId: string;
  let consumerId: string;

  const proofConfig: ProofConfig = {
    networkPassphrase: Networks.TESTNET,
    contractId,
    signer: Keypair.random(),
  };

  // Representative `/api/ingest/stats` payload. The pipeline's own accounting
  // is covered by its unit tests; here the point is that the route serializes
  // a spec-shaped document, so a renamed/removed field fails this suite too.
  const ingestStats = (): IngestStats => ({
    lastTick: {
      ok: true,
      serial: false,
      depth: 4,
      maxInFlightObserved: 2,
      windowsPlanned: 1,
      windowsCommitted: 1,
      requests: 1,
      caughtUp: true,
      eventsSeen: 4,
      eventsInserted: 4,
      duplicates: 0,
      projectionSkips: 0,
      lateEvents: 0,
      gapLedgers: 0,
      windowLedgers: 20,
      ledgersCovered: 20,
      resumeAt: 121,
      durationMs: 5,
    },
    sequencer: {
      windowsCommitted: 1,
      ledgersCovered: 20,
      gapWindows: 0,
      gapLedgers: 0,
      eventsSeen: 4,
      lateEvents: 0,
      maxLateDepth: 0,
      streamsTracked: 1,
    },
    budget: {
      maxRps: 10,
      burstCapacity: 20,
      availableTokens: 19,
      observedLatencyMs: 12.5,
      healthyEndpoints: 1,
      hedgedReads: true,
    },
  });

  before(async () => {
    store = new StreamStore(":memory:");
    consumerId = "obc_openapi_contract";
    store.db
      .prepare(
        `INSERT INTO outbox_consumers (id, kind, url, secret, max_attempts, rate_limit_per_sec, status, created_at)
         VALUES (?, 'push', ?, NULL, 8, NULL, 'active', ?)`,
      )
      .run(consumerId, "https://example.invalid/hook", new Date().toISOString());

    const endpoint = store.webhooks.createEndpoint({ url: "https://example.invalid/hook", events: ["*"] });
    webhookEndpointId = endpoint.id;

    const fixtureEvents = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as RpcEvent[];
    store.ingestPage(fixtureEvents.map((event) => decodeEvent(event)), "120", 120);

    stream = store.getStream("1")!;
    assert.ok(stream, "fixture did not project stream 1");

    // Webhook deliveries are written directly rather than through ingestion:
    // `WebhookStore.queueDeliveriesForEvent` JSON-stringifies the decoded payload
    // without a BigInt replacer, so the fixture's i128/u64 fields make it throw
    // (the error is logged and swallowed in `StreamStore.ingestWithinTransaction`).
    // That pre-existing bug is reported on the issue; it is not the subject here.
    store.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, endpoint_id, event_id, stream_id, event_type, payload, attempt, status, next_retry_at, history, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "del_openapi_contract",
        webhookEndpointId,
        "0000000100-00001",
        "1",
        "stream_created",
        JSON.stringify({ sender: stream.sender, recipient: stream.recipient, deposit: stream.deposit }),
        1,
        "pending",
        Date.now(),
        "[]",
        new Date().toISOString(),
      );

    // Non-empty dead-letter queue so the DLQ item schema is exercised.
    const delivery = store.webhooks.getDelivery("del_openapi_contract");
    assert.ok(delivery, "fixture did not persist a webhook delivery");
    store.db
      .prepare(
        `INSERT INTO webhook_dead_letter
         (id, delivery_id, endpoint_id, event_id, stream_id, event_type, payload, attempts_count, last_error, last_status_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "dlq_openapi_contract",
        delivery.id,
        delivery.endpoint_id,
        delivery.event_id,
        delivery.stream_id,
        delivery.event_type,
        JSON.stringify(delivery.payload),
        8,
        "synthetic failure for the contract fixture",
        500,
        new Date().toISOString(),
      );

    const wasmDispatcher = new PluginDispatcher(store.wasm, new WasmPluginHost({ timeoutMs: 200 }), {
      redactionEnabled: false,
      onFallback: () => {},
    });

    const app = createApp(
      store,
      undefined,
      undefined,
      undefined,
      () => [],
      ingestStats,
      proofConfig,
      undefined,
      { dispatcher: wasmDispatcher },
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    store?.close();
  });

  it("GET /health", async () => {
    const response = await request(baseUrl, "/health");
    assert.equal(response.status, 200);
    assert.match(String(response.headers["content-type"]), /application\/json/);
    assertResponse("getHealth", response.status, response.json);
    assert.equal(response.json.lastLedger, "120");
    assert.equal(response.json.ingest.budget.healthyEndpoints, 1);
  });

  it("GET /streams?recipient=", async () => {
    const response = await request(baseUrl, `/streams?recipient=${encodeURIComponent(stream.recipient!)}`);
    assert.equal(response.status, 200);
    assertResponse("listStreamsByRecipient", response.status, response.json);
    assert.equal(Array.isArray(response.json), true);
    assert.ok(response.json.length > 0);

    const empty = await request(baseUrl, "/streams");
    assert.equal(empty.status, 200);
    assertResponse("listStreamsByRecipient", empty.status, empty.json);
    assert.deepEqual(empty.json, []);
  });

  it("GET /streams/:id", async () => {
    const response = await request(baseUrl, "/streams/1");
    assert.equal(response.status, 200);
    assertResponse("getStream", response.status, response.json);
    assert.equal(response.json.streamId, "1");

    const missing = await request(baseUrl, "/streams/9999");
    assert.equal(missing.status, 404);
    assertResponse("getStream", missing.status, missing.json);
  });

  it("GET /streams/:id/history", async () => {
    const response = await request(baseUrl, "/streams/1/history");
    assert.equal(response.status, 200);
    assertResponse("getStreamHistory", response.status, response.json);
    assert.equal(response.json.length, 4);
  });

  it("GET /streams/:id/events", async () => {
    const response = await request(baseUrl, "/streams/1/events?after=0&limit=10");
    assert.equal(response.status, 200);
    assertResponse("replayStreamEvents", response.status, response.json);
    assert.ok(response.json.events.length > 0);
    assert.equal(typeof response.json.next_cursor, "number");
  });

  it("GET /streams/:id/proof", async () => {
    const response = await request(baseUrl, "/streams/1/proof");
    assert.equal(response.status, 200);
    assertResponse("getStreamProof", response.status, response.json);
    assert.equal(response.json.stream.streamId, "1");
  });

  it("GET /address/:addr/streams", async () => {
    const response = await request(baseUrl, `/address/${stream.sender}/streams`);
    assert.equal(response.status, 200);
    assertResponse("listAddressStreams", response.status, response.json);
    assert.equal(response.json.address, stream.sender);
    assert.equal(response.json.count, response.json.streams.length);
  });

  it("GET /api/ingest/stats", async () => {
    const response = await request(baseUrl, "/api/ingest/stats");
    assert.equal(response.status, 200);
    assertResponse("getIngestStats", response.status, response.json);
    assert.equal(response.json.lastTick.ok, true);
  });

  it("GET /api/outbox/consumers and /api/outbox/consumers/:id", async () => {
    const list = await request(baseUrl, "/api/outbox/consumers");
    assert.equal(list.status, 200);
    assertResponse("listOutboxConsumers", list.status, list.json);
    assert.ok(list.json.some((consumer: { id: string }) => consumer.id === consumerId));

    const one = await request(baseUrl, `/api/outbox/consumers/${consumerId}`);
    assert.equal(one.status, 200);
    assertResponse("getOutboxConsumer", one.status, one.json);

    const missing = await request(baseUrl, "/api/outbox/consumers/does-not-exist");
    assert.equal(missing.status, 404);
    assertResponse("getOutboxConsumer", missing.status, missing.json);
  });

  it("GET /api/outbox/intents", async () => {
    const response = await request(baseUrl, "/api/outbox/intents?state=pending&limit=10");
    assert.equal(response.status, 200);
    assertResponse("listOutboxIntents", response.status, response.json);
    assert.ok(response.json.length > 0);

    const invalid = await request(baseUrl, "/api/outbox/intents?state=nope");
    assert.equal(invalid.status, 400);
    assertResponse("listOutboxIntents", invalid.status, invalid.json);
  });

  it("GET /api/outbox/stats", async () => {
    const response = await request(baseUrl, "/api/outbox/stats");
    assert.equal(response.status, 200);
    assertResponse("getOutboxStats", response.status, response.json);
    assert.ok(response.json.events > 0);
  });

  it("GET /api/webhooks/endpoints and /api/webhooks/endpoints/:id", async () => {
    const list = await request(baseUrl, "/api/webhooks/endpoints");
    assert.equal(list.status, 200);
    assertResponse("listWebhookEndpoints", list.status, list.json);
    assert.ok(list.json.some((endpoint: { id: string }) => endpoint.id === webhookEndpointId));

    const one = await request(baseUrl, `/api/webhooks/endpoints/${webhookEndpointId}`);
    assert.equal(one.status, 200);
    assertResponse("getWebhookEndpoint", one.status, one.json);

    const missing = await request(baseUrl, "/api/webhooks/endpoints/nope");
    assert.equal(missing.status, 404);
    assertResponse("getWebhookEndpoint", missing.status, missing.json);
  });

  it("GET /api/webhooks/deliveries and /api/webhooks/dlq", async () => {
    const deliveries = await request(baseUrl, "/api/webhooks/deliveries?limit=10");
    assert.equal(deliveries.status, 200);
    assertResponse("listWebhookDeliveries", deliveries.status, deliveries.json);
    assert.ok(deliveries.json.length > 0);

    const dlq = await request(baseUrl, "/api/webhooks/dlq?limit=10");
    assert.equal(dlq.status, 200);
    assertResponse("listWebhookDeadLetters", dlq.status, dlq.json);
    assert.equal(dlq.json.length, 1);
  });

  it("GET /api/traces/correlate", async () => {
    const registered = await request(baseUrl, "/api/traces/correlate", "POST", {
      txHash: "openapi-contract-tx",
      traceContext: { traceId: "trace-openapi", spanId: "span-openapi", traceFlags: 1 },
      streamId: "1",
    });
    assert.equal(registered.status, 200);

    const response = await request(baseUrl, "/api/traces/correlate?txHash=openapi-contract-tx");
    assert.equal(response.status, 200);
    assertResponse("getTraceCorrelation", response.status, response.json);
    assert.equal(response.json.context.traceId, "trace-openapi");

    const missing = await request(baseUrl, "/api/traces/correlate?txHash=unknown");
    assert.equal(missing.status, 404);
    assertResponse("getTraceCorrelation", missing.status, missing.json);
  });

  it("GET /api/wasm/plugins and /api/wasm/fallbacks", async () => {
    const plugins = await request(baseUrl, "/api/wasm/plugins");
    assert.equal(plugins.status, 200);
    assertResponse("listWasmPlugins", plugins.status, plugins.json);

    const fallbacks = await request(baseUrl, "/api/wasm/fallbacks");
    assert.equal(fallbacks.status, 200);
    assertResponse("listWasmFallbacks", fallbacks.status, fallbacks.json);
  });

  it("GET /events/stream emits spec-shaped SSE data frames", async () => {
    const data = await readFirstSseDataFrame(baseUrl, "/events/stream?streamId=1&lastEventId=0000000100-00001");
    const event = JSON.parse(data) as Record<string, unknown>;
    exercised.add("streamEvents");
    const errors = validateSchema({ $ref: "#/components/schemas/SseEvent" }, event, root);
    assert.deepEqual(errors, [], `SSE data frame drifted from openapi.json:\n${formatErrors(errors)}`);
    assert.equal(event.streamId, "1");
  });

  it("GET /graphql rejects ad-hoc queries with a documented 400", async () => {
    const response = await request(baseUrl, "/graphql");
    assert.equal(response.status, 400);
    assertResponse("getGraphql", response.status, response.json);
    assert.ok(Array.isArray(response.json.persistedQueries));
  });

  it("GET /graphql/schema serves the SDL", async () => {
    const response = await request(baseUrl, "/graphql/schema");
    assert.equal(response.status, 200);
    exercised.add("getGraphqlSchema");
    assert.match(String(response.headers["content-type"]), /text\/plain/);
    assert.match(response.text, /type Stream/);
  });

  it("GET /metrics serves Prometheus text", async () => {
    const response = await request(baseUrl, "/metrics");
    assert.equal(response.status, 200);
    exercised.add("getMetrics");
    assert.match(String(response.headers["content-type"]), /text\/plain/);
    assert.ok(response.text.length > 0);
  });

  it("exercises every documented operation", () => {
    const untested = [...operations.keys()].filter((operationId) => !exercised.has(operationId));
    assert.deepEqual(untested, [], `openapi.json documents operations with no contract test: ${untested.join(", ")}`);
  });
});
