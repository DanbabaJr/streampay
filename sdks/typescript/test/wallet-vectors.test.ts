import assert from "node:assert/strict";
import { test } from "node:test";
import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { MockWalletAdapter } from "./mock-wallet.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_FINGERPRINT } from "../src/generated.js";
import { decodeVector, type VectorFile } from "../src/vectors.js";

const vectorsDir = fileURLToPath(new URL("../../../vectors/", import.meta.url));
const files = readdirSync(vectorsDir).filter((name) => name.endsWith(".json"));

test("mock-wallet vector suite round-trips the shared transaction envelopes", async () => {
  const wallet = new MockWalletAdapter();
  await wallet.connect(wallet.id, { networkPassphrase: Networks.TESTNET });
  for (const file of files) {
    const vector = JSON.parse(readFileSync(join(vectorsDir, file), "utf8")) as VectorFile;
    assert.equal(vector.specFingerprint, SPEC_FINGERPRINT, `${file} uses a different spec`);
    assert.deepEqual(decodeVector(vector), vector.expected, `${file} canonical decode drifted`);
    const signed = await wallet.signTransaction(vector.transactionEnvelopeXdr, {
      networkPassphrase: Networks.TESTNET,
    });
    const parsed = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
    assert.ok(parsed.toEnvelope().v1().signatures().length > 0, `${file} did not get signed`);
  }
});
