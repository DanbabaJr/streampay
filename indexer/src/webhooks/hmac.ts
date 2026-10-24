import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEventEnvelope } from "./types.js";

/**
 * Deterministic canonical JSON serialization with sorted keys.
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalizeJson).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson((obj as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(",")}}`;
}

/**
 * Computes an HMAC-SHA256 hex digest for a given secret and payload.
 */
export function computeHmacSha256(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf-8").digest("hex");
}

/**
 * Generates the canonical `Streampay-Signature` header value.
 * Format: `t={timestamp},v1={hex_signature}`
 * If `previousSecret` is present (during secret rotation), includes dual signatures:
 * `t={timestamp},v1={current_signature},v1={previous_signature}`
 */
export function generateSignatureHeader(
  secret: string,
  timestamp: number,
  payloadJson: string,
  previousSecret?: string | null
): string {
  const message = `${timestamp}.${payloadJson}`;
  const sig1 = computeHmacSha256(secret, message);
  let header = `t=${timestamp},v1=${sig1}`;

  if (previousSecret && previousSecret !== secret) {
    const sig2 = computeHmacSha256(previousSecret, message);
    header += `,v1=${sig2}`;
  }

  return header;
}

/**
 * Verifies a `Streampay-Signature` header against one or more active secrets.
 * Enforces replay protection (toleranceSec window) and constant-time equality check.
 */
export function verifySignatureHeader(
  header: string,
  secrets: string | string[],
  payloadJson: string,
  toleranceSec = 300
): { valid: boolean; reason?: string } {
  if (!header || typeof header !== "string") {
    return { valid: false, reason: "Missing or empty signature header" };
  }

  const parts = header.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") {
      timestamp = Number(value);
    } else if (key === "v1" && value) {
      signatures.push(value.trim());
    }
  }

  if (timestamp === null || Number.isNaN(timestamp)) {
    return { valid: false, reason: "Malformed timestamp in signature header" };
  }

  if (signatures.length === 0) {
    return { valid: false, reason: "No v1 signature found in header" };
  }

  // Replay protection check
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) {
    return {
      valid: false,
      reason: `Signature timestamp out of bounds (drift: ${Math.abs(now - timestamp)}s > tolerance: ${toleranceSec}s)`,
    };
  }

  const message = `${timestamp}.${payloadJson}`;
  const allowedSecrets = Array.isArray(secrets) ? secrets : [secrets];

  for (const secret of allowedSecrets) {
    if (!secret) continue;
    const expected = computeHmacSha256(secret, message);
    const expectedBuf = Buffer.from(expected, "hex");

    for (const provided of signatures) {
      try {
        const providedBuf = Buffer.from(provided, "hex");
        if (
          expectedBuf.length === providedBuf.length &&
          timingSafeEqual(expectedBuf, providedBuf)
        ) {
          return { valid: true };
        }
      } catch {
        continue;
      }
    }
  }

  return { valid: false, reason: "Signature mismatch against all provided secrets" };
}
