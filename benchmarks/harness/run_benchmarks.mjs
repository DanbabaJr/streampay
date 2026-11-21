#!/usr/bin/env node
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(REPO_ROOT, "benchmarks/data");
const OUTPUT_FILE = path.join(DATA_DIR, "soroban_streampay.json");

console.log("================================================================================");
console.log("  STREAMPAY BENCHMARK HARNESS: RUNNING SOROBAN METERING MEASUREMENTS");
console.log("================================================================================");

try {
  const cmd = "cargo run -p streampay-contract --example protocol_benchmark -- --json";
  console.log(`Executing: ${cmd}`);
  const stdout = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

  // Find the JSON output starting from {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Failed to find JSON payload in benchmark output:\n" + stdout);
  }
  const jsonStr = stdout.slice(jsonStart).trim();
  const benchmarkData = JSON.parse(jsonStr);

  // Update measured_at
  benchmarkData.measured_at = new Date().toISOString().split("T")[0];

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(benchmarkData, null, 2) + "\n", "utf8");
  console.log(`\n✅ Benchmark metrics successfully captured & written to:\n   ${OUTPUT_FILE}`);

  console.log("\nSummary of measured operations:");
  console.table({
    create_stream: {
      cpu_instructions: benchmarkData.operations.create_stream.cpu_instructions,
      memory_bytes: benchmarkData.operations.create_stream.memory_bytes,
      event_bytes: benchmarkData.operations.create_stream.event_bytes,
    },
    withdraw: {
      cpu_instructions: benchmarkData.operations.withdraw.cpu_instructions,
      memory_bytes: benchmarkData.operations.withdraw.memory_bytes,
      event_bytes: benchmarkData.operations.withdraw.event_bytes,
    },
    withdraw_max: {
      cpu_instructions: benchmarkData.operations.withdraw_max.cpu_instructions,
      memory_bytes: benchmarkData.operations.withdraw_max.memory_bytes,
      event_bytes: benchmarkData.operations.withdraw_max.event_bytes,
    },
    cancel_stream: {
      cpu_instructions: benchmarkData.operations.cancel_stream.cpu_instructions,
      memory_bytes: benchmarkData.operations.cancel_stream.memory_bytes,
      event_bytes: benchmarkData.operations.cancel_stream.event_bytes,
    },
    storage_footprint: {
      total_bytes: benchmarkData.storage.total_persistent_entry_bytes,
      rent_stroops_per_second: benchmarkData.rent_economics.rent_stroops_per_second,
      rent_xlm_per_month: benchmarkData.rent_economics.rent_xlm_per_30d,
    },
  });
} catch (err) {
  console.error("❌ Benchmark execution failed:", err);
  process.exit(1);
}
