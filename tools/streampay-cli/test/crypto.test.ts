import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/crypto.ts";

test("encrypted signer file round-trips and rejects tampering", () => {
  const encrypted = encryptSecret("SAMPLE_SECRET", "correct horse battery staple");
  assert.equal(decryptSecret(encrypted, "correct horse battery staple"), "SAMPLE_SECRET");
  assert.throws(() => decryptSecret(encrypted, "wrong password"));
  assert.throws(() => decryptSecret({ ...encrypted, ciphertext: "AA==" }, "correct horse battery staple"));
});