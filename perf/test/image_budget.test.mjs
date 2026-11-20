import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateImageSize,
  formatImageReport,
} from "../harness/check_image_budget.mjs";

const MB = 1024 * 1024;

describe("image size budget", () => {
  it("passes at or below the budget", () => {
    assert.equal(evaluateImageSize(150 * MB, 180).passed, true);
    assert.equal(evaluateImageSize(180 * MB, 180).passed, true);
  });

  it("fails when the measured size exceeds the budget", () => {
    const result = evaluateImageSize(256 * MB, 180);
    assert.equal(result.passed, false);
    assert.equal(Math.round(result.measuredMb), 256);
    assert.equal(result.allowedMb, 180);
  });

  it("applies the tolerance band to the allowed size", () => {
    const result = evaluateImageSize(200 * MB, 180, 15);
    assert.equal(Math.round(result.allowedMb), 207);
    assert.equal(result.passed, true);

    const over = evaluateImageSize(210 * MB, 180, 15);
    assert.equal(over.passed, false);
  });

  it("reports both the actual and the allowed size", () => {
    const result = evaluateImageSize(256 * MB, 180, 15);
    const report = formatImageReport({
      image: "streampay/indexer:test",
      measuredMb: result.measuredMb,
      allowedMb: result.allowedMb,
      budgetMb: 180,
      passed: result.passed,
    });

    assert.match(report, /measured 256\.0 MB/);
    assert.match(report, /allowed 207\.0 MB/);
    assert.match(report, /FAIL/);
  });
});

describe("docker baseline", () => {
  const baselinePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../baselines/docker.json"
  );
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  it("declares an indexer budget with the repo's budget schema", () => {
    const indexer = baseline.images.indexer;
    assert.equal(typeof indexer.budget, "number");
    assert.equal(typeof indexer.baseline, "number");
    assert.equal(indexer.unit, "MB");
    assert.equal(typeof indexer.tolerance_percent, "number");
  });

  it("rejects the 256 MiB bloated fixture", () => {
    const indexer = baseline.images.indexer;
    const fixtureLayerMb = 256;
    const baseImageMb = 44;
    const result = evaluateImageSize(
      (fixtureLayerMb + baseImageMb) * MB,
      indexer.budget,
      indexer.tolerance_percent
    );
    assert.equal(result.passed, false);
  });
});
