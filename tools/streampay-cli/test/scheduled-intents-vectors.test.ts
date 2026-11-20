import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

// Parity of the CLI's transaction encoding with the shared conformance
// vectors for scheduled intents (sdks/vectors, issue #495). The CLI has no
// scheduling commands yet, so this asserts the encoding rule its operation
// builders use (`new Contract(id).call(fn, ...nativeToScVal(arg, spec type))`)
// reproduces every recorded scheduled-intent envelope byte for byte, and that
// the recorded error codes agree with the CLI-visible error catalog.
const vectorsDir = new URL("../../../sdks/vectors/", import.meta.url);
const spec = JSON.parse(
  readFileSync(new URL("../../../sdks/spec/streampay.spec.json", import.meta.url), "utf8")
) as { functions: Array<{ name: string; args: Array<{ name: string; type: string }> }> };
const catalog = readFileSync(new URL("../../../frontend/lib/errors.ts", import.meta.url), "utf8");

const SCHEDULED_FUNCTIONS = new Set([
  "schedule_stream",
  "execute_scheduled",
  "cancel_scheduled",
  "reclaim_expired",
]);

interface Vector {
  name: string;
  transactionEnvelopeXdr: string;
  expected: {
    transaction: { contract: string; function: string; args: Record<string, string | boolean> };
    result: { ok?: unknown; error?: { name: string; code: number } };
    events: Array<{ name: string }>;
  };
}

const vectors = readdirSync(vectorsDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(new URL(file, vectorsDir), "utf8")) as Vector)
  .filter((vector) => SCHEDULED_FUNCTIONS.has(vector.expected.transaction.function));

const toScVal = (type: string, value: string | boolean) =>
  type === "address"
    ? nativeToScVal(Address.fromString(String(value)), { type: "address" })
    : type === "bool"
      ? nativeToScVal(Boolean(value))
      : nativeToScVal(BigInt(String(value)), { type: type as "u32" | "u64" | "i128" });

test("every scheduled-intent lifecycle outcome has a vector", () => {
  const names = vectors.map((vector) => vector.name).sort();
  assert.deepEqual(names, [
    "cancel-scheduled",
    "error-intent-not-cancellable",
    "error-intent-not-expired",
    "error-intent-not-pending",
    "error-intent-not-yet-executable",
    "execute-scheduled",
    "reclaim-expired",
    "schedule-stream",
  ]);
});

test("CLI encoding reproduces every scheduled-intent vector envelope", () => {
  for (const vector of vectors) {
    const { contract, function: fn, args } = vector.expected.transaction;
    const fnSpec = spec.functions.find((candidate) => candidate.name === fn);
    assert.ok(fnSpec, `${vector.name}: ${fn} is not in the spec`);
    const expected = new Contract(contract).call(
      fn,
      ...fnSpec.args.map((arg) => toScVal(arg.type, args[arg.name] as string | boolean))
    );
    const tx = TransactionBuilder.fromXDR(vector.transactionEnvelopeXdr, Networks.TESTNET);
    const operation = tx.operations[0] as unknown as { func: { toXDR(f: "base64"): string } };
    const expectedFunc = (
      expected as unknown as {
        body: { value: { hostFunction: { toXDR(f: "base64"): string } } };
      }
    ).body.value.hostFunction;
    assert.equal(
      operation.func.toXDR("base64"),
      expectedFunc.toXDR("base64"),
      `${vector.name} envelope drifted`
    );
  }
});

test("recorded scheduled-intent error codes match the error catalog", () => {
  for (const vector of vectors) {
    const error = vector.expected.result.error;
    if (error === undefined) continue;
    assert.match(
      catalog,
      new RegExp(`${error.code}:\\s*\\{\\s*code:\\s*${error.code},\\s*name:\\s*"${error.name}"`),
      `${vector.name}: ${error.name} (${error.code}) is not in frontend/lib/errors.ts`
    );
  }
});
