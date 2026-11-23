import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_CONTRACT_EVENT_NAMES } from "../generated/events.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  FutureSchemaVersionError,
  InvalidUpcasterError,
  LEGACY_EVENT_SCHEMA_VERSION,
  MissingUpcasterError,
  UnknownEventSchemaError,
  UpcasterRegistry,
  type EventData,
  assertUpcastersMatchSchemaRegistry,
  createDefaultUpcasterRegistry,
  defaultUpcasterRegistry,
} from "./upcasters.js";

const v0StreamCreated = {
  sender: "G" + "A".repeat(55),
  recipient: "G" + "B".repeat(55),
  token: "C" + "C".repeat(55),
  amount: "1000",
  start: 1704067200,
  end: 1704153600,
};

test("legacy stream_created payload is upcast to the registry v1 shape", () => {
  const { version, data } = defaultUpcasterRegistry.upcast("stream_created", LEGACY_EVENT_SCHEMA_VERSION, v0StreamCreated);
  assert.equal(version, CURRENT_EVENT_SCHEMA_VERSION);
  assert.deepEqual(data, {
    sender: v0StreamCreated.sender,
    recipient: v0StreamCreated.recipient,
    token: v0StreamCreated.token,
    deposit: "1000",
    start_time: 1704067200,
    end_time: 1704153600,
    cancelable: true,
  });
});

test("legacy withdrawn/stream_topped_up totals are renamed, not recomputed", () => {
  const withdrawn = defaultUpcasterRegistry.upcast("withdrawn", 0, { recipient: "G" + "B".repeat(55), amount: "100", total: "250" });
  assert.deepEqual(withdrawn.data, { recipient: "G" + "B".repeat(55), amount: "100", withdrawn_total: "250" });

  const topUp = defaultUpcasterRegistry.upcast("stream_topped_up", 0, { sender: "G" + "A".repeat(55), amount: "500", deposit: "1500" });
  assert.deepEqual(topUp.data, { sender: "G" + "A".repeat(55), amount: "500", new_deposit: "1500" });
});

test("a current-version payload is returned untouched, by reference", () => {
  const current = { sender: "G" + "A".repeat(55), recipient: "G" + "B".repeat(55) };
  const result = defaultUpcasterRegistry.upcast("stream_created", CURRENT_EVENT_SCHEMA_VERSION, current);
  assert.equal(result.version, CURRENT_EVENT_SCHEMA_VERSION);
  assert.equal(result.data, current, "no chain runs, so the payload is not copied");
  assert.equal(defaultUpcasterRegistry.chain("stream_created", CURRENT_EVENT_SCHEMA_VERSION).length, 0);
});

test("upcasting never mutates the journal payload it was handed", () => {
  const input = structuredClone(v0StreamCreated) as Record<string, unknown>;
  const snapshot = structuredClone(input);
  defaultUpcasterRegistry.upcast("stream_created", 0, input as EventData);
  assert.deepEqual(input, snapshot);
});

test("an event without a registered legacy chain fails closed", () => {
  assert.throws(
    () => defaultUpcasterRegistry.upcast("stream_cancelled", LEGACY_EVENT_SCHEMA_VERSION, {}),
    (err: unknown) => err instanceof MissingUpcasterError && err.eventName === "stream_cancelled" && err.from === 0,
  );
});

test("a payload newer than this tree understands fails closed instead of being projected", () => {
  assert.throws(
    () => defaultUpcasterRegistry.upcast("stream_created", CURRENT_EVENT_SCHEMA_VERSION + 1, {}),
    (err: unknown) => err instanceof FutureSchemaVersionError && err.version === 2 && err.current === 1,
  );
});

test("negative and non-integer versions are rejected as unknown", () => {
  assert.throws(() => defaultUpcasterRegistry.upcast("stream_created", -1, {}), UnknownEventSchemaError);
  assert.throws(() => defaultUpcasterRegistry.upcast("stream_created", 0.5, {}), UnknownEventSchemaError);
});

test("chains must be contiguous, unique and target a registry event", () => {
  const registry = new UpcasterRegistry();
  const upcast = (data: EventData): EventData => data;

  assert.throws(() => registry.register("not_an_event", { from: 0, to: 1, upcast }), InvalidUpcasterError);
  assert.throws(() => registry.register("stream_created", { from: 0, to: 2, upcast }), InvalidUpcasterError);
  assert.throws(() => registry.register("stream_created", { from: -1, to: 0, upcast }), InvalidUpcasterError);

  registry.register("stream_created", { from: 0, to: 1, upcast });
  assert.throws(() => registry.register("stream_created", { from: 0, to: 1, upcast }), InvalidUpcasterError);
});

test("a gap in a multi-step chain is a missing upcaster, not a silent skip", () => {
  const registry = new UpcasterRegistry({ currentVersion: () => 2 });
  registry.register("stream_created", { from: 1, to: 2, upcast: (data) => ({ ...data, v2: true }) });
  assert.throws(
    () => registry.upcast("stream_created", 0, {}),
    (err: unknown) => err instanceof MissingUpcasterError && err.from === 0,
  );

  registry.register("stream_created", { from: 0, to: 1, upcast: (data) => ({ ...data, v1: true }) });
  const result = registry.upcast("stream_created", 0, { base: "x" });
  assert.equal(result.version, 2);
  assert.deepEqual(result.data, { base: "x", v1: true, v2: true });
});

test("the shipped chains correspond to the generated schema registry", () => {
  assert.doesNotThrow(() => assertUpcastersMatchSchemaRegistry());
  const known = new Set<string>(ALL_CONTRACT_EVENT_NAMES);
  for (const { eventName } of createDefaultUpcasterRegistry().describe()) {
    assert.ok(known.has(eventName), `${eventName} is not a registry event`);
  }
  assert.deepEqual(defaultUpcasterRegistry.eventsWithUpcasters(), ["stream_created", "stream_topped_up", "withdrawn"]);
});
