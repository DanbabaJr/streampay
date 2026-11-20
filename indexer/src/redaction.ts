/**
 * Shared privacy redaction for the indexer's read APIs (#487, #576, #579, #580).
 *
 * One file, used identically by the GraphQL read layer (#576), the gRPC
 * streaming transport (#579) and the WASM plugin filters (#580), so the
 * three transports redact identically and later merges do not conflict.
 *
 * When redaction is enabled, every Stellar address that leaves the indexer
 * is truncated to its 8-character prefix via `sanitizeAddress` (the same
 * rule `docs/PRIVACY.md` and `privacy.ts` enforce for telemetry). When
 * redaction is disabled the record is returned unchanged — that is the
 * current REST default, so existing clients see no behaviour change.
 *
 * The rule is applied here, once, by one shared recursive redactor
 * (`redactValue`): a full Stellar address is truncated wherever it appears,
 * at any depth, and a field whose key always names an address (see
 * `ADDRESS_KEYS`) is truncated the same way even when its value is a
 * short/partial address, so it never leaks more than its prefix.
 *
 * Ordering: redaction runs after WASM plugin transforms, never before —
 * a plugin receives the raw event, shapes it, and whatever it emits is
 * redacted on the way out, so a plugin can never un-redact a protected
 * field. See `PluginDispatcher.dispatch` (#580).
 */
import { sanitizeAddress, sanitizeWebhookUrl } from "./privacy.js";
import type { DecodedEvent, EventValue, Stream } from "./types.js";
import type { WebhookEndpoint } from "./webhooks/types.js";

export const STELLAR_ADDRESS_REGEX = /^[GCB][A-Z2-7]{55}$/;

/** Payload keys that always name an address, even if the value is short. */
export const ADDRESS_KEYS = new Set([
  "sender",
  "recipient",
  "token",
  "payer",
  "governor",
  "beneficiary",
  "sponsor",
  "cancelled_by",
  "changed_by",
  "executed_by",
  "proposed_by",
  "vetoed_by",
  "set_by",
  "new_owner",
  "previous_owner",
  "current_owner",
  "sender_from",
  "new_sender",
  "sender_to",
  "new_target",
  "previous_target",
  "proposed_admin",
  "new_admin",
  "current_admin",
  "admin",
  "publisher",
  "keeper",
]);

export function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ADDRESS_REGEX.test(value);
}

/**
 * Redact one value. With redaction off the value is returned unchanged.
 * With it on, a full Stellar address becomes its 8-character prefix
 * (`GBMOCK12...`); address-keyed fields are truncated the same way even
 * when the value is not a full StrKey, so a short/partial address never
 * leaks more than its prefix. Objects and arrays are redacted recursively.
 */
export function redactValue(value: unknown, enabled: boolean): unknown {
  if (!enabled) return value;
  if (typeof value === "string") {
    return isStellarAddress(value) ? sanitizeAddress(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, true));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (ADDRESS_KEYS.has(key) && typeof item === "string" && item.length > 8) {
        out[key] = sanitizeAddress(item);
      } else {
        out[key] = redactValue(item, true);
      }
    }
    return out;
  }
  return value;
}

/** Truncate one address when redaction is on; otherwise return it as-is. */
export function redactAddress(value: string | null | undefined, enabled: boolean): string | null | undefined {
  if (!enabled || value === null || value === undefined) return value;
  return sanitizeAddress(value);
}

/**
 * Redact a projected Stream row. Only address-valued fields are touched
 * (sender, recipient, refund_target, cancelled_by); amounts, ids, status
 * and timestamps pass through unchanged.
 */
export function redactStream(stream: Stream, enabled: boolean): Stream {
  if (!enabled) return stream;
  return {
    ...stream,
    sender: redactAddress(stream.sender, true) ?? null,
    recipient: redactAddress(stream.recipient, true) ?? null,
    refund_target:
      stream.refund_target === undefined
        ? undefined
        : redactAddress(stream.refund_target, true) ?? null,
    cancelled_by:
      stream.cancelled_by === undefined
        ? undefined
        : redactAddress(stream.cancelled_by, true) ?? null,
  };
}

/** A single row of `StreamStore.getStreamHistory`. */
export interface StreamHistoryRow {
  id: string;
  stream_id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  payload: unknown;
}

/** Recursively truncate Stellar addresses inside an event payload. */
export function redactEvent<T extends StreamHistoryRow>(event: T, enabled: boolean): T {
  if (!enabled) return event;
  return { ...event, payload: redactValue(event.payload, true) };
}

/**
 * Redact a webhook subscription for the GraphQL `WebhookSubscription` type.
 * The secret is never exposed by GraphQL at all (it is not in the schema);
 * the URL is masked to origin + `***` when redaction is on, exactly as
 * `sanitizeWebhookUrl` does for telemetry.
 */
export function redactWebhookEndpoint(
  endpoint: WebhookEndpoint,
  enabled: boolean
): { id: string; url: string; events: string[]; status: string; created_at: string; updated_at: string } {
  return {
    id: endpoint.id,
    url: enabled ? sanitizeWebhookUrl(endpoint.url) : endpoint.url,
    events: [...endpoint.events],
    status: endpoint.status,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at,
  };
}

/** Redact an event payload; a no-op (same shape, same values) when off. */
export function redactPayload(
  payload: Record<string, unknown>,
  enabled: boolean
): Record<string, unknown> {
  if (!enabled) return payload;
  return redactValue(payload, true) as Record<string, unknown>;
}

/** True when redacting `payload` changes at least one value. */
export function payloadWasRedacted(payload: Record<string, unknown>): boolean {
  const redacted = redactPayload(payload, true);
  return JSON.stringify(redacted) !== JSON.stringify(payload);
}

/**
 * Redact Stellar addresses inside an event payload. Returns the input
 * unchanged (same reference) when `enabled` is false.
 */
export function redactEventData(
  data: Record<string, EventValue>,
  enabled: boolean,
): Record<string, EventValue> {
  if (!enabled) return data;
  return redactValue(data, true) as Record<string, EventValue>;
}

/**
 * Redact a whole decoded event's payload. Envelope fields are untouched —
 * `contractId` is a public contract address, not a protected wallet — only
 * `data` is walked. Returns the input event unchanged when disabled.
 */
export function redactDecodedEvent(event: DecodedEvent, enabled: boolean): DecodedEvent {
  if (!enabled) return event;
  return { ...event, data: redactEventData(event.data, true) };
}
