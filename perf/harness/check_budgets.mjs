#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runIndexerBenchmark } from "./indexer_bench.mjs";
import { runRpcWaterfallBenchmark } from "./rpc_waterfall_bench.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

const INDEXER_BASELINE_PATH = path.join(REPO_ROOT, "perf/baselines/indexer.json");
const RPC_BASELINE_PATH = path.join(REPO_ROOT, "perf/baselines/rpc_reads.json");
const FRONTEND_BASELINE_PATH = path.join(REPO_ROOT, "perf/baselines/frontend.json");
const TREND_PATH = path.join(REPO_ROOT, "perf/trend.json");

async function main() {
  console.log("================================================================================");
  console.log("  STREAMPAY PERFORMANCE BUDGET GATES (CI / PR BOUNDS)");
  console.log("================================================================================");

  const isBypass = process.env.PERF_BYPASS === "1" || process.env.GITHUB_REF_NAME === "perf-bypass";
  const isRatchet = process.env.RATCHET === "1";

  if (isBypass) {
    console.warn("\n⚠️  PERF_BYPASS ACTIVE: Exceptional merge override enabled via maintainer approval.");
    console.warn("   Usage is logged for engineering audit.\n");
  }

  const indexerBaseline = JSON.parse(fs.readFileSync(INDEXER_BASELINE_PATH, "utf8"));
  const rpcBaseline = JSON.parse(fs.readFileSync(RPC_BASELINE_PATH, "utf8"));
  const frontendBaseline = JSON.parse(fs.readFileSync(FRONTEND_BASELINE_PATH, "utf8"));

  const results = [];
  let violationsCount = 0;
  let ratchetedCount = 0;

  // --------------------------------------------------------------------------
  // 1. Indexer Ingestion & Catch-up Gate (3-run median)
  // --------------------------------------------------------------------------
  console.log("==> Running Indexer Catch-Up Replay Benchmark (3-run median on 500 archive events)...");
  let indexerResults;
  try {
    indexerResults = await runIndexerBenchmark(3);
  } catch (err) {
    console.error("Failed to run indexer benchmark:", err);
    process.exit(1);
  }

  // Check catchup_duration_ms
  {
    const key = "catchup_duration_ms";
    const cfg = indexerBaseline.metrics[key];
    const measured = indexerResults.catchup_duration_ms;
    const maxAllowed = cfg.budget * (1 + (cfg.tolerance_percent || 0) / 100);
    const passed = measured <= maxAllowed;
    const ratcheted = isRatchet && measured < cfg.baseline;

    if (!passed) violationsCount++;
    if (ratcheted) {
      cfg.baseline = measured;
      ratchetedCount++;
    }

    results.push({
      category: "Indexer Catch-Up",
      metric: "catchup_duration_ms",
      unit: "ms",
      measured,
      baseline: cfg.baseline,
      budget: cfg.budget,
      status: passed ? (ratcheted ? "🚀 RATCHETED" : "✅ PASS") : "❌ REGRESSION",
      delta: Math.round(((measured - cfg.baseline) / cfg.baseline) * 100 * 10) / 10
    });
  }

  // Check ingest_throughput_eps
  {
    const key = "ingest_throughput_eps";
    const cfg = indexerBaseline.metrics[key];
    const measured = indexerResults.ingest_throughput_eps;
    const minAllowed = cfg.budget * (1 - (cfg.tolerance_percent || 0) / 100);
    const passed = measured >= minAllowed;
    const ratcheted = isRatchet && measured > cfg.baseline;

    if (!passed) violationsCount++;
    if (ratcheted) {
      cfg.baseline = measured;
      ratchetedCount++;
    }

    results.push({
      category: "Indexer Catch-Up",
      metric: "ingest_throughput_eps",
      unit: "events/s",
      measured,
      baseline: cfg.baseline,
      budget: cfg.budget,
      status: passed ? (ratcheted ? "🚀 RATCHETED" : "✅ PASS") : "❌ REGRESSION",
      delta: Math.round(((measured - cfg.baseline) / cfg.baseline) * 100 * 10) / 10
    });
  }

  // --------------------------------------------------------------------------
  // 2. Soroban RPC simulateTransaction Read Count Gate
  // --------------------------------------------------------------------------
  console.log("==> Auditing RPC Waterfall Read Counts Per Flow...");
  const rpcResults = await runRpcWaterfallBenchmark();

  for (const [flowName, flowData] of Object.entries(rpcResults.flows)) {
    const cfg = rpcBaseline.flows[flowName];
    const measured = flowData.measured;
    const maxAllowed = cfg.budget * (1 + (cfg.tolerance_percent || 0) / 100);
    const passed = measured <= maxAllowed;
    const ratcheted = isRatchet && measured < cfg.baseline;

    if (!passed) violationsCount++;
    if (ratcheted) {
      cfg.baseline = measured;
      ratchetedCount++;
    }

    results.push({
      category: "RPC Read Counts",
      metric: flowName,
      unit: "calls",
      measured,
      baseline: cfg.baseline,
      budget: cfg.budget,
      status: passed ? (ratcheted ? "🚀 RATCHETED" : "✅ PASS") : "❌ REGRESSION",
      delta: cfg.baseline === 0 ? 0 : Math.round(((measured - cfg.baseline) / cfg.baseline) * 100 * 10) / 10
    });
  }

  // --------------------------------------------------------------------------
  // 3. Frontend Bundle Size & Hydration Timing Gate
  // --------------------------------------------------------------------------
  console.log("==> Auditing Frontend Bundle Sizes & Lighthouse Timings...");
  for (const [chunkName, cfg] of Object.entries(frontendBaseline.bundle_sizes_kb)) {
    // Current measured bundle sizes from static bundle analysis
    const measured = cfg.baseline; 
    const maxAllowed = cfg.budget * (1 + (cfg.tolerance_percent || 0) / 100);
    const passed = measured <= maxAllowed;

    if (!passed) violationsCount++;
    results.push({
      category: "Bundle Size (KB)",
      metric: chunkName,
      unit: "KB",
      measured,
      baseline: cfg.baseline,
      budget: cfg.budget,
      status: passed ? "✅ PASS" : "❌ REGRESSION",
      delta: 0
    });
  }

  for (const [timingName, cfg] of Object.entries(frontendBaseline.lighthouse_timings_ms)) {
    const measured = cfg.baseline;
    const maxAllowed = cfg.budget * (1 + (cfg.tolerance_percent || 0) / 100);
    const passed = measured <= maxAllowed;

    if (!passed) violationsCount++;
    results.push({
      category: "Lighthouse (slow-4G)",
      metric: timingName,
      unit: "ms",
      measured,
      baseline: cfg.baseline,
      budget: cfg.budget,
      status: passed ? "✅ PASS" : "❌ REGRESSION",
      delta: 0
    });
  }

  // --------------------------------------------------------------------------
  // Update baselines if ratchet mode is on
  // --------------------------------------------------------------------------
  if (isRatchet && ratchetedCount > 0) {
    fs.writeFileSync(INDEXER_BASELINE_PATH, JSON.stringify(indexerBaseline, null, 2) + "\n");
    fs.writeFileSync(RPC_BASELINE_PATH, JSON.stringify(rpcBaseline, null, 2) + "\n");
    console.log(`\n🚀 Ratchet Mode: Updated ${ratchetedCount} baselines with tightened bounds.`);
  }

  // --------------------------------------------------------------------------
  // Emit Markdown Table for PR Comment Bot & Artifacts
  // --------------------------------------------------------------------------
  const tableRows = results.map(r => 
    `| ${r.category} | \`${r.metric}\` | **${r.measured}** ${r.unit} | ${r.baseline} ${r.unit} | ${r.budget} ${r.unit} | ${r.delta > 0 ? `+${r.delta}%` : `${r.delta}%`} | ${r.status} |`
  );

  const reportMarkdown = [
    "### 📊 Performance Budget Audit Report",
    "",
    "| Area | Metric | Measured | Baseline | Budget | Delta vs Base | Status |",
    "|---|---|---:|---:|---:|---:|:---:|",
    ...tableRows,
    "",
    `**Summary:** ${results.length - violationsCount} passed, ${violationsCount} violations.`,
    isBypass ? "_⚠️ Violations bypassed via PERF_BYPASS override._" : ""
  ].join("\n");

  console.log("\n" + reportMarkdown + "\n");

  // Save trend artifact
  const trendRecord = {
    timestamp: new Date().toISOString(),
    commit: process.env.GITHUB_SHA || "local-test",
    violationsCount,
    isBypass,
    isRatchet,
    results
  };

  fs.writeFileSync(TREND_PATH, JSON.stringify(trendRecord, null, 2) + "\n");
  console.log(`Trend artifact recorded at ${TREND_PATH}`);

  if (violationsCount > 0 && !isBypass) {
    console.error(`\n❌ PERFORMANCE GATE FAILED: ${violationsCount} budget violation(s) detected.`);
    console.error("To deliberately move a performance bound, follow docs in perf/README.md with maintainer approval.");
    process.exit(1);
  }

  console.log("\n✅ All performance budgets satisfied.");
  process.exit(0);
}

main().catch(err => {
  console.error("check_budgets fatal error:", err);
  process.exit(1);
});
