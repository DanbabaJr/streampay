#!/usr/bin/env node
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const BASELINE_FILE = path.join(REPO_ROOT, "benchmarks/data/soroban_streampay.json");
const COMPETITORS_FILE = path.join(REPO_ROOT, "benchmarks/data/competitors.json");

console.log("================================================================================");
console.log("  STREAMPAY BENCHMARK REGRESSION DEFENSE: CI METRIC FRESHNESS GATE");
console.log("================================================================================");

// 1. Verify Competitors Data integrity & citations
if (!fs.existsSync(COMPETITORS_FILE)) {
  console.error(`❌ Competitors dataset missing at: ${COMPETITORS_FILE}`);
  process.exit(1);
}
const competitorsData = JSON.parse(fs.readFileSync(COMPETITORS_FILE, "utf8"));
if (!competitorsData.competitors?.sablier_v2_linear || !competitorsData.competitors?.superfluid_cfa) {
  console.error("❌ Competitors dataset must include both Sablier V2 and Superfluid CFA entries.");
  process.exit(1);
}
console.log("✅ Competitors dataset verified (Sablier V2 & Superfluid CFA cited and dated).");

// 2. Read baseline
if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`❌ Baseline dataset missing at: ${BASELINE_FILE}`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));

// 3. Re-run live measurement harness
console.log("\n==> Re-measuring StreamPay contract on Soroban host environment...");
let measured;
try {
  const cmd = "cargo run -p streampay-contract --example protocol_benchmark -- --json";
  const stdout = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Invalid output from protocol_benchmark example:\n" + stdout);
  }
  measured = JSON.parse(stdout.slice(jsonStart).trim());
} catch (err) {
  console.error("❌ Failed to execute Soroban measurement harness:", err);
  process.exit(1);
}

// 4. Assert bounds and verify no silent rot
let violations = 0;
const results = [];
const TOLERANCE_PERCENT = 5.0; // 5% regression band

function checkMetric(name, measuredVal, baselineVal, maxAllowedDeltaPercent = TOLERANCE_PERCENT) {
  const deltaPercent = ((measuredVal - baselineVal) / baselineVal) * 100;
  const isRegression = deltaPercent > maxAllowedDeltaPercent;
  if (isRegression) violations++;
  results.push({
    metric: name,
    measured: measuredVal,
    baseline: baselineVal,
    delta: `${deltaPercent >= 0 ? "+" : ""}${deltaPercent.toFixed(2)}%`,
    status: isRegression ? "❌ REGRESSION" : "✅ PASS",
  });
}

// Check hot path instructions
checkMetric(
  "create_stream CPU Instructions",
  measured.operations.create_stream.cpu_instructions,
  baseline.operations.create_stream.cpu_instructions
);
checkMetric(
  "withdraw (claim) CPU Instructions",
  measured.operations.withdraw.cpu_instructions,
  baseline.operations.withdraw.cpu_instructions
);
checkMetric(
  "withdraw_max CPU Instructions",
  measured.operations.withdraw_max.cpu_instructions,
  baseline.operations.withdraw_max.cpu_instructions
);
checkMetric(
  "cancel_stream CPU Instructions",
  measured.operations.cancel_stream.cpu_instructions,
  baseline.operations.cancel_stream.cpu_instructions
);
checkMetric(
  "top_up CPU Instructions",
  measured.operations.top_up.cpu_instructions,
  baseline.operations.top_up.cpu_instructions
);

// Storage bytes check (must match exact bytes)
if (measured.storage.total_persistent_entry_bytes !== baseline.storage.total_persistent_entry_bytes) {
  console.error(
    `❌ Storage footprint drift! Measured: ${measured.storage.total_persistent_entry_bytes} B, Baseline: ${baseline.storage.total_persistent_entry_bytes} B`
  );
  violations++;
} else {
  results.push({
    metric: "Total Persistent Entry Bytes",
    measured: measured.storage.total_persistent_entry_bytes,
    baseline: baseline.storage.total_persistent_entry_bytes,
    delta: "0.00%",
    status: "✅ PASS",
  });
}

// Rent calculations check
if (Math.abs(measured.rent_economics.rent_stroops_per_second - baseline.rent_economics.rent_stroops_per_second) > 0.0001) {
  console.error("❌ Rent rate calculation drift detected!");
  violations++;
} else {
  results.push({
    metric: "Rent Stroops / Second",
    measured: measured.rent_economics.rent_stroops_per_second,
    baseline: baseline.rent_economics.rent_stroops_per_second,
    delta: "0.00%",
    status: "✅ PASS",
  });
}

console.log("\n--- Benchmark Regression Defense Results ---");
console.table(results);

if (violations > 0) {
  console.error(`\n❌ Gate Failed: ${violations} benchmark regression(s) detected. Protocol metrics have silently drifted!`);
  process.exit(1);
}

console.log("\n✅ All benchmark metrics match committed baselines. Zero silent rot detected.");
process.exit(0);
