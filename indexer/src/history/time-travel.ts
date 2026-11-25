/**
 * Time-travel / as-of historical state queries (issue #577).
 *
 * The indexer is event-sourced: the `events` journal is the truth and the
 * `streams` table is a fold of it. This module folds the journal *up to a
 * ledger* instead of up to the tip, so a caller can ask "what did stream 7
 * look like at ledger 1200?" and get the exact record the projection held
 * then — plus a proof that the record is the one the journal implies:
 *
 *   - every journal event at or below the ledger is committed to by a
 *     domain-separated leaf hash, folded into a Merkle `eventRoot` with the
 *     same tree builder the checkpoint / light-client proofs use
 *     (`proof.ts: buildMerkleTree`);
 *   - the reconstructed record is committed to by a state leaf over the
 *     canonical stream encoding the replay engine hashes
 *     (`replay/engine.ts: canonicalStreamState`), folded into a `stateRoot`;
 *   - the proof carries a digest of the committed event registry
 *     (`generated/events.ts: EVENT_FINGERPRINTS`, issue #213), so a proof
 *     minted against a stale registry fails verification instead of passing
 *     silently — the freshness gate the issue asks for.
 *
 * `verifyAsOfProof` is the client-side verifier: it re-folds the events,
 * re-hashes the record and checks every inclusion step against the roots.
 * It needs nothing but this module's pure functions and the response body.
 *
 * Bounds, so a historical read can never be silently wrong or unbounded:
 *   - retention window: a ledger older than `tip - retentionWindowLedgers`,
 *     or older than the first journalled ledger, is expired history and
 *     fails with `history_expired` — never a partial reconstruction;
 *   - cost budget: a query is charged one unit per journal event it must
 *     fold; exceeding `maxCostUnits` fails with `cost_budget_exceeded`;
 *   - a ledger ahead of the tip fails with `as_of_in_future`.
 *
 * Redaction: the service layer applies the shared privacy redaction
 * (`redaction.ts`, the same path the GraphQL/gRPC/WASM reads use) to the
 * record and event payloads it returns when redaction is enabled. Proof
 * leaf hashes always commit to the canonical, unredacted journal; a
 * redacted response is flagged `proof.redacted` and the verifier then
 * checks inclusion against the roots without re-hashing payloads it was
 * deliberately not shown.
 *
 * Cursor: the response `cursor` is the id of the last journal event at or
 * below the ledger — the same stable event-id cursor `getEventsAfter`
 * resumes from, so a client can continue a live read where an as-of read
 * stopped.
 */
import { createHash } from "node:crypto";

import { EVENT_FINGERPRINTS, EVENT_KEYS } from "../generated/events.js";
import { buildMerkleTree, hashMerkleNode, type MerkleStep } from "../proof.js";
import { redactEventData, redactStream } from "../redaction.js";
import { canonicalStreamState } from "../replay/engine.js";
import type { StreamStore } from "../store.js";
import type { EventValue, Stream } from "../types.js";

export const HISTORY_EVENT_LEAF_PREFIX = "STREAMPAY_HISTORY_EVENT_LEAF_V1\0";
export const HISTORY_STATE_LEAF_PREFIX = "STREAMPAY_HISTORY_STATE_LEAF_V1\0";

/** Version of the as-of proof schema; tied to the registry digest below. */
export const AS_OF_PROOF_SCHEMA_VERSION = 1;

/** ~57 days of 5-second ledgers. Deployments override via policy/env. */
export const DEFAULT_RETENTION_WINDOW_LEDGERS = 1_000_000;
/** One cost unit per journal event folded; a single-stream history is small. */
export const DEFAULT_MAX_COST_UNITS = 1_000;

export type TimeTravelErrorCode =
  | "history_expired"
  | "cost_budget_exceeded"
  | "as_of_in_future"
  | "invalid_ledger";

/** A bounded-query failure with a machine-readable `code` for the API layer. */
export class TimeTravelError extends Error {
  constructor(
    readonly code: TimeTravelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TimeTravelError";
  }
}

export interface TimeTravelPolicy {
  /** How far behind the tip a query may reach, in ledgers. */
  retentionWindowLedgers: number;
  /** Maximum cost units (journal events folded) one query may spend. */
  maxCostUnits: number;
  /** Cost charged per journal event folded. Defaults to 1. */
  costPerEvent?: number;
}

export const DEFAULT_TIME_TRAVEL_POLICY: TimeTravelPolicy = {
  retentionWindowLedgers: DEFAULT_RETENTION_WINDOW_LEDGERS,
  maxCostUnits: DEFAULT_MAX_COST_UNITS,
  costPerEvent: 1,
};

/** One journal row, in the shape `StreamStore.getStreamHistory` returns. */
export interface HistoricalEvent {
  id: string;
  streamId: string;
  name: string;
  ledger: number;
  ledgerClosedAt: string;
  data: Record<string, EventValue>;
}

export interface HistoricalEventProof {
  id: string;
  ledger: number;
  name: string;
  leafHash: string;
  proof: MerkleStep[];
}

export interface AsOfProof {
  schemaVersion: number;
  /** Digest of the event registry this proof was minted against (#213). */
  registryDigest: string;
  ledger: number;
  eventCount: number;
  eventRoot: string;
  stateRoot: string;
  stateLeafHash: string;
  stateProof: MerkleStep[];
  events: HistoricalEventProof[];
  /** True when the response record/payloads were privacy-redacted. */
  redacted: boolean;
}

export interface AsOfStreamResult {
  ledger: number;
  stream: Stream;
  events: HistoricalEvent[];
  /** Stable event-id cursor: the last event folded, for `getEventsAfter`. */
  cursor: string | null;
  costUnits: number;
  proof: AsOfProof;
}

export interface AsOfPortfolioResult {
  ledger: number;
  address: string;
  streams: AsOfStreamResult[];
  costUnits: number;
}

/**
 * Digest of the committed event registry (#213): the sorted struct names and
 * their schema fingerprints, hashed once. Any registry drift — a renamed
 * event, a changed field, a new fingerprint — changes this digest, and a
 * proof carrying the old one no longer verifies against the new registry.
 */
export function eventRegistryDigest(): string {
  const canonical = Object.keys(EVENT_FINGERPRINTS)
    .sort()
    .map((struct) => `${struct}:${EVENT_FINGERPRINTS[struct]}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/** JSON with recursively sorted keys and bigints as strings: one byte shape per value. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256Hex(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/** Domain-separated leaf committing to one journal event, exactly as journalled. */
export function computeHistoricalEventLeaf(event: HistoricalEvent): string {
  return sha256Hex([
    HISTORY_EVENT_LEAF_PREFIX,
    canonicalJson({
      id: event.id,
      streamId: event.streamId,
      name: event.name,
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      data: event.data,
    }),
  ]);
}

/** Domain-separated leaf committing to a reconstructed stream record. */
export function computeHistoricalStateLeaf(stream: Stream): string {
  return sha256Hex([HISTORY_STATE_LEAF_PREFIX, canonicalStreamState(stream)]);
}

/** Folds Merkle inclusion steps from a leaf; returns the implied root. */
export function foldMerkleProof(leafHash: string, steps: readonly MerkleStep[]): string {
  let node = leafHash;
  for (const step of steps) {
    node = step.position === "left" ? hashMerkleNode(step.hash, node) : hashMerkleNode(node, step.hash);
  }
  return node;
}

function get(data: Record<string, EventValue>, key: string): string | null {
  const value = data[key];
  return value === undefined || value === null ? null : String(value);
}

/**
 * Re-folds one stream's journal events into the record the live projection
 * held after the last of them — the same patches, in the same order, with
 * the same defaults as `StreamStore`'s projection switch. Events the
 * projection ignores are journalled but change no record, exactly as in
 * the store. Returns `undefined` when no projecting event exists at or
 * below the ledger (the stream did not exist yet, as far as the journal
 * can prove).
 */
export function reconstructStream(
  events: readonly HistoricalEvent[],
  streamId: string,
  asOfLedger: number,
): Stream | undefined {
  const ordered = events
    .filter((event) => event.streamId === streamId && event.ledger <= asOfLedger)
    .sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let current: Stream | undefined;
  for (const event of ordered) {
    const d = event.data;
    const patch: Partial<Stream> = { lastLedger: event.ledger, updatedAt: event.ledgerClosedAt };
    switch (event.name) {
      case EVENT_KEYS.StreamCreated:
        Object.assign(patch, {
          sender: get(d, "sender"),
          recipient: get(d, "recipient"),
          token: get(d, "token"),
          deposit: get(d, "deposit"),
          startTime: get(d, "start_time"),
          endTime: get(d, "end_time"),
          cancelable: Boolean(d.cancelable),
          status: "active",
          withdrawn: "0",
        });
        break;
      case EVENT_KEYS.Withdrawn:
        patch.withdrawn = get(d, "withdrawn_total") ?? current?.withdrawn ?? "0";
        break;
      case EVENT_KEYS.StreamToppedUp:
        patch.deposit = get(d, "new_deposit") ?? current?.deposit ?? null;
        break;
      case EVENT_KEYS.StreamCancelled: {
        patch.status = "cancelled";
        patch.cancelled_by = get(d, "cancelled_by") ?? current?.cancelled_by ?? null;
        patch.recipient_amount = get(d, "recipient_amount") ?? current?.recipient_amount ?? null;
        patch.sender_amount = get(d, "sender_amount") ?? current?.sender_amount ?? null;
        if (patch.recipient_amount) {
          const prevWithdrawn = BigInt(current?.withdrawn ?? "0");
          patch.withdrawn = (prevWithdrawn + BigInt(patch.recipient_amount)).toString();
        }
        break;
      }
      case EVENT_KEYS.StreamPaused:
        patch.status = "paused";
        break;
      case EVENT_KEYS.StreamResumed:
        patch.status = "active";
        break;
      case EVENT_KEYS.StreamRefundTargetChanged:
        patch.refund_target = get(d, "new_target");
        break;
      default:
        // Journalled, but the projection ignores it — no record change.
        continue;
    }
    const base: Stream = current ?? {
      streamId,
      sender: null,
      recipient: null,
      token: null,
      deposit: null,
      withdrawn: "0",
      startTime: null,
      endTime: null,
      cancelable: null,
      status: "active",
      lastLedger: event.ledger,
      updatedAt: event.ledgerClosedAt,
    };
    current = {
      ...base,
      sender: patch.sender ?? base.sender,
      recipient: patch.recipient ?? base.recipient,
      token: patch.token ?? base.token,
      deposit: patch.deposit ?? base.deposit,
      withdrawn: patch.withdrawn ?? base.withdrawn,
      startTime: patch.startTime ?? base.startTime,
      endTime: patch.endTime ?? base.endTime,
      cancelable: patch.cancelable === undefined ? base.cancelable : patch.cancelable,
      status: patch.status ?? base.status,
      cancelled_by: patch.cancelled_by ?? base.cancelled_by,
      recipient_amount: patch.recipient_amount ?? base.recipient_amount,
      sender_amount: patch.sender_amount ?? base.sender_amount,
      refund_target: patch.refund_target ?? base.refund_target,
      lastLedger: event.ledger,
      updatedAt: event.ledgerClosedAt,
    };
    current.id = streamId;
  }
  return current;
}

export interface AsOfQueryContext {
  /** Highest ledger the indexer has seen (the tip the window is measured from). */
  tipLedger: number;
  /** First ledger present in the journal; older history may have been pruned. */
  journalFloorLedger?: number;
  policy?: Partial<TimeTravelPolicy>;
  /** Apply the shared privacy redaction to the returned record/payloads. */
  redact?: boolean;
}

function resolvePolicy(partial?: Partial<TimeTravelPolicy>): TimeTravelPolicy {
  const policy = { ...DEFAULT_TIME_TRAVEL_POLICY, ...partial };
  if (!Number.isSafeInteger(policy.retentionWindowLedgers) || policy.retentionWindowLedgers < 0) {
    throw new RangeError(`retentionWindowLedgers must be a non-negative integer (got ${policy.retentionWindowLedgers})`);
  }
  if (!Number.isSafeInteger(policy.maxCostUnits) || policy.maxCostUnits < 1) {
    throw new RangeError(`maxCostUnits must be a positive integer (got ${policy.maxCostUnits})`);
  }
  return policy;
}

function assertAsOfWithinBounds(asOfLedger: number, context: AsOfQueryContext, policy: TimeTravelPolicy): void {
  if (!Number.isSafeInteger(asOfLedger) || asOfLedger < 0) {
    throw new TimeTravelError("invalid_ledger", `ledger must be a non-negative integer (got ${asOfLedger})`);
  }
  if (asOfLedger > context.tipLedger) {
    throw new TimeTravelError(
      "as_of_in_future",
      `ledger ${asOfLedger} is ahead of the indexed tip ${context.tipLedger}; the state at that ledger is not known yet`,
    );
  }
  const retentionFloor = context.tipLedger - policy.retentionWindowLedgers;
  const journalFloor = context.journalFloorLedger ?? 0;
  const earliestAvailable = Math.max(retentionFloor, journalFloor);
  if (asOfLedger < earliestAvailable) {
    throw new TimeTravelError(
      "history_expired",
      `ledger ${asOfLedger} is outside the retained history window; earliest available ledger is ${earliestAvailable} ` +
        `(retention window ${policy.retentionWindowLedgers} ledgers behind tip ${context.tipLedger}, journal floor ${journalFloor})`,
    );
  }
}

/**
 * Answers one stream's as-of query over an in-memory journal slice.
 * Returns `undefined` when the stream has no projected state at that
 * ledger. Throws `TimeTravelError` for expired / future / over-budget
 * queries — never a silently partial reconstruction.
 */
export function queryStreamAsOf(
  journal: readonly HistoricalEvent[],
  streamId: string,
  asOfLedger: number,
  context: AsOfQueryContext,
): AsOfStreamResult | undefined {
  const policy = resolvePolicy(context.policy);
  assertAsOfWithinBounds(asOfLedger, context, policy);

  const events = journal
    .filter((event) => event.streamId === streamId && event.ledger <= asOfLedger)
    .sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const costUnits = events.length * (policy.costPerEvent ?? 1);
  if (costUnits > policy.maxCostUnits) {
    throw new TimeTravelError(
      "cost_budget_exceeded",
      `as-of query for stream ${streamId} at ledger ${asOfLedger} costs ${costUnits} units ` +
        `(${events.length} journal events) over a budget of ${policy.maxCostUnits}`,
    );
  }

  const stream = reconstructStream(events, streamId, asOfLedger);
  if (!stream) return undefined;

  const leaves = events.map((event) => computeHistoricalEventLeaf(event));
  const eventTree = buildMerkleTree(leaves);
  const stateLeafHash = computeHistoricalStateLeaf(stream);
  const stateTree = buildMerkleTree([stateLeafHash]);

  const proof: AsOfProof = {
    schemaVersion: AS_OF_PROOF_SCHEMA_VERSION,
    registryDigest: eventRegistryDigest(),
    ledger: asOfLedger,
    eventCount: events.length,
    eventRoot: eventTree.root,
    stateRoot: stateTree.root,
    stateLeafHash,
    stateProof: stateTree.getProof(0),
    events: events.map((event, index) => ({
      id: event.id,
      ledger: event.ledger,
      name: event.name,
      leafHash: leaves[index],
      proof: eventTree.getProof(index),
    })),
    redacted: false,
  };

  return {
    ledger: asOfLedger,
    stream,
    events,
    cursor: events.length > 0 ? events[events.length - 1].id : null,
    costUnits,
    proof,
  };
}

/**
 * Client-side verifier for an as-of response. Recomputes everything a
 * client can recompute from the body alone:
 *   - the proof schema and registry digest are current (freshness gate);
 *   - the proof's ledger is the queried ledger, and no event exceeds it;
 *   - every event inclusion step folds to the event root, and the state
 *     inclusion step folds to the state root;
 *   - unless the response was redacted, every leaf re-hashes from the
 *     payload shown, and re-folding the events reproduces the record
 *     exactly — a tampered record, a swapped event or a wrong-ledger
 *     answer all fail here.
 */
export function verifyAsOfProof(result: AsOfStreamResult, expectedLedger?: number): boolean {
  try {
    const { proof } = result;
    if (proof.schemaVersion !== AS_OF_PROOF_SCHEMA_VERSION) return false;
    if (proof.registryDigest !== eventRegistryDigest()) return false;
    if (proof.ledger !== result.ledger) return false;
    if (expectedLedger !== undefined && result.ledger !== expectedLedger) return false;
    if (result.stream.lastLedger > result.ledger) return false;
    if (proof.eventCount !== result.events.length || proof.events.length !== result.events.length) return false;

    for (let i = 0; i < result.events.length; i++) {
      const event = result.events[i];
      const committed = proof.events[i];
      if (event.ledger > result.ledger) return false;
      if (committed.id !== event.id || committed.ledger !== event.ledger || committed.name !== event.name) return false;
      if (i > 0 && event.ledger < result.events[i - 1].ledger) return false;
      if (foldMerkleProof(committed.leafHash, committed.proof) !== proof.eventRoot) return false;
      if (!proof.redacted && computeHistoricalEventLeaf(event) !== committed.leafHash) return false;
    }
    if (foldMerkleProof(proof.stateLeafHash, proof.stateProof) !== proof.stateRoot) return false;

    if (!proof.redacted) {
      if (computeHistoricalStateLeaf(result.stream) !== proof.stateLeafHash) return false;
      const refolded = reconstructStream(result.events, result.stream.streamId, result.ledger);
      if (!refolded || canonicalStreamState(refolded) !== canonicalStreamState(result.stream)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Store-backed service: the HTTP layer's entry point. Reads the bounded
 * journal slice from SQLite (never a full-chain rescan — the journal *is*
 * the retained history, indexed by `(stream_id, ledger)`), enforces the
 * policy bounds, and applies shared redaction on the way out when asked.
 */
export class TimeTravelService {
  private readonly policy: TimeTravelPolicy;

  constructor(
    private readonly store: StreamStore,
    policy?: Partial<TimeTravelPolicy>,
  ) {
    this.policy = resolvePolicy(policy);
  }

  private context(): AsOfQueryContext {
    const tip = this.store.getState("lastLedger");
    return {
      tipLedger: tip === undefined ? 0 : Number(tip),
      journalFloorLedger: this.store.journalFloorLedger(),
      policy: this.policy,
    };
  }

  getStreamAsOf(streamId: string, asOfLedger: number, options?: { redact?: boolean }): AsOfStreamResult | undefined {
    const rows = this.store.getStreamEventsUpTo(streamId, asOfLedger);
    const journal: HistoricalEvent[] = rows.map((row) => ({
      id: row.id,
      streamId: row.stream_id,
      name: row.event_type,
      ledger: row.ledger,
      ledgerClosedAt: row.ledger_closed_at,
      data: row.payload as Record<string, EventValue>,
    }));
    const result = queryStreamAsOf(journal, streamId, asOfLedger, this.context());
    if (!result || !options?.redact) return result;
    return this.redactResult(result);
  }

  private redactResult(result: AsOfStreamResult): AsOfStreamResult {
    return {
      ...result,
      stream: redactStream(result.stream, true),
      events: result.events.map((event) => ({ ...event, data: redactEventData(event.data, true) })),
      proof: { ...result.proof, redacted: true },
    };
  }

  /**
   * Every stream an address held at the ledger: the candidate set comes
   * from the current projection (sender/recipient are never re-assigned by
   * a projecting event, so today's portfolio is the historical candidate
   * set), each candidate is reconstructed as-of the ledger, and only the
   * ones where the address actually held that role *then* are returned.
   * The shared cost budget applies across the whole portfolio.
   */
  getPortfolioAsOf(address: string, asOfLedger: number, options?: { redact?: boolean }): AsOfPortfolioResult {
    const context = this.context();
    assertAsOfWithinBounds(asOfLedger, context, this.policy);
    const candidates = this.store.listAddress(address);
    const streams: AsOfStreamResult[] = [];
    let spent = 0;
    for (const candidate of candidates) {
      // Filter on the canonical record, before any redaction truncates the
      // very addresses the filter compares against.
      const result = this.getStreamAsOf(candidate.streamId, asOfLedger);
      if (!result) continue;
      spent += result.costUnits;
      if (spent > this.policy.maxCostUnits) {
        throw new TimeTravelError(
          "cost_budget_exceeded",
          `as-of portfolio query for ${address} at ledger ${asOfLedger} exceeds the budget of ` +
            `${this.policy.maxCostUnits} cost units (spent ${spent} across ${streams.length + 1} streams)`,
        );
      }
      if (result.stream.sender === address || result.stream.recipient === address) {
        streams.push(options?.redact ? this.redactResult(result) : result);
      }
    }
    return { ledger: asOfLedger, address, streams, costUnits: spent };
  }
}
