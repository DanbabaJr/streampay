#!/usr/bin/env node
// Dashboard-as-code validator for infra/observability/grafana/dashboards/*.json.
//
// Two jobs:
//   1. Structural sanity: the fragment parses, has the fields Grafana's file
//      provider needs, panel ids are unique, and every target carries a
//      non-empty PromQL `expr`.
//   2. The rule that matters for #542: "every panel must query a metric the
//      code actually emits, not a guess." Extract each `streampay_*` metric
//      referenced in any `expr` and assert the name appears in a metrics
//      producer module. A fabricated panel therefore fails CI, and so does a
//      panel left pointing at a metric the code later removed.
//
// Dependency-free by design: the CI quality job runs no `npm install`.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_DIR = join(ROOT, "infra", "observability", "grafana", "dashboards");

// Directories whose source is the authority for which metrics are emitted.
// Outbox/webhook metrics live in indexer/src; the indexer and reconciler
// families are produced under infra/*/src (and mirrored in their dist build).
const PRODUCER_DIRS = ["indexer/src", "infra/indexer", "infra/reconciler"];
const PRODUCER_EXT = [".ts", ".js", ".mjs", ".rs", ".go"];

const KNOWN_PANEL_TYPES = new Set([
  "row",
  "timeseries",
  "stat",
  "gauge",
  "bargauge",
  "graph",
  "table",
  "heatmap",
  "text",
  "logs",
]);

const METRIC_RE = /streampay_[a-z0-9_]+/g;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".git") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (PRODUCER_EXT.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function collectEmittedMetrics() {
  const names = new Set();
  for (const dir of PRODUCER_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      for (const m of readFileSync(file, "utf8").match(METRIC_RE) ?? []) names.add(m);
    }
  }
  return names;
}

function listDashboardFiles(dir) {
  if (!existsSync(dir)) throw new Error(`dashboard provisioning dir missing: ${relative(ROOT, dir)}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

/** @returns {string[]} human-readable errors; empty means the dashboard is valid. */
function validateDashboard(path, emitted) {
  const errors = [];
  const rel = relative(ROOT, path);
  let dash;
  try {
    dash = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [`${rel}: invalid JSON — ${e.message}`];
  }

  for (const field of ["title", "uid", "panels", "schemaVersion"]) {
    if (dash[field] === undefined) errors.push(`${rel}: missing required field "${field}"`);
  }
  if (!Array.isArray(dash.panels)) {
    errors.push(`${rel}: "panels" must be an array`);
    return errors;
  }

  const ids = new Set();
  const visit = (panel) => {
    if (panel.id !== undefined) {
      if (ids.has(panel.id)) errors.push(`${rel}: duplicate panel id ${panel.id}`);
      ids.add(panel.id);
    }
    if (panel.type === undefined) errors.push(`${rel}: panel ${panel.id ?? "?"} has no type`);
    else if (!KNOWN_PANEL_TYPES.has(panel.type)) {
      errors.push(`${rel}: panel ${panel.id} has unknown type "${panel.type}"`);
    }
    for (const target of panel.targets ?? []) {
      if (typeof target.expr !== "string" || target.expr.trim() === "") {
        errors.push(`${rel}: panel ${panel.id} has a target without a non-empty expr`);
      }
      for (const metric of typeof target.expr === "string" ? target.expr.match(METRIC_RE) ?? [] : []) {
        if (!emitted.has(metric)) {
          errors.push(`${rel}: panel ${panel.id} queries "${metric}" which no metrics module emits`);
        }
      }
    }
    for (const sub of panel.panels ?? []) visit(sub);
  };
  for (const panel of dash.panels) visit(panel);

  return errors;
}

function run(emitted) {
  const files = listDashboardFiles(DASHBOARD_DIR);
  const errors = [];
  for (const file of files) errors.push(...validateDashboard(file, emitted));
  return { files, errors };
}

function selfTest() {
  const emitted = collectEmittedMetrics();
  const tmp = join(DASHBOARD_DIR, "__selftest__.json");
  const problems = [];
  try {
    // A fabricated metric must be caught...
    writeFileSync(
      tmp,
      JSON.stringify({
        title: "x",
        uid: "x",
        schemaVersion: 38,
        panels: [{ id: 1, type: "timeseries", targets: [{ expr: "rate(streampay_this_metric_does_not_exist[5m])" }] }],
      })
    );
    const bad = validateDashboard(tmp, emitted);
    if (!bad.some((e) => e.includes("streampay_this_metric_does_not_exist"))) {
      problems.push("fabricated metric was NOT rejected");
    }
    // ...a real metric panel must pass...
    writeFileSync(
      tmp,
      JSON.stringify({
        title: "x",
        uid: "x",
        schemaVersion: 38,
        panels: [{ id: 1, type: "timeseries", targets: [{ expr: "streampay_outbox_lag_seconds" }] }],
      })
    );
    const good = validateDashboard(tmp, emitted);
    if (good.length) problems.push(`real-metric panel wrongly rejected: ${good.join("; ")}`);
    // ...and a duplicate panel id must be caught.
    writeFileSync(
      tmp,
      JSON.stringify({
        title: "x",
        uid: "x",
        schemaVersion: 38,
        panels: [
          { id: 1, type: "stat", targets: [] },
          { id: 1, type: "stat", targets: [] },
        ],
      })
    );
    const dup = validateDashboard(tmp, emitted);
    if (!dup.some((e) => e.includes("duplicate panel id"))) problems.push("duplicate panel id was NOT rejected");
  } finally {
    rmSync(tmp, { force: true });
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const emitted = collectEmittedMetrics();

  if (args.includes("--self-test")) {
    const problems = selfTest();
    if (problems.length) {
      console.error("dashboard validator self-test FAILED:\n" + problems.map((p) => "  - " + p).join("\n"));
      process.exit(1);
    }
    console.log("dashboard validator self-test passed (fabricated metric, real metric, duplicate id all handled).");
  }

  const { files, errors } = run(emitted);
  console.log(`checked ${files.length} dashboard(s) against ${emitted.size} emitted metric name(s)`);
  if (errors.length) {
    console.error("dashboard validation FAILED:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log("all dashboards valid; every queried metric is emitted by a metrics module.");
}

main();
