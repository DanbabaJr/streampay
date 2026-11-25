#!/usr/bin/env node
// Converts Lighthouse JSON reports to the gate's input. Usage:
//   node scripts/lighthouse-to-lab.mjs "/=lh-home.json" "/stream/[id]=lh-stream.json" > lab-results.json
import { readFileSync } from "node:fs";

const out = {};
for (const arg of process.argv.slice(2)) {
  const i = arg.lastIndexOf("=");
  const route = arg.slice(0, i);
  const a = JSON.parse(readFileSync(arg.slice(i + 1), "utf8")).audits;
  out[route] = {
    lcp: a["largest-contentful-paint"].numericValue,
    tbt: a["total-blocking-time"].numericValue,
    cls: a["cumulative-layout-shift"].numericValue,
  };
}
console.log(JSON.stringify(out, null, 2));
