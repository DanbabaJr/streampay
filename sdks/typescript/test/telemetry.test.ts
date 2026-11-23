import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StreamPayError } from "../src/errors.js";
import {
  SDK_NAME,
  SDK_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  errorCodeFrom,
  findLeak,
  isEmittable,
  latencyBucket,
  sanitizeTelemetryCall,
  telemetryEnabled,
  createTelemetry,
  type TelemetryEvent,
  type TelemetryTransport,
} from "../src/telemetry.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

const ADDRESS = "G" + "A".repeat(55);
const CONTRACT = "C" + "A".repeat(55);
const SEED = "S" + "A".repeat(55);
const HEX_KEY = "a".repeat(64);
const XDR_BLOB = Buffer.from("x".repeat(60)).toString("base64");
const AMOUNT = "123456789012345678";

/**
 * Leak regression corpus: values that must never appear in a telemetry event,
 * whatever field they are forced into. Each entry is paired with the denylist
 * pattern expected to catch it, so a weakened pattern fails the test.
 */
const LEAK_FIXTURES: ReadonlyArray<{ name: string; value: string; pattern: string }> = [
  { name: "stellar account", value: ADDRESS, pattern: "stellar_address" },
  { name: "contract id", value: CONTRACT, pattern: "stellar_address" },
  { name: "secret seed", value: SEED, pattern: "secret_seed" },
  { name: "transaction xdr", value: XDR_BLOB, pattern: "xdr_base64" },
  { name: "signing key", value: HEX_KEY, pattern: "hex_key" },
  { name: "email", value: "jane.doe@example.com", pattern: "email" },
  { name: "amount", value: AMOUNT, pattern: "amount" },
];

function recordingTransport(): { batches: TelemetryEvent[][]; transport: TelemetryTransport } {
  const batches: TelemetryEvent[][] = [];
  return {
    batches,
    transport: {
      async send(events) {
        batches.push([...events]);
      },
    },
  };
}

test("telemetry is off until a host opts in", async () => {
  const { batches, transport } = recordingTransport();
  const telemetry = createTelemetry({ transport, now: () => 1_000 });
  assert.equal(telemetry.enabled, false);
  assert.equal(telemetryEnabled(), false, "importing the SDK never enables telemetry");

  telemetry.record({ method: "create_stream", outcome: "ok", durationMs: 5 });
  assert.equal(telemetry.queueLength, 0);
  await telemetry.flush();
  assert.equal(batches.length, 0);
});

test("consent gating: enabling reports, withdrawing clears and stops", async () => {
  const { batches, transport } = recordingTransport();
  const telemetry = createTelemetry({ transport, now: () => 1_000 }).enable();

  telemetry.record({ method: "create_stream", outcome: "ok", durationMs: 5 });
  telemetry.record({ method: "withdraw", outcome: "error", durationMs: 800, errorCode: "InsufficientBalance" });
  await telemetry.flush();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.map((event) => event.method), ["create_stream", "withdraw"]);
  assert.equal(batches[0]![1]!.error_code, "InsufficientBalance");

  telemetry.record({ method: "cancel_stream", outcome: "ok", durationMs: 1 });
  telemetry.disable();
  assert.equal(telemetry.queueLength, 0, "withdrawn consent discards queued events");
  await telemetry.flush();
  assert.equal(batches.length, 1);
});

test("the kill switch stops reporting and clears the queue", async () => {
  const { batches, transport } = recordingTransport();
  const telemetry = createTelemetry({ transport, now: () => 1_000, killSwitch: () => true }).enable();

  telemetry.record({ method: "create_stream", outcome: "ok", durationMs: 5 });
  await telemetry.flush();

  assert.equal(batches.length, 0);
  assert.equal(telemetry.isKilled(), true);
  assert.equal(telemetry.enabled, false);
  assert.equal(telemetry.queueLength, 0);
});

test("latency is bucketed, never a raw duration", () => {
  assert.equal(latencyBucket(0), "lt_10ms");
  assert.equal(latencyBucket(9.9), "lt_10ms");
  assert.equal(latencyBucket(10), "lt_50ms");
  assert.equal(latencyBucket(499), "lt_500ms");
  assert.equal(latencyBucket(5_000), "gte_5s");
  assert.equal(latencyBucket(Number.NaN), "lt_10ms");
  assert.equal(latencyBucket(-1), "lt_10ms");
});

test("leak fixtures are caught by the denylist at the emission boundary", () => {
  for (const fixture of LEAK_FIXTURES) {
    assert.equal(findLeak(fixture.value), fixture.pattern, `${fixture.name} must match ${fixture.pattern}`);

    const event = sanitizeTelemetryCall({
      method: fixture.value,
      outcome: "error",
      durationMs: 5,
      errorCode: fixture.value,
    });
    assert.equal(event.method, "unknown_method", `${fixture.name} must not become a method name`);
    assert.equal(event.error_code, undefined, `${fixture.name} must not become an error code`);
    assert.equal(findLeak(JSON.stringify(event)), undefined);
    assert.equal(isEmittable(event), true);
  }
});

test("an event carries only the allowlisted fields", () => {
  const event = sanitizeTelemetryCall({ method: "withdraw_all", outcome: "ok", durationMs: 42 });
  assert.deepEqual(Object.keys(event).sort(), [
    "event",
    "latency_bucket",
    "method",
    "outcome",
    "schema",
    "sdk",
  ]);
  assert.equal(event.schema, TELEMETRY_SCHEMA_VERSION);
  assert.deepEqual(event.sdk, { name: SDK_NAME, version: SDK_VERSION });
  assert.equal(event.event, "call");
  assert.equal(event.latency_bucket, "lt_50ms");

  const withCode = sanitizeTelemetryCall({ method: "withdraw", outcome: "error", durationMs: 1, errorCode: "simulation" });
  assert.equal(withCode.error_code, "simulation");
  // Anything that is not an identifier is dropped rather than passed through.
  assert.equal(sanitizeTelemetryCall({ method: "withdraw", outcome: "error", durationMs: 1, errorCode: "boom: secret text" }).error_code, undefined);
});

test("error codes are the contract name or the failure kind, never the message", () => {
  assert.equal(errorCodeFrom(new StreamPayError("boom", "simulation")), "simulation");
  const withContract = new StreamPayError("boom", "inclusion", { contract: { code: 12, name: "InsufficientBalance" } });
  assert.equal(errorCodeFrom(withContract), "InsufficientBalance");
  assert.equal(errorCodeFrom(new Error("address G... leaked in a message")), "unknown_error");
});

test("track records outcome, bucket and error code without changing behaviour", async () => {
  const { batches, transport } = recordingTransport();
  let clock = 1_000;
  const telemetry = createTelemetry({ transport, now: () => clock }).enable();

  const value = await telemetry.track("create_stream", async () => {
    clock += 30;
    return 7n;
  });
  assert.equal(value, 7n);

  const failure = new StreamPayError("rejected", "submission");
  await assert.rejects(
    telemetry.track("withdraw", async () => {
      clock += 700;
      throw failure;
    }),
    (error: unknown) => error === failure,
    "the original error object must reach the caller",
  );

  await telemetry.flush();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.map((event) => [event.method, event.outcome, event.latency_bucket]), [
    ["create_stream", "ok", "lt_50ms"],
    ["withdraw", "error", "lt_1s"],
  ]);
  assert.equal(batches[0]![1]!.error_code, "submission");
});

test("a failing transport never breaks the host, backs off, then gives up", async () => {
  let clock = 0;
  let attempts = 0;
  const telemetry = createTelemetry({
    transport: {
      async send() {
        attempts += 1;
        throw new Error("network down");
      },
    },
    now: () => clock,
    maxAttempts: 2,
    baseBackoffMs: 100,
  }).enable();

  telemetry.record({ method: "create_stream", outcome: "ok", durationMs: 1 });
  await telemetry.flush(); // must resolve, not throw
  assert.equal(attempts, 1);
  assert.equal(telemetry.queueLength, 1, "the batch is kept for retry");

  await telemetry.flush(); // inside the backoff window: no retry yet
  assert.equal(attempts, 1);

  clock += 100;
  await telemetry.flush();
  assert.equal(attempts, 2, "the retry happened after the backoff elapsed");
  assert.equal(telemetry.queueLength, 0, "the undeliverable batch is dropped, not retried forever");
  assert.equal(telemetry.droppedEvents, 1);

  // A later batch still works: one failure does not poison the instance.
  const ok = recordingTransport();
  const healthy = createTelemetry({ transport: ok.transport, now: () => 0 }).enable();
  healthy.record({ method: "get_stream", outcome: "ok", durationMs: 1 });
  await healthy.flush();
  assert.equal(ok.batches.length, 1);
});

test("reporting is batched", async () => {
  const { batches, transport } = recordingTransport();
  const telemetry = createTelemetry({ transport, now: () => 0, batchSize: 2 }).enable();

  for (let i = 0; i < 5; i++) {
    telemetry.record({ method: "get_stream", outcome: "ok", durationMs: i });
  }
  await telemetry.flush();

  assert.equal(batches.length >= 2, true, "more than one request was sent");
  assert.equal(batches.flat().length, 5, "every event was reported exactly once");
  assert.equal(batches.every((batch) => batch.length <= 2), true, "no batch exceeds batchSize");
  assert.equal(telemetry.droppedEvents, 0);
});

test("the queue is bounded and drops the oldest events", async () => {
  const { batches, transport } = recordingTransport();
  const telemetry = createTelemetry({ transport, now: () => 0, batchSize: 100, maxQueue: 3 }).enable();

  for (let i = 0; i < 5; i++) {
    telemetry.record({ method: "get_stream", outcome: "ok", durationMs: i });
  }
  assert.equal(telemetry.queueLength, 3, "the queue never exceeds maxQueue");
  assert.equal(telemetry.droppedEvents, 2, "the oldest events are the ones dropped");

  await telemetry.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 3);
});

test("SDK identity in the event matches the published package", () => {
  assert.equal(SDK_NAME, pkg.name);
  assert.equal(SDK_VERSION, pkg.version);
});
