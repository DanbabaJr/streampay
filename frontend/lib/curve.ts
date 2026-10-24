import { createHash } from "node:crypto";
import { computeAccruedAt } from "./accrual.ts";

export interface CurvePoint {
  timestamp: number;
  accrued: string;
}

export interface StreamData {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  withdrawn: bigint;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
  asOfLedger: number;
  asOfTimestamp: number;
}

export interface ValidatedQueryParams {
  id: string;
  from: number;
  to: number;
  step: number;
}

export interface AccrualCurveResponse {
  streamId: string;
  asOfLedger: number;
  asOfTimestamp: number;
  stateHash: string;
  params: {
    from: number;
    to: number;
    step: number;
    count: number;
  };
  points: CurvePoint[];
}

export const MAX_POINTS_LIMIT = 1000;
export const DEFAULT_LAG_THRESHOLD_SECONDS = 60;

export class ValidationError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, code = "INVALID_QUERY_PARAMS", statusCode = 400) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Validate query parameters: id, from, to, step.
 * Enforces from <= to, step > 0, and hard point limit.
 */
export function validateQueryParams(
  raw: {
    id?: string | null;
    from?: string | null;
    to?: string | null;
    step?: string | null;
  },
  maxPoints = MAX_POINTS_LIMIT
): ValidatedQueryParams {
  const { id, from, to, step } = raw;

  if (!id || typeof id !== "string" || !/^\d+$/.test(id.trim())) {
    throw new ValidationError(
      "Query parameter 'id' must be a valid positive integer stream ID.",
      "INVALID_STREAM_ID"
    );
  }

  if (from === undefined || from === null || from === "" || !/^-?\d+$/.test(from)) {
    throw new ValidationError(
      "Query parameter 'from' must be an integer Unix timestamp (in seconds).",
      "INVALID_FROM_PARAM"
    );
  }

  if (to === undefined || to === null || to === "" || !/^-?\d+$/.test(to)) {
    throw new ValidationError(
      "Query parameter 'to' must be an integer Unix timestamp (in seconds).",
      "INVALID_TO_PARAM"
    );
  }

  if (step === undefined || step === null || step === "" || !/^-?\d+$/.test(step)) {
    throw new ValidationError(
      "Query parameter 'step' must be an integer (in seconds).",
      "INVALID_STEP_PARAM"
    );
  }

  const fromNum = parseInt(from, 10);
  const toNum = parseInt(to, 10);
  const stepNum = parseInt(step, 10);

  if (fromNum < 0) {
    throw new ValidationError(
      "Query parameter 'from' must be a non-negative timestamp.",
      "NEGATIVE_FROM"
    );
  }

  if (toNum < 0) {
    throw new ValidationError(
      "Query parameter 'to' must be a non-negative timestamp.",
      "NEGATIVE_TO"
    );
  }

  if (stepNum <= 0) {
    throw new ValidationError(
      "Query parameter 'step' must be greater than zero.",
      "INVALID_STEP_POSITIVE"
    );
  }

  if (fromNum > toNum) {
    throw new ValidationError(
      `Query parameter 'from' (${fromNum}) must be less than or equal to 'to' (${toNum}).`,
      "FROM_GREATER_THAN_TO"
    );
  }

  const pointCount = Math.floor((toNum - fromNum) / stepNum) + 1;
  if (pointCount > maxPoints) {
    throw new ValidationError(
      `Requested range yields ${pointCount} points, which exceeds the maximum allowed limit of ${maxPoints} points. Increase step size or reduce range.`,
      "POINT_LIMIT_EXCEEDED"
    );
  }

  return {
    id: id.trim(),
    from: fromNum,
    to: toNum,
    step: stepNum,
  };
}

/**
 * Derives a cryptographic SHA-256 state hash for the stream as-of the indexed ledger.
 */
export function computeStateHash(stream: StreamData): string {
  const canonical = JSON.stringify({
    id: stream.id,
    token: stream.token,
    sender: stream.sender,
    recipient: stream.recipient,
    deposit: stream.deposit.toString(),
    withdrawn: stream.withdrawn.toString(),
    startTime: stream.startTime,
    endTime: stream.endTime,
    cancelable: stream.cancelable,
    status: stream.status,
    asOfLedger: stream.asOfLedger,
    asOfTimestamp: stream.asOfTimestamp,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Derives the ETag from the state hash and exact query parameters.
 * Identical state and parameters will produce the exact same ETag.
 */
export function computeETag(
  stateHash: string,
  params: ValidatedQueryParams
): string {
  const input = `${stateHash}:${params.id}:${params.from}:${params.to}:${params.step}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return `W/"${hash.substring(0, 32)}"`;
}

/**
 * Compares an incoming If-None-Match header against the computed ETag.
 * Supports weak matching and comma-separated/quoted values per RFC 9110.
 */
export function matchesIfNoneMatch(
  ifNoneMatchHeader: string | null | undefined,
  computedETag: string
): boolean {
  if (!ifNoneMatchHeader) return false;
  const targetTag = computedETag.replace(/^W\//, "").replace(/"/g, "").trim();

  const candidates = ifNoneMatchHeader.split(",").map((s) => s.trim());
  for (const candidate of candidates) {
    if (candidate === "*") return true;
    const cleanCandidate = candidate.replace(/^W\//, "").replace(/"/g, "").trim();
    if (cleanCandidate === targetTag) return true;
  }
  return false;
}

/**
 * Computes the accrual curve points on-the-fly using the pure accrual function.
 * Points are NEVER stored anywhere.
 */
export function computeCurve(
  stream: StreamData,
  params: ValidatedQueryParams
): CurvePoint[] {
  const { from, to, step } = params;
  const points: CurvePoint[] = [];

  for (let t = from; t <= to; t += step) {
    const accrued = computeAccruedAt(
      stream.deposit,
      stream.startTime,
      stream.endTime,
      BigInt(t)
    );
    points.push({
      timestamp: t,
      accrued: accrued.toString(),
    });
  }

  return points;
}
