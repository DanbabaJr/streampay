/**
 * Pure TUI state: panels, selection, the confirm-before-submit gate and the
 * keyboard reducer. No I/O lives here, so every flow is unit-testable and
 * rendering stays deterministic.
 */
import type { StreamState } from "../state.ts";

export const PANELS = ["streams", "accrual", "forecast", "events"] as const;
export type PanelName = (typeof PANELS)[number];
export type ActionKind = "withdraw" | "cancel";

export interface StreamRow {
  stream: StreamState;
  /** Contract `available` read: withdrawable now, in token base units. */
  available: string;
}

export interface TuiEvent {
  name: string;
  streamId: string;
  detail: string;
}

export type Connection = "connecting" | "live" | "reconnecting";

export interface PendingAction {
  kind: ActionKind;
  streamId: string;
}

export interface TuiModel {
  recipient: string;
  network: string;
  rows: StreamRow[];
  events: TuiEvent[];
  panel: PanelName;
  selected: number;
  connection: Connection;
  /** Consecutive failed refreshes; drives the backoff delay. */
  failures: number;
  lastError: string | null;
  pending: PendingAction | null;
  message: string | null;
  quit: boolean;
}

export type Effect = { type: "refresh" } | { type: "submit"; action: PendingAction } | { type: "quit" };

export function initialModel(recipient: string, network: string): TuiModel {
  return {
    recipient,
    network,
    rows: [],
    events: [],
    panel: "streams",
    selected: 0,
    connection: "connecting",
    failures: 0,
    lastError: null,
    pending: null,
    message: null,
    quit: false,
  };
}

export function selectedRow(model: TuiModel): StreamRow | undefined {
  return model.rows[model.selected];
}

function clampSelection(model: TuiModel): number {
  return Math.max(0, Math.min(model.selected, model.rows.length - 1));
}

/** A successful refresh replaces the data and resets the reconnect state. */
export function applyRefresh(model: TuiModel, rows: StreamRow[], events: TuiEvent[]): TuiModel {
  const keepId = selectedRow(model)?.stream.id;
  const next: TuiModel = { ...model, rows, events, connection: "live", failures: 0, lastError: null };
  const kept = keepId === undefined ? -1 : rows.findIndex((row) => row.stream.id === keepId);
  next.selected = kept >= 0 ? kept : clampSelection(next);
  return next;
}

export function applyFailure(model: TuiModel, error: string): TuiModel {
  return { ...model, connection: "reconnecting", failures: model.failures + 1, lastError: error };
}

export function applyActionResult(model: TuiModel, message: string): TuiModel {
  return { ...model, pending: null, message };
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff for reconnects: base, 2x, 4x ... capped. */
export function backoffDelay(failures: number, intervalMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

export type Key = string;

/**
 * Keyboard model. Transactions need two deliberate steps: `w`/`c` stage an
 * action and show a prompt, then only `y` emits the submit effect. Any other
 * key cancels the prompt. Nothing is ever submitted without that `y`.
 */
export function reduceKey(model: TuiModel, key: Key): { model: TuiModel; effect?: Effect } {
  if (key === "ctrl-c") return { model: { ...model, quit: true }, effect: { type: "quit" } };

  if (model.pending) {
    if (key === "y") {
      return { model: { ...model, message: "submitting..." }, effect: { type: "submit", action: model.pending } };
    }
    return { model: { ...model, pending: null, message: "cancelled, nothing submitted" } };
  }

  const cleared = model.message ? { ...model, message: null } : model;
  const panelIndex = PANELS.indexOf(cleared.panel);
  switch (key) {
    case "q":
      return { model: { ...cleared, quit: true }, effect: { type: "quit" } };
    case "tab":
    case "right":
    case "l":
      return { model: { ...cleared, panel: PANELS[(panelIndex + 1) % PANELS.length]! } };
    case "shift-tab":
    case "left":
    case "h":
      return { model: { ...cleared, panel: PANELS[(panelIndex + PANELS.length - 1) % PANELS.length]! } };
    case "1":
    case "2":
    case "3":
    case "4":
      return { model: { ...cleared, panel: PANELS[Number(key) - 1]! } };
    case "down":
    case "j":
      return { model: { ...cleared, selected: Math.min(cleared.selected + 1, Math.max(0, cleared.rows.length - 1)) } };
    case "up":
    case "k":
      return { model: { ...cleared, selected: Math.max(cleared.selected - 1, 0) } };
    case "r":
      return { model: cleared, effect: { type: "refresh" } };
    case "w":
    case "c": {
      const row = selectedRow(cleared);
      if (!row) return { model: { ...cleared, message: "no stream selected" } };
      const kind: ActionKind = key === "w" ? "withdraw" : "cancel";
      if (kind === "cancel" && !row.stream.cancelable) {
        return { model: { ...cleared, message: `stream #${row.stream.id} is not cancelable` } };
      }
      if (kind === "withdraw" && BigInt(row.available) <= 0n) {
        return { model: { ...cleared, message: `nothing to withdraw from stream #${row.stream.id}` } };
      }
      return { model: { ...cleared, pending: { kind, streamId: row.stream.id } } };
    }
    default:
      return { model: cleared };
  }
}

/** Splits a raw terminal chunk into named keys. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i]!;
    if (ch === "\u0003") keys.push("ctrl-c");
    else if (ch === "\t") keys.push("tab");
    else if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "\u001b") {
      if (chunk[i + 1] === "[") {
        const code = chunk[i + 2];
        i += 2;
        if (code === "A") keys.push("up");
        else if (code === "B") keys.push("down");
        else if (code === "C") keys.push("right");
        else if (code === "D") keys.push("left");
        else if (code === "Z") keys.push("shift-tab");
      } else {
        keys.push("escape");
      }
    } else keys.push(ch);
  }
  return keys;
}
