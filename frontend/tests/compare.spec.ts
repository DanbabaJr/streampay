import { describe, expect, it } from "vitest";
import { accrualCurve, streamedAt } from "../lib/compare/simulator";
import { forecast } from "../lib/compare/forecast";
import { estimateFees, DEFAULT_FEES } from "../lib/compare/fees";
import { addItem, compare, removeItem, MAX_ITEMS, type CompareItem } from "../lib/compare/model";
import { decodeState, encodeState } from "../lib/compare/url";

const mk = (n: number, dep = 1000n, dur = 100n, kind: "stream" | "hypothetical" = "hypothetical"): CompareItem => ({
  key: `${kind === "stream" ? "s" : "h"}:${n}`, label: `Item ${n}`, kind, deposit: dep, duration: dur,
});

describe("simulator parity with contract streamed_at", () => {
  it("matches the contract's edge semantics", () => {
    expect(streamedAt(1000n, 100n, 0n)).toBe(0n);
    expect(streamedAt(1000n, 100n, 50n)).toBe(500n);
    expect(streamedAt(1000n, 100n, 100n)).toBe(1000n);
    expect(streamedAt(1000n, 100n, 500n)).toBe(1000n); // capped at deposit
    expect(streamedAt(10n, 3n, 1n)).toBe(3n); // floors 3.33
    expect(streamedAt(0n, 10n, 5n)).toBe(0n);
    expect(streamedAt(5n, 0n, 5n)).toBe(0n);
  });
  it("handles values beyond 2^53 exactly (bigint)", () => {
    const dep = 10n ** 30n;
    expect(streamedAt(dep, 3n, 1n)).toBe(dep / 3n);
  });
  it("curve is monotonic, starts at 0 and ends at deposit", () => {
    const c = accrualCurve({ deposit: 12345n, duration: 777n }, 24);
    expect(c[0].accrued).toBe(0n);
    expect(c[c.length - 1].accrued).toBe(12345n);
    for (let i = 1; i < c.length; i++) expect(c[i].accrued >= c[i - 1].accrued).toBe(true);
  });
});

describe("overlay / forecast parity vs simulator", () => {
  it("overlay endpoints agree with the forecast and simulator", () => {
    const cmp = compare([mk(1, 1000n, 100n), mk(2, 5000n, 400n)]);
    for (const r of cmp.results) {
      const last = r.curve[r.curve.length - 1];
      expect(last.t).toBe(r.item.duration);
      expect(last.accrued).toBe(streamedAt(r.item.deposit, r.item.duration, r.item.duration));
      expect(r.forecast.exhaustionSeconds).toBe(r.item.duration);
    }
    expect(cmp.horizon).toBe(400n);
    expect(cmp.maxDeposit).toBe(5000n);
  });
  it("forecast runway, remaining and shortfall", () => {
    const f = forecast({ deposit: 1000n, duration: 100n }, 25n, 1500n);
    expect(f.runwaySeconds).toBe(75n);
    expect(f.remaining).toBe(750n);
    expect(f.shortfall).toBe(500n);
    expect(forecast({ deposit: 1000n, duration: 100n }, 999n).runwaySeconds).toBe(0n);
    expect(forecast({ deposit: 1000n, duration: 100n }, 10n, 900n).shortfall).toBe(0n);
  });
  it("is deterministic", () => {
    const a = compare([mk(1), mk(2, 7n, 3n)]);
    const b = compare([mk(1), mk(2, 7n, 3n)]);
    expect(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });
  it("fees add up", () => {
    const f = estimateFees(1_000_000n, { txFee: 100n, withdrawals: 3n, protocolFeeBps: 25n });
    expect(f).toEqual({ creation: 100n, withdrawals: 300n, protocol: 2500n, total: 2900n });
  });
});

describe("selection", () => {
  it("caps at MAX_ITEMS, ignores duplicates, removes by key", () => {
    let items: CompareItem[] = [];
    for (let i = 0; i < MAX_ITEMS + 3; i++) items = addItem(items, mk(i));
    expect(items).toHaveLength(MAX_ITEMS);
    expect(addItem(items, mk(0))).toHaveLength(MAX_ITEMS);
    expect(removeItem(items, "h:0")).toHaveLength(MAX_ITEMS - 1);
    expect(addItem([mk(1)], mk(1))).toHaveLength(1);
  });
  it("empty selection compares to an empty overlay", () => {
    const c = compare([]);
    expect(c.results).toEqual([]);
    expect(c.horizon).toBe(0n);
  });
});

describe("shareable URL round-trip", () => {
  it("round-trips items and fees exactly", () => {
    const state = {
      items: [mk(1, 123456789012345678901234567890n, 86400n * 30n), { ...mk(7, 55n, 9n, "stream"), label: "Pay roll & co" }],
      fees: { txFee: 1234n, withdrawals: 4n, protocolFeeBps: 30n },
    };
    const back = decodeState(encodeState(state));
    expect(back).toEqual(state);
    expect(encodeState(back)).toBe(encodeState(state));
  });
  it("same URL gives the same comparison", () => {
    const state = { items: [mk(1), mk(2, 99n, 7n)], fees: DEFAULT_FEES };
    const q = encodeState(state);
    const s = (x: ReturnType<typeof compare>) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(s(compare(decodeState(q).items))).toBe(s(compare(state.items)));
  });
  it("drops malformed and hostile input instead of throwing", () => {
    const bad = "c=x.1.2.a.b~s.-1.5.a.s%3A1~s.5.0.a.s%3A2~s.5.5.%E0%A4%A.s%3A3~s.5.5.ok.<script>~junk&tx=-5&w=99999999&bps=20000";
    const s = decodeState(bad);
    expect(s.items).toEqual([]);
    expect(s.fees).toEqual(DEFAULT_FEES);
    expect(decodeState("").items).toEqual([]);
  });
  it("caps items and dedupes keys from a crafted URL", () => {
    const one = "h.5.5.a.h%3A1";
    expect(decodeState("c=" + Array(10).fill(one).join("~")).items).toHaveLength(1);
    const many = Array.from({ length: 10 }, (_, i) => `h.5.5.a.h%3A${i}`).join("~");
    expect(decodeState("c=" + many).items).toHaveLength(MAX_ITEMS);
  });
});
