import { createHash } from "node:crypto";
import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export const STATE_LEAF_PREFIX = "STREAMPAY_STATE_LEAF_V1\0";
export const EVENT_LEAF_PREFIX = "STREAMPAY_EVENT_LEAF_V1\0";
export const MERKLE_NODE_PREFIX = "STREAMPAY_MERKLE_NODE_V1\0";
export const MERKLE_EMPTY_PREFIX = "STREAMPAY_MERKLE_EMPTY_V1\0";
export const CHECKPOINT_PREFIX = "STREAMPAY_CHECKPOINT_V1\0";

export type ProofRejectionCode =
  | "UNSUPPORTED_VERSION"
  | "UNTRUSTED_SIGNER"
  | "CONTRACT_MISMATCH"
  | "NETWORK_MISMATCH"
  | "INVALID_SIGNATURE"
  | "CHECKPOINT_MISMATCH"
  | "STALE_PROOF"
  | "EXPIRED_ENTRY"
  | "MISSING_ENTRY"
  | "KEY_MISMATCH"
  | "INVALID_XDR"
  | "STATE_MISMATCH"
  | "LEAF_HASH_MISMATCH"
  | "INVALID_MERKLE_PROOF"
  | "EVENT_PROOF_INVALID";

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

export interface RpcEventPayload {
  id: string;
  pagingToken: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string;
}

export interface EventProofItem {
  event: RpcEventPayload;
  leafHash: string;
  proof: MerkleStep[];
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

export interface VerifyProofOptions {
  /** Pinned Stellar Ed25519 public keys (G...) allowed to sign checkpoints. */
  trustedSigners: string[];
  /** Expected StreamPay contract address (C...). */
  expectedContractId: string;
  /** Expected Stellar network passphrase. */
  expectedNetworkPassphrase: string;
  /** Expected stream ID requested by the client. */
  expectedStreamId?: string;
  /** Minimum acceptable ledger sequence (anti-rollback). */
  minLedger?: number;
  /** Current UNIX timestamp in seconds (for maxAgeSeconds freshness check). */
  nowTimestamp?: number;
  /** Maximum acceptable age of checkpoint in seconds. */
  maxAgeSeconds?: number;
}

export type VerificationResult =
  | {
      ok: true;
      stream: VerifiedStreamState;
      ledger: number;
      ledgerCloseTime: number;
      signer: string;
    }
  | {
      ok: false;
      code: ProofRejectionCode;
      reason: string;
    };

function sha256Hex(parts: Array<string | Buffer | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
}

function isValidHex32(hex: string): boolean {
  return typeof hex === "string" && /^[0-9a-fA-F]{64}$/.test(hex);
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
 * Encodes a `VerifiedStreamState` into canonical Soroban `LedgerEntryData::ContractData` XDR.
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

function normalizeStatus(status: string): "Active" | "Cancelled" | "Depleted" | "Paused" {
  const lower = status.toLowerCase();
  if (lower === "cancelled") return "Cancelled";
  if (lower === "depleted") return "Depleted";
  if (lower === "paused") return "Paused";
  return "Active";
}

/**
 * Decodes a base64 `LedgerEntryData` XDR and returns the embedded contract address,
 * key stream ID, and `VerifiedStreamState`.
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
    throw new Error(`Expected persistent contractData durability, got ${String(cd.durability)}`);
  }
  const contractId = Address.fromScAddress(cd.contract).toString();
  const keyNative = scValToNative(cd.key) as unknown;
  if (!Array.isArray(keyNative) || keyNative[0] !== "Stream" || keyNative.length !== 2) {
    throw new Error("ContractData key is not DataKey::Stream(u64)");
  }
  const keyStreamId = String(keyNative[1]);
  const raw = scValToNative(cd.val) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") {
    throw new Error("ContractData val did not decode to a map");
  }
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
      status: normalizeStatus(statusRaw),
    },
  };
}

export function computeStateLeafHash(
  contractId: string,
  streamId: string,
  entry: RpcLedgerEntryProofData
): string {
  const payload = `${contractId}:${streamId}:${entry.keyXdr}:${entry.entryXdr}:${entry.lastModifiedLedgerSeq}:${entry.liveUntilLedgerSeq}`;
  return sha256Hex([STATE_LEAF_PREFIX, payload]);
}

export function computeEventLeafHash(event: RpcEventPayload): string {
  const topicCsv = event.topic.join(",");
  const payload = `${event.id}:${event.ledger}:${event.contractId}:${topicCsv}:${event.value}`;
  return sha256Hex([EVENT_LEAF_PREFIX, payload]);
}

export function hashMerkleNode(leftHex: string, rightHex: string): string {
  return sha256Hex([
    MERKLE_NODE_PREFIX,
    Buffer.from(leftHex, "hex"),
    Buffer.from(rightHex, "hex"),
  ]);
}

export function verifyMerkleBranch(
  leafHash: string,
  steps: MerkleStep[],
  expectedRoot: string
): boolean {
  if (!isValidHex32(leafHash) || !isValidHex32(expectedRoot)) {
    return false;
  }
  let current = leafHash.toLowerCase();
  for (const step of steps) {
    if (!step || !isValidHex32(step.hash)) {
      return false;
    }
    const sibling = step.hash.toLowerCase();
    if (step.position === "left") {
      current = hashMerkleNode(sibling, current);
    } else if (step.position === "right") {
      current = hashMerkleNode(current, sibling);
    } else {
      return false;
    }
  }
  return current === expectedRoot.toLowerCase();
}

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
 * Verifies a `LightClientStreamProof` against a public `SignedCheckpoint` and client options.
 * Deterministic and stateless: suitable for browser frontend and CLI verification.
 */
export function verifyStreamProof(
  proof: LightClientStreamProof | null | undefined,
  checkpoint: SignedCheckpoint | null | undefined,
  options: VerifyProofOptions
): VerificationResult {
  if (!proof || !checkpoint) {
    return { ok: false, code: "MISSING_ENTRY", reason: "Proof or checkpoint is missing" };
  }

  if (proof.version !== 1 || checkpoint.version !== 1) {
    return {
      ok: false,
      code: "UNSUPPORTED_VERSION",
      reason: `Unsupported proof (${String(proof.version)}) or checkpoint (${String(checkpoint.version)}) version`,
    };
  }

  // 1. Verify checkpoint signer is pinned
  if (!options.trustedSigners.includes(checkpoint.signerPublicKey)) {
    return {
      ok: false,
      code: "UNTRUSTED_SIGNER",
      reason: `Checkpoint signer ${checkpoint.signerPublicKey} is not in trustedSigners`,
    };
  }

  // 2. Verify network passphrase and contract ID binding
  if (checkpoint.networkPassphrase !== options.expectedNetworkPassphrase) {
    return {
      ok: false,
      code: "NETWORK_MISMATCH",
      reason: `Checkpoint network '${checkpoint.networkPassphrase}' does not match expected '${options.expectedNetworkPassphrase}'`,
    };
  }

  if (
    checkpoint.contractId !== options.expectedContractId ||
    proof.contractId !== options.expectedContractId
  ) {
    return {
      ok: false,
      code: "CONTRACT_MISMATCH",
      reason: `Contract ID mismatch: proof=${proof.contractId}, checkpoint=${checkpoint.contractId}, expected=${options.expectedContractId}`,
    };
  }

  // 3. Verify Ed25519 signature on the checkpoint
  try {
    const digest = computeCheckpointDigest(checkpoint);
    const sigBytes = Buffer.from(checkpoint.signature, "base64");
    const kp = Keypair.fromPublicKey(checkpoint.signerPublicKey);
    if (!kp.verify(digest, sigBytes)) {
      return {
        ok: false,
        code: "INVALID_SIGNATURE",
        reason: "Checkpoint Ed25519 signature verification failed",
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_SIGNATURE",
      reason: `Malformed checkpoint signature or public key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Verify proof is bound to the exact supplied checkpoint
  if (
    proof.ledger !== checkpoint.ledger ||
    !proof.checkpoint ||
    proof.checkpoint.ledger !== checkpoint.ledger ||
    proof.checkpoint.stateRoot.toLowerCase() !== checkpoint.stateRoot.toLowerCase() ||
    proof.checkpoint.eventRoot.toLowerCase() !== checkpoint.eventRoot.toLowerCase() ||
    proof.checkpoint.signature !== checkpoint.signature
  ) {
    return {
      ok: false,
      code: "CHECKPOINT_MISMATCH",
      reason: `Proof ledger/checkpoint (${proof.ledger}) does not match trusted checkpoint (${checkpoint.ledger})`,
    };
  }

  // 5. Freshness / Stale proof checks
  if (options.minLedger !== undefined && checkpoint.ledger < options.minLedger) {
    return {
      ok: false,
      code: "STALE_PROOF",
      reason: `Checkpoint ledger ${checkpoint.ledger} is older than minimum required ledger ${options.minLedger}`,
    };
  }

  if (options.nowTimestamp !== undefined && options.maxAgeSeconds !== undefined) {
    const age = options.nowTimestamp - checkpoint.ledgerCloseTime;
    if (age > options.maxAgeSeconds) {
      return {
        ok: false,
        code: "STALE_PROOF",
        reason: `Checkpoint age (${age}s) exceeds maximum allowed age (${options.maxAgeSeconds}s)`,
      };
    }
  }

  // 6. Verify requested stream ID and presence of RPC entry
  if (!proof.stream || !proof.rpcEntry || !proof.rpcEntry.keyXdr || !proof.rpcEntry.entryXdr) {
    return {
      ok: false,
      code: "MISSING_ENTRY",
      reason: "Proof is missing stream state or rpcEntry XDR payload",
    };
  }

  if (options.expectedStreamId !== undefined && proof.streamId !== options.expectedStreamId) {
    return {
      ok: false,
      code: "KEY_MISMATCH",
      reason: `Proof streamId (${proof.streamId}) does not match requested streamId (${options.expectedStreamId})`,
    };
  }

  if (proof.stream.streamId !== proof.streamId) {
    return {
      ok: false,
      code: "KEY_MISMATCH",
      reason: `Stream payload id (${proof.stream.streamId}) does not match proof streamId (${proof.streamId})`,
    };
  }

  // 7. Verify entry TTL liveness at checkpoint ledger
  if (
    typeof proof.rpcEntry.liveUntilLedgerSeq !== "number" ||
    proof.rpcEntry.liveUntilLedgerSeq < checkpoint.ledger
  ) {
    return {
      ok: false,
      code: "EXPIRED_ENTRY",
      reason: `Entry liveUntilLedgerSeq (${proof.rpcEntry.liveUntilLedgerSeq}) is expired at checkpoint ledger ${checkpoint.ledger}`,
    };
  }

  if (
    typeof proof.rpcEntry.lastModifiedLedgerSeq !== "number" ||
    proof.rpcEntry.lastModifiedLedgerSeq > checkpoint.ledger
  ) {
    return {
      ok: false,
      code: "STATE_MISMATCH",
      reason: `Entry lastModifiedLedgerSeq (${proof.rpcEntry.lastModifiedLedgerSeq}) is in the future relative to checkpoint ledger ${checkpoint.ledger}`,
    };
  }

  // 8. Rebuild canonical LedgerKey XDR and verify exact match
  let expectedKeyXdr: string;
  try {
    expectedKeyXdr = buildStreamLedgerKeyXdr(options.expectedContractId, proof.streamId);
  } catch (err) {
    return {
      ok: false,
      code: "KEY_MISMATCH",
      reason: `Failed to construct canonical LedgerKey: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (proof.rpcEntry.keyXdr !== expectedKeyXdr) {
    return {
      ok: false,
      code: "KEY_MISMATCH",
      reason: "rpcEntry.keyXdr does not match canonical DataKey::Stream(streamId) XDR",
    };
  }

  // 9. Decode LedgerEntryData XDR and cross-check every field against proof.stream
  let decodedEntry: ReturnType<typeof decodeStreamFromEntryXdr>;
  try {
    decodedEntry = decodeStreamFromEntryXdr(proof.rpcEntry.entryXdr);
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_XDR",
      reason: `Failed to decode rpcEntry.entryXdr: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (decodedEntry.contractId !== options.expectedContractId) {
    return {
      ok: false,
      code: "CONTRACT_MISMATCH",
      reason: `XDR entry contract (${decodedEntry.contractId}) does not match expected (${options.expectedContractId})`,
    };
  }

  if (decodedEntry.keyStreamId !== proof.streamId) {
    return {
      ok: false,
      code: "KEY_MISMATCH",
      reason: `XDR entry key streamId (${decodedEntry.keyStreamId}) does not match proof.streamId (${proof.streamId})`,
    };
  }

  const s = proof.stream;
  const d = decodedEntry.stream;
  if (
    s.streamId !== d.streamId ||
    s.sender !== d.sender ||
    s.recipient !== d.recipient ||
    s.token !== d.token ||
    s.deposit !== d.deposit ||
    s.withdrawn !== d.withdrawn ||
    s.startTime !== d.startTime ||
    s.endTime !== d.endTime ||
    s.cancelable !== d.cancelable ||
    s.status !== d.status
  ) {
    return {
      ok: false,
      code: "STATE_MISMATCH",
      reason: "Claimed stream JSON fields do not match decoded Soroban ContractDataEntry XDR",
    };
  }

  // 10. Recompute state leaf hash and verify Merkle path to checkpoint.stateRoot
  const computedLeafHash = computeStateLeafHash(
    options.expectedContractId,
    proof.streamId,
    proof.rpcEntry
  );

  if (computedLeafHash.toLowerCase() !== proof.stateLeafHash?.toLowerCase()) {
    return {
      ok: false,
      code: "LEAF_HASH_MISMATCH",
      reason: "Recomputed state leaf hash does not match proof.stateLeafHash",
    };
  }

  if (
    !Array.isArray(proof.stateProof) ||
    !verifyMerkleBranch(computedLeafHash, proof.stateProof, checkpoint.stateRoot)
  ) {
    return {
      ok: false,
      code: "INVALID_MERKLE_PROOF",
      reason: "State Merkle inclusion proof failed against checkpoint.stateRoot",
    };
  }

  // 11. Optional: Verify attached event inclusion proofs against checkpoint.eventRoot
  if (proof.events !== undefined) {
    if (!Array.isArray(proof.events)) {
      return {
        ok: false,
        code: "EVENT_PROOF_INVALID",
        reason: "proof.events must be an array when present",
      };
    }
    for (const item of proof.events) {
      if (!item || !item.event) {
        return {
          ok: false,
          code: "EVENT_PROOF_INVALID",
          reason: "Malformed event proof item",
        };
      }
      if (item.event.contractId !== options.expectedContractId) {
        return {
          ok: false,
          code: "EVENT_PROOF_INVALID",
          reason: `Event ${item.event.id} contractId mismatch`,
        };
      }
      if (item.event.ledger > checkpoint.ledger) {
        return {
          ok: false,
          code: "EVENT_PROOF_INVALID",
          reason: `Event ${item.event.id} ledger (${item.event.ledger}) exceeds checkpoint ledger (${checkpoint.ledger})`,
        };
      }
      // Verify event topic[1] matches this streamId
      try {
        if (item.event.topic.length < 2) {
          return {
            ok: false,
            code: "EVENT_PROOF_INVALID",
            reason: `Event ${item.event.id} missing streamId topic`,
          };
        }
        const evStreamId = String(
          scValToNative(xdr.ScVal.fromXDR(item.event.topic[1], "base64"))
        );
        if (evStreamId !== proof.streamId) {
          return {
            ok: false,
            code: "EVENT_PROOF_INVALID",
            reason: `Event ${item.event.id} belongs to stream ${evStreamId}, expected ${proof.streamId}`,
          };
        }
        // Ensure event value is valid ScVal XDR
        xdr.ScVal.fromXDR(item.event.value, "base64");
      } catch (err) {
        return {
          ok: false,
          code: "EVENT_PROOF_INVALID",
          reason: `Event ${item.event.id} has invalid XDR topic or value: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const expectedEventLeaf = computeEventLeafHash(item.event);
      if (expectedEventLeaf.toLowerCase() !== item.leafHash?.toLowerCase()) {
        return {
          ok: false,
          code: "EVENT_PROOF_INVALID",
          reason: `Event ${item.event.id} leaf hash mismatch`,
        };
      }
      if (
        !Array.isArray(item.proof) ||
        !verifyMerkleBranch(expectedEventLeaf, item.proof, checkpoint.eventRoot)
      ) {
        return {
          ok: false,
          code: "EVENT_PROOF_INVALID",
          reason: `Event ${item.event.id} failed Merkle proof verification against checkpoint.eventRoot`,
        };
      }
    }
  }

  return {
    ok: true,
    stream: decodedEntry.stream,
    ledger: checkpoint.ledger,
    ledgerCloseTime: checkpoint.ledgerCloseTime,
    signer: checkpoint.signerPublicKey,
  };
}
