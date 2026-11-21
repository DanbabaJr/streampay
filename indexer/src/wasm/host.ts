/**
 * WASM plugin host (issue #580).
 *
 * One invocation = one `node:worker_threads` worker running `worker.ts`.
 * The worker instantiates the module, copies the input JSON into linear
 * memory, calls `transform`, and posts the reply back. The host enforces
 * the budgets the worker cannot enforce on itself:
 *
 *   - wall-clock: a timer terminates the worker after `timeoutMs`; a
 *     runaway plugin is killed, never left spinning;
 *   - output size: the worker rejects lengths above the cap, and the host
 *     re-checks the reply bytes;
 *   - memory: validated before the worker starts (see `validate.ts`).
 *
 * The host never throws for a bad plugin or a bad reply. Every failure
 * mode — invalid module, trap, timeout, oversized or unparsable reply —
 * becomes `{ status: "fallback", reason }`, so the caller (the dispatcher)
 * can fall back to the raw stream. Only a programming error in the host
 * itself (an invalid `timeoutMs`, an input that cannot be serialised)
 * throws.
 */
import { Worker } from "node:worker_threads";
import {
  DROP,
  ENVELOPE_KEYS,
  MAX_OUTPUT_BYTES,
  eventToJson,
  resolveLimits,
  type PluginLimits,
} from "./abi.js";
import { validatePlugin } from "./validate.js";
import type { PluginWorkerData, PluginWorkerResult } from "./worker.js";
import type { DecodedEvent, EventValue } from "../types.js";

export type TransformOutcome =
  | { status: "transformed"; output: Record<string, EventValue>; durationMs: number }
  | { status: "dropped"; durationMs: number }
  | { status: "fallback"; reason: string; durationMs: number };

export class WasmPluginHost {
  private readonly limits: Required<PluginLimits>;

  constructor(limits: PluginLimits = {}) {
    this.limits = resolveLimits(limits);
  }

  /**
   * Run `bytes` against a decoded event. The reply's `data` becomes the
   * event's new data (see `abi.ts` for the reply-shape rules); the envelope
   * is preserved by the caller, never by the plugin.
   */
  async transformEvent(
    bytes: Uint8Array,
    event: DecodedEvent,
    limits?: PluginLimits,
  ): Promise<TransformOutcome> {
    const outcome = await this.transform(bytes, eventToJson(event), limits);
    if (outcome.status !== "transformed") return outcome;
    return { status: "transformed", output: outcome.output, durationMs: outcome.durationMs };
  }

  /** Run `bytes` against an already-serialised JSON string. */
  async transform(
    bytes: Uint8Array,
    inputJson: string,
    limits?: PluginLimits,
  ): Promise<TransformOutcome> {
    const started = Date.now();
    const done = (outcome: TransformOutcome): TransformOutcome => ({
      ...outcome,
      durationMs: Date.now() - started,
    });
    const resolved = limits ? resolveLimits({ ...this.limits, ...limits }) : this.limits;

    try {
      validatePlugin(bytes, resolved);
    } catch (err) {
      return done({ status: "fallback", reason: err instanceof Error ? err.message : String(err), durationMs: 0 });
    }

    const inputBytes = new TextEncoder().encode(inputJson);
    if (inputBytes.length > resolved.maxInputBytes) {
      return done({
        status: "fallback",
        reason: `input is ${inputBytes.length} bytes, over the ${resolved.maxInputBytes} byte limit`,
        durationMs: 0,
      });
    }

    const workerData: PluginWorkerData = {
      bytes: new Uint8Array(bytes),
      input: inputJson,
      maxMemoryPages: resolved.maxMemoryPages,
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { workerData });
    } catch (err) {
      return done({ status: "fallback", reason: `failed to start plugin worker: ${err instanceof Error ? err.message : String(err)}`, durationMs: 0 });
    }

    return new Promise<TransformOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: TransformOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(done(outcome));
      };
      const timer = setTimeout(() => {
        finish({
          status: "fallback",
          reason: `plugin exceeded the ${resolved.timeoutMs}ms wall-clock budget`,
          durationMs: 0,
        });
      }, resolved.timeoutMs);
      // The timer must not keep the process alive on its own.
      timer.unref?.();

      worker.on("message", (result: PluginWorkerResult) => {
        if ("dropped" in result && result.dropped) {
          finish({ status: "dropped", durationMs: 0 });
          return;
        }
        if ("error" in result) {
          finish({ status: "fallback", reason: `plugin failed: ${result.error}`, durationMs: 0 });
          return;
        }
        if ("output" in result) {
          const outputBytes = new TextEncoder().encode(result.output);
          if (outputBytes.length > MAX_OUTPUT_BYTES) {
            finish({ status: "fallback", reason: "plugin reply exceeds the output size limit", durationMs: 0 });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.output) as unknown;
          } catch {
            finish({ status: "fallback", reason: "plugin reply is not valid JSON", durationMs: 0 });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            finish({ status: "fallback", reason: "plugin reply must be a JSON object", durationMs: 0 });
            return;
          }
          finish({ status: "transformed", output: mergeReplyData(parsed as Record<string, unknown>), durationMs: 0 });
          return;
        }
        finish({ status: "fallback", reason: "plugin worker returned an unknown result", durationMs: 0 });
      });
      worker.on("error", (err) => {
        finish({ status: "fallback", reason: `plugin worker error: ${err.message}`, durationMs: 0 });
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          finish({ status: "fallback", reason: `plugin worker exited with code ${code}`, durationMs: 0 });
        }
      });
    });
  }
}

/**
 * Apply the reply-shape rules from `abi.ts`: `data` (when an object) is the
 * new data, and any non-envelope top-level key is merged into it. Values
 * are carried as JSON values, which are a subset of `EventValue`.
 */
export function mergeReplyData(reply: Record<string, unknown>): Record<string, EventValue> {
  const data = reply.data;
  const merged: Record<string, EventValue> =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as Record<string, EventValue>) }
      : {};
  for (const [key, value] of Object.entries(reply)) {
    if (key === "data" || ENVELOPE_KEYS.has(key)) continue;
    merged[key] = value as EventValue;
  }
  // No `data` key at all: the reply itself (minus envelope keys) is the data.
  if (data === undefined) {
    for (const [key, value] of Object.entries(reply)) {
      if (ENVELOPE_KEYS.has(key)) continue;
      merged[key] = value as EventValue;
    }
  }
  return merged;
}

export { DROP };
