/**
 * Deterministic frame renderer. Takes the model plus an explicit `nowSeconds`
 * (never reads the clock) and returns plain text lines with no ANSI, so the
 * same input always yields byte-identical output and snapshots stay stable.
 */
import { PANELS, selectedRow, type PanelName, type StreamRow, type TuiModel } from "./model.ts";

export const MIN_WIDTH = 60;

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}~` : text;
}

/** Linear accrual, clamped to [0, deposit]. All bigint, no float drift. */
export function accruedAt(row: StreamRow, nowSeconds: number): bigint {
  const { startTime, endTime, deposit } = row.stream;
  const total = BigInt(deposit);
  if (endTime <= startTime) return total;
  if (nowSeconds <= startTime) return 0n;
  if (nowSeconds >= endTime) return total;
  return (total * BigInt(nowSeconds - startTime)) / BigInt(endTime - startTime);
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

function streamsPanel(model: TuiModel, width: number): string[] {
  if (model.rows.length === 0) return ["  no streams for this recipient"];
  return model.rows.map((row, index) => {
    const marker = index === model.selected ? ">" : " ";
    const line = `${marker} #${row.stream.id.padEnd(4)} ${row.stream.status.padEnd(10)} deposit ${row.stream.deposit} withdrawn ${row.stream.withdrawn} available ${row.available}`;
    return clip(line, width);
  });
}

function accrualPanel(model: TuiModel, now: number, width: number): string[] {
  const row = selectedRow(model);
  if (!row) return ["  no stream selected"];
  const accrued = accruedAt(row, now);
  const withdrawn = BigInt(row.stream.withdrawn);
  const unclaimed = accrued > withdrawn ? accrued - withdrawn : 0n;
  return [
    `  stream #${row.stream.id} (${row.stream.status})`,
    `  accrued:    ${accrued} / ${row.stream.deposit}`,
    `  withdrawn:  ${row.stream.withdrawn}`,
    `  unclaimed:  ${unclaimed}`,
    `  on-chain available: ${row.available}`,
    `  sender: ${short(row.stream.sender)}  token: ${short(row.stream.token)}`,
  ].map((line) => clip(line, width));
}

function forecastPanel(model: TuiModel, now: number, width: number): string[] {
  const row = selectedRow(model);
  if (!row) return ["  no stream selected"];
  const { startTime, endTime, deposit } = row.stream;
  const duration = Math.max(0, endTime - startTime);
  const perHour = duration > 0 ? (BigInt(deposit) * 3_600n) / BigInt(duration) : 0n;
  const state = now < startTime ? `starts in ${formatDuration(startTime - now)}` : now >= endTime ? "fully accrued" : `ends in ${formatDuration(endTime - now)}`;
  const accrued = accruedAt(row, now);
  const progress = BigInt(deposit) === 0n ? 100n : (accrued * 100n) / BigInt(deposit);
  return [
    `  stream #${row.stream.id}: ${state}`,
    `  rate:       ${perHour} units/hour`,
    `  window:     ${startTime} -> ${endTime} (${formatDuration(duration)})`,
    `  progress:   ${progress}%`,
    `  cancelable: ${row.stream.cancelable ? "yes" : "no"}`,
  ].map((line) => clip(line, width));
}

function eventsPanel(model: TuiModel, width: number): string[] {
  if (model.events.length === 0) return ["  no recent events"];
  return model.events.slice(0, 8).map((event) => clip(`  ${event.name.padEnd(16)} #${event.streamId} ${event.detail}`, width));
}

const TITLES: Record<PanelName, string> = {
  streams: "Streams",
  accrual: "Accrual",
  forecast: "Forecast",
  events: "Events",
};

export function renderFrame(model: TuiModel, nowSeconds: number, width = 80): string[] {
  const w = Math.max(MIN_WIDTH, width);
  const lines: string[] = [];
  const state = model.connection === "live" ? "live" : model.connection === "connecting" ? "connecting" : `reconnecting (attempt ${model.failures})`;
  lines.push(clip(`StreamPay  ${model.network}  recipient ${short(model.recipient)}  [${state}]`, w));
  lines.push(PANELS.map((panel, i) => (panel === model.panel ? `[${i + 1}:${TITLES[panel]}]` : ` ${i + 1}:${TITLES[panel]} `)).join(" "));
  lines.push("-".repeat(Math.min(w, 72)));
  const body =
    model.panel === "streams" ? streamsPanel(model, w)
    : model.panel === "accrual" ? accrualPanel(model, nowSeconds, w)
    : model.panel === "forecast" ? forecastPanel(model, nowSeconds, w)
    : eventsPanel(model, w);
  lines.push(...body);
  lines.push("-".repeat(Math.min(w, 72)));
  if (model.lastError) lines.push(clip(`error: ${model.lastError}`, w));
  if (model.pending) {
    lines.push(`CONFIRM ${model.pending.kind} on stream #${model.pending.streamId}? press y to submit, any other key to cancel`);
  } else if (model.message) {
    lines.push(clip(model.message, w));
  } else {
    lines.push("tab/arrows: panels  j/k: select  w: withdraw  c: cancel  r: refresh  q: quit");
  }
  return lines;
}
