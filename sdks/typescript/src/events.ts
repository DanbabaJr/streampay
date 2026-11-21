import { xdr } from "@stellar/stellar-sdk";
import { decodeStreamPayEvent, type StreamPayEvent } from "./generated.js";
import { decodeError } from "./errors.js";

/** Decodes one RPC `ContractEvent`; `null` for events from other contracts. */
export function decodeEvent(event: xdr.ContractEvent): StreamPayEvent | null {
  return decodeStreamPayEvent(event);
}

/** Decodes one base64 `ContractEvent` XDR (RPC `getEvents().valueXdr`). */
export function decodeEventXdr(base64: string): StreamPayEvent | null {
  try {
    return decodeEvent(xdr.ContractEvent.fromXDR(base64, "base64"));
  } catch (error) {
    throw decodeError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Decodes a batch of events, dropping foreign contracts. A malformed event
 * fails the batch instead of being silently skipped: indexers need to know
 * when their feed is corrupt.
 */
export function decodeEvents(base64: readonly string[]): StreamPayEvent[] {
  const decoded: StreamPayEvent[] = [];
  for (const encoded of base64) {
    const event = decodeEventXdr(encoded);
    if (event !== null) decoded.push(event);
  }
  return decoded;
}
