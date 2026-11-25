#!/usr/bin/env node
// CI lab gate. Usage:
//   node scripts/rum-budget-gate.mjs --measured lab-results.json
// lab-results.json: { "/": { "lcp": ms, "tbt": ms, "cls": n }, "/stream/[id]": {...} }
// (produce it from Lighthouse; see docs/RUM.md). Exits 1 on any failure.
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate } from "./rum-gate-lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const measuredPath = flag("--measured");
if (!measuredPath) {
  console.error("usage: rum-budget-gate.mjs --measured <file> [--update-baseline]");
  process.exit(2);
}
const budgets = JSON.parse(readFileSync(new URL("../rum/budgets.json", import.meta.url), "utf8")).lab;
const baselineUrl = new URL("../rum/lab-baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselineUrl, "utf8"));
const measured = JSON.parse(readFileSync(measuredPath, "utf8"));

if (args.includes("--update-baseline")) {
  writeFileSync(baselineUrl, JSON.stringify(measured, null, 2) + "\n");
  console.log("baseline updated");
  process.exit(0);
}
const { ok, failures } = evaluate(measured, budgets, baseline);
if (!ok) {
  console.error("RUM lab budget gate FAILED:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("RUM lab budget gate passed");
