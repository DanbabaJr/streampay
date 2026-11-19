import { canonicalizeJson, generateSignatureHeader } from "../webhooks/hmac.js";
import { validateWebhookUrl } from "../webhooks/ssrf.js";
import type { OutboxIntent } from "./types.js";
import type { OutboxConsumerConfig, OutboxTransport, TransportResult } from "./transport.js";

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Default push transport: HTTPS POST of the canonical StreamPay envelope with
 * an HMAC signature (same scheme as webhooks) plus idempotency/seq headers so
 * consumers can dedupe duplicate deliveries from at-least-once dispatch.
 */
export const httpPushTransport: OutboxTransport = async (
  intent: OutboxIntent,
  consumer: OutboxConsumerConfig
): Promise<TransportResult> => {
  if (!consumer.url) return { ok: false, error: "consumer has no url" };

  const ssrf = await validateWebhookUrl(consumer.url);
  if (!ssrf.safe) return { ok: false, status: 403, error: `SSRF blocked: ${ssrf.reason}` };

  const envelope = {
    delivery_id: intent.idempotency_key,
    event_id: intent.event_id,
    event_type: intent.name,
    stream_id: intent.stream_id,
    seq: intent.event_seq,
    ledger: intent.ledger,
    timestamp: Math.floor(Date.now() / 1000),
    payload: intent.payload,
  };
  const body = canonicalizeJson(envelope);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "StreamPay-Outbox/1.0",
    "Streampay-Event": intent.name,
    "Streampay-Idempotency-Key": intent.idempotency_key,
    "Streampay-Seq": String(intent.event_seq),
  };
  if (consumer.secret) {
    headers["Streampay-Signature"] = generateSignatureHeader(consumer.secret, envelope.timestamp, body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(consumer.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
};
