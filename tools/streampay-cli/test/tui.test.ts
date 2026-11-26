import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  applyFailure,
  applyRefresh,
  backoffDelay,
  initialModel,
  parseKeys,
  reduceKey,
  type PendingAction,
  type StreamRow,
  type TuiModel,
} from "../src/tui/model.ts";
import { accruedAt, renderFrame } from "../src/tui/render.ts";
import { diffEvents, runJsonLines, runTui, type TuiDeps } from "../src/tui/runtime.ts";

const RECIPIENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const snapshotDir = new URL("./__snapshots__/", import.meta.url);
const update = process.env.UPDATE_SNAPSHOTS === "1";

function row(id: string, overrides: Partial<StreamRow["stream"]> = {}, available = "250"): StreamRow {
  return {
    available,
    stream: {
      id,
      sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      recipient: RECIPIENT,
      token: "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL",
      deposit: "1000",
      withdrawn: "100",
      startTime: 1_000,
      endTime: 2_000,
      cancelable: true,
      status: "Active",
      ...overrides,
    },
  };
}

const NOW = 1_500;

function loaded(): TuiModel {
  return applyRefresh(initialModel(RECIPIENT, "testnet"), [row("1"), row("2", { cancelable: false }, "0")], [
    { name: "withdrawn", streamId: "1", detail: "+50" },
  ]);
}

function snapshot(name: string, lines: string[]): void {
  const file = new URL(`tui.${name}.txt`, snapshotDir);
  const text = `${lines.join("\n")}\n`;
  if (update || !existsSync(file)) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(file, text);
  }
  assert.equal(text, readFileSync(file, "utf8"), `run with UPDATE_SNAPSHOTS=1 to refresh tui.${name}.txt`);
}

for (const [index, panel] of ["streams", "accrual", "forecast", "events"].entries()) {
  test(`${panel} panel renders deterministically (snapshot)`, () => {
    const model = reduceKey(loaded(), String(index + 1)).model;
    const first = renderFrame(model, NOW, 80);
    assert.deepEqual(renderFrame(model, NOW, 80), first);
    snapshot(panel, first);
  });
}

test("accrual is linear, clamped and bigint exact", () => {
  const r = row("1");
  assert.equal(accruedAt(r, 500), 0n);
  assert.equal(accruedAt(r, 1_500), 500n);
  assert.equal(accruedAt(r, 9_999), 1000n);
});

test("render cost stays within budget for 500 streams", () => {
  const rows = Array.from({ length: 500 }, (_, i) => row(String(i + 1)));
  const model = applyRefresh(initialModel(RECIPIENT, "testnet"), rows, []);
  const started = performance.now();
  for (let i = 0; i < 50; i += 1) renderFrame(model, NOW, 120);
  const perFrame = (performance.now() - started) / 50;
  assert.ok(perFrame < 20, `render took ${perFrame}ms per frame`);
});

test("keys switch panels and move selection", () => {
  let model = loaded();
  model = reduceKey(model, "tab").model;
  assert.equal(model.panel, "accrual");
  model = reduceKey(model, "shift-tab").model;
  assert.equal(model.panel, "streams");
  model = reduceKey(model, "j").model;
  assert.equal(model.selected, 1);
  model = reduceKey(model, "j").model;
  assert.equal(model.selected, 1);
  model = reduceKey(model, "k").model;
  assert.equal(model.selected, 0);
  assert.deepEqual(parseKeys("\u001b[B\tq"), ["down", "tab", "q"]);
});

test("withdraw never submits without an explicit y", () => {
  const staged = reduceKey(loaded(), "w");
  assert.equal(staged.effect, undefined);
  assert.deepEqual(staged.model.pending, { kind: "withdraw", streamId: "1" });
  assert.match(renderFrame(staged.model, NOW).join("\n"), /CONFIRM withdraw on stream #1/);

  const declined = reduceKey(staged.model, "n");
  assert.equal(declined.effect, undefined);
  assert.equal(declined.model.pending, null);

  const confirmed = reduceKey(staged.model, "y");
  assert.deepEqual(confirmed.effect, { type: "submit", action: { kind: "withdraw", streamId: "1" } });
});

test("cancel needs confirmation and respects cancelable", () => {
  const staged = reduceKey(loaded(), "c");
  assert.equal(staged.effect, undefined);
  assert.equal(reduceKey(staged.model, "escape").effect, undefined);
  const second = reduceKey(reduceKey(loaded(), "j").model, "c");
  assert.equal(second.model.pending, null);
  assert.match(second.model.message ?? "", /not cancelable/);
  const none = reduceKey(reduceKey(loaded(), "j").model, "w");
  assert.match(none.model.message ?? "", /nothing to withdraw/);
});

test("backoff grows and caps; a good refresh resets it", () => {
  assert.equal(backoffDelay(0, 5_000), 5_000);
  assert.deepEqual([1, 2, 3, 4, 10].map((n) => backoffDelay(n, 5_000)), [1_000, 2_000, 4_000, 8_000, 30_000]);
  let model = applyFailure(applyFailure(loaded(), "rpc down"), "rpc down");
  assert.equal(model.connection, "reconnecting");
  assert.equal(model.failures, 2);
  assert.match(renderFrame(model, NOW).join("\n"), /reconnecting \(attempt 2\)/);
  model = applyRefresh(model, [row("1")], []);
  assert.equal(model.connection, "live");
  assert.equal(model.failures, 0);
});

test("diffEvents reports withdrawals and status changes", () => {
  const events = diffEvents([row("1")], [row("1", { withdrawn: "150", status: "Cancelled" }), row("2")]);
  assert.deepEqual(events.map((e) => e.name), ["withdrawn", "status-changed", "stream-seen"]);
});

function harness(fetchRows: TuiDeps["fetchRows"], submits: PendingAction[] = []) {
  const frames: string[] = [];
  const sleeps: number[] = [];
  let input: ((chunk: string) => void) | undefined;
  const controller = new AbortController();
  const deps: TuiDeps = {
    fetchRows,
    submit: async (action) => {
      submits.push(action);
      return `${action.kind} done`;
    },
    nowSeconds: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
    write: (text) => frames.push(text),
    columns: () => 80,
    onInput: (handler) => {
      input = handler;
      return () => {
        input = undefined;
      };
    },
  };
  return { deps, frames, sleeps, controller, press: (key: string) => input?.(key) };
}

test("runtime reconnects with backoff after RPC failures, then recovers", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    if (calls <= 3) throw new Error("rpc down");
    return [row("1")];
  });
  const original = h.deps.sleep;
  h.deps.sleep = async (ms, signal) => {
    await original(ms, signal);
    if (calls >= 5) h.press("q");
  };
  const model = await runTui({ recipient: RECIPIENT, network: "testnet", intervalMs: 5_000, signal: h.controller.signal }, h.deps);
  assert.deepEqual(h.sleeps.slice(0, 4), [1_000, 2_000, 4_000, 5_000]);
  assert.equal(model.connection, "live");
  assert.ok(h.frames.some((frame) => frame.includes("reconnecting (attempt 3)")));
});

test("runtime submits only after y and refreshes afterwards", async () => {
  const submits: PendingAction[] = [];
  const h = harness(async () => [row("1")], submits);
  const original = h.deps.sleep;
  let step = 0;
  h.deps.sleep = async (ms, signal) => {
    await original(ms, signal);
    step += 1;
    if (step === 1) h.press("w");
    if (step === 2) {
      assert.deepEqual(submits, [], "staging alone must not submit");
      h.press("y");
    }
    if (step === 3) h.press("q");
  };
  await runTui({ recipient: RECIPIENT, network: "testnet", intervalMs: 1_000, signal: h.controller.signal }, h.deps);
  assert.deepEqual(submits, [{ kind: "withdraw", streamId: "1" }]);
});

test("non-TTY fallback emits JSON lines with no escape codes", async () => {
  const lines: Record<string, unknown>[] = [];
  await runJsonLines({ network: "testnet", contract: "CABC", recipient: RECIPIENT }, async () => [row("1"), row("2")], (l) => lines.push(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.event, "change");
  assert.equal(lines[2]!.event, "summary");
  assert.equal(lines[2]!.streams, 2);
  assert.ok(!JSON.stringify(lines).includes("\u001b"));
});
