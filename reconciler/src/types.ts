//! Shared types for the dual-read reconciliation service.

export type StreamStatus = "Active" | "Cancelled" | "Depleted";

export interface StreamState {
  streamId: string;
  ledger: number;
  timestamp: string;
  data: {
    deposit: string;
    withdrawn: string;
    status: StreamStatus;
  };
}

export interface HorizonStreamEffect {
  streamId: string;
  deposit: string;
  withdrawn: string;
  status: StreamStatus;
  ledger: number;
  effectType: "payment" | "account_debited" | "account_credited";
}

export interface SorobanStreamStorage {
  streamId: string;
  deposit: string;
  withdrawn: string;
  startTime: string;
  endTime: string;
  cancelable: boolean;
  status: StreamStatus;
  ledger: number;
}

export interface DivergenceRecord {
  streamId: string;
  checkType: "stream_balance" | "stream_status" | "missing_record";
  severity: "warning" | "critical";
  indexedValue: Record<string, unknown>;
  onChainValue: Record<string, unknown>;
  horizonLagMs?: number;
  sorobanLagMs?: number;
  detectedAt: string;
}

export interface ReconciliationResult {
  totalChecked: number;
  inSync: number;
  withinLagWindow: number;
  divergences: DivergenceRecord[];
  timestamp: string;
  ledgerGap: number;
}

export interface AlertingConfig {
  webhookUrl: string;
  consistencyWindowMs: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

export interface WebhookPayload {
  alert: {
    type: string;
    severity: "warning" | "critical";
    timestamp: string;
    source: string;
    data: Record<string, unknown>;
  };
  metadata: {
    version: string;
    environment: string;
    reconcilerId: string;
  };
}

export interface StructuredLogEntry {
  timestamp: string;
  service: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  details: Record<string, unknown>;
}

export interface ReaderConfig {
  url: string;
  token?: string;
  pollIntervalMs: number;
}

export interface ReconcilerConfig extends ReaderConfig {
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  consistencyWindowMs: number;
  webhookUrl?: string;
  pollIntervalMs: number;
}