/**
 * Programmatic generator for negative Soroban ScVal decoding fixtures (issue #486).
 *
 * Builds corrupted and malformed RPC event fixtures from real event schemas
 * (schemas/events/v1/) and existing sample fixtures (indexer/fixtures/).
 *
 * Categories covered:
 * 1. Truncated XDR: truncated base64 topics, truncated value map, mid-symbol cuts, garbage bytes.
 * 2. Wrong-type ScVals for each event field: wrong ScVal discriminant for stream_id topic
 *    and each data field (sender, recipient, token, deposit, start_time, end_time, cancelable).
 * 3. Unknown event topics: empty topics, non-symbol name, unknown event name, extra/missing topics.
 * 4. Schema violations: missing required fields, negative u64 values, invalid Stellar StrKey addresses,
 *    and non-map payload structures.
 */

import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import type { DecodeErrorCode } from "./decoder.js";
import type { RpcEvent } from "./types.js";

export interface CorruptTestCase {
  id: string;
  name: string;
  category: "truncated_xdr" | "wrong_type" | "unknown_topic" | "schema_violation" | "invalid_data";
  event: RpcEvent;
  expectedErrorCode: DecodeErrorCode;
  expectedField?: string;
  description: string;
}

const GOVERNED_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";

/**
 * Canonical valid stream_created RPC fixture (from indexer/fixtures/stream-created.json).
 */
export function getValidStreamCreatedFixture(): RpcEvent {
  return {
    id: "fixture:1-0",
    pagingToken: "fixture:1-0",
    ledger: 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: GOVERNED_CONTRACT_ID,
    topic: [
      "AAAADwAAAA5zdHJlYW1fY3JlYXRlZAAA", // symbol "stream_created"
      "AAAABQAAAAAAAAAH",                 // u64 7
    ],
    value:
      "AAAAEQAAAAEAAAAHAAAADwAAAAZzZW5kZXIAAAAAABIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAlyZWNpcGllbnQAAAAAAAASAAAAAAAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQAAAA8AAAAFdG9rZW4AAAAAAAASAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAADwAAAAdkZXBvc2l0AAAAAAoAAAAAAAAAAAAAAAAAD0JAAAAADwAAAApzdGFydF90aW1lAAAAAAAFAAAAAAAAA+gAAAAPAAAACGVuZF90aW1lAAAABQAAAAAAAAfQAAAADwAAAApjYW5jZWxhYmxlAAAAAAAAAAAAAQ==",
  };
}

/**
 * Canonical valid withdrawn RPC fixture (from indexer/fixtures/events-fixture.json).
 */
export function getValidWithdrawnFixture(): RpcEvent {
  return {
    id: "fixture:1-1",
    pagingToken: "fixture:1-1",
    ledger: 105,
    ledgerClosedAt: "2026-01-01T00:05:00Z",
    contractId: GOVERNED_CONTRACT_ID,
    topic: [
      "AAAADwAAAAl3aXRoZHJhd24AAAA=", // symbol "withdrawn"
      "AAAABQAAAAAAAAAB",             // u64 1
    ],
    value:
      "AAAAEQAAAAEAAAADAAAADwAAAAlyZWNpcGllbnQAAAAAAAASAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAHoSAAAAADwAAAA93aXRoZHJhd25fdG90YWwAAAAACgAAAAAAAAAAAAAAAAAehIA=",
  };
}

/**
 * Constructs an ScVal map encoded as base64 XDR.
 */
export function encodeScValMap(entries: Record<string, xdr.ScVal>): string {
  const mapEntries: xdr.ScMapEntry[] = Object.entries(entries).map(
    ([key, val]) =>
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val,
      })
  );
  return xdr.ScVal.scvMap(mapEntries).toXDR("base64");
}

/**
 * Standard valid entries for stream_created data.
 */
function getStandardStreamCreatedEntries(): Record<string, xdr.ScVal> {
  return {
    sender: nativeToScVal("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", { type: "address" }),
    recipient: nativeToScVal("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", { type: "address" }),
    token: nativeToScVal("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM", { type: "address" }),
    deposit: nativeToScVal(1_000_000n, { type: "i128" }),
    start_time: nativeToScVal(1_000n, { type: "u64" }),
    end_time: nativeToScVal(2_000n, { type: "u64" }),
    cancelable: nativeToScVal(true, { type: "bool" }),
  };
}

/**
 * Standard valid entries for withdrawn data.
 */
function getStandardWithdrawnEntries(): Record<string, xdr.ScVal> {
  return {
    recipient: nativeToScVal("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", { type: "address" }),
    amount: nativeToScVal(100n, { type: "i128" }),
    withdrawn_total: nativeToScVal(100n, { type: "i128" }),
  };
}

// ── 1. Truncated & Malformed XDR Generators ───────────────────────────────────

export function generateTruncatedXdrFixtures(): CorruptTestCase[] {
  const base = getValidStreamCreatedFixture();
  return [
    {
      id: "trunc-xdr-topic-0-short",
      name: "truncated event name topic XDR (cut short)",
      category: "truncated_xdr",
      event: {
        ...base,
        id: "trunc-xdr-topic-0",
        topic: [(base.topic[0] as string).slice(0, 8), base.topic[1]],
      },
      expectedErrorCode: "TRUNCATED_XDR",
      expectedField: "topic[0]",
      description: "Topic 0 base64 truncated to 8 bytes, causing XDR decode failure",
    },
    {
      id: "trunc-xdr-topic-0-mid",
      name: "truncated event name topic XDR (mid-symbol cut)",
      category: "truncated_xdr",
      event: {
        ...base,
        id: "trunc-xdr-topic-0-mid",
        topic: ["AAAADwAAAA", base.topic[1]],
      },
      expectedErrorCode: "TRUNCATED_XDR",
      expectedField: "topic[0]",
      description: "Topic 0 cut mid-symbol XDR struct",
    },
    {
      id: "trunc-xdr-topic-1-stream-id",
      name: "truncated positional topic stream_id XDR",
      category: "truncated_xdr",
      event: {
        ...base,
        id: "trunc-xdr-topic-1",
        topic: [base.topic[0], (base.topic[1] as string).slice(0, 6)],
      },
      expectedErrorCode: "TRUNCATED_XDR",
      expectedField: "topic[1]",
      description: "Positional topic 1 (stream_id) base64 cut in half",
    },
    {
      id: "trunc-xdr-value-map",
      name: "truncated value map payload XDR",
      category: "truncated_xdr",
      event: {
        ...base,
        id: "trunc-xdr-value",
        value: (base.value as string).slice(0, 32),
      },
      expectedErrorCode: "TRUNCATED_XDR",
      expectedField: "value",
      description: "Data value map base64 truncated mid-payload",
    },
    {
      id: "corrupt-xdr-topic-garbage",
      name: "non-base64 garbage topic XDR",
      category: "truncated_xdr",
      event: {
        ...base,
        id: "corrupt-topic-garbage",
        topic: ["!!!NOT_BASE64_BYTES!!!", base.topic[1]],
      },
      expectedErrorCode: "TRUNCATED_XDR",
      expectedField: "topic[0]",
      description: "Topic 0 contains invalid characters failing base64 decoding",
    },
    {
      id: "corrupt-xdr-value-garbage",
      name: "non-base64 garbage value XDR",
      category: "truncated_xdr",
      event: {
        ...base,
        id: "corrupt-val-garbage",
        value: "???CORRUPTED_VALUE_BYTES???",
      },
      expectedErrorCode: "TRUNCATED_XDR",
      expectedField: "value",
      description: "Value contains invalid characters failing XDR decoding",
    },
  ];
}

// ── 2. Wrong-Type ScVals For Each Event Field ─────────────────────────────────

export function generateWrongTypeFieldFixtures(): CorruptTestCase[] {
  const base = getValidStreamCreatedFixture();
  const cases: CorruptTestCase[] = [];

  // Wrong-type positional topic: stream_id (declared as u64)
  const badStreamIdTopicTypes = [
    { typeName: "Symbol", val: nativeToScVal("seven", { type: "symbol" }) },
    { typeName: "Bool", val: nativeToScVal(true, { type: "bool" }) },
    {
      typeName: "Address",
      val: nativeToScVal("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", { type: "address" }),
    },
  ];

  for (const item of badStreamIdTopicTypes) {
    cases.push({
      id: `wrong-type-topic-stream_id-${item.typeName.toLowerCase()}`,
      name: `wrong-type topic stream_id as ScVal ${item.typeName}`,
      category: "wrong_type",
      event: {
        ...base,
        id: `wrong-type-topic-stream_id-${item.typeName.toLowerCase()}`,
        topic: [base.topic[0], item.val.toXDR("base64")],
      },
      expectedErrorCode: "INVALID_TYPE",
      expectedField: "stream_id",
      description: `Positional topic stream_id passed as ${item.typeName} instead of required u64`,
    });
  }

  // Wrong-type ScVals for each stream_created data field
  const streamCreatedFieldsWrongTypes: Record<string, { typeName: string; val: xdr.ScVal }> = {
    sender: { typeName: "u64", val: nativeToScVal(12345n, { type: "u64" }) },
    recipient: { typeName: "bool", val: nativeToScVal(false, { type: "bool" }) },
    token: { typeName: "u32", val: nativeToScVal(500, { type: "u32" }) },
    deposit: { typeName: "Symbol", val: nativeToScVal("not_an_i128", { type: "symbol" }) },
    start_time: { typeName: "Symbol", val: nativeToScVal("start_now", { type: "symbol" }) },
    end_time: { typeName: "bool", val: nativeToScVal(true, { type: "bool" }) },
    cancelable: { typeName: "u64", val: nativeToScVal(1n, { type: "u64" }) },
  };

  for (const [field, { typeName, val }] of Object.entries(streamCreatedFieldsWrongTypes)) {
    const entries = getStandardStreamCreatedEntries();
    entries[field] = val;
    cases.push({
      id: `wrong-type-data-stream_created-${field}`,
      name: `wrong-type data field ${field} as ScVal ${typeName}`,
      category: "wrong_type",
      event: {
        ...base,
        id: `wrong-type-data-${field}`,
        value: encodeScValMap(entries),
      },
      expectedErrorCode: "INVALID_TYPE",
      expectedField: field,
      description: `Field ${field} encoded as ${typeName} instead of declared contract type`,
    });
  }

  // Also verify withdrawn data fields
  const withdrawnBase = getValidWithdrawnFixture();
  const withdrawnFieldsWrongTypes: Record<string, { typeName: string; val: xdr.ScVal }> = {
    recipient: { typeName: "u64", val: nativeToScVal(999n, { type: "u64" }) },
    amount: { typeName: "Symbol", val: nativeToScVal("ten_tokens", { type: "symbol" }) },
    withdrawn_total: { typeName: "bool", val: nativeToScVal(true, { type: "bool" }) },
  };

  for (const [field, { typeName, val }] of Object.entries(withdrawnFieldsWrongTypes)) {
    const entries = getStandardWithdrawnEntries();
    entries[field] = val;
    cases.push({
      id: `wrong-type-data-withdrawn-${field}`,
      name: `wrong-type data field withdrawn.${field} as ScVal ${typeName}`,
      category: "wrong_type",
      event: {
        ...withdrawnBase,
        id: `wrong-type-withdrawn-${field}`,
        value: encodeScValMap(entries),
      },
      expectedErrorCode: "INVALID_TYPE",
      expectedField: field,
      description: `Withdrawn field ${field} encoded as ${typeName} instead of declared contract type`,
    });
  }

  return cases;
}

// ── 3. Unknown Event Topics Generators ───────────────────────────────────────

export function generateUnknownTopicFixtures(): CorruptTestCase[] {
  const base = getValidStreamCreatedFixture();
  return [
    {
      id: "unknown-topic-empty",
      name: "empty event topics array",
      category: "unknown_topic",
      event: {
        ...base,
        id: "topic-empty",
        topic: [],
      },
      expectedErrorCode: "MISSING_TOPIC",
      description: "Event has no topics at all",
    },
    {
      id: "unknown-topic-non-symbol-name",
      name: "non-symbol event name topic (u64)",
      category: "unknown_topic",
      event: {
        ...base,
        id: "topic-non-symbol",
        topic: [nativeToScVal(100n, { type: "u64" }).toXDR("base64"), base.topic[1]],
      },
      expectedErrorCode: "INVALID_TOPIC",
      expectedField: "topic[0]",
      description: "Topic 0 is a u64 integer rather than a symbol name",
    },
    {
      id: "unknown-topic-unregistered-event-name",
      name: "unknown event name without stream_id fallback",
      category: "unknown_topic",
      event: {
        ...base,
        id: "topic-unknown-event",
        topic: [nativeToScVal("unknown_arbitrary_event", { type: "symbol" }).toXDR("base64")],
      },
      expectedErrorCode: "UNKNOWN_TOPIC",
      description: "Governed event name not in registry and missing stream_id topic",
    },
    {
      id: "unknown-topic-extra-positional",
      name: "extra positional topic violating registry layout",
      category: "unknown_topic",
      event: {
        ...base,
        id: "topic-extra-pos",
        topic: [
          base.topic[0],
          base.topic[1],
          nativeToScVal(999n, { type: "u64" }).toXDR("base64"),
        ],
      },
      expectedErrorCode: "INVALID_TOPIC",
      description: "StreamCreated declares exactly 1 positional topic (stream_id); 2 provided",
    },
    {
      id: "unknown-topic-missing-positional",
      name: "missing positional topic declared by registry",
      category: "unknown_topic",
      event: {
        ...base,
        id: "topic-missing-pos",
        topic: [base.topic[0]],
      },
      expectedErrorCode: "INVALID_TOPIC",
      description: "StreamCreated declares 1 positional topic; 0 provided",
    },
  ];
}

// ── 4. Payloads That Decode But Violate schemas/events/v1/ ─────────────────────

export function generateSchemaViolationFixtures(): CorruptTestCase[] {
  const base = getValidStreamCreatedFixture();
  const cases: CorruptTestCase[] = [];

  // Missing required fields
  const requiredFields = ["sender", "recipient", "token", "deposit", "start_time", "end_time", "cancelable"];
  for (const field of requiredFields) {
    const entries = getStandardStreamCreatedEntries();
    delete entries[field];
    cases.push({
      id: `schema-missing-${field}`,
      name: `payload missing required field "${field}"`,
      category: "schema_violation",
      event: {
        ...base,
        id: `schema-missing-${field}`,
        value: encodeScValMap(entries),
      },
      expectedErrorCode: "SCHEMA_VIOLATION",
      expectedField: field,
      description: `Decodes to map but omits required schema property "${field}"`,
    });
  }

  // Negative unsigned integers (u64 minimum: 0 constraint)
  // In Soroban XDR, we can encode negative integers via scvI64 or scvI128
  const negativeI64 = xdr.ScVal.scvI64(xdr.Int64.fromString("-1")); // -1n
  const startTimeEntries = getStandardStreamCreatedEntries();
  startTimeEntries.start_time = negativeI64;
  cases.push({
    id: "schema-negative-start_time",
    name: "negative value for unsigned start_time",
    category: "schema_violation",
    event: {
      ...base,
      id: "negative-start_time",
      value: encodeScValMap(startTimeEntries),
    },
    expectedErrorCode: "SCHEMA_VIOLATION",
    expectedField: "start_time",
    description: "start_time is decoded as negative integer, violating schema minimum: 0",
  });

  const endTimeEntries = getStandardStreamCreatedEntries();
  endTimeEntries.end_time = negativeI64;
  cases.push({
    id: "schema-negative-end_time",
    name: "negative value for unsigned end_time",
    category: "schema_violation",
    event: {
      ...base,
      id: "negative-end_time",
      value: encodeScValMap(endTimeEntries),
    },
    expectedErrorCode: "SCHEMA_VIOLATION",
    expectedField: "end_time",
    description: "end_time is decoded as negative integer, violating schema minimum: 0",
  });

  // Negative stream_id topic
  cases.push({
    id: "schema-negative-topic-stream_id",
    name: "negative value for unsigned topic stream_id",
    category: "schema_violation",
    event: {
      ...base,
      id: "negative-stream_id",
      topic: [base.topic[0], negativeI64.toXDR("base64")],
    },
    expectedErrorCode: "SCHEMA_VIOLATION",
    expectedField: "stream_id",
    description: "topic stream_id is decoded as negative integer, violating schema minimum: 0",
  });

  // Invalid Stellar Address format (StrKey)
  const invalidAddressEntries = getStandardStreamCreatedEntries();
  invalidAddressEntries.sender = xdr.ScVal.scvString("NOT_A_VALID_STELLAR_STRKEY_ADDRESS");
  cases.push({
    id: "schema-invalid-address-strkey",
    name: "malformed Stellar address format for sender",
    category: "schema_violation",
    event: {
      ...base,
      id: "invalid-sender-addr",
      value: encodeScValMap(invalidAddressEntries),
    },
    expectedErrorCode: "SCHEMA_VIOLATION",
    expectedField: "sender",
    description: "sender string is not a valid 56-char Base32 Stellar account or contract StrKey",
  });

  // Non-map payload data
  cases.push({
    id: "schema-non-map-payload-vec",
    name: "payload decodes to ScVal vector instead of map",
    category: "invalid_data",
    event: {
      ...base,
      id: "non-map-vec",
      value: xdr.ScVal.scvVec([
        nativeToScVal(1n, { type: "u64" }),
        nativeToScVal(2n, { type: "u64" }),
      ]).toXDR("base64"),
    },
    expectedErrorCode: "INVALID_DATA",
    description: "event.value decodes to Vec instead of Map, violating schema type: object",
  });

  cases.push({
    id: "schema-non-map-payload-u64",
    name: "payload decodes to ScVal u64 instead of map",
    category: "invalid_data",
    event: {
      ...base,
      id: "non-map-u64",
      value: nativeToScVal(9999n, { type: "u64" }).toXDR("base64"),
    },
    expectedErrorCode: "INVALID_DATA",
    description: "event.value decodes to u64 primitive instead of Map",
  });

  return cases;
}

/**
 * Returns the complete reproducible negative fixture corpus.
 */
export function buildCorruptCorpus(): CorruptTestCase[] {
  return [
    ...generateTruncatedXdrFixtures(),
    ...generateWrongTypeFieldFixtures(),
    ...generateUnknownTopicFixtures(),
    ...generateSchemaViolationFixtures(),
  ];
}