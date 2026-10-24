import crypto from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type {
  CanonicalConsentMessage,
  CanonicalWithdrawMessage,
  PartySignature,
} from "./types.ts";

export const DISCOVERY_DOMAIN = "StreamPayDiscovery:v1";

/**
 * Deterministically serializes any JavaScript object into canonical JSON:
 * - Keys sorted alphabetically at all nesting levels
 * - No extraneous whitespace
 * - Standard string, boolean, number representations
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const serializedElements = obj.map((item) => canonicalJsonStringify(item));
    return `[${serializedElements.join(",")}]`;
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];

  for (const key of sortedKeys) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== undefined) {
      entries.push(`${JSON.stringify(key)}:${canonicalJsonStringify(val)}`);
    }
  }

  return `{${entries.join(",")}}`;
}

/**
 * Computes SHA-256 digest of canonical JSON string.
 */
export function hashCanonicalPayload(payload: unknown): Buffer {
  const canonicalStr = canonicalJsonStringify(payload);
  return crypto.createHash("sha256").update(canonicalStr, "utf8").digest();
}

/**
 * Signs a canonical payload with a Keypair and returns a base64-encoded Ed25519 signature.
 */
export function signCanonicalPayload(keypair: Keypair, payload: unknown): string {
  const digest = hashCanonicalPayload(payload);
  return Buffer.from(keypair.sign(digest)).toString("base64");
}

/**
 * Constructs canonical consent payload for a party to sign.
 */
export function buildCanonicalConsentMessage(params: {
  network: string;
  contractId: string;
  streamId: string;
  nonce: string;
  expiry: number;
  shareAddress: boolean;
}): CanonicalConsentMessage {
  return {
    action: "STREAM_DISCOVERY_CONSENT",
    version: "1",
    domain: DISCOVERY_DOMAIN,
    network: params.network,
    contractId: params.contractId,
    streamId: params.streamId,
    nonce: params.nonce,
    expiry: params.expiry,
    shareAddress: params.shareAddress,
  };
}

/**
 * Constructs canonical withdrawal payload for a party to sign.
 */
export function buildCanonicalWithdrawMessage(params: {
  network: string;
  contractId: string;
  streamId: string;
  listingId: string;
  nonce: string;
  timestamp: number;
}): CanonicalWithdrawMessage {
  return {
    action: "STREAM_DISCOVERY_WITHDRAW",
    version: "1",
    domain: DISCOVERY_DOMAIN,
    network: params.network,
    contractId: params.contractId,
    streamId: params.streamId,
    listingId: params.listingId,
    nonce: params.nonce,
    timestamp: params.timestamp,
  };
}

export interface VerificationResult {
  valid: boolean;
  error?:
    | "EXPIRED"
    | "WRONG_NETWORK"
    | "WRONG_CONTRACT"
    | "WRONG_SIGNER"
    | "INVALID_PUBLIC_KEY"
    | "MALFORMED_SIGNATURE"
    | "INVALID_SIGNATURE"
    | "INVALID_NONCE";
}

/**
 * Low-level Ed25519 signature verification against both raw digest and canonical string.
 */
function verifyEd25519(
  publicKey: string,
  canonicalPayload: unknown,
  signatureBase64: string
): boolean {
  try {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      return false;
    }

    const keypair = Keypair.fromPublicKey(publicKey);
    const signatureBuffer = Buffer.from(signatureBase64, "base64");
    if (signatureBuffer.length !== 64) {
      return false;
    }

    const digest = hashCanonicalPayload(canonicalPayload);
    // 1. Try verifying against 32-byte SHA-256 digest
    if (keypair.verify(digest, signatureBuffer)) {
      return true;
    }

    // 2. Try verifying against UTF-8 canonical string
    const rawBuffer = Buffer.from(canonicalJsonStringify(canonicalPayload), "utf8");
    if (keypair.verify(rawBuffer, signatureBuffer)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Verifies a stream party's consent signature against domain rules.
 */
export function verifyPartyConsent(params: {
  expectedSigner: string;
  expectedNetwork: string;
  expectedContractId: string;
  expectedStreamId: string;
  nonce: string;
  expiry: number;
  partyConsent: PartySignature;
  nowSeconds?: number;
}): VerificationResult {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);

  // 1. Expiry check
  if (params.expiry <= now) {
    return { valid: false, error: "EXPIRED" };
  }

  // 2. Signer match
  if (params.partyConsent.address !== params.expectedSigner) {
    return { valid: false, error: "WRONG_SIGNER" };
  }

  // 3. Public key syntax
  if (!StrKey.isValidEd25519PublicKey(params.partyConsent.address)) {
    return { valid: false, error: "INVALID_PUBLIC_KEY" };
  }

  // 4. Nonce validity
  if (!params.nonce || params.nonce.length < 8) {
    return { valid: false, error: "INVALID_NONCE" };
  }

  // 5. Construct expected canonical message
  const message = buildCanonicalConsentMessage({
    network: params.expectedNetwork,
    contractId: params.expectedContractId,
    streamId: params.expectedStreamId,
    nonce: params.nonce,
    expiry: params.expiry,
    shareAddress: params.partyConsent.shareAddress,
  });

  // 6. Verify Ed25519 signature
  const valid = verifyEd25519(
    params.partyConsent.address,
    message,
    params.partyConsent.signature
  );

  if (!valid) {
    return { valid: false, error: "INVALID_SIGNATURE" };
  }

  return { valid: true };
}

/**
 * Verifies a party's withdrawal signature.
 */
export function verifyPartyWithdrawal(params: {
  expectedSigner: string;
  expectedNetwork: string;
  expectedContractId: string;
  expectedStreamId: string;
  listingId: string;
  nonce: string;
  timestamp: number;
  signature: string;
  maxTimestampDriftSeconds?: number;
  nowSeconds?: number;
}): VerificationResult {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxDrift = params.maxTimestampDriftSeconds ?? 86400; // 24 hours drift tolerance

  if (Math.abs(params.timestamp - now) > maxDrift) {
    return { valid: false, error: "EXPIRED" };
  }

  if (!StrKey.isValidEd25519PublicKey(params.expectedSigner)) {
    return { valid: false, error: "INVALID_PUBLIC_KEY" };
  }

  if (!params.nonce || params.nonce.length < 8) {
    return { valid: false, error: "INVALID_NONCE" };
  }

  const message = buildCanonicalWithdrawMessage({
    network: params.expectedNetwork,
    contractId: params.expectedContractId,
    streamId: params.expectedStreamId,
    listingId: params.listingId,
    nonce: params.nonce,
    timestamp: params.timestamp,
  });

  const valid = verifyEd25519(params.expectedSigner, message, params.signature);
  if (!valid) {
    return { valid: false, error: "INVALID_SIGNATURE" };
  }

  return { valid: true };
}

/**
 * Generates an HMAC-SHA256 blind attestation proving on-chain verification.
 */
export function generateVerificationAttestation(params: {
  listingId: string;
  asset: string;
  rateBucket: string;
  durationBucket: string;
  status: string;
  secretKey?: string;
}): string {
  const secret = params.secretKey || process.env.DISCOVERY_ATTESTATION_SECRET || "streampay-attestation-secret";
  const content = `${params.listingId}:${params.asset}:${params.rateBucket}:${params.durationBucket}:${params.status}`;
  return crypto.createHmac("sha256", secret).update(content).digest("hex");
}
