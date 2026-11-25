import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../scripts/rum-gate-lib.mjs";
import file from "../rum/budgets.json";
import baseline from "../rum/lab-baseline.json";

const budgets = file.lab;
const good = {
  "/": { lcp: 1850, tbt: 125, cls: 0.01 },
  "/stream/[id]": { lcp: 2050, tbt: 150, cls: 0.02 },
};

describe("lab budget gate self-tests (a regression must fail)", () => {
  it("passes when within budget and tolerance", () => {
    expect(evaluate(good, budgets, baseline).ok).toBe(true);
  });
  it("fails on LCP regression beyond tolerance even if under absolute budget", () => {
    const r = evaluate({ ...good, "/": { ...good["/"], lcp: 2500 } }, budgets, baseline);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toContain("regressed vs baseline");
  });
  it("fails when the absolute budget is exceeded", () => {
    const r = evaluate({ ...good, "/": { ...good["/"], lcp: 3500 } }, budgets, baseline);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toContain("exceeds budget");
  });
  it("fails on TBT and CLS regressions", () => {
    expect(evaluate({ ...good, "/": { ...good["/"], tbt: 400 } }, budgets, baseline).ok).toBe(false);
    expect(evaluate({ ...good, "/": { ...good["/"], cls: 0.2 } }, budgets, baseline).ok).toBe(false);
  });
  it("fails on a missing measurement", () => {
    expect(evaluate({ "/": { lcp: 1800, tbt: 120 } as never }, budgets, baseline).ok).toBe(false);
  });
  it("CLI exits non-zero on regression and zero on pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "rum-"));
    const bad = join(dir, "bad.json");
    const okf = join(dir, "ok.json");
    writeFileSync(bad, JSON.stringify({ ...good, "/": { lcp: 9000, tbt: 120, cls: 0.01 } }));
    writeFileSync(okf, JSON.stringify(good));
    const run = (f: string) => spawnSync("node", ["scripts/rum-budget-gate.mjs", "--measured", f], { encoding: "utf8" });
    expect(run(bad).status).toBe(1);
    expect(run(okf).status).toBe(0);
    void execFileSync;
  });
});
