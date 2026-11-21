/**
 * Decoded, canonical StreamPay stream state.
 *
 * Watch mode compares this projection — never raw RPC responses. RPC replies
 * carry per-call noise (latest ledger, simulation metadata), and the contract
 * stores no wall-clock fields, so only the `get_stream` fields below can
 * change because of an on-chain state transition.
 */

export type NetworkLabel = "testnet" | "mainnet";
export type StreamCommand = "status" | "get";

export interface StreamState {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
}

const STATE_KEYS = [
  "id",
  "sender",
  "recipient",
  "token",
  "deposit",
  "withdrawn",
  "startTime",
  "endTime",
  "cancelable",
  "status",
] as const;

function asAmount(value: unknown, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return value;
  throw new Error(`get_stream returned an invalid ${field}`);
}

function asAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`get_stream returned an invalid ${field}`);
  }
  return value;
}

function asTimestamp(value: unknown, field: string): number {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`get_stream returned an invalid ${field}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`get_stream returned a ${field} outside the safe integer range`);
  }
  return parsed;
}

/**
 * `scValToNative` renders a unit enum variant as its name (e.g. "Active").
 * Accept that directly, and normalise other plausible enum encodings so a
 * malformed decode fails on the field type rather than silently stringifying
 * an object.
 */
function asStatus(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record.tag ?? record.name ?? record.variant;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw new Error("get_stream returned an invalid status");
}

/** Projects a decoded `get_stream` value into stable, schema-friendly state. */
export function decodeStreamState(value: unknown): StreamState {
  if (!value || typeof value !== "object") {
    throw new Error("get_stream returned no stream state");
  }
  const raw = value as Record<string, unknown>;
  return {
    id: asAmount(raw.id, "id"),
    sender: asAddress(raw.sender, "sender"),
    recipient: asAddress(raw.recipient, "recipient"),
    token: asAddress(raw.token, "token"),
    deposit: asAmount(raw.deposit, "deposit"),
    withdrawn: asAmount(raw.withdrawn, "withdrawn"),
    startTime: asTimestamp(raw.start_time, "start_time"),
    endTime: asTimestamp(raw.end_time, "end_time"),
    cancelable: Boolean(raw.cancelable),
    status: asStatus(raw.status),
  };
}

/**
 * Stable comparison key for change detection. Field order is fixed by
 * `STATE_KEYS`; any extra RPC fields (latest ledger, timestamps, cost, ...)
 * are not part of the projection and therefore cannot trigger an emission.
 */
export function canonicalStreamState(state: StreamState): string {
  return JSON.stringify(STATE_KEYS.map((key) => state[key]));
}

export function streamStatesEqual(left: StreamState, right: StreamState): boolean {
  return canonicalStreamState(left) === canonicalStreamState(right);
}
