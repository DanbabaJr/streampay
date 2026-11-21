import type { OutboxIntent } from "./types.js";

export interface OutboxConsumerConfig {
  id: string;
  url: string | null;
  secret: string | null;
  max_attempts: number;
  rate_limit_per_sec: number | null;
}

export interface TransportResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Delivery transport for push consumers. Implementations must be safe to call
 * more than once for the same intent: consumers dedupe on the idempotency key.
 */
export type OutboxTransport = (
  intent: OutboxIntent,
  consumer: OutboxConsumerConfig
) => Promise<TransportResult>;
