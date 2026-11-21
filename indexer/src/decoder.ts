import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { DecodedEvent, EventValue, RpcEvent } from "./types.js";
import { EVENT_SHAPES, isContractEventName } from "./generated/events.js";

export type DecodeErrorCode =
  | "TRUNCATED_XDR"
  | "MISSING_TOPIC"
  | "INVALID_TOPIC"
  | "UNKNOWN_TOPIC"
  | "INVALID_TYPE"
  | "SCHEMA_VIOLATION"
  | "INVALID_DATA";

export class DecodeError extends Error {
  readonly code: DecodeErrorCode;
  readonly eventId?: string;
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;

  constructor(
    message: string,
    options: {
      code: DecodeErrorCode;
      eventId?: string;
      field?: string;
      expected?: string;
      actual?: string;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "DecodeError";
    this.code = options.code;
    this.eventId = options.eventId;
    this.field = options.field;
    this.expected = options.expected;
    this.actual = options.actual;
    if (options.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, DecodeError.prototype);
  }
}

function decodeScVal(encoded: unknown, eventId?: string, location?: string): EventValue {
  try {
    if (typeof encoded === "string") {
      return scValToNative(xdr.ScVal.fromXDR(encoded, "base64")) as EventValue;
    }
    if (
      typeof encoded === "object" &&
      encoded !== null &&
      "xdr" in encoded &&
      typeof (encoded as { xdr: string }).xdr === "string"
    ) {
      return scValToNative(xdr.ScVal.fromXDR((encoded as { xdr: string }).xdr, "base64")) as EventValue;
    }
    return scValToNative(encoded as Parameters<typeof scValToNative>[0]) as EventValue;
  } catch (err) {
    if (err instanceof DecodeError) throw err;
    throw new DecodeError(
      `Event ${eventId ?? "unknown"} failed to decode XDR at ${location ?? "unknown"}: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: "TRUNCATED_XDR",
        eventId,
        field: location,
        cause: err,
      }
    );
  }
}

function record(value: EventValue, eventId?: string): Record<string, EventValue> {
  if (value instanceof Map) {
    const obj: Record<string, EventValue> = {};
    for (const [k, v] of value.entries()) {
      obj[String(k)] = v as EventValue;
    }
    return obj;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DecodeError("Expected event data to decode to a map", {
      code: "INVALID_DATA",
      eventId,
    });
  }
  return value as Record<string, EventValue>;
}

function isStellarAddress(val: unknown): boolean {
  return typeof val === "string" && /^[GCBM][A-Z2-7]{55,68}$/.test(val);
}

function validateField(
  val: unknown,
  expectedType: string,
  fieldName: string,
  eventId: string,
  eventName: string,
  kind: "topic" | "data"
): void {
  if (expectedType.startsWith("Option<")) {
    if (val === null || val === undefined) return;
    const inner = expectedType.slice(7, -1);
    return validateField(val, inner, fieldName, eventId, eventName, kind);
  }

  if (expectedType.startsWith("Vec<")) {
    if (!Array.isArray(val)) {
      throw new DecodeError(
        `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected ${expectedType}, got ${typeof val}`,
        {
          code: "INVALID_TYPE",
          eventId,
          field: fieldName,
          expected: expectedType,
          actual: typeof val,
        }
      );
    }
    const inner = expectedType.slice(4, -1);
    if (inner === "Address") {
      for (let i = 0; i < val.length; i++) {
        if (!isStellarAddress(val[i])) {
          throw new DecodeError(
            `Event ${eventId} (${eventName}) ${kind} ${fieldName}[${i}] violates schema constraint: expected valid Stellar Address, got "${val[i]}"`,
            {
              code: "SCHEMA_VIOLATION",
              eventId,
              field: `${fieldName}[${i}]`,
              expected: "valid Stellar Address",
              actual: String(val[i]),
            }
          );
        }
      }
    } else if (inner === "u64") {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] !== "bigint" && typeof val[i] !== "number") {
          throw new DecodeError(
            `Event ${eventId} (${eventName}) ${kind} ${fieldName}[${i}] expected u64, got ${typeof val[i]}`,
            {
              code: "INVALID_TYPE",
              eventId,
              field: `${fieldName}[${i}]`,
              expected: "u64",
              actual: typeof val[i],
            }
          );
        }
        if (BigInt(val[i]) < 0n) {
          throw new DecodeError(
            `Event ${eventId} (${eventName}) ${kind} ${fieldName}[${i}] violates schema constraint: u64 cannot be negative`,
            {
              code: "SCHEMA_VIOLATION",
              eventId,
              field: `${fieldName}[${i}]`,
              expected: "non-negative integer",
              actual: String(val[i]),
            }
          );
        }
      }
    }
    return;
  }

  switch (expectedType) {
    case "Address": {
      if (typeof val !== "string") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected Address, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "Address",
            actual: typeof val,
          }
        );
      }
      if (!isStellarAddress(val)) {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} violates schema constraint: expected valid Stellar Address, got "${val}"`,
          {
            code: "SCHEMA_VIOLATION",
            eventId,
            field: fieldName,
            expected: "valid Stellar Address",
            actual: val,
          }
        );
      }
      break;
    }
    case "bool": {
      if (typeof val !== "boolean") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected bool, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "bool",
            actual: typeof val,
          }
        );
      }
      break;
    }
    case "u64": {
      if (typeof val !== "bigint" && typeof val !== "number") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected u64, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "u64",
            actual: typeof val,
          }
        );
      }
      if (BigInt(val) < 0n) {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} violates schema constraint: u64 cannot be negative, got ${val}`,
          {
            code: "SCHEMA_VIOLATION",
            eventId,
            field: fieldName,
            expected: "non-negative u64",
            actual: String(val),
          }
        );
      }
      break;
    }
    case "u32": {
      if (typeof val !== "number" && typeof val !== "bigint") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected u32, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "u32",
            actual: typeof val,
          }
        );
      }
      const numVal = Number(val);
      if (!Number.isInteger(numVal) || numVal < 0 || numVal > 0xffffffff) {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} violates schema constraint: expected u32 in range [0, 4294967295], got ${val}`,
          {
            code: "SCHEMA_VIOLATION",
            eventId,
            field: fieldName,
            expected: "u32 in range [0, 4294967295]",
            actual: String(val),
          }
        );
      }
      break;
    }
    case "i128": {
      if (typeof val !== "bigint" && typeof val !== "number") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected i128, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "i128",
            actual: typeof val,
          }
        );
      }
      break;
    }
    case "Symbol": {
      if (typeof val !== "string") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected Symbol, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "Symbol",
            actual: typeof val,
          }
        );
      }
      break;
    }
    case "BytesN<32>": {
      const isBufferOrUint8 =
        val instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(val));
      if (!isBufferOrUint8) {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected BytesN<32>, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: "BytesN<32>",
            actual: typeof val,
          }
        );
      }
      if ((val as Uint8Array).length !== 32) {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} violates schema constraint: expected 32 bytes, got ${(val as Uint8Array).length}`,
          {
            code: "SCHEMA_VIOLATION",
            eventId,
            field: fieldName,
            expected: "32 bytes",
            actual: `${(val as Uint8Array).length} bytes`,
          }
        );
      }
      break;
    }
    case "OwnershipRole": {
      if (val !== "Recipient" && val !== "Sender") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected OwnershipRole ("Recipient" | "Sender"), got ${JSON.stringify(val)}`,
          {
            code: "SCHEMA_VIOLATION",
            eventId,
            field: fieldName,
            expected: '"Recipient" | "Sender"',
            actual: String(val),
          }
        );
      }
      break;
    }
    default: {
      if (val === null || typeof val !== "object") {
        throw new DecodeError(
          `Event ${eventId} (${eventName}) ${kind} ${fieldName} expected ${expectedType}, got ${typeof val}`,
          {
            code: "INVALID_TYPE",
            eventId,
            field: fieldName,
            expected: expectedType,
            actual: typeof val,
          }
        );
      }
      break;
    }
  }
}

/**
 * Decode one RPC event. Registry-known events (schemas/events/) are validated
 * field-for-field against the generated shape table: the positional topic
 * layout must match the registry and every declared data field must be
 * present, so an event-shape drift fails loudly here instead of silently
 * corrupting indexed state.
 *
 * `streamId` is populated only when the registry declares a `stream_id` topic,
 * and is `null` otherwise — most events are not about a stream at all.
 *
 * `options.contractId` names the contract the registry governs. The registry is
 * the source of truth for *our* events, so when it is set, an event from any
 * other contract is decoded as raw data only: no registry shape is applied and
 * no positional value is relabelled as a stream id. Without it, an unrelated
 * contract that reuses the `stream_created` symbol would be indexed as ours —
 * which is the failure mode the registry exists to prevent.
 */
export interface DecodeOptions {
  contractId?: string;
}

export function decodeEvent(event: RpcEvent, options: DecodeOptions = {}): DecodedEvent {
  if (!event.topic || event.topic.length < 1) {
    throw new DecodeError(`Event ${event.id} has no topic`, {
      code: "MISSING_TOPIC",
      eventId: event.id,
    });
  }
  const topics = event.topic.map((t, i) => decodeScVal(t, event.id, `topic[${i}]`));
  const name = topics[0];
  if (typeof name !== "string") {
    throw new DecodeError(`Event ${event.id} has a non-symbol name topic`, {
      code: "INVALID_TOPIC",
      eventId: event.id,
      field: "topic[0]",
      expected: "symbol",
      actual: typeof name,
    });
  }
  const fromGovernedContract = options.contractId === undefined || event.contractId === options.contractId;

  if (fromGovernedContract && isContractEventName(name)) {
    const shape = EVENT_SHAPES[name];
    const positional = topics.slice(1);
    if (positional.length !== shape.topics.length) {
      throw new DecodeError(
        `Event ${event.id} (${name}) has ${positional.length} positional topic(s), registry declares ${shape.topics.length} — schema drift, check schemas/events/${name}.json`,
        {
          code: "INVALID_TOPIC",
          eventId: event.id,
          expected: `${shape.topics.length} positional topics`,
          actual: `${positional.length} positional topics`,
        }
      );
    }
    let streamId: string | null = null;
    shape.topics.forEach((field, i) => {
      validateField(positional[i], field.type, field.name, event.id, name, "topic");
      if (field.name === "stream_id") streamId = String(positional[i]);
    });
    const data = record(decodeScVal(event.value, event.id, "value"), event.id);
    const missing = shape.data.filter((f) => !(f.name in data)).map((f) => f.name);
    if (missing.length > 0) {
      throw new DecodeError(
        `Event ${event.id} (${name}) is missing registry data field(s): ${missing.join(", ")}`,
        {
          code: "SCHEMA_VIOLATION",
          eventId: event.id,
          field: missing.join(", "),
          expected: `presence of ${missing.join(", ")}`,
        }
      );
    }
    for (const field of shape.data) {
      validateField(data[field.name], field.type, field.name, event.id, name, "data");
    }
    return buildDecoded(event, name, streamId, data);
  }

  const data = record(decodeScVal(event.value, event.id, "value"), event.id);
  if (!fromGovernedContract) {
    // Foreign traffic: journalled under its own name with no stream claim.
    return buildDecoded(event, name, null, data);
  }
  if (topics.length < 2) {
    throw new DecodeError(`Event ${event.id} has no stream id topic`, {
      code: "UNKNOWN_TOPIC",
      eventId: event.id,
    });
  }
  const streamIdValue = topics[1];
  if (typeof streamIdValue !== "bigint" && typeof streamIdValue !== "number" && typeof streamIdValue !== "string") {
    throw new DecodeError(`Event ${event.id} has an unexpected topic shape`, {
      code: "INVALID_TOPIC",
      eventId: event.id,
      field: "topic[1]",
    });
  }
  // Pre-registry history: `[name, stream_id, …]` is the only shape this
  // fallback can mean, and it is reachable only for our own contract.
  return buildDecoded(event, name, String(streamIdValue), data);
}

function buildDecoded(
  event: RpcEvent,
  name: string,
  streamId: string | null,
  data: Record<string, EventValue>
): DecodedEvent {
  const rawTx = event.txHash ?? event.transactionHash;
  return {
    id: event.id,
    pagingToken: event.pagingToken ?? String(event.ledger),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    name,
    streamId,
    data,
    txHash: rawTx ? String(rawTx) : undefined,
  };
}
