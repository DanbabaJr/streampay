import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { StreamStore } from "../store.js";
import type { DecodedEvent, EventValue, Stream } from "../types.js";
import { redactDecodedEvent } from "../redaction.js";
import { buildMerkleTree } from "../proof.js";
import { compareStreamIds } from "../sharding/sharded-store.js";
import { ReplayCheckpointStore, type ReplayCheckpoint } from "./checkpoint.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  defaultUpcasterRegistry,
  type UpcasterRegistry,
} from "./upcasters.js";

export const REPLAY_STATE_LEAF_PREFIX = "STREAMPAY_REPLAY_STATE_LEAF_V1\0";
export const DEFAULT_REPLAY_RANGE_SIZE = 1_000;

/** A journal row, before upcasting. `payload` is whatever the journal stored. */
export interface ReplayEventRow {
  id: string;
  streamId: string | null;
  name: string;
  ledger: number;
  ledgerClosedAt: string;
  payload: unknown;
  schemaVersion?: number;
  txHash?: string | null;
}

export interface ReplaySource {
  /** Rows with `fromLedger <= ledger <= toLedger`, ordered by ledger then id. */
  readRange(fromLedger: number, toLedger: number): ReplayEventRow[];
}

/** Malformed or truncated journal data: replay refuses rather than guessing. */
export class ReplayFixtureError extends Error {
  constructor(readonly eventId: string, readonly reason: string) {
    super(`replay fixture ${eventId} is unusable: ${reason}`);
    this.name = "ReplayFixtureError";
  }
}

export interface ReplayRunOptions {
  /** Checkpoint key; one job per contract/projection. */
  job: string;
  contractId: string;
  fromLedger: number;
  toLedger: number;
  /** Ledgers per replay range. Ranges are the unit of parallelism and checkpointing. */
  rangeSize?: number;
  /** Ranges prepared concurrently. Application stays ledger-ordered. */
  concurrency?: number;
  /** Redact addresses exactly as the live read paths do. */
  redact?: boolean;
  /** Header written to the checkpoint, so a test can pin "today". */
  now?: () => string;
  registry?: UpcasterRegistry;
  /** Called after a range has been applied and checkpointed. Throwing aborts the run. */
  onRangeApplied?: (report: ReplayRangeReport) => void;
}

export interface ReplayRangeReport {
  fromLedger: number;
  toLedger: number;
  events: number;
  duplicates: number;
  /** Events whose payload crossed at least one upcaster step. */
  upcast: number;
  /** Cumulative Merkle root of the projected state after this range. */
  stateRoot: string;
}

export interface ReplayResult {
  job: string;
  fromLedger: number;
  toLedger: number;
  /** Watermark the run resumed from, `null` for a fresh replay. */
  resumedFrom: number | null;
  ranges: ReplayRangeReport[];
  events: number;
  upcast: number;
  skippedRanges: number;
  stateRoot: string;
}

interface ReplayRange {
  fromLedger: number;
  toLedger: number;
}

interface PreparedRange {
  range: ReplayRange;
  events: DecodedEvent[];
  upcast: number;
}

function sha256Hex(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/**
 * Canonical JSON for a projected stream. Field order is fixed here rather than
 * inherited from object insertion order, so two runs that project the same
 * state hash identically regardless of which component built the row.
 */
export function canonicalStreamState(stream: Stream): string {
  const ordered: Record<string, string | number | boolean | null> = {
    streamId: stream.streamId,
    sender: stream.sender ?? null,
    recipient: stream.recipient ?? null,
    token: stream.token ?? null,
    deposit: stream.deposit ?? null,
    withdrawn: stream.withdrawn,
    startTime: stream.startTime ?? null,
    endTime: stream.endTime ?? null,
    cancelable: stream.cancelable ?? null,
    status: stream.status,
    cancelled_by: stream.cancelled_by ?? null,
    recipient_amount: stream.recipient_amount ?? null,
    sender_amount: stream.sender_amount ?? null,
    refund_target: stream.refund_target ?? null,
    lastLedger: stream.lastLedger,
    updatedAt: stream.updatedAt,
  };
  return JSON.stringify(ordered);
}

/**
 * Merkle root over the projected state: one domain-separated leaf per stream,
 * ordered by stream id and folded with the same tree builder the checkpoint /
 * light-client proofs use. Same streams in, same root out — on any machine.
 */
export function computeReplayStateRoot(streams: readonly Stream[]): string {
  const leaves = [...streams]
    .sort((a, b) => compareStreamIds(a.streamId, b.streamId))
    .map((stream) => sha256Hex([REPLAY_STATE_LEAF_PREFIX, canonicalStreamState(stream)]));
  return buildMerkleTree(leaves).root;
}

function assertFiniteLedger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer ledger (got ${value})`);
  }
}

/** Splits `[fromLedger, toLedger]` into inclusive, ascending, disjoint ranges. */
export function planReplayRanges(fromLedger: number, toLedger: number, rangeSize: number): ReplayRange[] {
  assertFiniteLedger(fromLedger, "fromLedger");
  assertFiniteLedger(toLedger, "toLedger");
  if (!Number.isSafeInteger(rangeSize) || rangeSize < 1) {
    throw new RangeError(`rangeSize must be a positive integer (got ${rangeSize})`);
  }
  if (toLedger < fromLedger) return [];
  const ranges: ReplayRange[] = [];
  for (let start = fromLedger; start <= toLedger; start += rangeSize) {
    ranges.push({ fromLedger: start, toLedger: Math.min(toLedger, start + rangeSize - 1) });
  }
  return ranges;
}

/**
 * Replays a journal range into a projection, deterministically:
 *
 *   read range -> upcast to the current schema -> redact -> project
 *
 * Ranges are read and upcast concurrently, but applied in ascending ledger
 * order, so events for one stream always reach the projection in the order the
 * chain emitted them. Progress is checkpointed per range with the Merkle root it
 * produced, which makes a run resumable (`watermark`) and its result verifiable
 * (`stateRoot`).
 *
 * Fail-closed: an unknown/missing upcaster, a payload from a future schema, or
 * malformed journal data aborts the run before the affected range is applied or
 * checkpointed, so a partial run never looks like a completed one.
 */
export class ReplayEngine {
  readonly checkpoints: ReplayCheckpointStore;

  constructor(
    private readonly store: StreamStore,
    private readonly source: ReplaySource,
  ) {
    this.checkpoints = new ReplayCheckpointStore(store.db);
  }

  /** The durable progress for a job, without running it. */
  checkpoint(job: string): ReplayCheckpoint | undefined {
    return this.checkpoints.get(job);
  }

  async run(options: ReplayRunOptions): Promise<ReplayResult> {
    const {
      job,
      contractId,
      fromLedger,
      toLedger,
      rangeSize = DEFAULT_REPLAY_RANGE_SIZE,
      concurrency = 1,
      redact = true,
      registry = defaultUpcasterRegistry,
      now = () => new Date().toISOString(),
    } = options;

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`concurrency must be a positive integer (got ${concurrency})`);
    }

    const allRanges = planReplayRanges(fromLedger, toLedger, rangeSize);
    const checkpoint = this.checkpoints.get(job);
    const watermark = checkpoint?.watermark ?? null;
    const pending = watermark === null
      ? allRanges
      : allRanges.filter((range) => range.toLedger > watermark);
    const skippedRanges = allRanges.length - pending.length;

    const reports: ReplayRangeReport[] = [];
    const prepared = new Map<number, Promise<PreparedRange>>();
    let started = 0;

    const startNext = (): void => {
      if (started >= pending.length) return;
      const index = started++;
      prepared.set(
        index,
        this.prepareRange(pending[index], contractId, registry, redact),
      );
    };
    for (let i = 0; i < Math.min(concurrency, pending.length); i++) startNext();

    for (let index = 0; index < pending.length; index++) {
      const range = pending[index];
      const outcome = await prepared.get(index)!;
      prepared.delete(index);
      const report = this.applyRange(range, outcome);
      this.checkpoints.record(job, range.toLedger, report.stateRoot, now());
      reports.push(report);
      options.onRangeApplied?.(report);
      startNext();
    }

    const last = reports[reports.length - 1];
    const stateRoot = last?.stateRoot
      ?? checkpoint?.stateRoot
      ?? computeReplayStateRoot(this.store.listAllStreams());

    return {
      job,
      fromLedger,
      toLedger,
      resumedFrom: pending.length === allRanges.length ? null : watermark,
      ranges: reports,
      events: reports.reduce((sum, report) => sum + report.events, 0),
      upcast: reports.reduce((sum, report) => sum + report.upcast, 0),
      skippedRanges,
      stateRoot,
    };
  }

  /** Reads and upcasts one range. Touches no shared state, so ranges run in parallel. */
  private async prepareRange(
    range: ReplayRange,
    contractId: string,
    registry: UpcasterRegistry,
    redact: boolean,
  ): Promise<PreparedRange> {
    const rows = this.source.readRange(range.fromLedger, range.toLedger);
    const events: DecodedEvent[] = [];
    let upcast = 0;

    for (const row of rows) {
      const data = this.readPayload(row);
      const version = row.schemaVersion ?? CURRENT_EVENT_SCHEMA_VERSION;
      const result = registry.upcast(row.name, version, data);
      if (result.version !== version) upcast += 1;

      const event: DecodedEvent = {
        id: row.id,
        pagingToken: row.id,
        ledger: row.ledger,
        ledgerClosedAt: row.ledgerClosedAt,
        contractId,
        name: row.name,
        streamId: row.streamId,
        data: result.data,
        ...(row.txHash ? { txHash: row.txHash } : {}),
      };
      events.push(redactDecodedEvent(event, redact));
    }

    return { range, events, upcast };
  }

  /** Rejects truncated or structurally wrong payloads instead of projecting them. */
  private readPayload(row: ReplayEventRow): Record<string, EventValue> {
    if (!Number.isSafeInteger(row.ledger) || row.ledger < 0) {
      throw new ReplayFixtureError(row.id, `invalid ledger ${row.ledger}`);
    }
    const payload = row.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ReplayFixtureError(row.id, `payload is ${payload === null ? "null" : Array.isArray(payload) ? "an array" : typeof payload}, expected an object`);
    }
    return payload as Record<string, EventValue>;
  }

  /** Applies one prepared range in ledger order and hashes the resulting state. */
  private applyRange(range: ReplayRange, prepared: PreparedRange): ReplayRangeReport {
    let duplicates = 0;
    for (const event of prepared.events) {
      // Idempotent: a range replayed after a crash re-reports its rows as
      // duplicates instead of re-projecting them.
      if (this.store.projectEvent(event).duplicate) duplicates += 1;
    }
    return {
      fromLedger: range.fromLedger,
      toLedger: range.toLedger,
      events: prepared.events.length - duplicates,
      duplicates,
      upcast: prepared.upcast,
      stateRoot: computeReplayStateRoot(this.store.listAllStreams()),
    };
  }
}

/** Journal-backed source: reads committed rows straight out of the indexer DB. */
export class SqliteReplaySource implements ReplaySource {
  private readonly hasSchemaVersion: boolean;

  constructor(private readonly db: Database.Database) {
    const columns = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    this.hasSchemaVersion = columns.some((column) => column.name === "schema_version");
  }

  readRange(fromLedger: number, toLedger: number): ReplayEventRow[] {
    const versionColumn = this.hasSchemaVersion ? ", schema_version" : "";
    const rows = this.db
      .prepare(`SELECT id, stream_id, name, ledger, ledger_closed_at, tx_hash, payload${versionColumn}
        FROM events WHERE ledger >= ? AND ledger <= ? ORDER BY ledger ASC, id ASC`)
      .all(fromLedger, toLedger) as Array<{
        id: string;
        stream_id: string | null;
        name: string;
        ledger: number;
        ledger_closed_at: string;
        tx_hash: string | null;
        payload: string;
        schema_version?: number | null;
      }>;

    return rows.map((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch (err) {
        throw new ReplayFixtureError(row.id, `payload is not JSON (${(err as Error).message})`);
      }
      return {
        id: row.id,
        streamId: row.stream_id,
        name: row.name,
        ledger: Number(row.ledger),
        ledgerClosedAt: row.ledger_closed_at,
        payload,
        ...(row.schema_version === undefined || row.schema_version === null
          ? {}
          : { schemaVersion: Number(row.schema_version) }),
        txHash: row.tx_hash,
      };
    });
  }
}

/** Fixture-backed source: the pinned historical corpus the CI gate replays. */
export class ArrayReplaySource implements ReplaySource {
  private readonly rows: ReplayEventRow[];

  constructor(rows: readonly ReplayEventRow[]) {
    this.rows = [...rows];
  }

  readRange(fromLedger: number, toLedger: number): ReplayEventRow[] {
    return this.rows
      .filter((row) => row.ledger >= fromLedger && row.ledger <= toLedger)
      .sort((a, b) => (a.ledger === b.ledger ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.ledger - b.ledger));
  }
}
