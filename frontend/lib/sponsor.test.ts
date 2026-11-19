// Unit tests for sponsor.ts using Node.js built-in test runner.
//
// The frozen wire vector below is produced by the Rust test
// `canonical_relay_message_has_a_frozen_wire_form`
// (contracts/streaming-payments/src/sponsor_test.rs). If either side changes
// the message layout, one of these two tests fails — that is the point.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Keypair } from "@stellar/stellar-sdk";
import {
  CLAIM_DOMAIN_TAG,
  claimDigest,
  claimMessageHex,
  consentPublicKeyHex,
  signClaim,
  type ClaimIntent,
} from "./sponsor.ts";

const VECTOR: ClaimIntent = {
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
  sponsor: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM",
  beneficiary: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
  token: "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL",
  streamId: "42",
  amount: "1000000000",
  nonce: "7",
  deadline: 1_800_000_000,
};

const VECTOR_MESSAGE_XDR =
  "000000100000000100000009" + // ScVal::Vec of 9 elements
  // domain tag + 4 strkeys (ScVal::String, XDR-padded to multiples of 4)…
  "0000000e0000001f53747265616d5061792f73706f6e736f7265642d77697468647261772f763100" +
  "0000000e00000038434141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414d445234" +
  "0000000e00000038434141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414f4c5a4d" +
  "0000000e000000384341414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414149544134" +
  "0000000e0000003843424550444e5659585147574235595542584b4a57594a41374f58545a57354c464c4e4f354a52524745365a3643354f53555a504343454c" +
  // …then stream id (u64), amount (i128), nonce (u64), deadline (u64).
  "00000005000000000000002a" +
  "0000000a0000000000000000000000003b9aca00" +
  "000000050000000000000007" +
  "00000005000000006b49d200";

const VECTOR_DIGEST =
  "e2c974bef0af32c95b39bd02965fe636cbed3e8397af2158e9c534560f2de186";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("canonical claim intent", () => {
  it("uses the contract's domain tag", () => {
    assert.equal(CLAIM_DOMAIN_TAG, "StreamPay/sponsored-withdraw/v1");
  });

  it("encodes the message exactly as the contract does", () => {
    assert.equal(claimMessageHex(VECTOR), VECTOR_MESSAGE_XDR);
  });

  it("hashes to the contract's digest", async () => {
    assert.equal(toHex(await claimDigest(VECTOR)), VECTOR_DIGEST);
  });

  it("produces signatures that verify against the digest", async () => {
    const key = Keypair.random();
    const sig = await signClaim(key, VECTOR);
    const digest = await claimDigest(VECTOR);
    assert.equal(sig.length, 128);
    assert.ok(
      key.verify(digest, Buffer.from(sig, "hex")),
      "signature must verify over the digest bytes"
    );
    assert.ok(
      !key.verify(await claimDigest({ ...VECTOR, amount: "1" }), Buffer.from(sig, "hex")),
      "a changed amount must not verify"
    );
  });

  it("exposes the raw 32-byte public key the contract enrolls", () => {
    const key = Keypair.random();
    assert.equal(consentPublicKeyHex(key).length, 64);
  });
});
