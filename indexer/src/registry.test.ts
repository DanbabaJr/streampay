// Registry-consumption tests: the generated event table must match the
// committed schema registry, and the decoder must enforce it (issue #213).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { decodeEvent } from "./decoder.js";
import {
  ALL_CONTRACT_EVENT_NAMES,
  EVENT_FINGERPRINTS,
  EVENT_KEYS,
  EVENT_SHAPES,
  isContractEventName,
  type ContractEventName,
} from "./generated/events.js";
import type { RpcEvent } from "./types.js";

interface RegistryFile {
  registry_version: number;
  events: Record<string, { event_key: string; fingerprint: string; topics: { name: string; type: string }[]; data: { name: string; type: string }[] }>;
  fingerprints: Record<string, string>;
}

function loadRegistry(): RegistryFile {
  const candidates = [
    new URL("../../schemas/events/registry.json", import.meta.url),
    new URL("../../../schemas/events/registry.json", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(url, "utf8")) as RegistryFile;
    } catch {
      // try next location (source tree vs dist build)
    }
  }
  throw new Error("cannot locate schemas/events/registry.json");
}

test("generated event table matches the committed registry field-for-field", () => {
  const registry = loadRegistry();
  const structs = Object.keys(registry.events).sort();

  assert.deepEqual(Object.keys(EVENT_KEYS).sort(), structs);
  assert.deepEqual(Object.keys(EVENT_FINGERPRINTS).sort(), structs);
  for (const structName of structs) {
    const ev = registry.events[structName];
    assert.equal(EVENT_KEYS[structName as keyof typeof EVENT_KEYS], ev.event_key);
    const shape = EVENT_SHAPES[ev.event_key as ContractEventName];
    assert.equal(shape.struct, structName);
    assert.equal(shape.fingerprint, ev.fingerprint);
    assert.deepEqual(shape.topics, ev.topics);
    assert.deepEqual(shape.data, ev.data);
  }
  assert.equal(registry.registry_version, 1);
  assert.equal(ALL_CONTRACT_EVENT_NAMES.length, structs.length);
});

test("isContractEventName narrows registry keys only", () => {
  assert.equal(isContractEventName("stream_created"), true);
  assert.equal(isContractEventName("withdrawn"), true);
  assert.equal(isContractEventName("policy_initialized"), true);
  assert.equal(isContractEventName("not_a_streampay_event"), false);
});

function rpcEvent(topics: unknown[], value: unknown): RpcEvent {
  return {
    id: "00000000000000000000000000000001#1",
    ledger: 1,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM",
    topic: topics,
    value,
  };
}

test("registry-known event with an unexpected topic layout fails loudly", () => {
  // `withdrawn` declares exactly one positional topic (stream_id); give it two.
  const event = rpcEvent(
    [xdr.ScVal.scvSymbol("withdrawn"), nativeToScVal(7n, { type: "u64" }), nativeToScVal(8n, { type: "u64" })],
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: nativeToScVal("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", { type: "address" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(1n, { type: "i128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("withdrawn_total"), val: nativeToScVal(1n, { type: "i128" }) }),
    ])
  );
  assert.throws(() => decodeEvent(event), /withdrawn.*registry declares 1/s);
});

test("registry-known event missing a declared data field fails", () => {
  const event = rpcEvent(
    [xdr.ScVal.scvSymbol("withdrawn"), nativeToScVal(7n, { type: "u64" })],
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: nativeToScVal("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", { type: "address" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(1n, { type: "i128" }) }),
    ])
  );
  assert.throws(() => decodeEvent(event), /missing registry data field\(s\): withdrawn_total/);
});

test("registry events that declare no stream_id topic decode with a null stream", () => {
  // `fee_withdrawn` is keyed by `token`, `contract_frozen_state_changed` by a
  // bool. Neither is about a stream, and before the registry was authoritative
  // the first positional topic was relabelled as one: a freeze event was indexed
  // under stream id "true", and a fee event under the token's StrKey.
  const token = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
  const gov = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const event = rpcEvent(
    [xdr.ScVal.scvSymbol("fee_withdrawn"), nativeToScVal(token, { type: "address" })],
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("governor"), val: nativeToScVal(gov, { type: "address" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: nativeToScVal(gov, { type: "address" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(3n, { type: "i128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("withdrawn_total"), val: nativeToScVal(3n, { type: "i128" }) }),
    ])
  );
  const decoded = decodeEvent(event);
  assert.equal(decoded.name, "fee_withdrawn");
  assert.equal(decoded.streamId, null);
  assert.equal(decoded.data.amount, 3n);

  const frozen = decodeEvent(
    rpcEvent(
      [xdr.ScVal.scvSymbol("contract_frozen_state_changed"), xdr.ScVal.scvBool(true)],
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("changed_by"), val: nativeToScVal(gov, { type: "address" }) }),
      ])
    )
  );
  assert.equal(frozen.name, "contract_frozen_state_changed");
  assert.equal(frozen.streamId, null, "a bool topic must not become a stream id");
});

test("the declared stream_id topic still populates the stream", () => {
  // The null case above must not cost the events that do declare one.
  const recipient = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const decoded = decodeEvent(
    rpcEvent(
      [xdr.ScVal.scvSymbol("withdrawn"), nativeToScVal(7n, { type: "u64" })],
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: nativeToScVal(recipient, { type: "address" }) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(2n, { type: "i128" }) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("withdrawn_total"), val: nativeToScVal(9n, { type: "i128" }) }),
      ])
    )
  );
  assert.equal(decoded.streamId, "7");
});

test("registry shapes apply only to the governed contract", () => {
  // A third contract emitting the `withdrawn` symbol with a payload missing a
  // declared field is somebody else's event: it must not be validated against
  // our schema, and its topics must not be read as one of our stream ids.
  const foreignContractId = "CBMYPHAKEU2XKVDE2UTQD6Q2X6YQ7UZKGOLLM3DPNVRPW7XHOOVMOA7A";
  const event = rpcEvent(
    [xdr.ScVal.scvSymbol("withdrawn"), nativeToScVal(4n, { type: "u64" })],
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(2n, { type: "i128" }) }),
    ])
  );
  const foreign = decodeEvent(event, { contractId: foreignContractId });
  assert.equal(foreign.name, "withdrawn");
  assert.equal(foreign.streamId, null);
  assert.equal(foreign.data.amount, 2n);

  // Same bytes from our own contract still fail the registry check.
  assert.throws(
    () => decodeEvent(event, { contractId: event.contractId }),
    /missing registry data field\(s\): recipient, withdrawn_total/
  );
});

test("extra data keys (additive registry evolution) are tolerated", () => {
  const recipient = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const event = rpcEvent(
    [xdr.ScVal.scvSymbol("withdrawn"), nativeToScVal(7n, { type: "u64" })],
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: nativeToScVal(recipient, { type: "address" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(2n, { type: "i128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("withdrawn_total"), val: nativeToScVal(2n, { type: "i128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("memo"), val: nativeToScVal(recipient, { type: "address" }) }),
    ])
  );
  const decoded = decodeEvent(event);
  assert.equal(decoded.data.memo, recipient);
});
