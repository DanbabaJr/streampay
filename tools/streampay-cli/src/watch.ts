/**
 * Stream status watch loop.
 *
 * Polls `get_stream`, projects the decoded value through
 * `canonicalStreamState`, and writes exactly one JSON line when that
 * projection changes. Polls that observe the same stream state write nothing.
 * A SIGINT-driven abort always ends with one summary line.
 */
import {
  canonicalStreamState,
  type NetworkLabel,
  type StreamCommand,
  type StreamState,
} from "./state.ts";

/** Floor for `--interval`: two RPC reads per second is already aggressive. */
export const MIN_WATCH_INTERVAL_MS = 1_000;
/** Default polling cadence: comfortable for a public Soroban RPC endpoint. */
export const DEFAULT_WATCH_INTERVAL_MS = 5_000;

export interface WatchChangeLine {
  schemaVersion: 1;
  ok: true;
  command: StreamCommand;
  event: "change";
  sequence: number;
  network: NetworkLabel;
  contract: string;
  stream: StreamState;
}

export interface WatchSummaryLine {
  schemaVersion: 1;
  ok: true;
  command: StreamCommand;
  event: "summary";
  reason: "sigint";
  polls: number;
  changes: number;
  network: NetworkLabel;
  contract: string;
  stream: StreamState | null;
}

export interface WatchResult {
  polls: number;
  changes: number;
  last: StreamState | null;
}

export interface WatchOptions {
  command: StreamCommand;
  network: NetworkLabel;
  contract: string;
  intervalMs: number;
  /** One `get_stream` read. The CLI supplies a live RPC closure; tests mock it. */
  readStream: () => Promise<StreamState>;
  /** Receives each complete JSONL record; the CLI serialises with JSON.stringify. */
  writeLine: (line: WatchChangeLine | WatchSummaryLine) => void;
  /** Aborted by the CLI's SIGINT handler (or by a test). */
  signal: AbortSignal;
}

const ABORTED = Symbol("aborted");

function abortPromise(signal: AbortSignal): {
  promise: Promise<typeof ABORTED>;
  dispose: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Sleeps for `ms`, resolving early when the watch is aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs the watch loop until `signal` aborts, then emits the summary line.
 *
 * The first successful poll is a change (null -> observed state), so callers
 * get a baseline line immediately instead of waiting for the first mutation.
 */
export async function watchStream(options: WatchOptions): Promise<WatchResult> {
  const { command, network, contract, intervalMs, readStream, writeLine, signal } = options;
  let polls = 0;
  let changes = 0;
  let last: StreamState | null = null;
  let lastCanonical: string | null = null;

  while (true) {
    if (signal.aborted) break;
    const abort = abortPromise(signal);
    let state: StreamState | typeof ABORTED;
    try {
      state = await Promise.race([readStream(), abort.promise]);
    } finally {
      abort.dispose();
    }
    if (state === ABORTED || signal.aborted) break;

    polls += 1;
    const canonical = canonicalStreamState(state);
    if (canonical !== lastCanonical) {
      changes += 1;
      last = state;
      lastCanonical = canonical;
      writeLine({
        schemaVersion: 1,
        ok: true,
        command,
        event: "change",
        sequence: changes,
        network,
        contract,
        stream: state,
      });
    }

    if (signal.aborted) break;
    await sleep(intervalMs, signal);
  }

  writeLine({
    schemaVersion: 1,
    ok: true,
    command,
    event: "summary",
    reason: "sigint",
    polls,
    changes,
    network,
    contract,
    stream: last,
  });

  return { polls, changes, last };
}
