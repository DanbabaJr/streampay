import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";

const vectorsDir = new URL("../../../sdks/vectors/", import.meta.url);
const spec = JSON.parse(
  readFileSync(new URL("../../../sdks/spec/streampay.spec.json", import.meta.url), "utf8")
) as { functions: Array<{ name: string; args: Array<{ name: string; type: unknown }> }> };

interface Vector {
  name: string;
  transactionEnvelopeXdr: string;
  resultXdr: string;
  expected: {
    transaction: { contract: string; function: string; args: Record<string, unknown> };
    result: { ok?: unknown; error?: { name: string; code: number } };
    events: Array<{ name: string; topics?: unknown; data?: unknown }>;
  };
}

const BATCH_NAMES = new Set([
  "batch-withdraw-success",
  "batch-withdraw-partial",
  "error-batch-withdraw-empty",
  "error-batch-withdraw-unknown-strict",
  "claim-all-success",
  "claim-all-partial",
]);

const vectors = readdirSync(vectorsDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(new URL(file, vectorsDir), "utf8")) as Vector)
  .filter((vector) => BATCH_NAMES.has(vector.name));

const toScVal = (type: unknown, value: unknown): xdr.ScVal => {
  if (typeof type !== "string") {
    const specType = type as unknown as { option?: unknown; vec?: string };
    if (specType.option !== undefined) return nativeToScVal(value);
    if (specType.vec !== undefined) {
      return nativeToScVal(
        (value as string[]).map((item) => BigInt(item)),
        { type: specType.vec as "u32" | "u64" | "i128" }
      );
    }
    throw new Error(`unsupported spec argument type ${JSON.stringify(specType)}`);
  }
  if (type === "address") {
    return nativeToScVal(Address.fromString(String(value)), { type: "address" });
  }
  if (type === "bool") return nativeToScVal(Boolean(value));
  if (type === "vec:u64") {
    return nativeToScVal((value as string[]).map((item) => BigInt(item)), { type: "u64" });
  }
  if (type.startsWith("option:")) return nativeToScVal(value);
  return nativeToScVal(BigInt(String(value)), { type: type as "u32" | "u64" | "i128" });
};

test("batch and claim-all conformance vectors are complete", () => {
  assert.deepEqual(
    vectors.map((vector) => vector.name).sort(),
    [...BATCH_NAMES].sort()
  );
});

test("CLI envelope encoding reproduces every batch vector", () => {
  for (const vector of vectors) {
    const { contract, function: fn, args } = vector.expected.transaction;
    const fnSpec = spec.functions.find((candidate) => candidate.name === fn);
    assert.ok(fnSpec, `${vector.name}: ${fn} is not in the spec`);

    const operation = new Contract(contract).call(
      fn,
      ...fnSpec.args.map((arg) =>
        toScVal(arg.type, args[arg.name])
      )
    );
    const tx = TransactionBuilder.fromXDR(vector.transactionEnvelopeXdr, Networks.TESTNET);
    const recorded = tx.operations[0] as unknown as {
      func: { toXDR(format: "base64"): string };
    };
    assert.equal(
      recorded.func.toXDR("base64"),
      (
        operation as unknown as {
          body: { value: { hostFunction: { toXDR(format: "base64"): string } } };
        }
      ).body.value.hostFunction.toXDR("base64"),
      `${vector.name} envelope drifted`
    );
  }
});

test("batch vector result and error XDR remain directly decodable", () => {
  for (const vector of vectors) {
    const result = xdr.ScVal.fromXDR(vector.resultXdr, "base64");
    if (vector.expected.result.error !== undefined) {
      const bytes = Buffer.from(vector.resultXdr, "base64");
      assert.equal(bytes.readUInt32BE(0), 2, `${vector.name}: expected SCV_ERROR`);
      assert.equal(bytes.readUInt32BE(8), vector.expected.result.error.code);
      continue;
    }
    assert.ok(scValToNative(result) !== undefined, `${vector.name}: missing result value`);
  }
});
