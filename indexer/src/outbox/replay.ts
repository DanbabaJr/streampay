import type { OutboxDispatcher } from "./dispatcher.js";
import type { OutboxStore } from "./store.js";
import type { OutboxIntent } from "./types.js";

export interface DeadLetterFilter {
  /** Only dead intents for this consumer. */
  consumerId?: string;
  /** Only dead intents whose event id is in this list. */
  eventIds?: string[];
  /** Only dead intents with these ids. */
  intentIds?: number[];
  /** Only dead intents with this dead_reason (e.g. `max_attempts`). */
  reason?: string;
  /** Maximum entries to select (default 100). */
  limit?: number;
}

export interface DeadLetterEntry {
  intent_id: number;
  consumer_id: string;
  event_id: string;
  idempotency_key: string;
  name: string;
  stream_id: string | null;
  attempts: number;
  dead_reason: string | null;
  last_error: string | null;
}

export type ReplayOutcome = "delivered" | "pending" | "dead" | "skipped";

export interface ReplayResult extends DeadLetterEntry {
  outcome: ReplayOutcome;
}

export interface ReplaySummary {
  mode: "dry-run" | "execute";
  /** Dead-letter entries selected by the filter. */
  selected: number;
  /** Entries actually reset to pending (always 0 in dry-run). */
  replayed: number;
  delivered: number;
  /** Replayed but not (yet) delivered: scheduled for retry. */
  pending: number;
  /** Replayed and dead-lettered again. */
  dead: number;
  /** Selected but no longer dead when replay ran (lost a race / already replayed). */
  skipped: number;
  destinations: string[];
  event_ids: string[];
  entries: ReplayResult[];
}

/** Hard ceiling so a typo cannot select an unbounded slice of the DLQ. */
export const REPLAY_MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function toEntry(i: OutboxIntent): DeadLetterEntry {
  return {
    intent_id: i.id,
    consumer_id: i.consumer_id,
    event_id: i.event_id,
    idempotency_key: i.idempotency_key,
    name: i.name,
    stream_id: i.stream_id,
    attempts: i.attempts,
    dead_reason: i.dead_reason,
    last_error: i.last_error,
  };
}

/** Lists dead-lettered intents matching the filter, oldest first. Read-only. */
export function listDeadLetters(store: OutboxStore, filter: DeadLetterFilter = {}): DeadLetterEntry[] {
  const limit = Math.min(REPLAY_MAX_LIMIT, Math.max(1, filter.limit ?? DEFAULT_LIMIT));
  const eventIds = filter.eventIds && filter.eventIds.length > 0 ? new Set(filter.eventIds) : null;
  const intentIds = filter.intentIds && filter.intentIds.length > 0 ? new Set(filter.intentIds) : null;
  const out: DeadLetterEntry[] = [];

  // Page through the DLQ (ordered by intent id) so post-filters on event id /
  // reason cannot be starved by the SQL LIMIT.
  const pageSize = REPLAY_MAX_LIMIT;
  let seen = 0;
  for (;;) {
    const page = store.listIntents({ state: "dead", consumerId: filter.consumerId, limit: pageSize + seen });
    const fresh = page.slice(seen);
    for (const intent of fresh) {
      if (eventIds && !eventIds.has(intent.event_id)) continue;
      if (intentIds && !intentIds.has(intent.id)) continue;
      if (filter.reason && intent.dead_reason !== filter.reason) continue;
      out.push(toEntry(intent));
      if (out.length >= limit) return out;
    }
    if (fresh.length < pageSize) return out;
    seen += fresh.length;
  }
}

function summarise(
  mode: ReplaySummary["mode"],
  entries: ReplayResult[],
  replayed: number
): ReplaySummary {
  const count = (o: ReplayOutcome) => entries.filter((e) => e.outcome === o).length;
  return {
    mode,
    selected: entries.length,
    replayed,
    delivered: count("delivered"),
    pending: count("pending"),
    dead: count("dead"),
    skipped: count("skipped"),
    destinations: [...new Set(entries.map((e) => e.consumer_id))].sort(),
    event_ids: [...new Set(entries.map((e) => e.event_id))],
    entries,
  };
}

export interface ReplayOptions {
  filter?: DeadLetterFilter;
  /** Dry-run is the default; replay only happens when this is true. */
  execute?: boolean;
  /** Required when `execute` is true; used to re-dispatch through the normal path. */
  dispatcher?: OutboxDispatcher;
}

/**
 * Operator dead-letter replay.
 *
 * - Dry-run (default): selects and reports; writes nothing.
 * - Execute: each selected intent goes dead → pending via the guarded
 *   `replayIntent` transition (fresh retry budget), then the normal
 *   `OutboxDispatcher` re-dispatches it. Idempotency keys, claim guards,
 *   backoff and metrics are therefore exactly the regular dispatch path.
 *
 * Replay is idempotent: a delivered intent is no longer `dead`, so selecting
 * it again yields nothing, and a stale selection resets nothing.
 */
export async function replayDeadLetters(store: OutboxStore, opts: ReplayOptions = {}): Promise<ReplaySummary> {
  const selected = listDeadLetters(store, opts.filter);
  if (!opts.execute) {
    return summarise("dry-run", selected.map((e) => ({ ...e, outcome: "pending" as const })), 0);
  }
  if (!opts.dispatcher) throw new Error("replayDeadLetters: execute mode requires a dispatcher");

  const reset = new Set<number>();
  for (const entry of selected) {
    if (store.replayIntent(entry.intent_id, { resetAttempts: true })) reset.add(entry.intent_id);
  }
  if (reset.size > 0) await opts.dispatcher.drainAll();

  const results: ReplayResult[] = selected.map((entry) => {
    if (!reset.has(entry.intent_id)) return { ...entry, outcome: "skipped" as const };
    const state = store.getIntent(entry.intent_id)?.state;
    const outcome: ReplayOutcome =
      state === "delivered" ? "delivered" : state === "dead" ? "dead" : "pending";
    return { ...entry, outcome };
  });
  return summarise("execute", results, reset.size);
}

/** Human-readable report for the CLI. */
export function formatReplaySummary(s: ReplaySummary): string {
  const lines: string[] = [];
  lines.push(
    s.mode === "dry-run"
      ? `DRY RUN — nothing was changed. ${s.selected} dead-letter entr${s.selected === 1 ? "y" : "ies"} would be re-dispatched.`
      : `REPLAY — ${s.replayed} of ${s.selected} selected entr${s.selected === 1 ? "y" : "ies"} re-dispatched.`
  );
  lines.push(`destinations: ${s.destinations.length > 0 ? s.destinations.join(", ") : "(none)"}`);
  lines.push(`event ids:    ${s.event_ids.length > 0 ? s.event_ids.join(", ") : "(none)"}`);
  if (s.mode === "execute") {
    lines.push(
      `outcome:      delivered=${s.delivered} pending-retry=${s.pending} dead-again=${s.dead} skipped=${s.skipped}`
    );
  }
  for (const e of s.entries) {
    const tail = s.mode === "execute" ? ` -> ${e.outcome}` : "";
    lines.push(
      `  #${e.intent_id} ${e.consumer_id} ${e.event_id} (${e.name}) reason=${e.dead_reason ?? "-"} attempts=${e.attempts}${tail}`
    );
  }
  if (s.mode === "dry-run" && s.selected > 0) lines.push("Re-run with --execute to replay these entries.");
  return lines.join("\n");
}
