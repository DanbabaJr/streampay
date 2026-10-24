import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  canonicalJsonStringify,
  hashCanonicalPayload,
  buildCanonicalConsentMessage,
  buildCanonicalWithdrawMessage,
  verifyPartyConsent,
  verifyPartyWithdrawal,
  signCanonicalPayload,
} from "./crypto.ts";
import {
  computeRateBucket,
  computeDurationBucket,
  applyKAnonymity,
  coarsenToUtcDay,
} from "./bucketing.ts";
import type { PublicListingView, RateBucket, DurationBucket } from "./types.ts";

describe("Discovery Serialization & Crypto", () => {
  it("canonicalJsonStringify produces deterministic sorted key order", () => {
    const objA = { z: 1, a: 2, m: { y: "hello", b: "world" } };
    const objB = { a: 2, m: { b: "world", y: "hello" }, z: 1 };

    const strA = canonicalJsonStringify(objA);
    const strB = canonicalJsonStringify(objB);

    assert.equal(strA, strB);
    assert.equal(strA, '{"a":2,"m":{"b":"world","y":"hello"},"z":1}');
  });

  it("hashCanonicalPayload produces expected SHA-256 digest", () => {
    const payload = { action: "TEST", val: 42 };
    const hash = hashCanonicalPayload(payload);
    assert.equal(hash.length, 32);
  });

  it("verifies valid Ed25519 consent signature", () => {
    const kp = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const nonce = "a1b2c3d4e5f67890abcdef1234567890";
    const now = 1700000000;
    const expiry = now + 3600;

    const message = buildCanonicalConsentMessage({
      network,
      contractId,
      streamId,
      nonce,
      expiry,
      shareAddress: false,
    });

    const signature = signCanonicalPayload(kp, message);

    const result = verifyPartyConsent({
      expectedSigner: kp.publicKey(),
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      nonce,
      expiry,
      partyConsent: {
        address: kp.publicKey(),
        signature,
        shareAddress: false,
      },
      nowSeconds: now,
    });

    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it("rejects expired consent", () => {
    const kp = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const nonce = "a1b2c3d4e5f67890abcdef1234567890";
    const now = 1700000000;
    const expiry = now - 10; // expired

    const result = verifyPartyConsent({
      expectedSigner: kp.publicKey(),
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      nonce,
      expiry,
      partyConsent: {
        address: kp.publicKey(),
        signature: "dummy",
        shareAddress: false,
      },
      nowSeconds: now,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "EXPIRED");
  });

  it("rejects wrong signer", () => {
    const kp1 = Keypair.random();
    const kp2 = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const nonce = "a1b2c3d4e5f67890abcdef1234567890";
    const now = 1700000000;
    const expiry = now + 3600;

    const result = verifyPartyConsent({
      expectedSigner: kp1.publicKey(), // expected kp1
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      nonce,
      expiry,
      partyConsent: {
        address: kp2.publicKey(), // provided kp2
        signature: "dummy",
        shareAddress: false,
      },
      nowSeconds: now,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "WRONG_SIGNER");
  });

  it("rejects malformed signature", () => {
    const kp = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const nonce = "a1b2c3d4e5f67890abcdef1234567890";
    const now = 1700000000;
    const expiry = now + 3600;

    const result = verifyPartyConsent({
      expectedSigner: kp.publicKey(),
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      nonce,
      expiry,
      partyConsent: {
        address: kp.publicKey(),
        signature: "not-a-valid-base64-or-length",
        shareAddress: false,
      },
      nowSeconds: now,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "INVALID_SIGNATURE");
  });

  it("rejects signature signed for wrong network or contract", () => {
    const kp = Keypair.random();
    const streamId = "101";
    const nonce = "a1b2c3d4e5f67890abcdef1234567890";
    const now = 1700000000;
    const expiry = now + 3600;

    // Signed with wrong network
    const messageWrongNetwork = buildCanonicalConsentMessage({
      network: "Public Global Stellar Network ; September 2015",
      contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      streamId,
      nonce,
      expiry,
      shareAddress: false,
    });

    const signature = signCanonicalPayload(kp, messageWrongNetwork);

    const result = verifyPartyConsent({
      expectedSigner: kp.publicKey(),
      expectedNetwork: "Test SDF Network ; September 2015", // target is testnet
      expectedContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      expectedStreamId: streamId,
      nonce,
      expiry,
      partyConsent: {
        address: kp.publicKey(),
        signature,
        shareAddress: false,
      },
      nowSeconds: now,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "INVALID_SIGNATURE");
  });

  it("verifies valid withdrawal signature", () => {
    const kp = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const listingId = "uuid-1234-5678";
    const nonce = "withdraw-nonce-12345678";
    const now = 1700000000;

    const message = buildCanonicalWithdrawMessage({
      network,
      contractId,
      streamId,
      listingId,
      nonce,
      timestamp: now,
    });

    const signature = signCanonicalPayload(kp, message);

    const result = verifyPartyWithdrawal({
      expectedSigner: kp.publicKey(),
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      listingId,
      nonce,
      timestamp: now,
      signature,
      nowSeconds: now,
    });

    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it("rejects withdrawal signature if listingId does not match (cryptographically binds listingId)", () => {
    const kp = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const signedListingId = "uuid-listing-signed-1";
    const targetListingId = "uuid-listing-target-2";
    const nonce = "withdraw-nonce-12345678";
    const now = 1700000000;

    // Signed for listing 1
    const message = buildCanonicalWithdrawMessage({
      network,
      contractId,
      streamId,
      listingId: signedListingId,
      nonce,
      timestamp: now,
    });
    const signature = signCanonicalPayload(kp, message);

    // Attempting to verify against listing 2
    const result = verifyPartyWithdrawal({
      expectedSigner: kp.publicKey(),
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      listingId: targetListingId, // Mismatched listingId!
      nonce,
      timestamp: now,
      signature,
      nowSeconds: now,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "INVALID_SIGNATURE");
  });

  it("rejects withdrawal signature if listingId is tampered with or modified", () => {
    const kp = Keypair.random();
    const network = "Test SDF Network ; September 2015";
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const streamId = "101";
    const listingId = "c85d7b32-901e-4581-81f7-e23a45610bc9";
    const nonce = "withdraw-nonce-12345678";
    const now = 1700000000;

    const message = buildCanonicalWithdrawMessage({
      network,
      contractId,
      streamId,
      listingId,
      nonce,
      timestamp: now,
    });
    const signature = signCanonicalPayload(kp, message);

    // Tamper single character in UUID
    const tamperedListingId = "c85d7b32-901e-4581-81f7-e23a45610bc0";
    const result = verifyPartyWithdrawal({
      expectedSigner: kp.publicKey(),
      expectedNetwork: network,
      expectedContractId: contractId,
      expectedStreamId: streamId,
      listingId: tamperedListingId,
      nonce,
      timestamp: now,
      signature,
      nowSeconds: now,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "INVALID_SIGNATURE");
  });
});

describe("Discovery Bucketing & k-Anonymity", () => {
  it("computes rate buckets correctly", () => {
    // 1 token = 10,000,000 stroops (7 decimals)
    // 1 day = 86400 seconds
    const ONE_DAY = 86400;

    // 5 tokens for 1 day = 5 tokens/day -> RATE_MICRO (<10)
    assert.equal(
      computeRateBucket(50_000_000n, ONE_DAY, 7),
      "RATE_MICRO"
    );

    // 50 tokens for 1 day = 50 tokens/day -> RATE_LOW (10-100)
    assert.equal(
      computeRateBucket(500_000_000n, ONE_DAY, 7),
      "RATE_LOW"
    );

    // 500 tokens for 1 day = 500 tokens/day -> RATE_MEDIUM (100-1000)
    assert.equal(
      computeRateBucket(5_000_000_000n, ONE_DAY, 7),
      "RATE_MEDIUM"
    );

    // 5,000 tokens for 1 day = 5,000 tokens/day -> RATE_HIGH (1000-10000)
    assert.equal(
      computeRateBucket(50_000_000_000n, ONE_DAY, 7),
      "RATE_HIGH"
    );

    // 50,000 tokens for 1 day = 50,000 tokens/day -> RATE_WHALE (>=10000)
    assert.equal(
      computeRateBucket(500_000_000_000n, ONE_DAY, 7),
      "RATE_WHALE"
    );
  });

  it("computes duration buckets correctly", () => {
    const ONE_DAY = 86400;

    assert.equal(computeDurationBucket(3600), "DUR_FLASH"); // 1 hour
    assert.equal(computeDurationBucket(ONE_DAY * 3), "DUR_WEEK"); // 3 days
    assert.equal(computeDurationBucket(ONE_DAY * 14), "DUR_MONTH"); // 14 days
    assert.equal(computeDurationBucket(ONE_DAY * 60), "DUR_QUARTER"); // 60 days
    assert.equal(computeDurationBucket(ONE_DAY * 120), "DUR_LONG"); // 120 days
  });

  it("coarsens timestamps to UTC calendar day", () => {
    // 2024-01-15T15:30:00Z = 1705332600
    assert.equal(coarsenToUtcDay(1705332600), "2024-01-15");
  });

  it("evaluates k-anonymity sets dynamically", () => {
    const dummyListing = (id: string, asset: string, rate: RateBucket, dur: DurationBucket): PublicListingView => ({
      listingId: id,
      asset,
      rateBucket: rate,
      durationBucket: dur,
      status: "Active",
      listedDay: "2024-01-15",
      anonymitySetSize: 0,
      anonymityFlag: "low",
      addressesShared: { sender: false, recipient: false },
      verificationHash: "hash",
    });

    const listings = [
      dummyListing("1", "USDC", "RATE_LOW", "DUR_MONTH"),
      dummyListing("2", "USDC", "RATE_LOW", "DUR_MONTH"),
      dummyListing("3", "USDC", "RATE_LOW", "DUR_MONTH"),
      dummyListing("4", "XLM", "RATE_HIGH", "DUR_WEEK"), // singleton
    ];

    const annotated = applyKAnonymity(listings, 3);

    // First 3 should have size 3 and normal anonymity
    assert.equal(annotated[0].anonymitySetSize, 3);
    assert.equal(annotated[0].anonymityFlag, "normal");

    // 4th should have size 1 and low anonymity
    assert.equal(annotated[3].anonymitySetSize, 1);
    assert.equal(annotated[3].anonymityFlag, "low");
  });
});
