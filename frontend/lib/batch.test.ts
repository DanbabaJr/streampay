import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseBatchCsv } from "./batch.ts";

describe("parseBatchCsv", () => {
  it("parses a header and computes the funded amount with integer math", () => {
    assert.deepEqual(
      parseBatchCsv("address,rate,duration\r\nGrecipient,25,3600"),
      [{ recipient: "Grecipient", deposit: "90000", duration: "3600" }]
    );
  });

  it("rejects non-positive or fractional values", () => {
    assert.throws(() => parseBatchCsv("Grecipient,0,10"), /must be positive/);
    assert.throws(() => parseBatchCsv("Grecipient,1.5,10"), /whole numbers/);
  });

  it("rejects a deposit that exceeds the contract's i128 range", () => {
    assert.throws(
      () => parseBatchCsv(`Grecipient,${1n << 126n},2`),
      /i128 deposit limit/
    );
  });

  it("rejects durations longer than the contract maximum", () => {
    assert.throws(() => parseBatchCsv("Grecipient,1,3155760001"), /100-year stream limit/);
  });

  it("rejects malformed and empty batches", () => {
    assert.throws(() => parseBatchCsv("Grecipient,10"), /expected address/);
    assert.throws(() => parseBatchCsv(" \n"), /at least one CSV row/);
  });
});
