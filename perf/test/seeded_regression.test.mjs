import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

describe("Performance Budget CI Gate — Regression Defense & Noise Policy", () => {
  const rpcBaselinePath = path.join(REPO_ROOT, "perf/baselines/rpc_reads.json");
  const originalRpcBaseline = fs.readFileSync(rpcBaselinePath, "utf8");

  it("passes cleanly when all metrics satisfy established budgets", () => {
    const cmd = `node perf/harness/check_budgets.mjs`;
    const output = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.match(output, /All performance budgets satisfied/);
    assert.match(output, /12 passed, 0 violations/);
  });

  it("fails the gate when a seeded RPC read regression exceeds budget", () => {
    try {
      // Seed a deliberate regression: set budget of cold_stream_detail to 1 (current measured is 2)
      const data = JSON.parse(originalRpcBaseline);
      data.flows.cold_stream_detail.budget = 1;
      data.flows.cold_stream_detail.tolerance_percent = 0;
      fs.writeFileSync(rpcBaselinePath, JSON.stringify(data, null, 2) + "\n");

      // Running check_budgets must exit non-zero (code 1)
      let threw = false;
      try {
        execSync(`node perf/harness/check_budgets.mjs`, { cwd: REPO_ROOT, encoding: "utf8" });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1);
        const stderrAndStdout = (err.stdout || "") + (err.stderr || "");
        assert.match(stderrAndStdout, /PERFORMANCE GATE FAILED/);
        assert.match(stderrAndStdout, /cold_stream_detail.*REGRESSION/);
      }
      assert.equal(threw, true, "check_budgets should have failed on seeded RPC read count regression");
    } finally {
      // Restore pristine baseline
      fs.writeFileSync(rpcBaselinePath, originalRpcBaseline);
    }
  });

  it("allows emergency bypass when PERF_BYPASS=1 is provided with maintainer approval", () => {
    try {
      // Seed regression again
      const data = JSON.parse(originalRpcBaseline);
      data.flows.cold_stream_detail.budget = 1;
      fs.writeFileSync(rpcBaselinePath, JSON.stringify(data, null, 2) + "\n");

      // Run with PERF_BYPASS=1
      const output = execSync(`node perf/harness/check_budgets.mjs`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PERF_BYPASS: "1" }
      });

      assert.match(output, /Violations bypassed via PERF_BYPASS override/);
      assert.match(output, /All performance budgets satisfied/);
    } finally {
      // Restore pristine baseline
      fs.writeFileSync(rpcBaselinePath, originalRpcBaseline);
    }
  });
});
