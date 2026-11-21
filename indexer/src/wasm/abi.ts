/**
 * Sandboxed WASM plugin filters for per-subscription transforms (issue #580).
 *
 * Pure transform ABI (version 1)
 * ===============================
 *
 * A plugin is a WebAssembly module with **no imports** (see `validate.ts`).
 * It must export:
 *
 *   - `memory` — a `WebAssembly.Memory` with at least 1 page, and a declared
 *     maximum no larger than {@link MAX_MEMORY_PAGES} pages.
 *   - `transform(inputPtr: i32, inputLen: i32) -> i32` — the transform.
 *
 * Memory layout (one 64 KiB page is the minimum; the layout fits in it):
 *
 *   - Input: the host writes the UTF-8 JSON of the full event (a
 *     `DecodedEvent`, with `bigint` values serialised as decimal strings, the
 *     same convention `StreamStore` uses for its journal) at
 *     {@link INPUT_OFFSET}, `inputLen` bytes long.
 *   - Output: the plugin writes its UTF-8 JSON reply at
 *     {@link OUTPUT_OFFSET} and returns its length in bytes.
 *   - Scratch / plugin data segments live above {@link OUTPUT_OFFSET} +
 *     {@link MAX_OUTPUT_BYTES}; the example/test plugin builders place
 *     constant data at {@link PLUGIN_DATA_OFFSET}.
 *
 * Return value of `transform`:
 *
 *   - `>= 0` — the length in bytes of the JSON reply at `OUTPUT_OFFSET`.
 *   - `-1` (`DROP`) — drop the event for this subscription.
 *   - Any other negative value, or a length larger than
 *     {@link MAX_OUTPUT_BYTES} — a host error; the invocation falls back.
 *
 * Reply shape. The reply must be a JSON object. It is interpreted as the
 * transformed *event*:
 *
 *   - If it has a `data` key whose value is an object, that object becomes
 *     the event's new `data`.
 *   - Any other top-level key that is not one of the known envelope keys
 *     (`id`, `pagingToken`, `ledger`, `ledgerClosedAt`, `contractId`, `name`,
 *     `streamId`, `txHash`, `traceId`, `spanId`, `linkedSpanContext`) is
 *     merged into `data` — this is how a plugin enriches an event, e.g. by
 *     appending `,"enriched":true` to the input JSON.
 *   - If there is no `data` key, the whole reply object minus envelope keys
 *     is the new `data`.
 *   - Envelope fields are **always** taken from the input event. A plugin
 *     cannot rewrite an event's id, ledger, name or stream id, so a
 *     transformed event can never be mistaken for a different journal entry.
 *
 * What a plugin cannot do. With no imports it has no host functions to call:
 * no I/O, no network, no clock, no randomness, no state outside its own
 * linear memory. It sees only the one event it is given, and its only
 * observable effect is the reply (or a drop). Determinism follows: the same
 * input bytes + the same plugin digest always produce the same reply, because
 * the module has no other input.
 *
 * Resource bounds ("fuel"). V8's WebAssembly engine exposes no instruction
 * fuel counter, so fuel is enforced as a proxy, documented here and in
 * `indexer/README.md`:
 *
 *   - wall-clock budget per invocation (`DEFAULT_TIMEOUT_MS`, enforced by
 *     running the transform in a `node:worker_threads` worker and
 *     terminating the worker on expiry — an infinite loop cannot stall
 *     ingestion);
 *   - memory cap (`MAX_MEMORY_PAGES`, enforced at validation time from the
 *     module's declared memory maximum — a module that declares no maximum,
 *     or one above the cap, is rejected before it ever runs);
 *   - input/output size caps (`MAX_INPUT_BYTES` / `MAX_OUTPUT_BYTES`).
 */
import { createHash } from "node:crypto";

/** Offset in linear memory where the host writes the input JSON. */
export const INPUT_OFFSET = 0;
/** Offset in linear memory where the plugin writes its JSON reply. */
export const OUTPUT_OFFSET = 32768;
/** Offset where plugin builders place constant data (reply templates, needles). */
export const PLUGIN_DATA_OFFSET = 60000;
/** Maximum input JSON size in bytes (fits in one page below OUTPUT_OFFSET). */
export const MAX_INPUT_BYTES = 32768;
/** Maximum reply JSON size in bytes. */
export const MAX_OUTPUT_BYTES = 32768;
/** Maximum WASM module size in bytes (a plugin is small by design). */
export const MAX_PLUGIN_BYTES = 1 << 20;
/** Maximum linear-memory size a plugin may declare, in 64 KiB pages. */
export const MAX_MEMORY_PAGES = 4;
/** One WASM memory page, in bytes. */
export const PAGE_BYTES = 65536;
/** Return value of `transform` meaning "drop this event". */
export const DROP = -1;
/** Default per-invocation wall-clock budget, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 500;
/** Hard ceiling for a caller-supplied per-invocation wall-clock budget. */
export const MAX_TIMEOUT_MS = 5000;

/** Envelope keys of a serialised `DecodedEvent`; never taken from a plugin. */
export const ENVELOPE_KEYS = new Set([
  "id",
  "pagingToken",
  "ledger",
  "ledgerClosedAt",
  "contractId",
  "name",
  "streamId",
  "txHash",
  "traceId",
  "spanId",
  "linkedSpanContext",
]);

/** Per-invocation resource limits. Every field is optional; defaults apply. */
export interface PluginLimits {
  /** Wall-clock budget per invocation in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Memory cap in pages (default {@link MAX_MEMORY_PAGES}). */
  maxMemoryPages?: number;
  /** Max input JSON bytes (default {@link MAX_INPUT_BYTES}). */
  maxInputBytes?: number;
  /** Max reply JSON bytes (default {@link MAX_OUTPUT_BYTES}). */
  maxOutputBytes?: number;
  /** Max module bytes (default {@link MAX_PLUGIN_BYTES}). */
  maxPluginBytes?: number;
}

/** Limits with every field filled in. */
export function resolveLimits(limits: PluginLimits = {}): Required<PluginLimits> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return {
    timeoutMs,
    maxMemoryPages: limits.maxMemoryPages ?? MAX_MEMORY_PAGES,
    maxInputBytes: limits.maxInputBytes ?? MAX_INPUT_BYTES,
    maxOutputBytes: limits.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    maxPluginBytes: limits.maxPluginBytes ?? MAX_PLUGIN_BYTES,
  };
}

/**
 * Content address of a plugin: the lowercase hex SHA-256 of the exact WASM
 * bytes. The digest *is* the plugin id — the same bytes always register
 * under the same id, and different bytes can never collide with it.
 */
export function pluginDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** JSON serialisation of an event, matching the store journal convention. */
export function eventToJson(event: unknown): string {
  return JSON.stringify(event, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
