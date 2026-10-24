/**
 * The one signed-intent queue for the whole client.
 *
 * A *signed intent* is an already-signed-but-unsubmitted transaction held in
 * client storage until it is worth submitting. Two features need exactly this
 * primitive:
 *
 *   - the fee-aware claim scheduler (#121) — hold a `withdraw_max` until fees
 *     drop; and
 *   - the PWA offline pending queue (#48) — hold any action taken while
 *     offline until connectivity returns.
 *
 * They must share one mechanism: a second queue would double-count intents,
 * diverge on crash recovery, and fight over the same wallet sequence number.
 * So this module is deliberately generic — intents are namespaced by `kind`
 * and scoped by `scope` (usually `<network>:<address>`), and each feature
 * stores its own payload shape under a discriminated `kind`.
 *
 * Persistence is `localStorage` (guarded for SSR), keyed by scope so ids from
 * one network or wallet never leak into another. Writes are whole-list
 * replacements: the queues here are small (a handful of intents), and
 * read-modify-write keeps recovery trivial.
 */

/** Storage key version — bump to invalidate older on-disk shapes. */
export const QUEUE_KEY_PREFIX = "streampay:pending-queue:v1:";

/** One queued intent. `kind` discriminates the payload for its owner. */
export interface QueuedIntent<T> {
  /** Stable id, unique within a scope. */
  id: string;
  /** Owner tag, e.g. `"claim"` (scheduler) or `"offline"` (#48). */
  kind: string;
  /** Owner namespace, conventionally `<network>:<address>`. */
  scope: string;
  /** Unix seconds the intent was first queued. */
  createdAt: number;
  /** Unix seconds of the last write. */
  updatedAt: number;
  /** Owner-defined intent body. */
  payload: T;
}

export function queueKey(scope: string): string {
  return QUEUE_KEY_PREFIX + scope;
}

/** All intents in a scope, oldest first. Never throws. */
export function loadQueue<T>(scope: string): QueuedIntent<T>[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(queueKey(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueuedIntent<T> =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as QueuedIntent<T>).id === "string" &&
        typeof (item as QueuedIntent<T>).kind === "string"
    );
  } catch {
    return [];
  }
}

/** Replaces the whole queue for a scope. Never throws. */
export function saveQueue<T>(scope: string, intents: readonly QueuedIntent<T>[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(queueKey(scope), JSON.stringify(intents));
  } catch {
    // Quota / private-mode failures are non-fatal: the in-memory scheduler
    // state keeps working for this session.
  }
}

/**
 * Inserts or replaces an intent by id (most-recent-write wins). Returns the
 * new queue. Intents are kept insertion-ordered.
 */
export function upsertIntent<T>(
  scope: string,
  intent: QueuedIntent<T>
): QueuedIntent<T>[] {
  const queue = loadQueue<T>(scope);
  const index = queue.findIndex((item) => item.id === intent.id);
  const next =
    index === -1
      ? [...queue, intent]
      : queue.map((item) => (item.id === intent.id ? intent : item));
  saveQueue(scope, next);
  return next;
}

/** Removes an intent by id. Returns the new queue. */
export function removeIntent<T>(scope: string, id: string): QueuedIntent<T>[] {
  const next = loadQueue<T>(scope).filter((item) => item.id !== id);
  saveQueue(scope, next);
  return next;
}

/** A collision-resistant intent id, with a non-crypto fallback. */
export function newIntentId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
