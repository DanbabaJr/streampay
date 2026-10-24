// Live-accrual engine tests (issue #211).
//
// Time-injection layer for frontend tests: node:test mock timers drive the
// 15s refresh + 1s ticker, the engine's `nowMs` seam is a fake local clock,
// and the server-action/RPC reads are mocked against a deterministic fake
// chain whose ledger is the oracle. Each property below runs the accrual
// path under controlled skew between the three clocks.

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  startLiveAccrual,
  type LiveAccrualState,
  type LiveStreamRead,
} from "./live-accrual.ts";
import {
  contractAvailableAt,
  epsilonUnits,
} from "./clock-skew.ts";
import type { StreamSnapshot } from "./accrual.ts";

const BASE = 1_700_000_000;
const DAY = 86_400;

type LoggedUpdate = LiveAccrualState & { ledgerAt: number };

class FakeChain {
  ledger = BASE;
  /** Constant offset between the local clock and the ledger (NTP drift). */
  skew = 0;
  withdrawn = 0n;
  deposit = 1_000_000n; // fast stream: 1_000_000/86_400 > 11 units per second
  startTime = BASE;
  endTime = BASE + DAY;
  readCount = 0;

  snapshot(): StreamSnapshot {
    return {
      deposit: this.deposit,
      startTime: this.startTime,
      endTime: this.endTime,
      withdrawn: this.withdrawn,
      status: "Active",
    };
  }

  /** Wall-clock ms per the (possibly skewed) local clock. */
  nowMs(): number {
    return (this.ledger + this.skew) * 1000;
  }

  /** Real seconds pass for both clocks; the skew stays constant. */
  advanceReal(seconds: number): void {
    this.ledger += seconds;
  }

  readStream(anchor: boolean): () => Promise<LiveStreamRead> {
    return async () => {
      this.readCount += 1;
      const base = this.snapshot();
      return anchor ? { ...base, ledgerTime: this.ledger } : base;
    };
  }

  readAvailable(): () => Promise<bigint> {
    return async () => contractAvailableAt(this.snapshot(), BigInt(this.ledger));
  }

  oracleAtNow(): bigint {
    return contractAvailableAt(this.snapshot(), BigInt(this.ledger));
  }

  epsilonNow(): bigint {
    return epsilonUnits(this.snapshot(), BigInt(this.ledger));
  }
}

let chain: FakeChain;
let updates: LoggedUpdate[];

function startEngine(opts: {
  anchor: boolean;
  skew: number;
  tickMs?: number;
  refreshMs?: number;
}): { stop: () => void; refresh: () => Promise<void> } {
  chain.skew = opts.skew;
  return startLiveAccrual({
    readStream: chain.readStream(opts.anchor),
    readAvailable: chain.readAvailable(),
    nowMs: () => chain.nowMs(),
    tickMs: opts.tickMs ?? 1000,
    refreshMs: opts.refreshMs ?? 15_000,
    onUpdate: (state) => updates.push({ ...state, ledgerAt: chain.ledger }),
  });
}

/** Flush pending microtasks (refresh promises) with the real timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Advance real time one second and fire the engine's interval once. */
async function tickSeconds(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    chain.advanceReal(1);
    mock.timers.tick(1000);
    await flush();
  }
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval"] });
  chain = new FakeChain();
  updates = [];
});

afterEach(() => {
  mock.timers.reset();
});

describe("anchored engine under a skewed local clock", () => {
  it("never shows more than contract-available + one epsilon for a clock 10s fast", async () => {
    const engine = startEngine({ anchor: true, skew: 10 });
    await flush();
    for (let i = 0; i < 40; i += 1) {
      await tickSeconds(1);
      const shown = updates[updates.length - 1]?.displayAvailable;
      if (shown !== undefined && shown !== null) {
        const cap = chain.oracleAtNow() + chain.epsilonNow();
        assert.ok(
          shown <= cap,
          `over-up at ledger ${chain.ledger}: display ${shown} > cap ${cap}`
        );
      }
    }
    engine.stop();
  });

  it("clips the raw ticker: the guard actually fires when the clock leads", async () => {
    const engine = startEngine({ anchor: true, skew: 10 });
    await flush();
    await tickSeconds(20);
    const last = updates[updates.length - 1];
    const rawAtLocal = contractAvailableAt(
      chain.snapshot(),
      BigInt(chain.ledger + chain.skew)
    );
    const cap = chain.oracleAtNow() + chain.epsilonNow();
    assert.ok(rawAtLocal > cap, "sanity: raw ticker should over-report");
    assert.ok((last.displayAvailable ?? 0n) <= cap);
    engine.stop();
  });

  it("holds the epsilon rule across the whole +/-10s drift vocabulary", async () => {
    for (const skew of [-10, -1, 0, 1, 5, 10]) {
      chain = new FakeChain();
      updates = [];
      const engine = startEngine({ anchor: true, skew });
      await flush();
      await tickSeconds(20);
      for (const update of updates) {
        if (update.displayAvailable === null) continue;
        const pointLedger = BigInt(update.ledgerAt);
        const cap =
          contractAvailableAt(chain.snapshot(), pointLedger) +
          epsilonUnits(chain.snapshot(), pointLedger);
        assert.ok(
          update.displayAvailable <= cap,
          `skew ${skew}s: display ${update.displayAvailable} > cap ${cap}`
        );
      }
      engine.stop();
      assert.ok(updates.length > 0, `skew ${skew}s produced no updates`);
    }
  });

  it("the confirmed simulate value a withdrawal is guarded by equals contract-available at the read moment", async () => {
    const engine = startEngine({ anchor: true, skew: 3 });
    await flush();
    await tickSeconds(15); // the 15s refresh fires exactly at ledger BASE+15
    const last = updates[updates.length - 1];
    assert.strictEqual(last.available, chain.oracleAtNow());
    engine.stop();
  });
});

describe("unanchored (legacy) ticker characterisation", () => {
  it("a 10s-fast clock without a ledger anchor DOES over-up — the documented hazard", async () => {
    const engine = startEngine({ anchor: false, skew: 10 });
    await flush();
    await tickSeconds(20);
    const last = updates[updates.length - 1];
    const cap = chain.oracleAtNow() + chain.epsilonNow();
    assert.ok(
      (last.displayAvailable ?? 0n) > cap,
      "legacy unanchored display is expected to over-report with a fast clock"
    );
    engine.stop();
  });

  it("with an honest clock the legacy path obeys the epsilon rule too", async () => {
    const engine = startEngine({ anchor: false, skew: 0 });
    await flush();
    await tickSeconds(20);
    for (const update of updates) {
      if (update.displayAvailable === null) continue;
      const ledger = BigInt(update.ledgerAt);
      assert.ok(
        update.displayAvailable <=
          contractAvailableAt(chain.snapshot(), ledger) +
            epsilonUnits(chain.snapshot(), ledger)
      );
    }
    engine.stop();
  });
});

describe("refresh + ticker cadence", () => {
  it("refreshes reads on the 15s cadence and ticks in between", async () => {
    const engine = startEngine({ anchor: true, skew: 0 });
    await flush();
    assert.strictEqual(chain.readCount, 1); // initial reload
    await tickSeconds(15);
    // Each tickSeconds(1) runs 1s of engine time; a refresh fired once at 15s.
    assert.strictEqual(chain.readCount, 2);
    await tickSeconds(15);
    assert.strictEqual(chain.readCount, 3);
    engine.stop();
  });

  it("sub-second local movement inside one epsilon-second renders no new update (no flicker)", async () => {
    let localOverrideMs: number | undefined;
    const engine = startLiveAccrual({
      readStream: chain.readStream(true),
      readAvailable: chain.readAvailable(),
      nowMs: () => localOverrideMs ?? chain.nowMs(),
      tickMs: 1000,
      refreshMs: 15_000,
      onUpdate: (state) => updates.push({ ...state, ledgerAt: chain.ledger }),
    });
    await flush();
    localOverrideMs = chain.nowMs() + 500; // mid-second
    mock.timers.tick(1000);
    await flush();
    const countAfterHalfSecond = updates.length;
    localOverrideMs = chain.nowMs() + 999; // still the same epsilon-second
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(
      updates.length,
      countAfterHalfSecond,
      "fractional milliseconds must not re-render the counter"
    );
    localOverrideMs = undefined; // next whole second accrues
    chain.advanceReal(1);
    mock.timers.tick(1000);
    await flush();
    assert.ok(updates.length > countAfterHalfSecond);
    engine.stop();
  });
});

describe("pending-transaction staleness through the engine loop", () => {
  it("a concurrent withdrawal re-anchors the display down at the next refresh, never up", async () => {
    const engine = startEngine({ anchor: true, skew: 0 });
    await flush();
    await tickSeconds(8);

    // Another device withdraws 50 units; the stale loop keeps showing the
    // pre-withdrawal number until the next explicit refresh (staying inside
    // the 15s window so no automatic refresh fires first).
    chain.withdrawn += 50n;
    await tickSeconds(6);
    const stale = updates[updates.length - 1].displayAvailable ?? 0n;
    assert.ok(
      stale > chain.oracleAtNow(),
      "stale display should temporarily over-report the raced withdrawal"
    );

    await engine.refresh();
    const corrected = updates[updates.length - 1].displayAvailable ?? 0n;
    assert.ok(corrected <= stale, "refresh must correct down, not jump up");
    assert.ok(corrected <= chain.oracleAtNow() + chain.epsilonNow());
    engine.stop();
  });

  it("the user's own withdrawal followed by refresh never raises the actionable value above truth", async () => {
    const engine = startEngine({ anchor: true, skew: 10 });
    await flush();
    await tickSeconds(5);
    const actionable = updates[updates.length - 1].available ?? 0n;
    assert.ok(actionable <= chain.oracleAtNow());

    // The tx pays out the guarded amount two ledgers later.
    chain.withdrawn += actionable;
    chain.advanceReal(2);
    await engine.refresh();
    const after = updates[updates.length - 1];
    assert.strictEqual(after.available, chain.oracleAtNow());
    assert.ok((after.displayAvailable ?? 0n) <= chain.oracleAtNow() + chain.epsilonNow());
    engine.stop();
  });
});

describe("failure path", () => {
  it("a failing refresh surfaces the error without clearing the last good display", async () => {
    let failMode = false;
    const guardedReadStream = chain.readStream(true);
    const guardedReadAvailable = chain.readAvailable();
    const engine = startLiveAccrual({
      readStream: async () => {
        if (failMode) throw new Error("rpc down");
        return guardedReadStream();
      },
      readAvailable: async () => {
        if (failMode) throw new Error("rpc down");
        return guardedReadAvailable();
      },
      nowMs: () => chain.nowMs(),
      tickMs: 1000,
      refreshMs: 15_000,
      onUpdate: (state) => updates.push({ ...state, ledgerAt: chain.ledger }),
    });
    await flush();
    await tickSeconds(2);
    const good = updates[updates.length - 1];
    assert.ok(good.snapshot);
    assert.strictEqual(good.error, null);

    failMode = true;
    mock.timers.tick(15_000); // automatic refresh fires and fails
    await flush();
    const failed = updates[updates.length - 1];
    assert.ok(failed.error instanceof Error);
    assert.strictEqual((failed.error as Error).message, "rpc down");
    // The last good snapshot and displayed value survive the failure.
    assert.deepStrictEqual(failed.snapshot, good.snapshot);
    assert.strictEqual(failed.displayAvailable, good.displayAvailable);

    failMode = false;
    await engine.refresh();
    const recovered = updates[updates.length - 1];
    assert.strictEqual(recovered.error, null);
    engine.stop();
  });
});
