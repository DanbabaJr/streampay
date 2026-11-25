/**
 * TUI runtime: wires the pure model/renderer to a terminal. Every side effect
 * (reading chain state, submitting, input, output, clock, sleeping) is an
 * injected dependency so reconnect, keyboard flows and the non-TTY fallback
 * are testable without a network or a real terminal. Nothing here logs keys.
 */
import {
  applyActionResult,
  applyFailure,
  applyRefresh,
  backoffDelay,
  initialModel,
  parseKeys,
  reduceKey,
  type PendingAction,
  type StreamRow,
  type TuiEvent,
  type TuiModel,
} from "./model.ts";
import { renderFrame } from "./render.ts";

export interface TuiDeps {
  /** Reads every stream of the recipient with its withdrawable amount. */
  fetchRows: () => Promise<StreamRow[]>;
  /** Submits a confirmed action; resolves to a one-line outcome. */
  submit: (action: PendingAction, row: StreamRow | undefined) => Promise<string>;
  nowSeconds: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  write: (text: string) => void;
  columns: () => number;
  /** Subscribes to raw key chunks; returns an unsubscribe function. */
  onInput: (handler: (chunk: string) => void) => () => void;
}

export interface TuiOptions {
  recipient: string;
  network: string;
  intervalMs: number;
  signal: AbortSignal;
}

export const CLEAR = "\u001b[2J\u001b[H";

/** Derives event-log entries by diffing two reads (no event subscription in the CLI read path). */
export function diffEvents(previous: StreamRow[], next: StreamRow[]): TuiEvent[] {
  const before = new Map(previous.map((row) => [row.stream.id, row.stream]));
  const events: TuiEvent[] = [];
  for (const { stream } of next) {
    const old = before.get(stream.id);
    if (!old) {
      events.push({ name: "stream-seen", streamId: stream.id, detail: `deposit ${stream.deposit}` });
      continue;
    }
    if (BigInt(stream.withdrawn) > BigInt(old.withdrawn)) {
      events.push({ name: "withdrawn", streamId: stream.id, detail: `+${BigInt(stream.withdrawn) - BigInt(old.withdrawn)}` });
    }
    if (stream.status !== old.status) {
      events.push({ name: "status-changed", streamId: stream.id, detail: `${old.status} -> ${stream.status}` });
    }
    if (BigInt(stream.deposit) > BigInt(old.deposit)) {
      events.push({ name: "topped-up", streamId: stream.id, detail: `+${BigInt(stream.deposit) - BigInt(old.deposit)}` });
    }
  }
  return events;
}

export async function runTui(options: TuiOptions, deps: TuiDeps): Promise<TuiModel> {
  const { signal } = options;
  let model = initialModel(options.recipient, options.network);
  const draw = () => deps.write(CLEAR + renderFrame(model, deps.nowSeconds(), deps.columns()).join("\n") + "\n");

  const refresh = async () => {
    try {
      const rows = await deps.fetchRows();
      const events = [...diffEvents(model.rows, rows).reverse(), ...model.events].slice(0, 50);
      model = applyRefresh(model, rows, model.connection === "connecting" ? [] : events);
    } catch (error) {
      model = applyFailure(model, error instanceof Error ? error.message : String(error));
    }
  };

  let wake: (() => void) | undefined;
  let busy = false;
  const handle = async (chunk: string) => {
    if (busy) return;
    for (const key of parseKeys(chunk)) {
      const { model: next, effect } = reduceKey(model, key);
      model = next;
      draw();
      if (effect?.type === "quit") {
        wake?.();
        return;
      }
      if (effect?.type === "refresh") {
        busy = true;
        await refresh();
        busy = false;
        draw();
      }
      if (effect?.type === "submit") {
        busy = true;
        const row = model.rows.find((candidate) => candidate.stream.id === effect.action.streamId);
        let message: string;
        try {
          message = await deps.submit(effect.action, row);
        } catch (error) {
          message = `${effect.action.kind} failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        model = applyActionResult(model, message);
        await refresh();
        busy = false;
        draw();
      }
    }
  };
  const unsubscribe = deps.onInput((chunk) => void handle(chunk));
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!model.quit && !signal.aborted) {
      await refresh();
      draw();
      if (model.quit || signal.aborted) break;
      const delay = backoffDelay(model.failures, options.intervalMs);
      await Promise.race([
        deps.sleep(delay, signal),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", onAbort);
  }
  return model;
}

/**
 * Non-TTY fallback: one JSON line per stream (same `change` shape as
 * `status --watch`), then a summary line. No escape codes, no prompts.
 */
export async function runJsonLines(
  options: { network: string; contract: string; recipient: string },
  fetchRows: () => Promise<StreamRow[]>,
  writeLine: (line: Record<string, unknown>) => void
): Promise<void> {
  const rows = await fetchRows();
  rows.forEach((row, index) => {
    writeLine({
      schemaVersion: 1,
      ok: true,
      command: "tui",
      event: "change",
      sequence: index + 1,
      network: options.network,
      contract: options.contract,
      stream: row.stream,
      available: row.available,
    });
  });
  writeLine({
    schemaVersion: 1,
    ok: true,
    command: "tui",
    event: "summary",
    reason: "non-tty",
    network: options.network,
    contract: options.contract,
    recipient: options.recipient,
    streams: rows.length,
  });
}
