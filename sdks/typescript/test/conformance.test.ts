import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SPEC_FINGERPRINT } from "../src/generated.js";
import { decodeVector, type VectorFile } from "../src/vectors.js";

const vectorsDir = fileURLToPath(new URL("../../../vectors/", import.meta.url));
const files = readdirSync(vectorsDir).filter((name) => name.endsWith(".json"));

test("the vector suite is present", () => {
  assert.ok(files.length >= 5, `expected vectors in ${vectorsDir}, found ${files.length}`);
});

test("every vector decodes to its expected canonical JSON", () => {
  for (const file of files) {
    const vector = JSON.parse(readFileSync(join(vectorsDir, file), "utf8")) as VectorFile;
    assert.equal(
      vector.specFingerprint,
      SPEC_FINGERPRINT,
      `${file} was generated from a different spec fingerprint`
    );
    assert.deepEqual(decodeVector(vector), vector.expected, `${file} drifted`);
  }
});

test("batch-withdraw vectors pin the event schema shape", () => {
  const schema = JSON.parse(
    readFileSync(
      join(fileURLToPath(new URL("../../../../", import.meta.url)), "schemas/events/v1/events/batch_withdraw_summary.json"),
      "utf8"
    )
  ) as {
    required: string[];
    properties: Record<string, unknown>;
  };

  const batchVectors = files.filter((file) => file.startsWith("batch-withdraw-"));
  assert.ok(batchVectors.length >= 2);

  for (const file of batchVectors) {
    const vector = JSON.parse(readFileSync(join(vectorsDir, file), "utf8")) as
      VectorFile & {
        expected: {
          events: Array<{ name: string; data: Record<string, unknown> }>;
        };
      };
    for (const event of vector.expected.events) {
      if (event.name !== "BatchWithdrawSummary") continue;
      assert.deepEqual(Object.keys(event.data).sort(), [...schema.required].sort());
      for (const settled of (event.data.settled as Array<Record<string, unknown>>)) {
        assert.deepEqual(Object.keys(settled).sort(), ["amount", "stream_id"]);
      }
    }
  }
});
