import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { DecodedEvent, EventValue, RpcEvent } from "./types.js";

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

export function decodeEvent(event: RpcEvent): DecodedEvent {
  if (!event.topic || event.topic.length < 2) throw new Error(`Event ${event.id} has no stream id topic`);
  const [name, streamId] = event.topic.map((t) => decodeScVal(t));
  if (typeof name !== "string" || (typeof streamId !== "bigint" && typeof streamId !== "number" && typeof streamId !== "string")) {
    throw new Error(`Event ${event.id} has an unexpected topic shape`);
  }
  return {
    id: event.id,
    pagingToken: event.pagingToken ?? String(event.ledger),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    name,
    streamId: String(streamId),
    data: record(decodeScVal(event.value)),
  };
}
