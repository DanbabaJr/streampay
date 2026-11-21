import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildStreamLedgerKeyXdr,
  computeCheckpointDigest,
  computeEventLeafHash,
  computeStateLeafHash,
  decodeStreamFromEntryXdr,
  encodeStreamContractDataEntryXdr,
  hashMerkleNode,
  verifyStreamProof,
  type LightClientStreamProof,
  type SignedCheckpoint,
  type VerifyProofOptions,
} from "./light-client-verifier.ts";

const fixtureUrl = new URL(
  "../../indexer/fixtures/testnet-rpc-proof-fixture.json",
  import.meta.url
);
const capturedFixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
  networkPassphrase: string;
  contractId: string;
  ledger: number;
  ledgerCloseTime: number;
  getLedgerEntriesResponse: {
    result: {
      latestLedger: number;
      entries: Array<{
        key: string;
        xdr: string;
        lastModifiedLedgerSeq: number;
        liveUntilLedgerSeq: number;
      }>;
    };
  };
  getEventsResponse: {
    result: {
      latestLedger: number;
      cursor: string;
      events: Array<{
        id: string;
        pagingToken: string;
        ledger: number;
        ledgerClosedAt: string;
        contractId: string;
        topic: string[];
        value: string;
      }>;
    };
  };
};

function createValidFixtureProof() {
  const signer = Keypair.random();
  const entry7 = capturedFixture.getLedgerEntriesResponse.result.entries[0];
  const decoded7 = decodeStreamFromEntryXdr(entry7.xdr);

  // Create a sibling stream (#8) so the Merkle tree has depth 1
  const stream8 = {
    ...decoded7.stream,
    streamId: "8",
    deposit: "5000000",
    withdrawn: "0",
  };
  const rpcEntry7 = {
    keyXdr: entry7.key,
    entryXdr: entry7.xdr,
    lastModifiedLedgerSeq: entry7.lastModifiedLedgerSeq,
    liveUntilLedgerSeq: entry7.liveUntilLedgerSeq,
  };
  const rpcEntry8 = {
    keyXdr: buildStreamLedgerKeyXdr(capturedFixture.contractId, "8"),
    entryXdr: encodeStreamContractDataEntryXdr(capturedFixture.contractId, stream8),
    lastModifiedLedgerSeq: 514192,
    liveUntilLedgerSeq: 1014192,
  };

  const leaf7 = computeStateLeafHash(capturedFixture.contractId, "7", rpcEntry7);
  const leaf8 = computeStateLeafHash(capturedFixture.contractId, "8", rpcEntry8);
  const stateRoot = hashMerkleNode(leaf7, leaf8);

  const [ev0, ev1] = capturedFixture.getEventsResponse.result.events;
  const evLeaf0 = computeEventLeafHash(ev0);
  const evLeaf1 = computeEventLeafHash(ev1);
  const eventRoot = hashMerkleNode(evLeaf0, evLeaf1);

  const unsignedCheckpoint: Omit<SignedCheckpoint, "signature" | "signerPublicKey"> = {
    version: 1,
    networkPassphrase: capturedFixture.networkPassphrase,
    contractId: capturedFixture.contractId,
    ledger: capturedFixture.ledger,
    ledgerCloseTime: capturedFixture.ledgerCloseTime,
    stateRoot,
    eventRoot,
    streamCount: 2,
  };

  const digest = computeCheckpointDigest(unsignedCheckpoint);
  const checkpoint: SignedCheckpoint = {
    ...unsignedCheckpoint,
    signerPublicKey: signer.publicKey(),
    signature: Buffer.from(signer.sign(digest)).toString("base64"),
  };

  const proof: LightClientStreamProof = {
    version: 1,
    contractId: capturedFixture.contractId,
    streamId: "7",
    ledger: capturedFixture.ledger,
    stream: decoded7.stream,
    rpcEntry: rpcEntry7,
    stateLeafHash: leaf7,
    stateProof: [{ position: "right", hash: leaf8 }],
    events: [
      {
        event: ev0,
        leafHash: evLeaf0,
        proof: [{ position: "right", hash: evLeaf1 }],
      },
      {
        event: ev1,
        leafHash: evLeaf1,
        proof: [{ position: "left", hash: evLeaf0 }],
      },
    ],
    checkpoint,
  };

  const options: VerifyProofOptions = {
    trustedSigners: [signer.publicKey()],
    expectedContractId: capturedFixture.contractId,
    expectedNetworkPassphrase: capturedFixture.networkPassphrase,
    expectedStreamId: "7",
    minLedger: 514000,
    nowTimestamp: capturedFixture.ledgerCloseTime + 30,
    maxAgeSeconds: 300,
  };

  return { signer, checkpoint, proof, options };
}

describe("Light-Client Stream State & Event Proof Verifier", () => {
  it("accepts a valid proof built from captured testnet getLedgerEntries & getEvents responses", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    const res = verifyStreamProof(proof, checkpoint, options);
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.stream.streamId, "7");
      assert.strictEqual(res.stream.deposit, "1000000");
      assert.strictEqual(res.stream.withdrawn, "250000");
      assert.strictEqual(res.stream.status, "Active");
      assert.strictEqual(res.ledger, 514200);
    }
  });

  it("rejects tampered response: modified deposit amount in JSON stream view", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    const tampered: LightClientStreamProof = {
      ...proof,
      stream: {
        ...proof.stream,
        deposit: "999999999999", // Attacker inflates stream deposit in JSON
      },
    };
    const res = verifyStreamProof(tampered, checkpoint, options);
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.code, "STATE_MISMATCH");
    }
  });

  it("rejects tampered response: modified withdrawn amount in both JSON and XDR entry", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    const forgedStream = {
      ...proof.stream,
      withdrawn: "0", // Attacker resets withdrawn from 250000 to 0 in both JSON and XDR
    };
    const forgedEntryXdr = encodeStreamContractDataEntryXdr(proof.contractId, forgedStream);
    const tamperedRpcEntry = {
      ...proof.rpcEntry,
      entryXdr: forgedEntryXdr,
    };
    // Even if attacker also recomputes stateLeafHash, it will fail against the signed checkpoint stateRoot
    const tamperedLeafHash = computeStateLeafHash(proof.contractId, "7", tamperedRpcEntry);
    const tampered: LightClientStreamProof = {
      ...proof,
      stream: forgedStream,
      rpcEntry: tamperedRpcEntry,
      stateLeafHash: tamperedLeafHash,
    };

    const res = verifyStreamProof(tampered, checkpoint, options);
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.code, "INVALID_MERKLE_PROOF");
    }
  });

  it("rejects tampered response: missing RPC entry or null proof payload", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();

    const resNull = verifyStreamProof(null, checkpoint, options);
    assert.strictEqual(resNull.ok, false);
    if (!resNull.ok) {
      assert.strictEqual(resNull.code, "MISSING_ENTRY");
    }

    const missingXdr: LightClientStreamProof = {
      ...proof,
      rpcEntry: {
        ...proof.rpcEntry,
        entryXdr: "",
      },
    };
    const resMissingXdr = verifyStreamProof(missingXdr, checkpoint, options);
    assert.strictEqual(resMissingXdr.ok, false);
    if (!resMissingXdr.ok) {
      assert.strictEqual(resMissingXdr.code, "MISSING_ENTRY");
    }
  });

  it("rejects tampered response: wrong stream entry substituted for requested streamId", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    // Client requested stream #8, but RPC returned proof for stream #7
    const res = verifyStreamProof(proof, checkpoint, {
      ...options,
      expectedStreamId: "8",
    });
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.code, "KEY_MISMATCH");
    }
  });

  it("rejects stale proof: ledger older than minLedger or older than maxAgeSeconds", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();

    // 1. Fails minLedger ratchet check
    const resOldLedger = verifyStreamProof(proof, checkpoint, {
      ...options,
      minLedger: 514201,
    });
    assert.strictEqual(resOldLedger.ok, false);
    if (!resOldLedger.ok) {
      assert.strictEqual(resOldLedger.code, "STALE_PROOF");
    }

    // 2. Fails maxAgeSeconds wall-clock freshness check
    const resOldTimestamp = verifyStreamProof(proof, checkpoint, {
      ...options,
      nowTimestamp: checkpoint.ledgerCloseTime + 600,
      maxAgeSeconds: 300,
    });
    assert.strictEqual(resOldTimestamp.ok, false);
    if (!resOldTimestamp.ok) {
      assert.strictEqual(resOldTimestamp.code, "STALE_PROOF");
    }

    // 3. Fails when proof ledger does not match the latest trusted checkpoint
    const newerSigner = Keypair.fromPublicKey(checkpoint.signerPublicKey);
    void newerSigner;
    const mismatchedProof: LightClientStreamProof = {
      ...proof,
      ledger: checkpoint.ledger - 5,
    };
    const resMismatch = verifyStreamProof(mismatchedProof, checkpoint, options);
    assert.strictEqual(resMismatch.ok, false);
    if (!resMismatch.ok) {
      assert.strictEqual(resMismatch.code, "CHECKPOINT_MISMATCH");
    }
  });

  it("rejects expired/archived ledger entry (liveUntilLedgerSeq < checkpoint.ledger)", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    const expiredProof: LightClientStreamProof = {
      ...proof,
      rpcEntry: {
        ...proof.rpcEntry,
        liveUntilLedgerSeq: checkpoint.ledger - 1,
      },
    };
    const res = verifyStreamProof(expiredProof, checkpoint, options);
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.code, "EXPIRED_ENTRY");
    }
  });

  it("rejects untrusted checkpoint signer or forged checkpoint signature", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    const attackerKey = Keypair.random();

    // 1. Attacker signs a valid checkpoint with their own unpinned key
    const attackerDigest = computeCheckpointDigest(checkpoint);
    const attackerCheckpoint: SignedCheckpoint = {
      ...checkpoint,
      signerPublicKey: attackerKey.publicKey(),
      signature: Buffer.from(attackerKey.sign(attackerDigest)).toString("base64"),
    };
    const resUntrusted = verifyStreamProof(
      { ...proof, checkpoint: attackerCheckpoint },
      attackerCheckpoint,
      options
    );
    assert.strictEqual(resUntrusted.ok, false);
    if (!resUntrusted.ok) {
      assert.strictEqual(resUntrusted.code, "UNTRUSTED_SIGNER");
    }

    // 2. Attacker mutates stateRoot on the pinned signer's checkpoint without valid signature
    const mutatedRootCheckpoint: SignedCheckpoint = {
      ...checkpoint,
      stateRoot: "f".repeat(64),
    };
    const resBadSig = verifyStreamProof(
      { ...proof, checkpoint: mutatedRootCheckpoint },
      mutatedRootCheckpoint,
      options
    );
    assert.strictEqual(resBadSig.ok, false);
    if (!resBadSig.ok) {
      assert.strictEqual(resBadSig.code, "INVALID_SIGNATURE");
    }
  });

  it("rejects tampered event payload in attached event proofs", () => {
    const { proof, checkpoint, options } = createValidFixtureProof();
    const tamperedEvents = structuredClone(proof.events!);
    // Mutate the withdrawn event's XDR value
    tamperedEvents[1].event.value = tamperedEvents[0].event.value;

    const res = verifyStreamProof(
      { ...proof, events: tamperedEvents },
      checkpoint,
      options
    );
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.code, "EVENT_PROOF_INVALID");
    }
  });
});
