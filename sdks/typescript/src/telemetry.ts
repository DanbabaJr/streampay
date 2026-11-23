import { StreamPayError } from "./errors.js";

/**
 * Opt-in, redacted usage telemetry (#595).
 *
 * Off by default. Nothing leaves the process until a host enables it (the
 * frontend consent flow, #515, is what flips it), and what leaves is a fixed
 * allowlist of non-identifying fields: schema version, SDK name/version, event
 * kind, SDK method name, outcome, a latency bucket and an error code. Amounts,
 * addresses, keys, XDR, payloads and free-form messages have no field to travel
 * in, and every emitted string is additionally checked against a denylist at the
 * emission boundary before it is queued.
 *
 * Reporting is batched and bounded, backs off after a failed send, honours a
 * kill switch, and never throws into the host application: telemetry failing is
 * always less important than the call it was measuring.
 */

export const SDK_NAME = "@streampay/sdk";
export const SDK_VERSION = "0.3.0";
export const TELEMETRY_SCHEMA_VERSION = 1;
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.streampay.dev/v1/events";

/** Latency is reported as a bucket, never as a raw duration. */
export const LATENCY_BUCKETS = [
  "lt_10ms",
  "lt_50ms",
  "lt_100ms",
  "lt_250ms",
  "lt_500ms",
  "lt_1s",
  "lt_2_5s",
  "lt_5s",
  "gte_5s",
] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

const LATENCY_BOUNDS_MS: ReadonlyArray<readonly [number, LatencyBucket]> = [
  [10, "lt_10ms"],
  [50, "lt_50ms"],
  [100, "lt_100ms"],
  [250, "lt_250ms"],
  [500, "lt_500ms"],
  [1_000, "lt_1s"],
  [2_500, "lt_2_5s"],
  [5_000, "lt_5s"],
];

export function latencyBucket(durationMs: number): LatencyBucket {
  // A clock that moved backwards or a non-finite duration must not become a
  // novel bucket string; it is clamped into the first/last one.
  if (!Number.isFinite(durationMs) || durationMs < 0) return "lt_10ms";
  for (const [bound, bucket] of LATENCY_BOUNDS_MS) {
    if (durationMs < bound) return bucket;
  }
  return "gte_5s";
}

/**
 * Denylist applied to every string that would be emitted. It is a second line of
 * defence: the allowlist already gives a raw address or amount nowhere to go, but
 * a future field mistake must not become a leak.
 */
export const LEAK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "stellar_address", pattern: /\b[GCB][A-Z2-7]{55}\b/ },
  { name: "secret_seed", pattern: /\bS[A-Z2-7]{55}\b/ },
  { name: "xdr_base64", pattern: /[A-Za-z0-9+/]{80,}={0,2}/ },
  { name: "hex_key", pattern: /\b[0-9a-fA-F]{64}\b/ },
  { name: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: "amount", pattern: /\b\d{7,}\b/ },
];

/** Returns the name of the first denylist pattern `value` matches, if any. */
export function findLeak(value: string): string | undefined {
  return LEAK_PATTERNS.find((entry) => entry.pattern.test(value))?.name;
}

const METHOD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface TelemetryCallInput {
  /** SDK method key, e.g. `create_stream` (from the generated `METHODS` table). */
  method: string;
  outcome: "ok" | "error";
  durationMs: number;
  errorCode?: string;
}

export interface TelemetryEvent {
  schema: number;
  sdk: { name: string; version: string };
  event: "call";
  method: string;
  outcome: "ok" | "error";
  latency_bucket: LatencyBucket;
  error_code?: string;
}

/**
 * The allowlist schema: the only fields a telemetry event may carry, with the
 * validator each one has to pass. Serialization is built from this table, never
 * from a spread of caller input, so a new input field is dropped until it is
 * added here deliberately.
 */
export const TELEMETRY_FIELD_SCHEMA: ReadonlyArray<{
  name: keyof TelemetryEvent;
  describe: string;
}> = [
  { name: "schema", describe: "telemetry schema version" },
  { name: "sdk", describe: "SDK name and version" },
  { name: "event", describe: "event kind, currently only `call`" },
  { name: "method", describe: "SDK method key, sanitized" },
  { name: "outcome", describe: "`ok` or `error`" },
  { name: "latency_bucket", describe: "latency bucket, never a raw duration" },
  { name: "error_code", describe: "contract error name or failure kind, sanitized" },
];

/** Maps a thrown error to a non-identifying code. Never the error message. */
export function errorCodeFrom(error: unknown): string {
  if (error instanceof StreamPayError) {
    return error.contract?.name ?? error.kind;
  }
  return "unknown_error";
}

/**
 * Builds the only shape that may be emitted. Anything that fails its validator
 * degrades to a constant (`unknown_method`, dropped error code) rather than being
 * passed through.
 */
export function sanitizeTelemetryCall(input: TelemetryCallInput): TelemetryEvent {
  const method = METHOD_PATTERN.test(input.method) && findLeak(input.method) === undefined
    ? input.method
    : "unknown_method";
  const outcome = input.outcome === "error" ? "error" : "ok";
  const event: TelemetryEvent = {
    schema: TELEMETRY_SCHEMA_VERSION,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    event: "call",
    method,
    outcome,
    latency_bucket: latencyBucket(input.durationMs),
  };
  const code = input.errorCode;
  if (typeof code === "string" && ERROR_CODE_PATTERN.test(code) && findLeak(code) === undefined) {
    event.error_code = code;
  }
  return event;
}

/** True when an already-serialized event contains nothing the denylist rejects. */
export function isEmittable(event: TelemetryEvent): boolean {
  return findLeak(JSON.stringify(event)) === undefined;
}

export interface TelemetryHttpResponse {
  ok: boolean;
  status: number;
}

export type TelemetryFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TelemetryHttpResponse>;

export interface TelemetryTransport {
  send(events: readonly TelemetryEvent[]): Promise<void>;
}

export interface TelemetryOptions {
  /** Opt-in. Absent/false means telemetry does nothing at all. */
  enabled?: boolean;
  endpoint?: string;
  transport?: TelemetryTransport;
  fetchImpl?: TelemetryFetch;
  /** Events per request. Bounded to 1..100. */
  batchSize?: number;
  /** Queue bound; the oldest event is dropped first. Bounded to 1..1000. */
  maxQueue?: number;
  /** Attempts before a batch is abandoned. */
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consulted before every send: `true` stops reporting immediately. */
  killSwitch?: () => boolean;
  now?: () => number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE = 200;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function httpTransport(endpoint: string, fetchImpl?: TelemetryFetch): TelemetryTransport {
  return {
    async send(events) {
      const doFetch = fetchImpl ?? (globalThis as { fetch?: TelemetryFetch }).fetch;
      if (!doFetch) throw new Error("telemetry transport unavailable (no fetch)");
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      });
      if (!response.ok) throw new Error(`telemetry endpoint returned ${response.status}`);
    },
  };
}

export class Telemetry {
  private readonly transport: TelemetryTransport;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly killSwitch: (() => boolean) | undefined;
  private readonly now: () => number;

  private queue: TelemetryEvent[] = [];
  private enabledFlag: boolean;
  private killed = false;
  private attempts = 0;
  private nextAttemptAt = 0;
  private sending: Promise<void> | undefined;
  private dropped = 0;

  constructor(options: TelemetryOptions = {}) {
    this.enabledFlag = options.enabled === true;
    this.batchSize = clampInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 100);
    this.maxQueue = clampInt(options.maxQueue, DEFAULT_MAX_QUEUE, 1, 1_000);
    this.maxAttempts = clampInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 20);
    this.baseBackoffMs = clampInt(options.baseBackoffMs, DEFAULT_BASE_BACKOFF_MS, 1, 60_000);
    this.maxBackoffMs = clampInt(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, this.baseBackoffMs, 300_000);
    this.killSwitch = options.killSwitch;
    this.now = options.now ?? (() => Date.now());
    this.transport = options.transport ?? httpTransport(options.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT, options.fetchImpl);
  }

  get enabled(): boolean {
    return this.enabledFlag && !this.killed;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** Events dropped because the queue was full or the batch kept failing. */
  get droppedEvents(): number {
    return this.dropped;
  }

  isKilled(): boolean {
    return this.killed;
  }

  enable(): this {
    if (this.killed) return this;
    this.enabledFlag = true;
    return this;
  }

  /** Consent withdrawn: stop reporting and forget anything not yet sent. */
  disable(): this {
    this.enabledFlag = false;
    this.queue = [];
    this.attempts = 0;
    this.nextAttemptAt = 0;
    return this;
  }

  /** Irreversible stop for this instance (remote kill switch, incident). */
  kill(): this {
    this.killed = true;
    this.enabledFlag = false;
    this.dropped += this.queue.length;
    this.queue = [];
    return this;
  }

  /** Records one call outcome. No-op unless opted in; never throws. */
  record(input: TelemetryCallInput): void {
    try {
      if (!this.enabled) return;
      const event = sanitizeTelemetryCall(input);
      if (!isEmittable(event)) {
        this.dropped += 1;
        return;
      }
      this.queue.push(event);
      while (this.queue.length > this.maxQueue) {
        this.queue.shift();
        this.dropped += 1;
      }
      if (this.queue.length >= this.batchSize) void this.flush();
    } catch {
      // Telemetry must never affect the call it measures.
    }
  }

  /**
   * Runs `fn` and records its method, outcome, latency bucket and error code.
   * The result and the error are passed through untouched.
   */
  async track<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      const result = await fn();
      this.record({ method, outcome: "ok", durationMs: this.now() - started });
      return result;
    } catch (error) {
      this.record({ method, outcome: "error", durationMs: this.now() - started, errorCode: errorCodeFrom(error) });
      throw error;
    }
  }

  /** Sends what is queued, in batches. Never throws, never blocks a caller forever. */
  async flush(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.flushOnce().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private async flushOnce(): Promise<void> {
    try {
      if (this.killed) return;
      if (!this.enabledFlag) return;
      if (this.killSwitch?.() === true) {
        this.kill();
        return;
      }
      if (this.now() < this.nextAttemptAt) return;

      while (this.queue.length > 0) {
        // Claim the batch out of the queue before sending, so events recorded
        // while a send is in flight are never dropped or sent twice.
        const batch = this.queue.splice(0, this.batchSize);
        try {
          await this.transport.send(batch);
          this.attempts = 0;
          this.nextAttemptAt = 0;
        } catch {
          this.attempts += 1;
          if (this.attempts >= this.maxAttempts) {
            // Best effort: an undeliverable batch is dropped, not retried forever.
            this.dropped += batch.length;
            this.attempts = 0;
            this.nextAttemptAt = 0;
            continue;
          }
          this.queue = [...batch, ...this.queue];
          while (this.queue.length > this.maxQueue) {
            this.queue.shift();
            this.dropped += 1;
          }
          const backoff = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.attempts - 1));
          this.nextAttemptAt = this.now() + backoff;
          return;
        }
        if (this.killSwitch?.() === true) {
          this.kill();
          return;
        }
      }
    } catch {
      // Never surface a telemetry failure to the host.
    }
  }
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  return new Telemetry(options);
}

/**
 * The SDK's own instance: disabled until the host opts in, so importing the SDK
 * never reports anything on its own.
 */
export const sdkTelemetry = createTelemetry();

/** Opts the default instance in (call from the consent flow, #515). */
export function enableTelemetry(): Telemetry {
  return sdkTelemetry.enable();
}

/** Withdraws consent: stops reporting and clears anything queued. */
export function disableTelemetry(): void {
  sdkTelemetry.disable();
}

export function telemetryEnabled(): boolean {
  return sdkTelemetry.enabled;
}

/** Records a call on the default instance. No-op unless enabled. */
export function recordTelemetry(input: TelemetryCallInput): void {
  sdkTelemetry.record(input);
}

/** Flushes the default instance. Resolves even when telemetry fails. */
export function flushTelemetry(): Promise<void> {
  return sdkTelemetry.flush();
}
