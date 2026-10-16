import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { DecodedEvent, EventValue, RpcEvent } from "./types.js";

function decodeScVal(encoded: string): EventValue {
  return scValToNative(xdr.ScVal.fromXDR(encoded, "base64")) as EventValue;
}

function record(value: EventValue): Record<string, EventValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Expected event data to decode to a map");
  }
  return value;
}

export function decodeEvent(event: RpcEvent): DecodedEvent {
  if (event.topic.length < 2) throw new Error(`Event ${event.id} has no stream id topic`);
  const [name, streamId] = event.topic.map(decodeScVal);
  if (typeof name !== "string" || typeof streamId !== "bigint" && typeof streamId !== "number") {
    throw new Error(`Event ${event.id} has an unexpected topic shape`);
  }
  return {
    id: event.id,
    pagingToken: event.pagingToken,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    name,
    streamId: String(streamId),
    data: record(decodeScVal(event.value)),
  };
}
