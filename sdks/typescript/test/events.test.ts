import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeEventXdr } from "../src/events.js";
import type { VectorFile } from "../src/vectors.js";

const vectorsDir = fileURLToPath(new URL("../../../vectors/", import.meta.url));

function vector(name: string): VectorFile {
  return JSON.parse(readFileSync(join(vectorsDir, `${name}.json`), "utf8")) as VectorFile;
}

test("decodes typed StreamCreated event fields", () => {
  const source = vector("create-stream");
  const event = decodeEventXdr(source.eventsXdr[0]!);
  assert.ok(event);
  assert.equal(event.type, "StreamCreated");
  assert.equal(event.streamId, 1n);
  assert.equal(event.deposit, 10_000_000_000n);
  assert.equal(event.cancelable, false);
  const expected = source.expected as { events: Array<{ contract: string }> };
  assert.equal(event.contractId, expected.events[0]!.contract);
});

test("decodes cancellation payouts", () => {
  const event = decodeEventXdr(vector("cancel-stream").eventsXdr[0]!);
  assert.ok(event);
  assert.equal(event.type, "StreamCancelled");
  assert.equal(event.recipientAmount, 1_999_999_000n);
  assert.equal(event.senderAmount, 8_000_000_000n);
});

test("malformed XDR is a decode failure, not a silent null", () => {
  assert.throws(() => decodeEventXdr("not-xdr"), /decode failed/);
});
