import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { ChallengeMessage } from "./types";

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes validity
const usedNonces = new Map<string, number>(); // nonce -> expiresAt
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Generates an address verification challenge message that the wallet owner must sign.
 */
export function createVerificationChallenge(
  address: string,
  ttlSeconds = CHALLENGE_TTL_SECONDS
): ChallengeMessage {
  const nonce = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;

  const message = [
    "[StreamPay Notification Subscription]",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(now * 1000).toISOString()}`,
    `Expires At: ${new Date(expiresAt * 1000).toISOString()}`,
    "Action: Authorize notification channels (Webhook/Email/Telegram) for StreamPay payment stream events.",
  ].join("\n");

  // Record active nonce with expiration for replay protection
  usedNonces.set(nonce, expiresAt);
  cleanupExpiredNonces(now);

  return {
    address,
    nonce,
    timestamp: now,
    expiresAt,
    message,
  };
}

/**
 * Validates the signed challenge against the claimed Stellar address.
 * Ensures the signature is valid, unexpired, and not replayed.
 */
export function verifySignatureChallenge(
  challengeText: string,
  signature: string | Buffer | Uint8Array,
  expectedAddress: string
): { valid: boolean; reason?: string } {
  const now = Math.floor(Date.now() / 1000);

  // 1. Extract Address, Nonce, and Expiry from the challenge text
  const addrMatch = challengeText.match(/Address:\s*([A-Za-z0-9]+)/);
  const nonceMatch = challengeText.match(/Nonce:\s*([a-f0-9]+)/);
  const expiresMatch = challengeText.match(/Expires At:\s*([^\n]+)/);

  if (!addrMatch || !nonceMatch || !expiresMatch) {
    return { valid: false, reason: "Malformed challenge message format." };
  }

  const parsedAddress = addrMatch[1].trim();
  const nonce = nonceMatch[1].trim();
  const expiresIso = expiresMatch[1].trim();
  const expiresAt = Math.floor(new Date(expiresIso).getTime() / 1000);

  // 2. Validate address match
  if (parsedAddress !== expectedAddress) {
    return {
      valid: false,
      reason: `Challenge address (${parsedAddress}) does not match subscriber address (${expectedAddress}).`,
    };
  }

  // 3. Check expiration
  if (now > expiresAt) {
    return { valid: false, reason: "Challenge message has expired. Please request a new one." };
  }

  // 4. Check replay attack protection
  if (!usedNonces.has(nonce)) {
    return { valid: false, reason: "Challenge nonce is invalid or has already been consumed." };
  }

  // 5. Verify ed25519 signature
  try {
    const keypair = Keypair.fromPublicKey(expectedAddress);
    let sigBuffer: Uint8Array;

    if (signature instanceof Uint8Array || Buffer.isBuffer(signature)) {
      sigBuffer = signature;
    } else if (typeof signature === "string") {
      const cleanSig = signature.trim();
      if (/^[0-9a-fA-F]+$/.test(cleanSig) && cleanSig.length === 128) {
        sigBuffer = Buffer.from(cleanSig, "hex");
      } else {
        sigBuffer = Buffer.from(cleanSig, "base64");
      }
    } else {
      return { valid: false, reason: "Invalid signature type." };
    }

    const isVerified = keypair.verify(Buffer.from(challengeText, "utf8"), Buffer.from(sigBuffer));
    if (!isVerified) {
      return { valid: false, reason: "Ed25519 cryptographic signature verification failed." };
    }
  } catch (err) {
    return { valid: false, reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Consume nonce on successful verification
  usedNonces.delete(nonce);
  return { valid: true };
}

/**
 * Rate limit check: prevents abuse/spam of subscription requests.
 * Allows at most `maxAttempts` per address per window.
 */
export function checkRateLimit(
  address: string,
  maxAttempts = 15,
  windowSeconds = 900 // 15 minutes
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const bucket = rateLimitBuckets.get(address);

  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(address, { count: 1, resetAt: now + windowSeconds });
    return true;
  }

  if (bucket.count >= maxAttempts) {
    return false;
  }

  bucket.count += 1;
  return true;
}

function cleanupExpiredNonces(now: number) {
  for (const [nonce, expiresAt] of usedNonces.entries()) {
    if (now > expiresAt) {
      usedNonces.delete(nonce);
    }
  }
}
