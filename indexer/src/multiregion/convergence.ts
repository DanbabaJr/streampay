import { createHash } from "node:crypto";
import { buildMerkleTree } from "../proof.js";
import { StreamStore } from "../store.js";
import type { DecodedEvent, EventValue, Stream } from "../types.js";

export const PROJECTION_LEAF_PREFIX = "STREAMPAY_PROJECTION_STREAM_V1\0";

export interface RegionProjection {
  regionId: string;
  streams: readonly Stream[];
  watermark: number;
}

export interface ConvergenceReport {
  converged: boolean;
  /** Per-region root over that region's projected streams. */
  roots: Record<string, string>;
  /** Stream ids whose projected rows differ between regions (sorted). */
  divergentStreams: string[];
  watermarks: Record<string, number>;
  /** Difference between the highest and lowest region watermark, in ledgers. */
  maxWatermarkSkew: number;
}

function compareStreamIds(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right) && left !== right) return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical JSON for a projected row. Field order is fixed here so two regions
 * that stored the same values in a different insertion order compare equal.
 */
export function canonicalProjection(stream: Stream): string {
  return JSON.stringify({
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
  });
}

export function streamFingerprint(stream: Stream): string {
  return createHash("sha256").update(PROJECTION_LEAF_PREFIX).update(canonicalProjection(stream)).digest("hex");
}

/** Merkle root over a region's projections, stream-id ordered. */
export function projectionRoot(streams: readonly Stream[]): string {
  const leaves = [...streams].sort((a, b) => compareStreamIds(a.streamId, b.streamId)).map(streamFingerprint);
  return buildMerkleTree(leaves).root;
}

/**
 * Compares the regions' projections. Two active-active regions converge when,
 * and only when, every stream row is identical: same values, same last ledger.
 * The report lists exactly which streams disagree, so a divergent region is
 * repairable rather than merely detectable.
 */
export function compareRegions(projections: readonly RegionProjection[]): ConvergenceReport {
  if (projections.length === 0) throw new RangeError("compareRegions needs at least one region");

  const roots: Record<string, string> = {};
  const watermarks: Record<string, number> = {};
  const byRegion = new Map<string, Map<string, string>>();
  const divergent = new Set<string>();

  for (const projection of projections) {
    roots[projection.regionId] = projectionRoot(projection.streams);
    watermarks[projection.regionId] = projection.watermark;
    byRegion.set(projection.regionId, new Map(projection.streams.map((stream) => [stream.streamId, streamFingerprint(stream)])));
  }

  const streamIds = new Set<string>();
  for (const regionStreams of byRegion.values()) for (const id of regionStreams.keys()) streamIds.add(id);

  const [first, ...rest] = [...byRegion.values()];
  for (const streamId of streamIds) {
    const reference = first.get(streamId);
    if (rest.some((regionStreams) => regionStreams.get(streamId) !== reference)) divergent.add(streamId);
  }

  const values = Object.values(watermarks);
  return {
    converged: divergent.size === 0,
    roots,
    divergentStreams: [...divergent].sort(compareStreamIds),
    watermarks,
    maxWatermarkSkew: Math.max(...values) - Math.min(...values),
  };
}

function rowToEvent(row: {
  id: string;
  stream_id: string | null;
  name: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string | null;
  payload: string;
}): DecodedEvent {
  let data: Record<string, EventValue>;
  try {
    data = JSON.parse(row.payload) as Record<string, EventValue>;
  } catch (err) {
    throw new Error(`journal payload for ${row.id} is not JSON: ${(err as Error).message}`);
  }
  return {
    id: row.id,
    pagingToken: row.id,
    ledger: Number(row.ledger),
    ledgerClosedAt: row.ledger_closed_at,
    contractId: "",
    name: row.name,
    streamId: row.stream_id,
    data,
    ...(row.tx_hash ? { txHash: row.tx_hash } : {}),
  };
}

/**
 * Folds every journalled event for a stream, in `(ledger, id)` order, into the
 * projection the store would hold had those events arrived exactly once and in
 * order. This is the deterministic reference state: it depends on the event set
 * only, never on the order each region happened to receive it in.
 */
export function foldStream(store: StreamStore, streamId: string): Stream | undefined {
  const rows = store.db
    .prepare(`SELECT id, stream_id, name, ledger, ledger_closed_at, tx_hash, payload
      FROM events WHERE stream_id = ? ORDER BY ledger ASC, id ASC`)
    .all(streamId) as Array<{
      id: string;
      stream_id: string | null;
      name: string;
      ledger: number;
      ledger_closed_at: string;
      tx_hash: string | null;
      payload: string;
    }>;
  if (rows.length === 0) return undefined;

  // A scratch store runs the exact projection the live path runs, so a fold can
  // never drift from ingestion semantics.
  const scratch = new StreamStore(":memory:");
  try {
    for (const row of rows) scratch.ingest(rowToEvent(row));
    return scratch.getStream(streamId);
  } finally {
    scratch.close();
  }
}

export type ReconcileOutcome = "in_sync" | "repaired" | "absent";

/**
 * Brings one stream's projection back to its journal fold. Regions diverge when
 * a late event was dropped by the monotonic guard before its predecessor
 * arrived; the event is still journalled, so the fold recovers it.
 */
export function reconcileStream(store: StreamStore, streamId: string): ReconcileOutcome {
  const folded = foldStream(store, streamId);
  if (!folded) return "absent";
  const current = store.getStream(streamId);
  if (current && streamFingerprint(current) === streamFingerprint(folded)) return "in_sync";
  return store.replaceProjection(folded) ? "repaired" : "in_sync";
}

/** Repairs every stream the journal knows about. Used after a region reconnects. */
export function reconcileRegion(store: StreamStore): { repaired: string[]; inSync: number; absent: number } {
  const ids = (store.db
    .prepare("SELECT DISTINCT stream_id FROM events WHERE stream_id IS NOT NULL ORDER BY stream_id ASC")
    .all() as Array<{ stream_id: string }>).map((row) => row.stream_id);
  const repaired: string[] = [];
  let inSync = 0;
  let absent = 0;
  for (const id of ids) {
    const outcome = reconcileStream(store, id);
    if (outcome === "repaired") repaired.push(id);
    else if (outcome === "in_sync") inSync += 1;
    else absent += 1;
  }
  return { repaired, inSync, absent };
}
