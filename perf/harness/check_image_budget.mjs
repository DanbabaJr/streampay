#!/usr/bin/env node
/**
 * Container image size budget gate (issue #543).
 *
 * Measures the uncompressed image size (`docker image inspect .Size`) and
 * compares it with the matching entry in perf/baselines/docker.json. A
 * violation fails CI with both the measured and the allowed size.
 *
 *   node perf/harness/check_image_budget.mjs --image streampay/indexer:ci --key indexer
 *   node perf/harness/check_image_budget.mjs --self-test --key indexer
 *
 * `--self-test` builds infra/docker/fixtures/Dockerfile.bloated-indexer and
 * requires the gate to reject it. A gate that cannot fail is not a gate.
 *
 * `--measured-bytes` exists so the comparison can be checked on a machine
 * without Docker; CI always measures the real image.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_BASELINE = path.join(REPO_ROOT, "perf/baselines/docker.json");
const FIXTURE_DOCKERFILE = "infra/docker/fixtures/Dockerfile.bloated-indexer";
const FIXTURE_TAG = "streampay/indexer:bloated-fixture";

const BYTES_PER_MB = 1024 * 1024;

export function evaluateImageSize(measuredBytes, budgetMb, tolerancePercent = 0) {
  const measuredMb = measuredBytes / BYTES_PER_MB;
  const allowedMb = budgetMb * (1 + tolerancePercent / 100);
  return { measuredMb, allowedMb, passed: measuredMb <= allowedMb };
}

export function formatImageReport({
  image,
  measuredMb,
  allowedMb,
  budgetMb,
  passed,
}) {
  return (
    `${image}: measured ${measuredMb.toFixed(1)} MB, ` +
    `allowed ${allowedMb.toFixed(1)} MB ` +
    `(budget ${budgetMb.toFixed(1)} MB) — ${passed ? "PASS" : "FAIL"}`
  );
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readConfig(key, baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`image budget baseline not found at ${baselinePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const config = parsed.images?.[key];
  if (!config) {
    throw new Error(`no image budget named "${key}" in ${baselinePath}`);
  }
  return config;
}

export function measureImageBytes(image) {
  const output = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", image],
    { encoding: "utf8" }
  ).trim();
  const bytes = Number(output);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`could not read the size of image ${image}`);
  }
  return bytes;
}

export function checkImage({
  image,
  budgetMb,
  tolerancePercent = 0,
  measuredBytes,
}) {
  const bytes = measuredBytes ?? measureImageBytes(image);
  const result = evaluateImageSize(bytes, budgetMb, tolerancePercent);
  console.log(
    formatImageReport({
      image,
      measuredMb: result.measuredMb,
      allowedMb: result.allowedMb,
      budgetMb,
      passed: result.passed,
    })
  );
  return result;
}

export function runSelfTest({ budgetMb, tolerancePercent }) {
  console.log(`==> Self-test: building bloated fixture ${FIXTURE_DOCKERFILE}`);
  execFileSync(
    "docker",
    ["build", "-f", FIXTURE_DOCKERFILE, "-t", FIXTURE_TAG, "."],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );

  try {
    const result = checkImage({
      image: FIXTURE_TAG,
      budgetMb,
      tolerancePercent,
    });
    if (result.passed) {
      console.error(
        "self-test FAILED: the bloated fixture fits the budget, so the gate cannot catch bloat"
      );
      return false;
    }
    console.log("self-test PASS: the bloated fixture was rejected by the budget");
    return true;
  } finally {
    try {
      execFileSync("docker", ["image", "rm", "-f", FIXTURE_TAG], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup is best effort.
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const key = argValue(argv, "--key") ?? "indexer";
  const baselinePath = argValue(argv, "--baseline") ?? DEFAULT_BASELINE;
  const config = readConfig(key, baselinePath);
  const budgetMb = Number(argValue(argv, "--budget-mb") ?? config.budget);
  const tolerancePercent = Number(
    argValue(argv, "--tolerance-percent") ?? config.tolerance_percent ?? 0
  );

  if (argv.includes("--self-test")) {
    return runSelfTest({ budgetMb, tolerancePercent }) ? 0 : 1;
  }

  const image = argValue(argv, "--image");
  if (!image) {
    console.error("usage: check_image_budget.mjs --image <tag> [--key indexer]");
    return 2;
  }

  const measuredBytes = argValue(argv, "--measured-bytes");
  const result = checkImage({
    image,
    budgetMb,
    tolerancePercent,
    measuredBytes:
      measuredBytes === undefined ? undefined : Number(measuredBytes),
  });

  if (!result.passed) {
    console.error(
      `❌ Image size budget exceeded for ${key}: ${result.measuredMb.toFixed(1)} MB > ${result.allowedMb.toFixed(1)} MB`
    );
    return 1;
  }

  console.log(`✅ ${key} image fits the size budget.`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    process.exit(main());
  } catch (error) {
    console.error("check_image_budget fatal error:", error);
    process.exit(1);
  }
}
