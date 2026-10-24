import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { DiscoveryService } from "./service.ts";
import type { StreamInfo } from "./service.ts";
import { discoveryStore } from "./store.ts";
import {
  buildCanonicalConsentMessage,
  buildCanonicalWithdrawMessage,
  signCanonicalPayload,
} from "./crypto.ts";
import type { ListingSubmissionPayload, ListingWithdrawPayload } from "./types.ts";

describe("Discovery Service & Privacy Egress", () => {
  const NETWORK = "Test SDF Network ; September 2015";
  const CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  let senderKp: Keypair;
  let recipientKp: Keypair;
  let thirdPartyKp: Keypair;
  let mockStreams: Map<string, StreamInfo>;
  let service: DiscoveryService;

  beforeEach(() => {
    discoveryStore.clear();

    senderKp = Keypair.random();
    recipientKp = Keypair.random();
    thirdPartyKp = Keypair.random();

    mockStreams = new Map();

    // Default mock stream: 100 XLM for 10 days
    mockStreams.set("101", {
      id: "101",
      sender: senderKp.publicKey(),
      recipient: recipientKp.publicKey(),
      token: "CAS3J7GYLGXMF6TDJBBYYSE3V",
      deposit: "1000000000", // 100 XLM (7 decimals)
      withdrawn: "0",
      startTime: 1700000000,
      endTime: 1700000000 + 86400 * 10, // 10 days -> DUR_MONTH
      cancelable: true,
      status: "Active",
    });

    service = new DiscoveryService({
      readStreamFn: async (id) => {
        const stream = mockStreams.get(id);
        if (!stream) throw new Error("Stream not found");
        return stream;
      },
      network: NETWORK,
      contractId: CONTRACT_ID,
      kThreshold: 3,
    });
  });

  function createValidSubmission(params?: {
    streamId?: string;
    shareAddressSender?: boolean;
    shareAddressRecipient?: boolean;
    nowSeconds?: number;
  }): { submission: ListingSubmissionPayload; nonce: string; expiry: number } {
    const streamId = params?.streamId ?? "101";
    const shareSender = params?.shareAddressSender ?? false;
    const shareRecipient = params?.shareAddressRecipient ?? false;
    const now = params?.nowSeconds ?? 1700000000;
    const expiry = now + 7200;
    const nonce = `test-nonce-${Math.random().toString(36).slice(2, 10)}`;

    const senderMsg = buildCanonicalConsentMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId,
      nonce,
      expiry,
      shareAddress: shareSender,
    });
    const senderSig = signCanonicalPayload(senderKp, senderMsg);

    const recipientMsg = buildCanonicalConsentMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId,
      nonce,
      expiry,
      shareAddress: shareRecipient,
    });
    const recipientSig = signCanonicalPayload(recipientKp, recipientMsg);

    return {
      submission: {
        streamId,
        nonce,
        expiry,
        senderConsent: {
          address: senderKp.publicKey(),
          signature: senderSig,
          shareAddress: shareSender,
        },
        recipientConsent: {
          address: recipientKp.publicKey(),
          signature: recipientSig,
          shareAddress: shareRecipient,
        },
      },
      nonce,
      expiry,
    };
  }

  it("successfully publishes listing when both parties consent", async () => {
    const { submission } = createValidSubmission();
    const result = await service.submitListing(submission, { nowSeconds: 1700000000 });

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.ok(result.listing.listingId);
    assert.equal(result.listing.asset, "CAS3J7GYLGXMF6TDJBBYYSE3V");
    assert.equal(result.listing.durationBucket, "DUR_MONTH");
    assert.equal(result.listing.rateBucket, "RATE_LOW"); // 100 XLM / 10 days = 10 XLM/day -> RATE_LOW
    assert.equal(result.listing.status, "Active");
  });

  it("privacy regression: NEVER exposes addresses by default under any code path", async () => {
    const { submission } = createValidSubmission({
      shareAddressSender: false,
      shareAddressRecipient: false,
    });
    const result = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(result.success, true);
    if (!result.success) return;

    // Direct assertions on public view
    assert.equal(result.listing.sender, undefined);
    assert.equal(result.listing.recipient, undefined);
    assert.equal("streamId" in result.listing, false);
    assert.equal("depositRaw" in result.listing, false);
    assert.equal("signatures" in result.listing, false);
    assert.equal("nonce" in result.listing, false);

    // Assert query also never leaks
    const query = service.queryListings({ includeLowAnonymity: true });
    assert.equal(query.listings.length, 1);
    assert.equal(query.listings[0].sender, undefined);
    assert.equal(query.listings[0].recipient, undefined);
    assert.equal(JSON.stringify(query).includes(senderKp.publicKey()), false);
    assert.equal(JSON.stringify(query).includes(recipientKp.publicKey()), false);
  });

  it("address opt-in: addresses remain hidden if only ONE party opts in", async () => {
    // Only sender opted in
    const { submission: sub1 } = createValidSubmission({
      shareAddressSender: true,
      shareAddressRecipient: false,
    });
    const res1 = await service.submitListing(sub1, { nowSeconds: 1700000000 });
    assert.equal(res1.success, true);
    if (!res1.success) return;
    assert.equal(res1.listing.sender, undefined);
    assert.equal(res1.listing.recipient, undefined);

    discoveryStore.clear();

    // Only recipient opted in
    const { submission: sub2 } = createValidSubmission({
      shareAddressSender: false,
      shareAddressRecipient: true,
    });
    const res2 = await service.submitListing(sub2, { nowSeconds: 1700000000 });
    assert.equal(res2.success, true);
    if (!res2.success) return;
    assert.equal(res2.listing.sender, undefined);
    assert.equal(res2.listing.recipient, undefined);
  });

  it("address opt-in: addresses are published ONLY when BOTH parties opt in", async () => {
    const { submission } = createValidSubmission({
      shareAddressSender: true,
      shareAddressRecipient: true,
    });
    const result = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.listing.sender, senderKp.publicKey());
    assert.equal(result.listing.recipient, recipientKp.publicKey());
  });

  it("rejects submission if stream is cancelled on-chain", async () => {
    mockStreams.set("102", {
      id: "102",
      sender: senderKp.publicKey(),
      recipient: recipientKp.publicKey(),
      token: "CAS3J7GYLGXMF6TDJBBYYSE3V",
      deposit: "1000000000",
      withdrawn: "0",
      startTime: 1700000000,
      endTime: 1700000000 + 86400 * 10,
      cancelable: true,
      status: "Cancelled",
    });

    const { submission } = createValidSubmission({ streamId: "102" });
    const result = await service.submitListing(submission, { nowSeconds: 1700000000 });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error, "STREAM_IS_CANCELLED");
    }
  });

  it("rejects submission if signer does not match on-chain stream parties", async () => {
    const { submission } = createValidSubmission();
    // Swap sender with third party
    submission.senderConsent.address = thirdPartyKp.publicKey();

    const result = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error, "WRONG_SENDER");
    }
  });

  it("rejects replayed nonce", async () => {
    const { submission } = createValidSubmission();
    const res1 = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(res1.success, true);

    // Replay with identical submission
    const res2 = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(res2.success, false);
    if (!res2.success) {
      assert.equal(resultError(res2.error), "REPLAYED_NONCE");
    }
  });

  it("enforces k-anonymity filtering", async () => {
    // Add 1 listing to (CAS3..., RATE_LOW, DUR_MONTH)
    const { submission: sub1 } = createValidSubmission();
    await service.submitListing(sub1, { nowSeconds: 1700000000 });

    // With k=3, default browse should return 0 listings (suppressed)
    const browseDefault = service.queryListings({});
    assert.equal(browseDefault.listings.length, 0);
    assert.equal(browseDefault.total, 0);

    // With includeLowAnonymity = true, should return 1 listing with low flag
    const browseWithLow = service.queryListings({ includeLowAnonymity: true });
    assert.equal(browseWithLow.listings.length, 1);
    assert.equal(browseWithLow.listings[0].anonymityFlag, "low");
    assert.equal(browseWithLow.listings[0].anonymitySetSize, 1);

    // Add 2 more streams in the exact same equivalence class
    for (let i = 2; i <= 3; i++) {
      const sId = `10${i}`;
      mockStreams.set(sId, {
        id: sId,
        sender: senderKp.publicKey(),
        recipient: recipientKp.publicKey(),
        token: "CAS3J7GYLGXMF6TDJBBYYSE3V",
        deposit: "1000000000",
        withdrawn: "0",
        startTime: 1700000000,
        endTime: 1700000000 + 86400 * 10,
        cancelable: true,
        status: "Active",
      });
      const { submission } = createValidSubmission({ streamId: sId });
      await service.submitListing(submission, { nowSeconds: 1700000000 });
    }

    // Now equivalence class count is 3 >= k=3! Default browse returns all 3
    const browseAfterK = service.queryListings({});
    assert.equal(browseAfterK.listings.length, 3);
    assert.equal(browseAfterK.listings[0].anonymityFlag, "normal");
    assert.equal(browseAfterK.listings[0].anonymitySetSize, 3);
  });

  it("supports unilateral withdrawal by sender", async () => {
    const { submission } = createValidSubmission();
    const pubRes = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(pubRes.success, true);
    if (!pubRes.success) return;

    const listingId = pubRes.listing.listingId;
    const withdrawNonce = "nonce-withdraw-sender-1";
    const now = 1700000100;

    const withdrawMsg = buildCanonicalWithdrawMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId: "101",
      listingId,
      nonce: withdrawNonce,
      timestamp: now,
    });
    const senderSig = signCanonicalPayload(senderKp, withdrawMsg);

    const withdrawPayload: ListingWithdrawPayload = {
      listingId,
      streamId: "101",
      nonce: withdrawNonce,
      timestamp: now,
      signerAddress: senderKp.publicKey(),
      signature: senderSig,
    };

    const withdrawRes = service.withdrawListing(withdrawPayload, { nowSeconds: now });
    assert.equal(withdrawRes.success, true);

    // Listing must disappear from active queries
    const checkQuery = service.queryListings({ includeLowAnonymity: true });
    assert.equal(checkQuery.listings.length, 0);

    // Direct lookup must return null
    assert.equal(service.getListingById(listingId), null);
  });

  it("supports unilateral withdrawal by recipient", async () => {
    const { submission } = createValidSubmission();
    const pubRes = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(pubRes.success, true);
    if (!pubRes.success) return;

    const listingId = pubRes.listing.listingId;
    const withdrawNonce = "nonce-withdraw-recip-1";
    const now = 1700000100;

    const withdrawMsg = buildCanonicalWithdrawMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId: "101",
      listingId,
      nonce: withdrawNonce,
      timestamp: now,
    });
    const recipientSig = signCanonicalPayload(recipientKp, withdrawMsg);

    const withdrawPayload: ListingWithdrawPayload = {
      listingId,
      streamId: "101",
      nonce: withdrawNonce,
      timestamp: now,
      signerAddress: recipientKp.publicKey(),
      signature: recipientSig,
    };

    const withdrawRes = service.withdrawListing(withdrawPayload, { nowSeconds: now });
    assert.equal(withdrawRes.success, true);

    assert.equal(service.getListingById(listingId), null);
  });

  it("rejects withdrawal by an unauthorized third party", async () => {
    const { submission } = createValidSubmission();
    const pubRes = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(pubRes.success, true);
    if (!pubRes.success) return;

    const listingId = pubRes.listing.listingId;
    const withdrawNonce = "nonce-withdraw-thirdparty";
    const now = 1700000100;

    const withdrawMsg = buildCanonicalWithdrawMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId: "101",
      listingId,
      nonce: withdrawNonce,
      timestamp: now,
    });
    const thirdSig = signCanonicalPayload(thirdPartyKp, withdrawMsg);

    const withdrawPayload: ListingWithdrawPayload = {
      listingId,
      streamId: "101",
      nonce: withdrawNonce,
      timestamp: now,
      signerAddress: thirdPartyKp.publicKey(),
      signature: thirdSig,
    };

    const withdrawRes = service.withdrawListing(withdrawPayload, { nowSeconds: now });
    assert.equal(withdrawRes.success, false);
    if (!withdrawRes.success) {
      assert.equal(withdrawRes.error, "UNAUTHORIZED_SIGNER");
    }

    // Verify listing remains published and untouched
    const stillActive = service.getListingById(listingId);
    assert.notEqual(stillActive, null);
  });

  it("rejects withdrawal when caller attempts to use a signature signed for a different listing (binding listingId)", async () => {
    // 1. Create Listing A for stream 101
    const { submission: subA } = createValidSubmission({ streamId: "101" });
    const pubA = await service.submitListing(subA, { nowSeconds: 1700000000 });
    assert.equal(pubA.success, true);
    if (!pubA.success) return;
    const listingIdA = pubA.listing.listingId;

    // 2. Create Listing B for stream 102 (mock on-chain stream 102)
    mockStreams.set("102", {
      id: "102",
      sender: senderKp.publicKey(),
      recipient: recipientKp.publicKey(),
      token: "CC_TEST_TOKEN",
      deposit: "5000000000",
      startTime: 1700000000,
      endTime: 1700086400,
      cancelable: true,
      status: "Active",
    });
    const { submission: subB } = createValidSubmission({
      streamId: "102",
      nonce: "nonce-proposal-sub-B-9988",
    });
    const pubB = await service.submitListing(subB, { nowSeconds: 1700000000 });
    assert.equal(pubB.success, true);
    if (!pubB.success) return;
    const listingIdB = pubB.listing.listingId;

    // 3. Sender signs a legitimate withdrawal explicitly bound to Listing A
    const now = 1700000100;
    const nonce = "nonce-withdraw-binding-test";
    const withdrawMsgA = buildCanonicalWithdrawMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId: "101",
      listingId: listingIdA, // Strictly bound to Listing A
      nonce,
      timestamp: now,
    });
    const sigA = signCanonicalPayload(senderKp, withdrawMsgA);

    // 4. Caller attempts to withdraw Listing B using the signature generated for Listing A
    const attackPayload: ListingWithdrawPayload = {
      listingId: listingIdB, // Target is Listing B
      streamId: "102",
      nonce,
      timestamp: now,
      signerAddress: senderKp.publicKey(),
      signature: sigA, // Signature was generated for Listing A!
    };

    const attackRes = service.withdrawListing(attackPayload, { nowSeconds: now });
    assert.equal(attackRes.success, false);
    if (!attackRes.success) {
      assert.equal(attackRes.error, "INVALID_WITHDRAWAL_SIGNATURE: INVALID_SIGNATURE");
    }

    // Crucial: Listing B MUST remain active and unrevoked
    const listingBActive = service.getListingById(listingIdB);
    assert.notEqual(listingBActive, null);
    assert.equal(listingBActive?.listingId, listingIdB);
  });

  it("rejects withdrawal when caller attempts to spoof sender address using unauthorized key", async () => {
    const { submission } = createValidSubmission();
    const pubRes = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(pubRes.success, true);
    if (!pubRes.success) return;

    const listingId = pubRes.listing.listingId;
    const withdrawNonce = "nonce-withdraw-spoof-1";
    const now = 1700000100;

    const withdrawMsg = buildCanonicalWithdrawMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId: "101",
      listingId,
      nonce: withdrawNonce,
      timestamp: now,
    });
    // Attacker signs with their own key
    const attackerSig = signCanonicalPayload(thirdPartyKp, withdrawMsg);

    // Attacker claims signerAddress is sender's public key
    const spoofPayload: ListingWithdrawPayload = {
      listingId,
      streamId: "101",
      nonce: withdrawNonce,
      timestamp: now,
      signerAddress: senderKp.publicKey(), // Spoofed sender public key
      signature: attackerSig,              // Signed by third party private key!
    };

    const withdrawRes = service.withdrawListing(spoofPayload, { nowSeconds: now });
    assert.equal(withdrawRes.success, false);
    if (!withdrawRes.success) {
      assert.equal(withdrawRes.error, "INVALID_WITHDRAWAL_SIGNATURE: INVALID_SIGNATURE");
    }

    assert.notEqual(service.getListingById(listingId), null);
  });

  it("rejects replay of an already consumed withdrawal nonce", async () => {
    const { submission } = createValidSubmission();
    const pubRes = await service.submitListing(submission, { nowSeconds: 1700000000 });
    assert.equal(pubRes.success, true);
    if (!pubRes.success) return;

    const listingId = pubRes.listing.listingId;
    const withdrawNonce = "nonce-withdraw-replay-nonce-1";
    const now = 1700000100;

    const withdrawMsg = buildCanonicalWithdrawMessage({
      network: NETWORK,
      contractId: CONTRACT_ID,
      streamId: "101",
      listingId,
      nonce: withdrawNonce,
      timestamp: now,
    });
    const senderSig = signCanonicalPayload(senderKp, withdrawMsg);

    const withdrawPayload: ListingWithdrawPayload = {
      listingId,
      streamId: "101",
      nonce: withdrawNonce,
      timestamp: now,
      signerAddress: senderKp.publicKey(),
      signature: senderSig,
    };

    // First withdrawal succeeds
    const res1 = service.withdrawListing(withdrawPayload, { nowSeconds: now });
    assert.equal(res1.success, true);

    // Second attempt with exact same payload and nonce must be rejected
    const res2 = service.withdrawListing(withdrawPayload, { nowSeconds: now });
    assert.equal(res2.success, false);
  });
});

function resultError(err: string) {
  return err.split(":")[0].trim();
}
