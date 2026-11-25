import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { decodeEvent } from "./decoder.js";
import {
  buildMerkleTree,
  buildStreamLedgerKeyXdr,
  computeCheckpointDigest,
  computeEventLeafHash,
  computeStateLeafHash,
  decodeStreamFromEntryXdr,
  encodeStreamContractDataEntryXdr,
  generateStreamProof,
  type RpcLedgerEntryProofData,
} from "./proof.js";
import type { DecodedEvent, RpcEvent, Stream } from "./types.js";

interface CapturedTestnetFixture {
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
      events: RpcEvent[];
    };
  };
}

function projectStreamEvents(streamId: string, events: DecodedEvent[]): Stream {
  const state: Stream = {
    streamId,
    sender: null,
    recipient: null,
    token: null,
    deposit: null,
    withdrawn: "0",
    startTime: null,
    endTime: null,
    cancelable: null,
    status: "active",
    lastLedger: 0,
    updatedAt: "",
  };
  for (const ev of events) {
    if (ev.streamId !== streamId) continue;
    state.lastLedger = ev.ledger;
    state.updatedAt = ev.ledgerClosedAt;
    const d = ev.data;
    if (ev.name === "stream_created") {
      state.sender = String(d.sender);
      state.recipient = String(d.recipient);
      state.token = String(d.token);
      state.deposit = String(d.deposit);
      state.startTime = String(d.start_time);
      state.endTime = String(d.end_time);
      state.cancelable = Boolean(d.cancelable);
      state.status = "active";
      state.withdrawn = "0";
    } else if (ev.name === "withdrawn") {
      state.withdrawn = String(d.withdrawn_total ?? state.withdrawn);
    }
  }
  return state;
}

test("generates canonical XDR state and event proofs from captured testnet responses", async () => {
  const fixtureRaw = await readFile(
    new URL("../fixtures/testnet-rpc-proof-fixture.json", import.meta.url),
    "utf8"
  );
  const fixture = JSON.parse(fixtureRaw) as CapturedTestnetFixture;

  // `.map(decodeEvent)` would pass the array index as decodeEvent's options
  // argument (the registry-driven decoder gained a second parameter), so the
  // event is decoded explicitly.
  const decodedEvents = fixture.getEventsResponse.result.events.map((event) => decodeEvent(event));
  const stream7 = projectStreamEvents("7", decodedEvents);

  // Add a second stream so the state Merkle tree has multiple leaves and non-empty sibling steps
  const stream8: Stream = {
    streamId: "8",
    sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    recipient: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    token: fixture.contractId,
    deposit: "5000000",
    withdrawn: "0",
    startTime: "1760000000",
    endTime: "1760003600",
    cancelable: false,
    status: "active",
    lastLedger: 514192,
    updatedAt: "2026-01-01T00:10:00Z",
  };

  assert.equal(stream7.deposit, "1000000");
  assert.equal(stream7.withdrawn, "250000");
  assert.equal(stream7.status, "active");

  // Verify our canonical XDR encoder produces the exact captured testnet getLedgerEntries XDR
  const capturedEntry = fixture.getLedgerEntriesResponse.result.entries[0];
  const expectedKeyXdr = buildStreamLedgerKeyXdr(fixture.contractId, "7");
  assert.equal(expectedKeyXdr, capturedEntry.key);

  const reencodedXdr = encodeStreamContractDataEntryXdr(fixture.contractId, {
    streamId: "7",
    sender: stream7.sender!,
    recipient: stream7.recipient!,
    token: stream7.token!,
    deposit: stream7.deposit!,
    withdrawn: stream7.withdrawn,
    startTime: stream7.startTime!,
    endTime: stream7.endTime!,
    cancelable: Boolean(stream7.cancelable),
    status: "Active",
  });
  assert.equal(reencodedXdr, capturedEntry.xdr);

  // Decode the captured XDR back and verify all fields match
  const decodedXdr = decodeStreamFromEntryXdr(capturedEntry.xdr);
  assert.equal(decodedXdr.contractId, fixture.contractId);
  assert.equal(decodedXdr.keyStreamId, "7");
  assert.equal(decodedXdr.stream.deposit, "1000000");
  assert.equal(decodedXdr.stream.withdrawn, "250000");

  // Generate the signed checkpoint and stream proof
  const signer = Keypair.random();
  const capturedMap: Record<string, RpcLedgerEntryProofData> = {
    "7": {
      keyXdr: capturedEntry.key,
      entryXdr: capturedEntry.xdr,
      lastModifiedLedgerSeq: capturedEntry.lastModifiedLedgerSeq,
      liveUntilLedgerSeq: capturedEntry.liveUntilLedgerSeq,
    },
  };

  const proof = generateStreamProof({
    networkPassphrase: fixture.networkPassphrase,
    contractId: fixture.contractId,
    ledger: fixture.ledger,
    ledgerCloseTime: fixture.ledgerCloseTime,
    streams: [stream7, stream8],
    events: fixture.getEventsResponse.result.events,
    targetStreamId: "7",
    signer,
    capturedEntriesByStreamId: capturedMap,
  });

  assert.equal(proof.version, 1);
  assert.equal(proof.streamId, "7");
  assert.equal(proof.ledger, 514200);
  assert.equal(proof.stateProof.length, 1);
  assert.equal(proof.events?.length, 2);

  // Verify checkpoint Ed25519 signature
  const digest = computeCheckpointDigest(proof.checkpoint);
  const sigValid = Keypair.fromPublicKey(proof.checkpoint.signerPublicKey).verify(
    digest,
    Buffer.from(proof.checkpoint.signature, "base64")
  );
  assert.equal(sigValid, true);

  // Verify state leaf hash and event leaf hashes
  assert.equal(
    proof.stateLeafHash,
    computeStateLeafHash(fixture.contractId, "7", proof.rpcEntry)
  );
  for (const evProof of proof.events ?? []) {
    assert.equal(evProof.leafHash, computeEventLeafHash(evProof.event));
  }

  // Verify empty Merkle tree edge case
  const emptyTree = buildMerkleTree([]);
  assert.equal(emptyTree.root.length, 64);
  assert.deepEqual(emptyTree.getProof(0), []);
});
