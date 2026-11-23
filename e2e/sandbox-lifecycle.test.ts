import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicWallet,
  injectDeterministicFreighterScript,
} from "./deterministic-signer.ts";

describe("Deterministic Sandbox Signer Bypass", () => {
  it("generates deterministic keypairs for sender and recipient", () => {
    const sender1 = createDeterministicWallet("sender");
    const sender2 = createDeterministicWallet("sender");
    const recipient = createDeterministicWallet("recipient");

    assert.equal(sender1.publicKey, sender2.publicKey);
    assert.notEqual(sender1.publicKey, recipient.publicKey);
    assert.match(sender1.publicKey, /^G[A-Z0-9]{55}$/);
    assert.match(recipient.publicKey, /^G[A-Z0-9]{55}$/);
  });

  it("produces deterministic signed XDR simulations", async () => {
    const wallet = createDeterministicWallet("sender");
    const mockXdr = "AAAAAGMOCK_TRANSACTION_PAYLOAD";
    const signed = await wallet.signTransaction(mockXdr);

    assert.match(signed, new RegExp(`^${mockXdr}:signed:${wallet.publicKey.slice(0, 8)}`));
  });

  it("injects valid Freighter API script", () => {
    const wallet = createDeterministicWallet("sender");
    const script = injectDeterministicFreighterScript(wallet.publicKey);

    assert.match(script, /window\.freighterApi =/);
    assert.match(script, new RegExp(wallet.publicKey));
    assert.match(script, /STANDALONE/);
  });
});
