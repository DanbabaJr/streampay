import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { DecodedEvent, EventValue, RpcEvent } from "./types.js";
import { EVENT_SHAPES, isContractEventName } from "./generated/events.js";

function decodeScVal(encoded: unknown): EventValue {
  if (typeof encoded === "string") {
    return scValToNative(xdr.ScVal.fromXDR(encoded, "base64")) as EventValue;
  }
  if (typeof encoded === "object" && encoded !== null && "xdr" in encoded && typeof (encoded as { xdr: string }).xdr === "string") {
    return scValToNative(xdr.ScVal.fromXDR((encoded as { xdr: string }).xdr, "base64")) as EventValue;
  }
  return scValToNative(encoded as Parameters<typeof scValToNative>[0]) as EventValue;
}

function record(value: EventValue): Record<string, EventValue> {
  if (value instanceof Map) {
    const obj: Record<string, EventValue> = {};
    for (const [k, v] of value.entries()) {
      obj[String(k)] = v as EventValue;
    }
    return obj;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Expected event data to decode to a map");
  }
  return value as Record<string, EventValue>;
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
  if (!event.topic || event.topic.length < 1) throw new Error(`Event ${event.id} has no topic`);
  const topics = event.topic.map((t) => decodeScVal(t));
  const name = topics[0];
  if (typeof name !== "string") {
    throw new Error(`Event ${event.id} has a non-symbol name topic`);
  }
  const fromGovernedContract = options.contractId === undefined || event.contractId === options.contractId;

  if (fromGovernedContract && isContractEventName(name)) {
    const shape = EVENT_SHAPES[name];
    const positional = topics.slice(1);
    if (positional.length !== shape.topics.length) {
      throw new Error(
        `Event ${event.id} (${name}) has ${positional.length} positional topic(s), registry declares ${shape.topics.length} — schema drift, check schemas/events/${name}.json`
      );
    }
    let streamId: string | null = null;
    shape.topics.forEach((field, i) => {
      if (field.name === "stream_id") streamId = String(positional[i]);
    });
    const data = record(decodeScVal(event.value));
    const missing = shape.data.filter((f) => !(f.name in data)).map((f) => f.name);
    if (missing.length > 0) {
      throw new Error(`Event ${event.id} (${name}) is missing registry data field(s): ${missing.join(", ")}`);
    }
    return buildDecoded(event, name, streamId, data);
  }

  const data = record(decodeScVal(event.value));
  if (!fromGovernedContract) {
    // Foreign traffic: journalled under its own name with no stream claim.
    return buildDecoded(event, name, null, data);
  }
  if (topics.length < 2) throw new Error(`Event ${event.id} has no stream id topic`);
  const streamIdValue = topics[1];
  if (typeof streamIdValue !== "bigint" && typeof streamIdValue !== "number" && typeof streamIdValue !== "string") {
    throw new Error(`Event ${event.id} has an unexpected topic shape`);
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
