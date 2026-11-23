import { createHmac, timingSafeEqual } from "node:crypto";

export const STREAMPAY_WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Reference TypeScript implementation for docs/WEBHOOKS.md.
 * rawBody must be the exact bytes received over HTTP, not re-serialized JSON.
 */
export function verifyStreampayWebhook(
  header: string,
  rawBody: Uint8Array,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = STREAMPAY_WEBHOOK_TOLERANCE_SEC
): boolean {
  if (!header) return false;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") {
      timestamp = Number(value);
    } else if (key === "v1" && value) {
      signatures.push(value.trim());
    }
  }

  if (
    timestamp === null ||
    !Number.isSafeInteger(timestamp) ||
    signatures.length === 0 ||
    Math.abs(nowSec - timestamp) > toleranceSec
  ) {
    return false;
  }

  const signingPayload = `${timestamp}.`;
  const expected = createHmac("sha256", secret)
    .update(signingPayload, "utf-8")
    .update(rawBody)
    .digest();

  for (const signature of signatures) {
    let provided: Buffer;
    try {
      if (!/^[0-9a-fA-F]{64}$/.test(signature)) continue;
      provided = Buffer.from(signature, "hex");
    } catch {
      continue;
    }

    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }

  return false;
}
