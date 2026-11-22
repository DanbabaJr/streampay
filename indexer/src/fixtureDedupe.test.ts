import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { findDuplicateEventFixtures, listIndexerFiles, CANONICAL_FIXTURE } from "./fixtureDedupeGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The compiled test lives at indexer/dist/..., so the package root is one up.
const INDEXER_ROOT = path.resolve(__dirname, "..");
const canonicalAbs = path.resolve(INDEXER_ROOT, "fixtures/events-fixture.json");

describe("event-fixture dedupe guard (issue #546)", () => {
  it("keeps exactly one events-fixture.json in the indexer tree", () => {
    const files = listIndexerFiles(INDEXER_ROOT);
    const duplicates = findDuplicateEventFixtures(files);
    assert.deepEqual(
      duplicates,
      [],
      `duplicate event fixture copies reappeared: ${duplicates.join(", ")} — the canonical is ${CANONICAL_FIXTURE}`
    );
  });

  it("ships the canonical fixture and no test/ copy", () => {
    assert.ok(fs.existsSync(canonicalAbs), `canonical fixture missing: ${canonicalAbs}`);
    const testCopy = path.resolve(INDEXER_ROOT, "test/events-fixture.json");
    assert.ok(
      !fs.existsSync(testCopy),
      `deprecated second copy reappeared at ${testCopy}; delete it and import the canonical fixture`
    );
  });

  // Self-test: the detector must actually fire on a re-added copy — a guard
  // that silently stopped scanning would otherwise report "clean" forever.
  it("self-test: detector flags a re-added copy and any stray basename", () => {
    assert.deepEqual(
      findDuplicateEventFixtures([
        "indexer/fixtures/events-fixture.json",
        "indexer/test/events-fixture.json",
      ]),
      ["indexer/test/events-fixture.json"]
    );
    // A brand-new location counts too, not just the known deprecated path.
    assert.deepEqual(
      findDuplicateEventFixtures([
        "indexer/fixtures/events-fixture.json",
        "indexer/src/generated/events-fixture.json",
      ]),
      ["indexer/src/generated/events-fixture.json"]
    );
    // Canonical alone is clean; unrelated files are ignored.
    assert.deepEqual(findDuplicateEventFixtures(["indexer/fixtures/events-fixture.json"]), []);
    assert.deepEqual(findDuplicateEventFixtures(["indexer/fixtures/stream-created.json"]), []);
  });
});
