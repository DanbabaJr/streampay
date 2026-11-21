import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  encodePaymentLinkRef,
  decodePaymentLinkRef,
  verifyRecipientBinding,
  deriveRecipientCommitment,
} from "./payment-link.ts";

describe("payment-link reference codec and recipient blinding", () => {
  const streamId = "1042";
  const recipient = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const otherAddress = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  it("round-trips encoding and decoding correctly", async () => {
    const ref = await encodePaymentLinkRef({
      streamId,
      recipient,
      contractId,
    });

    assert.strictEqual(typeof ref, "string");
    assert.ok(ref.length > 20);

    const decoded = await decodePaymentLinkRef(ref);
    assert.notStrictEqual(decoded, null);
    assert.strictEqual(decoded?.version, 1);
    assert.strictEqual(decoded?.streamId, streamId);
    assert.strictEqual(decoded?.contractHint, contractId.slice(0, 6));
  });

  it("does not leak plain text recipient address in the encoded reference", async () => {
    const ref = await encodePaymentLinkRef({
      streamId,
      recipient,
      contractId,
    });

    // The full address must never appear in raw or decoded base64 string
    assert.strictEqual(ref.includes(recipient), false);
    const decodedRaw = Buffer.from(ref, "base64url").toString("utf-8");
    assert.strictEqual(decodedRaw.includes(recipient), false);
  });

  it("verifies recipient binding accurately", async () => {
    const ref = await encodePaymentLinkRef({
      streamId,
      recipient,
      contractId,
    });

    const decoded = await decodePaymentLinkRef(ref);
    assert.notStrictEqual(decoded, null);

    // Matching recipient
    const match = await verifyRecipientBinding(decoded!, recipient);
    assert.strictEqual(match, true);

    // Non-matching recipient
    const mismatch = await verifyRecipientBinding(decoded!, otherAddress);
    assert.strictEqual(mismatch, false);
  });

  it("rejects tampered or corrupt payment link references", async () => {
    const ref = await encodePaymentLinkRef({
      streamId,
      recipient,
      contractId,
    });

    // Corrupt one character
    const tampered = ref.slice(0, -3) + (ref.endsWith("a") ? "b" : "a") + ref.slice(-2);
    const decoded = await decodePaymentLinkRef(tampered);
    assert.strictEqual(decoded, null);

    // Invalid non-base64 garbage
    assert.strictEqual(await decodePaymentLinkRef("not-a-valid-ref!@#$"), null);
    assert.strictEqual(await decodePaymentLinkRef(""), null);
  });

  it("produces deterministic commitment for identical inputs", async () => {
    const salt = "deadbeef";
    const c1 = await deriveRecipientCommitment(recipient, streamId, salt);
    const c2 = await deriveRecipientCommitment(recipient, streamId, salt);
    assert.strictEqual(c1, c2);
    assert.strictEqual(c1.length, 16);
  });
});
