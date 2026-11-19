import { createHash } from "node:crypto";
import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { RpcEvent, Stream } from "./types.js";

export const STATE_LEAF_PREFIX = "STREAMPAY_STATE_LEAF_V1\0";
export const EVENT_LEAF_PREFIX = "STREAMPAY_EVENT_LEAF_V1\0";
export const MERKLE_NODE_PREFIX = "STREAMPAY_MERKLE_NODE_V1\0";
export const MERKLE_EMPTY_PREFIX = "STREAMPAY_MERKLE_EMPTY_V1\0";
export const CHECKPOINT_PREFIX = "STREAMPAY_CHECKPOINT_V1\0";

export interface MerkleStep {
  position: "left" | "right";
  hash: string;
}

export interface RpcLedgerEntryProofData {
  keyXdr: string;
  entryXdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq: number;
}

export interface VerifiedStreamState {
  streamId: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: string;
  endTime: string;
  cancelable: boolean;
  status: "Active" | "Cancelled" | "Depleted" | "Paused";
}

export interface SignedCheckpoint {
  version: 1;
  networkPassphrase: string;
  contractId: string;
  ledger: number;
  ledgerCloseTime: number;
  stateRoot: string;
  eventRoot: string;
  streamCount: number;
  signerPublicKey: string;
  signature: string;
}

export interface EventProofItem {
  event: RpcEvent;
  leafHash: string;
  proof: MerkleStep[];
}

export interface LightClientStreamProof {
  version: 1;
  contractId: string;
  streamId: string;
  ledger: number;
  stream: VerifiedStreamState;
  rpcEntry: RpcLedgerEntryProofData;
  stateLeafHash: string;
  stateProof: MerkleStep[];
  events?: EventProofItem[];
  checkpoint: SignedCheckpoint;
}

function sha256Hex(parts: Array<string | Buffer | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
}

/**
 * Normalizes an indexer status ("active", "cancelled", etc.) to the canonical
 * Soroban contract enum symbol ("Active", "Cancelled", "Depleted", "Paused").
 */
export function toContractStatus(status: string): "Active" | "Cancelled" | "Depleted" | "Paused" {
  const lower = status.toLowerCase();
  if (lower === "cancelled") return "Cancelled";
  if (lower === "depleted") return "Depleted";
  if (lower === "paused") return "Paused";
  return "Active";
}

/**
 * Builds the canonical Soroban `LedgerKey::ContractData` XDR (base64) for `DataKey::Stream(id)`.
 */
export function buildStreamLedgerKeyXdr(contractId: string, streamId: string | number | bigint): string {
  const keyScv = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Stream"),
    xdr.ScVal.scvU64(BigInt(streamId)),
  ]);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: keyScv,
      durability: xdr.ContractDataDurability.persistent,
    })
  );
  return ledgerKey.toXDR("base64");
}

/**
 * Encodes a `VerifiedStreamState` into canonical Soroban `LedgerEntryData::ContractData` XDR (base64),
 * matching the exact field order and ScVal types returned by Soroban RPC `getLedgerEntries`.
 */
export function encodeStreamContractDataEntryXdr(
  contractId: string,
  stream: VerifiedStreamState
): string {
  const keyScv = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Stream"),
    xdr.ScVal.scvU64(BigInt(stream.streamId)),
  ]);
  const i128 = (v: string) => nativeToScVal(BigInt(v), { type: "i128" });
  const u64 = (v: string) => nativeToScVal(BigInt(v), { type: "u64" });
  const addr = (a: string) => nativeToScVal(Address.fromString(a), { type: "address" });
  const mapEntry = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });

  const valScv = xdr.ScVal.scvMap([
    mapEntry("cancelable", xdr.ScVal.scvBool(stream.cancelable)),
    mapEntry("deposit", i128(stream.deposit)),
    mapEntry("end_time", u64(stream.endTime)),
    mapEntry("id", u64(stream.streamId)),
    mapEntry("recipient", addr(stream.recipient)),
    mapEntry("sender", addr(stream.sender)),
    mapEntry("start_time", u64(stream.startTime)),
    mapEntry("status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(stream.status)])),
    mapEntry("token", addr(stream.token)),
    mapEntry("withdrawn", i128(stream.withdrawn)),
  ]);

  const entry = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.v0(),
    contract: Address.fromString(contractId).toScAddress(),
    key: keyScv,
    durability: xdr.ContractDataDurability.persistent,
    val: valScv,
  });

  return xdr.LedgerEntryData.contractData(entry).toXDR("base64");
}

/**
 * Decodes a base64 `LedgerEntryData` XDR from Soroban RPC `getLedgerEntries`
 * into its contractId, streamId, and `VerifiedStreamState`.
 */
export function decodeStreamFromEntryXdr(entryXdrBase64: string): {
  contractId: string;
  keyStreamId: string;
  stream: VerifiedStreamState;
} {
  const data = xdr.LedgerEntryData.fromXDR(entryXdrBase64, "base64");
  if (data.type !== "contractData") {
    throw new Error(`Expected contractData LedgerEntryData, got ${data.type}`);
  }
  const cd = data.contractData;
  if (String(cd.durability) !== String(xdr.ContractDataDurability.persistent)) {
    throw new Error(`Expected persistent contractData entry, got ${String(cd.durability)}`);
  }
  const contractId = Address.fromScAddress(cd.contract).toString();
  const keyNative = scValToNative(cd.key) as unknown;
  if (!Array.isArray(keyNative) || keyNative[0] !== "Stream" || keyNative.length !== 2) {
    throw new Error("ContractData key is not DataKey::Stream(u64)");
  }
  const keyStreamId = String(keyNative[1]);

  const raw = scValToNative(cd.val) as Record<string, unknown>;
  const statusRaw = Array.isArray(raw.status) ? String(raw.status[0]) : String(raw.status);

  return {
    contractId,
    keyStreamId,
    stream: {
      streamId: String(raw.id),
      sender: String(raw.sender),
      recipient: String(raw.recipient),
      token: String(raw.token),
      deposit: String(raw.deposit),
      withdrawn: String(raw.withdrawn),
      startTime: String(raw.start_time),
      endTime: String(raw.end_time),
      cancelable: Boolean(raw.cancelable),
      status: toContractStatus(statusRaw),
    },
  };
}

/**
 * Computes the domain-separated SHA-256 leaf hash for a stream state entry.
 */
export function computeStateLeafHash(
  contractId: string,
  streamId: string,
  entry: RpcLedgerEntryProofData
): string {
  const payload = `${contractId}:${streamId}:${entry.keyXdr}:${entry.entryXdr}:${entry.lastModifiedLedgerSeq}:${entry.liveUntilLedgerSeq}`;
  return sha256Hex([STATE_LEAF_PREFIX, payload]);
}

/**
 * Computes the domain-separated SHA-256 leaf hash for a raw Soroban RPC event.
 */
export function computeEventLeafHash(event: RpcEvent): string {
  const topicCsv = event.topic.join(",");
  const payload = `${event.id}:${event.ledger}:${event.contractId}:${topicCsv}:${event.value}`;
  return sha256Hex([EVENT_LEAF_PREFIX, payload]);
}

/**
 * Computes the parent hash of two 32-byte hex Merkle nodes.
 */
export function hashMerkleNode(leftHex: string, rightHex: string): string {
  return sha256Hex([
    MERKLE_NODE_PREFIX,
    Buffer.from(leftHex, "hex"),
    Buffer.from(rightHex, "hex"),
  ]);
}

/**
 * Deterministic binary Merkle tree over pre-sorted leaf hashes.
 * Odd leaves are promoted without duplication to prevent CVE-2012-2459 malleability.
 */
export function buildMerkleTree(leafHashes: string[]): {
  root: string;
  getProof: (index: number) => MerkleStep[];
} {
  if (leafHashes.length === 0) {
    const emptyRoot = sha256Hex([MERKLE_EMPTY_PREFIX]);
    return {
      root: emptyRoot,
      getProof: () => [],
    };
  }

  const levels: string[][] = [leafHashes.slice()];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashMerkleNode(current[i], current[i + 1]));
      } else {
        next.push(current[i]);
      }
    }
    levels.push(next);
  }

  const root = levels[levels.length - 1][0];

  const getProof = (index: number): MerkleStep[] => {
    if (index < 0 || index >= leafHashes.length) {
      throw new RangeError(`Leaf index ${index} out of bounds`);
    }
    const steps: MerkleStep[] = [];
    let idx = index;
    for (let level = 0; level < levels.length - 1; level++) {
      const nodes = levels[level];
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode ? idx - 1 : idx + 1;
      if (siblingIdx < nodes.length) {
        steps.push({
          position: isRightNode ? "left" : "right",
          hash: nodes[siblingIdx],
        });
      }
      idx = Math.floor(idx / 2);
    }
    return steps;
  };

  return { root, getProof };
}

/**
 * Computes the domain-separated 32-byte digest signed by a checkpoint authority.
 */
export function computeCheckpointDigest(
  checkpoint: Omit<SignedCheckpoint, "signature" | "signerPublicKey">
): Buffer {
  const canonical = [
    checkpoint.networkPassphrase,
    checkpoint.contractId,
    String(checkpoint.ledger),
    String(checkpoint.ledgerCloseTime),
    checkpoint.stateRoot,
    checkpoint.eventRoot,
    String(checkpoint.streamCount),
  ].join("\n");
  const hash = createHash("sha256");
  hash.update(CHECKPOINT_PREFIX);
  hash.update(canonical);
  return hash.digest();
}

/**
 * Signs a checkpoint header using a Stellar Ed25519 `Keypair`.
 */
export function signCheckpoint(
  unsigned: Omit<SignedCheckpoint, "signature" | "signerPublicKey">,
  signer: Keypair
): SignedCheckpoint {
  const digest = computeCheckpointDigest(unsigned);
  const sig = signer.sign(digest);
  return {
    ...unsigned,
    signerPublicKey: signer.publicKey(),
    signature: Buffer.from(sig).toString("base64"),
  };
}

/**
 * Converts an indexer `Stream` projection into a `VerifiedStreamState` and
 * synthesizes or attaches its `RpcLedgerEntryProofData` XDR.
 */
export function streamToProofEntry(
  contractId: string,
  stream: Stream,
  liveUntilLedgerSeq = stream.lastLedger + 500_000,
  capturedEntryXdr?: string
): { verifiedStream: VerifiedStreamState; rpcEntry: RpcLedgerEntryProofData } {
  if (!stream.sender || !stream.recipient || !stream.token || !stream.deposit || !stream.startTime || !stream.endTime || stream.cancelable === null) {
    throw new Error(`Stream ${stream.streamId} is incomplete and cannot be encoded to canonical XDR`);
  }
  const verifiedStream: VerifiedStreamState = {
    streamId: stream.streamId,
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    deposit: stream.deposit,
    withdrawn: stream.withdrawn,
    startTime: stream.startTime,
    endTime: stream.endTime,
    cancelable: stream.cancelable,
    status: toContractStatus(stream.status),
  };
  const keyXdr = buildStreamLedgerKeyXdr(contractId, stream.streamId);
  const entryXdr = capturedEntryXdr ?? encodeStreamContractDataEntryXdr(contractId, verifiedStream);
  return {
    verifiedStream,
    rpcEntry: {
      keyXdr,
      entryXdr,
      lastModifiedLedgerSeq: stream.lastLedger,
      liveUntilLedgerSeq,
    },
  };
}

/**
 * Generates a signed checkpoint and an inclusion proof for `targetStreamId`
 * from a snapshot of indexed streams and raw RPC events.
 */
export function generateStreamProof(params: {
  networkPassphrase: string;
  contractId: string;
  ledger: number;
  ledgerCloseTime: number;
  streams: Stream[];
  events?: RpcEvent[];
  targetStreamId: string;
  signer: Keypair;
  capturedEntriesByStreamId?: Record<string, RpcLedgerEntryProofData>;
}): LightClientStreamProof {
  const {
    networkPassphrase,
    contractId,
    ledger,
    ledgerCloseTime,
    streams,
    events = [],
    targetStreamId,
    signer,
    capturedEntriesByStreamId = {},
  } = params;

  const sortedStreams = [...streams].sort((a, b) =>
    a.streamId.localeCompare(b.streamId, undefined, { numeric: true })
  );

  const prepared = sortedStreams.map((s) => {
    const captured = capturedEntriesByStreamId[s.streamId];
    const base = streamToProofEntry(contractId, s);
    const rpcEntry = captured ?? base.rpcEntry;
    const leafHash = computeStateLeafHash(contractId, s.streamId, rpcEntry);
    return {
      streamId: s.streamId,
      verifiedStream: base.verifiedStream,
      rpcEntry,
      leafHash,
    };
  });

  const targetIndex = prepared.findIndex((p) => p.streamId === targetStreamId);
  if (targetIndex === -1) {
    throw new Error(`Stream ${targetStreamId} not found in snapshot`);
  }

  const stateTree = buildMerkleTree(prepared.map((p) => p.leafHash));

  const sortedEvents = [...events].sort((a, b) => a.id.localeCompare(b.id));
  const eventLeaves = sortedEvents.map((ev) => ({
    event: ev,
    leafHash: computeEventLeafHash(ev),
  }));
  const eventTree = buildMerkleTree(eventLeaves.map((e) => e.leafHash));

  const checkpoint = signCheckpoint(
    {
      version: 1,
      networkPassphrase,
      contractId,
      ledger,
      ledgerCloseTime,
      stateRoot: stateTree.root,
      eventRoot: eventTree.root,
      streamCount: prepared.length,
    },
    signer
  );

  const target = prepared[targetIndex];

  const streamEvents: EventProofItem[] = [];
  for (let i = 0; i < eventLeaves.length; i++) {
    const item = eventLeaves[i];
    // Include events belonging to this stream (topic[1] is u64 streamId).
    // `RpcEvent.topic` is `(string | unknown)[]` on this branch — the RPC hands
    // topics back as base64 strings, so a non-string element is not a stream
    // topic and is skipped rather than fed to `ScVal.fromXDR`.
    const topicStreamIdRaw = item.event.topic.length >= 2 ? item.event.topic[1] : undefined;
    if (typeof topicStreamIdRaw === "string") {
      try {
        const topicStreamId = String(scValToNative(xdr.ScVal.fromXDR(topicStreamIdRaw, "base64")));
        if (topicStreamId === targetStreamId) {
          streamEvents.push({
            event: item.event,
            leafHash: item.leafHash,
            proof: eventTree.getProof(i),
          });
        }
      } catch {
        // Ignore non-stream topic events
      }
    }
  }

  return {
    version: 1,
    contractId,
    streamId: targetStreamId,
    ledger,
    stream: target.verifiedStream,
    rpcEntry: target.rpcEntry,
    stateLeafHash: target.leafHash,
    stateProof: stateTree.getProof(targetIndex),
    ...(events.length > 0 ? { events: streamEvents } : {}),
    checkpoint,
  };
}
