/**
 * StreamPay Shareable Payment Link Reference Specification.
 *
 * Implements deterministic payment link references: /pay/[ref]
 * References encode:
 * - Version (1)
 * - Stream ID
 * - Contract ID hint (prefix + checksum)
 * - Blinded recipient commitment (prevents leaking claimant address in plain URL)
 * - Tamper-evident checksum
 */

export interface PaymentLinkData {
  version: number;
  streamId: string;
  contractHint: string;
  blindedRecipient: string;
  salt: string;
}

/**
 * Universal SHA-256 hash helper supporting both Web Crypto (browser & modern Node)
 * and node:crypto fallback.
 */
async function sha256Hex(message: string): Promise<string> {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node.js fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require("node:crypto");
    return nodeCrypto.createHash("sha256").update(message).digest("hex");
  } catch {
    throw new Error("Crypto environment not available");
  }
}

/**
 * Base64url encode and decode utilities.
 */
function toBase64Url(str: string): string {
  if (typeof btoa === "function") {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return Buffer.from(str, "utf-8").toString("base64url");
}

function fromBase64Url(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  if (typeof atob === "function") {
    return atob(padded);
  }
  return Buffer.from(padded, "base64").toString("utf-8");
}

/**
 * Derives a privacy-preserving commitment to the recipient's address.
 * Returns the first 16 hex chars (64 bits) of SHA-256(recipient + ":" + streamId + ":" + salt).
 */
export async function deriveRecipientCommitment(
  recipient: string,
  streamId: string,
  salt: string
): Promise<string> {
  const raw = `${recipient.trim().toUpperCase()}:${streamId.trim()}:${salt.trim()}`;
  const fullHash = await sha256Hex(raw);
  return fullHash.slice(0, 16);
}

/**
 * Computes an integrity checksum for a payment link payload.
 */
async function computePayloadChecksum(payloadStr: string): Promise<string> {
  const hash = await sha256Hex(`streampay-paylink-v1:${payloadStr}`);
  return hash.slice(0, 8);
}

/**
 * Encodes a payment link into a compact, deterministic, base64url string.
 */
export async function encodePaymentLinkRef(params: {
  streamId: string;
  recipient: string;
  contractId?: string;
  salt?: string;
}): Promise<string> {
  const { streamId, recipient } = params;
  const contractId =
    params.contractId ||
    process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID ||
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  const salt =
    params.salt ||
    Math.random().toString(16).slice(2, 10).padStart(8, "0");

  const contractHint = contractId.slice(0, 6);
  const blindedRecipient = await deriveRecipientCommitment(
    recipient,
    streamId,
    salt
  );

  const payload: PaymentLinkData = {
    version: 1,
    streamId,
    contractHint,
    blindedRecipient,
    salt,
  };

  const payloadStr = JSON.stringify(payload);
  const checksum = await computePayloadChecksum(payloadStr);

  const wrapped = JSON.stringify({
    d: payload,
    c: checksum,
  });

  return toBase64Url(wrapped);
}

/**
 * Decodes and validates a payment link reference string.
 * Returns null if format is invalid, version is unsupported, or checksum fails.
 */
export async function decodePaymentLinkRef(
  ref: string
): Promise<PaymentLinkData | null> {
  if (!ref || typeof ref !== "string" || ref.trim().length === 0) {
    return null;
  }

  try {
    const rawJson = fromBase64Url(ref.trim());
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || !parsed.d || !parsed.c) {
      return null;
    }

    const payload: PaymentLinkData = parsed.d;
    const checksum: string = parsed.c;

    if (payload.version !== 1) {
      return null;
    }
    if (!payload.streamId || !payload.contractHint || !payload.blindedRecipient || !payload.salt) {
      return null;
    }

    const expectedChecksum = await computePayloadChecksum(JSON.stringify(payload));
    if (checksum !== expectedChecksum) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Verifies if a connected wallet claimant matches the blinded recipient commitment
 * in the payment link reference.
 */
export async function verifyRecipientBinding(
  decoded: PaymentLinkData,
  claimantAddress: string
): Promise<boolean> {
  if (!claimantAddress || typeof claimantAddress !== "string") {
    return false;
  }

  const derived = await deriveRecipientCommitment(
    claimantAddress,
    decoded.streamId,
    decoded.salt
  );

  return derived.toLowerCase() === decoded.blindedRecipient.toLowerCase();
}
