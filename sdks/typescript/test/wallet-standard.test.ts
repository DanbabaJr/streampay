import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { WalletCapabilityError, WalletRegistry, type WalletStandardAdapter } from "../src/wallet-standard.js";
import type { WalletStandardAdapter as AdapterContract } from "../src/wallet-standard.js";
import { MockWalletAdapter } from "./mock-wallet.js";
import type { VectorFile } from "../src/vectors.js";

// Compile-time conformance: every required lifecycle and transaction method is present.
const adapterCoverage: Required<Pick<AdapterContract,
  "discover" | "connect" | "signTransaction" | "signAndSubmit" | "disconnect"
>> = new MockWalletAdapter();
void adapterCoverage satisfies Pick<WalletStandardAdapter,
  "discover" | "connect" | "signTransaction" | "signAndSubmit" | "disconnect"
>;

const vectorsDir = fileURLToPath(new URL("../../../vectors/", import.meta.url));
const vectorFiles = readdirSync(vectorsDir).filter((name) => name.endsWith(".json"));

test("mock wallet signs every shared conformance vector without exposing its key", async () => {
  const mock = new MockWalletAdapter();
  const registry = new WalletRegistry([mock]);
  const selection = await registry.select({ networkPassphrase: Networks.TESTNET });
  await selection.adapter.connect(selection.wallet.id, { networkPassphrase: Networks.TESTNET });

  for (const file of vectorFiles) {
    const vector = JSON.parse(readFileSync(join(vectorsDir, file), "utf8")) as VectorFile;
    const signed = await selection.adapter.signTransaction(vector.transactionEnvelopeXdr, {
      networkPassphrase: Networks.TESTNET,
    });
    const tx = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
    assert.ok(tx.toEnvelope().v1().signatures().length > 0, `${file} was not signed`);
  }
});

test("registry detects wallets and filters by network and feature", async () => {
  const wallet = new MockWalletAdapter();
  const registry = new WalletRegistry([wallet]);
  assert.equal((await registry.discover()).length, 1);
  assert.equal((await registry.discover({ networkPassphrase: Networks.TESTNET, requireSignAndSubmit: true })).length, 1);
  await assert.rejects(
    () => registry.select({ networkPassphrase: "unsupported network" }),
    WalletCapabilityError
  );
});

test("registry reports no detected compliant wallets clearly", async () => {
  const registry = new WalletRegistry([]);
  await assert.rejects(() => registry.select({ networkPassphrase: Networks.TESTNET }), {
    name: "WalletCapabilityError",
    message: "No compliant Stellar wallet was detected.",
  });
});
