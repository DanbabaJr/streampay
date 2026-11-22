/**
 * Opt-in retry policy for mutating calls.
 *
 * The policy only ever retries failures that are clearly transient (the
 * request never produced an answer: network errors, timeouts, 408/429/5xx,
 * or the RPC's own `TRY_AGAIN_LATER`). Everything else surfaces on the first
 * attempt. Once a transaction may have reached the network it is never
 * rebuilt or re-signed: a retry resends the byte-identical signed envelope,
 * whose hash doubles as the idempotency key, so the network can include it at
 * most once (see the client for the submission state machine).
 *
 * Backoff mirrors the frontend's RPC budget manager
 * (`frontend/lib/budget-manager.ts`): exponential growth, a hard cap, and a
 * server-provided `Retry-After` is honoured rather than undercut.
 */
import { StreamPayError } from "./errors.js";

/** Where in the pipeline a retry happened. */
export type RetryStage = "account" | "simulation" | "submission" | "inclusion";

export interface RetryAttemptInfo {
  stage: RetryStage;
  /** The attempt that just failed, starting at 1. */
  attempt: number;
  /** How long the client waits before the next attempt. */
  delayMs: number;
  error: unknown;
}

export interface SubmitRetryPolicy {
  /** Total attempts per stage, including the first. Default 3. */
  maxAttempts?: number;
  /** Delay ceiling for the first retry. Default 250 ms. */
  baseDelayMs?: number;
  /** Upper bound for any single delay. Default 5000 ms. */
  maxDelayMs?: number;
  /** Growth factor between retries. Default 2. */
  multiplier?: number;
  /**
   * `full` (default) picks a uniform delay in `[0, ceiling]` so concurrent
   * clients do not retry in lockstep; `none` always waits the full ceiling.
   */
  jitter?: "full" | "none";
  /** Observability hook, called before every wait. */
  onRetry?: (info: RetryAttemptInfo) => void;
}

/** Fully-resolved policy. `maxAttempts: 1` means "no retries". */
export interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: "full" | "none";
  onRetry?: (info: RetryAttemptInfo) => void;
}

/** Retries disabled: exactly the pre-policy behaviour. */
export const NO_RETRY: ResolvedRetryPolicy = Object.freeze({
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  multiplier: 1,
  jitter: "none" as const,
});

export const DEFAULT_RETRY_POLICY: Readonly<Required<Omit<SubmitRetryPolicy, "onRetry">>> =
  Object.freeze({
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
    multiplier: 2,
    jitter: "full" as const,
  });

/** Clock seam so tests can drive time without real timers. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Uniform in [0, 1). */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/** Validates and fills in a user policy. `undefined`/`false` disables retries. */
export function resolveRetryPolicy(
  policy: SubmitRetryPolicy | boolean | undefined
): ResolvedRetryPolicy {
  if (policy === undefined || policy === false) return NO_RETRY;
  const input: SubmitRetryPolicy = policy === true ? {} : policy;
  const resolved: ResolvedRetryPolicy = {
    maxAttempts: input.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: input.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: input.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    multiplier: input.multiplier ?? DEFAULT_RETRY_POLICY.multiplier,
    jitter: input.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
  if (input.onRetry !== undefined) resolved.onRetry = input.onRetry;
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new RangeError("retry.maxAttempts must be an integer >= 1");
  }
  if (!(resolved.baseDelayMs >= 0) || !(resolved.maxDelayMs >= resolved.baseDelayMs)) {
    throw new RangeError("retry delays must satisfy 0 <= baseDelayMs <= maxDelayMs");
  }
  if (!(resolved.multiplier >= 1)) {
    throw new RangeError("retry.multiplier must be >= 1");
  }
  return resolved;
}

/** The un-jittered ceiling for the wait after failed attempt `attempt` (1-based). */
export function backoffCeiling(policy: ResolvedRetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * policy.multiplier ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

/**
 * Delay before the next attempt. Always within `[0, maxDelayMs]`; a server
 * `Retry-After` raises the floor (still capped at `maxDelayMs`) so the client
 * never retries sooner than the node asked.
 */
export function backoffDelay(
  policy: ResolvedRetryPolicy,
  attempt: number,
  random: () => number,
  retryAfterMs?: number
): number {
  const ceiling = backoffCeiling(policy, attempt);
  const jittered =
    policy.jitter === "full" ? Math.floor(clampUnit(random()) * (ceiling + 1)) : ceiling;
  const floor = retryAfterMs === undefined ? 0 : Math.min(policy.maxDelayMs, retryAfterMs);
  return Math.min(policy.maxDelayMs, Math.max(jittered, floor));
}

function clampUnit(value: number): number {
  if (!(value >= 0)) return 0;
  return value >= 1 ? 1 - Number.EPSILON : value;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_NETWORK",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/**
 * True only for failures where the request clearly did not get an answer:
 * transport errors, timeouts, 408/429/5xx. Typed SDK errors, contract errors,
 * 4xx responses and anything unrecognised are permanent.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof StreamPayError) return false;
  if (typeof error !== "object" || error === null) return false;
  const status = httpStatusOf(error);
  if (status !== undefined) return TRANSIENT_STATUS.has(status);
  const record = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === "string" && TRANSIENT_CODES.has(record.code)) return true;
  if (record.name === "TimeoutError") return true;
  const message = typeof record.message === "string" ? record.message : "";
  // stellar-sdk's fetch and axios clients both report timeouts this way.
  if (/^timeout of \d+ms exceeded$/.test(message)) return true;
  // Node's fetch wraps socket failures as `TypeError: fetch failed`.
  if (record.name === "TypeError" && message === "fetch failed") return true;
  if (record.cause !== undefined && record.cause !== error) return isTransientError(record.cause);
  return false;
}

function httpStatusOf(error: object): number | undefined {
  const record = error as { response?: { status?: unknown }; status?: unknown };
  const status = record.response?.status ?? record.status;
  return typeof status === "number" ? status : undefined;
}

/** `Retry-After` from an HTTP error, in milliseconds (delta-seconds or HTTP date). */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as { response?: { headers?: unknown } }).response?.headers;
  const raw = readHeader(headers, "retry-after");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
    }
  }
  return undefined;
}

/**
 * Runs `operation`, retrying transient failures per `policy`. With retries
 * disabled the operation runs once and its error is rethrown untouched. When
 * attempts run out, the last error is rethrown unchanged.
 */
export async function withRetry<T>(
  stage: RetryStage,
  policy: ResolvedRetryPolicy,
  clock: Clock,
  operation: (attempt: number) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= policy.maxAttempts || !isTransientError(error)) throw error;
      await pause(stage, policy, clock, attempt, error);
    }
  }
}

/** Waits out the backoff after failed attempt `attempt`, reporting it first. */
export async function pause(
  stage: RetryStage,
  policy: ResolvedRetryPolicy,
  clock: Clock,
  attempt: number,
  error: unknown
): Promise<void> {
  const delayMs = backoffDelay(policy, attempt, clock.random, retryAfterMs(error, clock.now()));
  policy.onRetry?.({ stage, attempt, delayMs, error });
  await clock.sleep(delayMs);
}
