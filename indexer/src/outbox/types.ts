export type OutboxState = "pending" | "in_flight" | "delivered" | "dead";
export type OutboxConsumerKind = "push" | "pull";

export interface OutboxEventRow {
  seq: number;
  idempotency_key: string;
  event_id: string;
  stream_id: string | null;
  name: string;
  ledger: number;
  ledger_cursor: string;
  payload: Record<string, unknown>;
  ingested_at: string;
  retracted_at: string | null;
  retract_reason: string | null;
}

export interface OutboxConsumer {
  id: string;
  kind: OutboxConsumerKind;
  url: string | null;
  secret: string | null;
  max_attempts: number;
  rate_limit_per_sec: number | null;
  status: "active" | "disabled";
  created_at: string;
}

export interface OutboxIntent {
  id: number;
  event_seq: number;
  consumer_id: string;
  idempotency_key: string;
  state: OutboxState;
  attempts: number;
  next_retry_at: number;
  claimed_at: number | null;
  claim_token: string | null;
  delivered_at: string | null;
  dead_reason: string | null;
  last_error: string | null;
  created_at: string;
  event_id: string;
  stream_id: string | null;
  name: string;
  ledger: number;
  payload: Record<string, unknown>;
}

export interface OutboxStats {
  events: number;
  depth: Record<OutboxState, number>;
  oldestPendingAgeMs: number;
  maxSeq: number;
}

export interface OutboxReplayPage {
  events: Array<{
    seq: number;
    idempotency_key: string;
    event_id: string;
    stream_id: string | null;
    name: string;
    ledger: number;
    ledger_cursor: string;
    payload: Record<string, unknown>;
    ingested_at: string;
  }>;
  next_cursor: number | null;
}

export interface RetractResult {
  events_retracted: number;
  intents_retracted: number;
}
