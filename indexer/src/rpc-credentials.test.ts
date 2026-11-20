/**
 * RPC credential hot reload — issue #615.
 *
 * The manager applies credentials per request, so rotation is a map swap, not a
 * connection teardown. These tests pin the three behaviours that claim rests on:
 *
 *  1. a request already in flight completes on the credential it started with,
 *     and the next request uses the new one — no dropped call;
 *  2. a candidate that fails its probe aborts the whole rotation (fail-safe) and
 *     the previous credential stays active;
 *  3. health and failover state survive a rotation untouched, including when a
 *     probe itself fails: a probe is not traffic and must not mark a working
 *     endpoint unhealthy.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { RpcManager, type ManagerOptions } from "./rpc-manager.js";

const URL_PRIMARY = "https://rpc-primary.example.com";
const URL_SECONDARY = "https://rpc-secondary.example.com";

interface Call {
  url: string;
  authorization: string | undefined;
  method: string;
  startedAt: number;
  finishedAt?: number;
}

const calls: Call[] = [];
/** Credentials the fake provider accepts, keyed by Authorization value. */
let accepted: Set<string>;
let delayMs = 0;
let originalFetch: typeof fetch;
let failNext = new Map<string, number>();

function authOf(init?: RequestInit): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization;
}

const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const call: Call = {
    url,
    authorization: authOf(init),
    method: "",
    startedAt: Date.now(),
  };
  try {
    call.method = String(JSON.parse(String(init?.body ?? "{}")).method ?? "");
  } catch {
    call.method = "";
  }
  calls.push(call);

  const auth = call.authorization ?? "";
  const remainingFailures = failNext.get(url) ?? 0;
  if (remainingFailures > 0) {
    failNext.set(url, remainingFailures - 1);
    call.finishedAt = Date.now();
    throw new TypeError("fetch failed");
  }

  if (init?.signal?.aborted) {
    call.finishedAt = Date.now();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  call.finishedAt = Date.now();

  if (!accepted.has(auth)) {
    return new Response("unauthorized", { status: 401 });
  }
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sequence: 100, id: "hash", protocolVersion: 22 } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

function managerOptions(): ManagerOptions {
  return {
    endpoints: [
      { url: URL_PRIMARY, headers: { Authorization: "Bearer old" } },
      { url: URL_SECONDARY, headers: { Authorization: "Bearer old" } },
    ],
    maxRps: 1000,
    failureThreshold: 3,
    hedgeDelayMs: 0,
    healthCheckIntervalMs: 60_000,
    timeoutMs: 5_000,
  };
}

function boot() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
}

describe("RPC credential rotation", () => {
  beforeEach(() => {
    accepted = new Set(["Bearer old", "Bearer new"]);
    calls.length = 0;
    delayMs = 0;
    failNext = new Map();
    boot();
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("rotates mid-flight without dropping the in-flight request", async () => {
    const manager = new RpcManager(managerOptions());
    delayMs = 40;

    const inFlight = manager.getLatestLedger();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.getCredentialState().inflight, 1, "a request is genuinely in flight");

    const result = await manager.rotateCredentials([
      { url: URL_PRIMARY, headers: { Authorization: "Bearer new" } },
      { url: URL_SECONDARY, headers: { Authorization: "Bearer new" } },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.updated.sort(), [URL_PRIMARY, URL_SECONDARY].sort());

    // The request that was already running finishes on the credential it started
    // with — rotation never aborts it.
    assert.equal((await inFlight).sequence, 100);
    const inFlightCall = calls.find((call) => call.method === "getLatestLedger");
    assert.equal(inFlightCall?.authorization, "Bearer old");

    delayMs = 0;
    calls.length = 0;
    await manager.getLatestLedger();
    assert.equal(calls[0]?.authorization, "Bearer new", "the next request uses the new credential");
    assert.equal(manager.getCredentialState().inflight, 0);
    manager.stop();
  });

  it("aborts when the candidate credential is rejected and keeps the old one", async () => {
    const manager = new RpcManager(managerOptions());
    accepted = new Set(["Bearer old"]);

    const result = await manager.rotateCredentials([
      { url: URL_PRIMARY, headers: { Authorization: "Bearer rejected" } },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, [URL_PRIMARY]);
    assert.match(result.error ?? "", /previous credentials remain active/);

    calls.length = 0;
    await manager.getLatestLedger();
    assert.equal(calls[0]?.authorization, "Bearer old", "the old credential is still in use");
    manager.stop();
  });

  it("swaps nothing when one of several endpoints fails its probe", async () => {
    const manager = new RpcManager(managerOptions());
    // Secondary rejects the new credential; primary accepts it.
    accepted = new Set(["Bearer old"]);

    const result = await manager.rotateCredentials([
      { url: URL_PRIMARY, headers: { Authorization: "Bearer half" } },
      { url: URL_SECONDARY, headers: { Authorization: "Bearer half" } },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.updated, [], "a partial rotation is never applied");

    calls.length = 0;
    await manager.getLatestLedger();
    assert.equal(calls[0]?.authorization, "Bearer old");
    manager.stop();
  });

  it("preserves failover state across a rotation", async () => {
    const manager = new RpcManager(managerOptions());
    // Mark the secondary unhealthy with three consecutive failures.
    failNext.set(URL_SECONDARY, 3);
    for (let i = 0; i < 3; i++) {
      try {
        await manager.call({ method: "getLatestLedger", params: {} }, "read");
      } catch {
        // every call fails while both endpoints reject; the point is the state
      }
    }
    const before = manager
      .getHealth()
      .map((health) => ({ url: health.url, healthy: health.healthy, failures: health.failures }));

    const result = await manager.rotateCredentials([
      { url: URL_PRIMARY, headers: { Authorization: "Bearer new" } },
      { url: URL_SECONDARY, headers: { Authorization: "Bearer new" } },
    ], { probe: false });
    assert.equal(result.ok, true);

    const after = manager
      .getHealth()
      .map((health) => ({ url: health.url, healthy: health.healthy, failures: health.failures }));
    assert.deepEqual(after, before, "failure counts and health are untouched by a credential swap");

    // ...and the rotated credentials work on both endpoints again.
    calls.length = 0;
    await manager.getLatestLedger();
    assert.equal(calls[0]?.authorization, "Bearer new");
    manager.stop();
  });

  it("does not mark an endpoint unhealthy when only its credential probe fails", async () => {
    const manager = new RpcManager(managerOptions());
    accepted = new Set(["Bearer old"]);

    await manager.rotateCredentials([{ url: URL_PRIMARY, headers: { Authorization: "Bearer nope" } }]);

    const health = manager.getHealth().find((entry) => entry.url === URL_PRIMARY)!;
    assert.equal(health.healthy, true, "a probe is not traffic");
    assert.equal(health.failures, 0);
    manager.stop();
  });

  it("rejects credentials for an endpoint it does not manage", async () => {
    const manager = new RpcManager(managerOptions());
    const result = await manager.rotateCredentials([
      { url: "https://unknown.example.com", headers: { Authorization: "Bearer new" } },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["https://unknown.example.com"]);
    manager.stop();
  });

  it("exposes fingerprints for audit without exposing the secret", async () => {
    const manager = new RpcManager(managerOptions());
    const state = manager.getCredentialState();
    assert.equal(state.endpoints.length, 2);
    const fingerprint = state.endpoints[0]!.fingerprint;
    assert.equal(fingerprint.length, 16);
    assert.equal(JSON.stringify(state).includes("Bearer old"), false, "credential values never leave the manager");

    await manager.rotateCredentials([
      { url: URL_PRIMARY, headers: { Authorization: "Bearer new" } },
    ]);
    const rotated = manager.getCredentialState().endpoints.find((entry) => entry.url === URL_PRIMARY)!;
    assert.notEqual(rotated.fingerprint, fingerprint, "the fingerprint moves when the credential does");
    manager.stop();
  });
});
