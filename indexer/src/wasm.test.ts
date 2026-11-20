import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { StreamStore } from "./store.js";
import { createApp } from "./index.js";
import { redactDecodedEvent } from "./redaction.js";
import type { DecodedEvent, EventValue } from "./types.js";
import { pluginDigest } from "./wasm/abi.js";
import {
  buildConstOutputPlugin,
  buildDropIfContainsPlugin,
  buildEnrichPlugin,
  buildGrowLoopPlugin,
  buildHugeOutputLengthPlugin,
  buildIllegalImportPlugin,
  buildInfiniteLoopPlugin,
  buildInvalidOutputPlugin,
  buildPassthroughPlugin,
  buildPluginWithMemoryMax,
  buildPluginWithoutMemory,
  buildPluginWithoutTransform,
  buildTrapPlugin,
} from "./wasm/builder.js";
import { PluginDispatcher } from "./wasm/dispatcher.js";
import { WasmPluginHost } from "./wasm/host.js";
import { WasmPluginRegistry } from "./wasm/registry.js";
import { validatePlugin } from "./wasm/validate.js";

const ADDR_A = "G" + "A".repeat(55);
const ADDR_B = "G" + "B".repeat(55);
const TENANT = "tenant-acme";
const SUBSCRIPTION = "sub-1";

function baseEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    id: "evt-1",
    pagingToken: "1",
    ledger: 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: "C",
    name: "stream_created",
    streamId: "7",
    data: { sender: ADDR_A, recipient: ADDR_B, deposit: "1000" },
    ...overrides,
  };
}

function withdrawnEvent(): DecodedEvent {
  return baseEvent({
    id: "evt-2",
    pagingToken: "2",
    ledger: 105,
    name: "withdrawn",
    data: { recipient: ADDR_B, amount: "100", withdrawn_total: "100" },
  });
}

function registryWithPlugin(
  bytes: Uint8Array,
  tenant = TENANT,
  version = "1.0.0",
): { db: Database.Database; registry: WasmPluginRegistry; digest: string } {
  const db = new Database(":memory:");
  const registry = new WasmPluginRegistry(db);
  const record = registry.register(bytes, version, "test-plugin");
  registry.approve(tenant, record.digest);
  return { db, registry, digest: record.digest };
}

// `PluginValidationError` carries its stable code on `.code`, not in the
// message, so validation assertions check the code (and optionally the
// message) with this predicate.
function hasCode(code: string, pattern?: RegExp) {
  return (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    if ((err as { code?: unknown }).code !== code) return false;
    return pattern ? pattern.test(err.message) : true;
  };
}

function pluginBytesFor(name: string): Uint8Array {
  switch (name) {
    case "passthrough":
      return buildPassthroughPlugin();
    case "drop-withdrawn":
      return buildDropIfContainsPlugin("withdrawn");
    case "project":
      return buildConstOutputPlugin(JSON.stringify({ data: { kind: "stream_created", streamId: "7" } }));
    case "enrich":
      return buildEnrichPlugin();
    default:
      throw new Error(`unknown conformance plugin ${name}`);
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

test("validation accepts a well-formed passthrough plugin", () => {
  const { module, memory } = validatePlugin(buildPassthroughPlugin());
  assert.ok(module instanceof WebAssembly.Module);
  assert.equal(memory.initial, 1);
  assert.equal(memory.maximum, 4);
});

test("validation rejects any import, naming it", () => {
  assert.throws(
    () => validatePlugin(buildIllegalImportPlugin("env", "fetch")),
    hasCode("forbidden_import", /env\.fetch/),
  );
  assert.throws(
    () => validatePlugin(buildIllegalImportPlugin("wasi_snapshot_preview1", "fd_write")),
    hasCode("forbidden_import", /wasi_snapshot_preview1\.fd_write/),
  );
});

test("validation rejects unbounded or oversized memory", () => {
  assert.throws(() => validatePlugin(buildPluginWithMemoryMax(null)), hasCode("memory_unbounded"));
  assert.throws(() => validatePlugin(buildPluginWithMemoryMax(100)), hasCode("memory_too_large", /100 pages/));
  // A maximum below the initial size is malformed WASM, rejected earlier.
  assert.throws(() => validatePlugin(buildPluginWithMemoryMax(0)), hasCode("invalid_wasm"));
  assert.throws(() => validatePlugin(buildPluginWithMemoryMax(4, 0)), hasCode("memory", /at least 1 page/));
});

test("validation rejects modules missing memory or transform, empty or malformed bytes", () => {
  assert.throws(() => validatePlugin(buildPluginWithoutMemory()), hasCode("missing_memory"));
  assert.throws(() => validatePlugin(buildPluginWithoutTransform()), hasCode("missing_transform"));
  assert.throws(() => validatePlugin(new Uint8Array(0)), hasCode("empty"));
  assert.throws(
    () => validatePlugin(new TextEncoder().encode("not wasm at all")),
    hasCode("invalid_wasm"),
  );
  assert.throws(() => validatePlugin(new Uint8Array(2 * 1024 * 1024)), hasCode("too_large"));
});

// ── Registry: content-addressing and per-tenant approval ────────────────────

test("plugin id is the sha256 of the exact bytes", () => {
  const bytes = buildPassthroughPlugin();
  const db = new Database(":memory:");
  const registry = new WasmPluginRegistry(db);
  const record = registry.register(bytes, "1.0.0");
  assert.equal(record.digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(record.digest, pluginDigest(bytes));
  assert.equal(registry.register(bytes, "1.0.0").digest, record.digest, "re-registering the same bytes is idempotent");
  assert.throws(() => registry.register(bytes, "2.0.0"), /already registered as version 1\.0\.0/);
  const other = registry.register(buildTrapPlugin(), "1.0.0");
  assert.notEqual(other.digest, record.digest, "different bytes are a different plugin");
  db.close();
});

test("a plugin cannot run for a tenant until that tenant approves it", () => {
  const db = new Database(":memory:");
  const registry = new WasmPluginRegistry(db);
  const record = registry.register(buildPassthroughPlugin(), "1.0.0");
  assert.equal(registry.isApproved(TENANT, record.digest), false);
  assert.equal(registry.getApproved(TENANT, record.digest), undefined);
  assert.throws(() => registry.approve(TENANT, "0".repeat(64)), /unknown plugin/);
  registry.approve(TENANT, record.digest);
  assert.equal(registry.isApproved(TENANT, record.digest), true);
  assert.equal(registry.isApproved("tenant-other", record.digest), false, "approval is per tenant");
  assert.equal(registry.getApproved(TENANT, record.digest)?.digest, record.digest);
  assert.equal(registry.listApprovals(TENANT).length, 1);
  assert.equal(registry.revoke(TENANT, record.digest), true);
  assert.equal(registry.isApproved(TENANT, record.digest), false);
  db.close();
});

test("registry and approvals survive a restart (same SQLite file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "streampay-wasm-registry-"));
  const path = join(dir, "indexer.db");
  try {
    const db = new Database(path);
    const first = new WasmPluginRegistry(db);
    const record = first.register(buildPassthroughPlugin(), "1.0.0", "restart-plugin");
    first.approve(TENANT, record.digest);
    // A fresh registry over the same database re-reads both tables.
    const second = new WasmPluginRegistry(db);
    assert.equal(second.getPlugin(record.digest)?.name, "restart-plugin");
    assert.equal(second.isApproved(TENANT, record.digest), true);
    assert.equal(second.listPlugins().length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StreamStore owns a wasm registry over its own database", () => {
  const store = new StreamStore(":memory:");
  const record = store.wasm.register(buildPassthroughPlugin(), "1.0.0");
  store.wasm.approve(TENANT, record.digest);
  assert.equal(store.wasm.isApproved(TENANT, record.digest), true);
  store.close();
});

// ── Host: transforms ────────────────────────────────────────────────────────

test("host runs passthrough, projection and enrichment plugins", async () => {
  const host = new WasmPluginHost({ timeoutMs: 500 });
  const event = baseEvent();
  const pass = await host.transformEvent(buildPassthroughPlugin(), event);
  assert.equal(pass.status, "transformed");
  if (pass.status === "transformed") assert.deepEqual(pass.output, event.data);

  const projected = await host.transformEvent(
    buildConstOutputPlugin(JSON.stringify({ data: { kind: "stream_created", streamId: "7" } })),
    event,
  );
  assert.equal(projected.status, "transformed");
  if (projected.status === "transformed") {
    assert.deepEqual(projected.output, { kind: "stream_created", streamId: "7" });
  }

  const enriched = await host.transformEvent(buildEnrichPlugin(), event);
  assert.equal(enriched.status, "transformed");
  if (enriched.status === "transformed") {
    assert.equal(enriched.output.enriched, true);
    assert.equal(enriched.output.sender, ADDR_A);
  }
});

test("host drops events when the plugin returns the drop marker", async () => {
  const host = new WasmPluginHost({ timeoutMs: 500 });
  const dropper = buildDropIfContainsPlugin("withdrawn");
  assert.equal((await host.transformEvent(dropper, withdrawnEvent())).status, "dropped");
  const kept = await host.transformEvent(dropper, baseEvent());
  assert.equal(kept.status, "transformed");
});

test("hostile plugins fail safe with a fallback, never throwing", async () => {
  // Worker spawn takes ~250ms in this environment, so the budgets below
  // are deliberately above spawn time: a runaway plugin must actually be
  // running when the timeout kills it, and a trap must surface as a trap
  // rather than as a timeout.
  const host = new WasmPluginHost({ timeoutMs: 2000 });
  const event = baseEvent();
  const cases: Array<[string, Uint8Array, RegExp]> = [
    ["trap", buildTrapPlugin(), /plugin failed:.*unreachable/],
    ["huge output length", buildHugeOutputLengthPlugin(), /invalid output length/],
    ["non-JSON reply", buildInvalidOutputPlugin(), /not valid JSON/],
    ["illegal import", buildIllegalImportPlugin("env", "fetch"), /imports env\.fetch/],
    ["oversized memory", buildPluginWithMemoryMax(100), /over the 4 page limit/],
  ];
  for (const [label, bytes, pattern] of cases) {
    const started = Date.now();
    const outcome = await host.transformEvent(bytes, event);
    assert.equal(outcome.status, "fallback", `${label} must fall back`);
    if (outcome.status === "fallback") assert.match(outcome.reason, pattern, label);
    assert.ok(Date.now() - started < 5000, `${label} must not stall the caller`);
  }
});

test("runaway plugins are killed by the wall-clock budget", async () => {
  const host = new WasmPluginHost({ timeoutMs: 1000 });
  const event = baseEvent();
  for (const [label, bytes] of [
    ["infinite loop", buildInfiniteLoopPlugin()],
    ["memory-grow loop", buildGrowLoopPlugin()],
  ] as Array<[string, Uint8Array]>) {
    const started = Date.now();
    const outcome = await host.transformEvent(bytes, event);
    const elapsed = Date.now() - started;
    assert.equal(outcome.status, "fallback", `${label} must fall back`);
    if (outcome.status === "fallback") assert.match(outcome.reason, /wall-clock budget/, label);
    assert.ok(elapsed >= 900, `${label} must actually run until the budget expires (took ${elapsed}ms)`);
    assert.ok(elapsed < 5000, `${label} must not stall the caller`);
  }
});

test("host rejects oversized input instead of running the plugin", async () => {
  const host = new WasmPluginHost({ timeoutMs: 500 });
  const outcome = await host.transform(buildPassthroughPlugin(), "x".repeat(100), { maxInputBytes: 10 });
  assert.equal(outcome.status, "fallback");
  if (outcome.status === "fallback") assert.match(outcome.reason, /over the 10 byte limit/);
});

test("same input + same plugin digest yields the same output", async () => {
  const host = new WasmPluginHost({ timeoutMs: 500 });
  const bytes = buildEnrichPlugin();
  const event = baseEvent();
  const runs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const outcome = await host.transformEvent(bytes, event);
    assert.equal(outcome.status, "transformed");
    if (outcome.status === "transformed") runs.push(JSON.stringify(outcome.output));
  }
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[1], runs[2]);
  assert.equal(pluginDigest(bytes), pluginDigest(buildEnrichPlugin()), "identical bytes, identical digest");
});

// ── Conformance vectors ─────────────────────────────────────────────────────

interface ConformanceVector {
  name: string;
  plugin: string;
  input: DecodedEvent;
  expected: { outcome: "transformed" | "dropped"; data?: Record<string, EventValue> };
}

test("conformance vectors: input event + plugin digest yields the expected output", async () => {
  // Tests run from dist/, so the vectors file is resolved relative to the
  // source tree, not the build output (tsc does not copy .json/.wasm).
  const vectors: ConformanceVector[] = JSON.parse(
    readFileSync(new URL("../src/wasm/conformance-vectors.json", import.meta.url), "utf8"),
  );
  assert.ok(vectors.length >= 5, "vectors file must carry the suite");
  const host = new WasmPluginHost({ timeoutMs: 500 });
  for (const vector of vectors) {
    const outcome = await host.transformEvent(pluginBytesFor(vector.plugin), vector.input);
    assert.equal(outcome.status, vector.expected.outcome, vector.name);
    if (vector.expected.outcome === "transformed") {
      assert.equal(outcome.status, "transformed", vector.name);
      if (outcome.status === "transformed") {
        assert.deepEqual(outcome.output, vector.expected.data, vector.name);
      }
    }
    // Determinism: run it again, same result.
    const again = await host.transformEvent(pluginBytesFor(vector.plugin), vector.input);
    assert.equal(again.status, outcome.status, `${vector.name} (repeat)`);
  }
});

test("the example plugin drops withdrawn events and passes the rest", async () => {
  // The example plugin is built by the builder, not checked in as a
  // binary, so the repo carries no binary blob. The builder output is
  // pinned by digest to the module the example documents.
  const bytes = buildDropIfContainsPlugin("withdrawn");
  assert.equal(
    pluginDigest(bytes),
    "e58bcb8d09b2816cc9f2d11044964092367651cc14adea3066dc358982590905",
  );
  const host = new WasmPluginHost({ timeoutMs: 500 });
  assert.doesNotThrow(() => validatePlugin(bytes));
  assert.equal((await host.transformEvent(bytes, withdrawnEvent())).status, "dropped");
  const kept = await host.transformEvent(bytes, baseEvent());
  assert.equal(kept.status, "transformed");
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

test("dispatcher passes through events with no subscription", async () => {
  const { db, registry } = registryWithPlugin(buildPassthroughPlugin());
  const dispatcher = new PluginDispatcher(registry, new WasmPluginHost({ timeoutMs: 500 }));
  const event = baseEvent();
  const result = await dispatcher.dispatch(event, "no-such-subscription");
  assert.equal(result.outcome, "passthrough");
  assert.deepEqual(result.event, event);
  assert.equal(dispatcher.fallbackLog.length, 0);
  db.close();
});

test("dispatcher falls back with an alert for an unapproved plugin, and transforms once approved", async () => {
  const db = new Database(":memory:");
  const registry = new WasmPluginRegistry(db);
  const record = registry.register(buildEnrichPlugin(), "1.0.0");
  const alerts: Array<{ reason: string }> = [];
  const dispatcher = new PluginDispatcher(registry, new WasmPluginHost({ timeoutMs: 500 }), {
    onFallback: (alert) => alerts.push(alert),
  });
  dispatcher.subscribe(SUBSCRIPTION, TENANT, record.digest);
  const event = baseEvent();

  const unapproved = await dispatcher.dispatch(event, SUBSCRIPTION);
  assert.equal(unapproved.outcome, "fallback");
  assert.deepEqual(unapproved.event?.data, event.data, "fallback delivers the raw event");
  assert.match(unapproved.reason ?? "", /not approved/);
  assert.equal(dispatcher.fallbackLog.length, 1);
  assert.equal(alerts.length, 1);

  registry.approve(TENANT, record.digest);
  const transformed = await dispatcher.dispatch(event, SUBSCRIPTION);
  assert.equal(transformed.outcome, "transformed");
  assert.equal(transformed.event?.data.enriched, true);
  assert.equal(dispatcher.fallbackLog.length, 1, "no new alert after approval");

  registry.revoke(TENANT, record.digest);
  const revoked = await dispatcher.dispatch(event, SUBSCRIPTION);
  assert.equal(revoked.outcome, "fallback");
  db.close();
});

test("dispatcher drops events the plugin drops, and falls back on a runaway plugin", async () => {
  const { db, registry, digest } = registryWithPlugin(buildDropIfContainsPlugin("withdrawn"));
  const dispatcher = new PluginDispatcher(registry, new WasmPluginHost({ timeoutMs: 500 }));
  dispatcher.subscribe(SUBSCRIPTION, TENANT, digest);
  assert.equal((await dispatcher.dispatch(withdrawnEvent(), SUBSCRIPTION)).outcome, "dropped");
  assert.equal((await dispatcher.dispatch(baseEvent(), SUBSCRIPTION)).outcome, "transformed");
  db.close();

  const runaway = registryWithPlugin(buildInfiniteLoopPlugin());
  const slow = new PluginDispatcher(runaway.registry, new WasmPluginHost({ timeoutMs: 1000 }));
  slow.subscribe(SUBSCRIPTION, TENANT, runaway.digest);
  const started = Date.now();
  const result = await slow.dispatch(baseEvent(), SUBSCRIPTION);
  assert.equal(result.outcome, "fallback");
  assert.deepEqual(result.event?.data, baseEvent().data, "runaway plugin falls back to the raw stream");
  assert.ok(Date.now() - started < 5000, "ingestion is never stalled by a runaway plugin");
  assert.equal(slow.fallbackLog.length, 1);
  runaway.db.close();
});

// ── Redaction: after transforms, never before ───────────────────────────────

test("redaction truncates full Stellar addresses only when enabled", () => {
  const event = baseEvent({ data: { sender: ADDR_A, recipient: ADDR_B, note: "hello", nested: { owner: ADDR_A }, amount: "100", active: true } });
  assert.equal(redactDecodedEvent(event, false), event, "disabled redaction returns the event unchanged");
  const redacted = redactDecodedEvent(event, true);
  assert.equal(redacted.data.sender, "GAAAAAAA...");
  assert.equal(redacted.data.recipient, "GBBBBBBB...");
  assert.equal(redacted.data.note, "hello");
  assert.equal((redacted.data.nested as Record<string, EventValue>).owner, "GAAAAAAA...");
  assert.equal(redacted.data.amount, "100");
  assert.equal(redacted.data.active, true);
  assert.equal(redacted.id, event.id, "envelope is untouched");
});

test("redaction runs AFTER plugin transforms: a plugin cannot un-redact a field", async () => {
  const { db, registry, digest } = registryWithPlugin(
    buildConstOutputPlugin(JSON.stringify({ data: { sender: ADDR_A, recipient: ADDR_B } })),
  );
  // The plugin emits full addresses even though the input was already clean;
  // redaction downstream must still truncate them.
  const dispatcher = new PluginDispatcher(registry, new WasmPluginHost({ timeoutMs: 500 }), {
    redactionEnabled: true,
  });
  dispatcher.subscribe(SUBSCRIPTION, TENANT, digest);
  const result = await dispatcher.dispatch(baseEvent({ data: { sender: "GAAAAAAA...", note: "x" } }), SUBSCRIPTION);
  assert.equal(result.outcome, "transformed");
  assert.equal(result.event?.data.sender, "GAAAAAAA...");
  assert.equal(result.event?.data.recipient, "GBBBBBBB...");
  db.close();
});

test("enrichment and redaction compose: new fields survive, addresses do not", async () => {
  const { db, registry, digest } = registryWithPlugin(buildEnrichPlugin());
  const dispatcher = new PluginDispatcher(registry, new WasmPluginHost({ timeoutMs: 500 }), {
    redactionEnabled: true,
  });
  dispatcher.subscribe(SUBSCRIPTION, TENANT, digest);
  const result = await dispatcher.dispatch(baseEvent(), SUBSCRIPTION);
  assert.equal(result.outcome, "transformed");
  assert.equal(result.event?.data.enriched, true);
  assert.equal(result.event?.data.sender, "GAAAAAAA...");
  db.close();
});

// ── HTTP wiring: admin routes + plugin SSE ──────────────────────────────────

function httpJson(
  method: string,
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: text ? JSON.parse(text) : null });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("wasm admin routes register, approve and bind a plugin", async () => {
  const store = new StreamStore(":memory:");
  const dispatcher = new PluginDispatcher(store.wasm, new WasmPluginHost({ timeoutMs: 500 }));
  const app = createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { dispatcher });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const bytes = buildPassthroughPlugin();
    const created = await httpJson("POST", baseUrl, "/api/wasm/plugins", {
      bytesBase64: Buffer.from(bytes).toString("base64"),
      version: "1.0.0",
      name: "api-plugin",
    });
    assert.equal(created.status, 201);
    const digest = (created.data as { digest: string }).digest;
    assert.equal(digest, pluginDigest(bytes));

    const listed = await httpJson("GET", baseUrl, "/api/wasm/plugins");
    assert.equal((listed.data as Array<{ digest: string }>).some((p) => p.digest === digest), true);

    const bad = await httpJson("POST", baseUrl, "/api/wasm/plugins", {
      bytesBase64: Buffer.from(buildTrapPlugin()).toString("base64"),
      version: "1.0.0",
    });
    assert.equal(bad.status, 201, "a trapping module is still a valid plugin at registration");

    const illegal = await httpJson("POST", baseUrl, "/api/wasm/plugins", {
      bytesBase64: Buffer.from(buildIllegalImportPlugin("env", "fetch")).toString("base64"),
      version: "1.0.0",
    });
    assert.equal(illegal.status, 400);

    const approved = await httpJson("POST", baseUrl, `/api/wasm/plugins/${digest}/approve`, { tenant: TENANT });
    assert.equal(approved.status, 200);
    const bound = await httpJson("POST", baseUrl, "/api/wasm/subscriptions", {
      subscriptionId: SUBSCRIPTION,
      tenant: TENANT,
      pluginDigest: digest,
    });
    assert.equal(bound.status, 201);
    const fallbacks = await httpJson("GET", baseUrl, "/api/wasm/fallbacks");
    assert.equal(fallbacks.status, 200);
    assert.deepEqual(fallbacks.data, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("plugin SSE drops filtered events and passes the rest, in order", async () => {
  const store = new StreamStore(":memory:");
  const record = store.wasm.register(buildDropIfContainsPlugin("withdrawn"), "1.0.0", "sse-dropper");
  store.wasm.approve(TENANT, record.digest);
  const dispatcher = new PluginDispatcher(store.wasm, new WasmPluginHost({ timeoutMs: 500 }));
  const app = createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { dispatcher });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chunks: string[] = [];
  try {
    const req = http.get(
      `${baseUrl}/events/stream?tenant=${TENANT}&plugin=${record.digest}`,
      (res) => {
        assert.equal(res.statusCode, 200);
        res.on("data", (chunk) => chunks.push(chunk.toString()));
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    store.ingest(withdrawnEvent());
    store.ingest(baseEvent({ id: "evt-3", pagingToken: "3", ledger: 110 }));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for plugin SSE event")), 5000);
      const check = setInterval(() => {
        if (chunks.join("").includes("evt-3")) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 200));
    const text = chunks.join("");
    assert.equal(text.includes("evt-3"), true, "unfiltered event is delivered");
    assert.equal(text.includes("evt-2"), false, "withdrawn event is dropped by the plugin, not delivered");
    req.destroy();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
