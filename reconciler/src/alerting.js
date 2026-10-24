//! Structured logging and webhook dispatch for the dual-read reconciliation service.

import { createHttpAgent } from "./http.js";

export interface AlertingConfig {
  webhookUrl?: string;
  consistencyWindowMs: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  serviceName: string;
  environment: string;
  reconcilerId: string;
}

export interface WebhookDispatchResult {
  success: boolean;
  status?: number;
  message?: string;
  durationMs: number;
}

export class AlertingService {
  private config: AlertingConfig;
  private webhookUrl?: string;
  private httpAgent = createHttpAgent();

  constructor(config: AlertingConfig) {
    this.config = config;
    this.webhookUrl = config.webhookUrl;
  }

  /**
   * Emit a structured JSON log entry.
   */
  log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, details: Record<string, unknown> = {}): void {
    if (!this.shouldLog(level)) return;

    const entry = {
      timestamp: new Date().toISOString(),
      service: this.config.serviceName,
      level,
      message,
      details,
    };

    // Write to stderr for log collection (e.g., docker logs)
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  /**
   * Dispatch a divergence alert to the webhook target.
   */
  async dispatchWebhook(d: DivergenceRecord): Promise<WebhookDispatchResult> {
    const start = Date.now();
    const payload = this.buildWebhookPayload(d);
    const payloadStr = JSON.stringify(payload);

    this.log("WARN", `Webhook dispatch initiated for stream ${d.streamId}`, {
      payloadSize: payloadStr.length,
      checkType: d.checkType,
      severity: d.severity,
    });

    if (!this.webhookUrl) {
      this.log("WARN", "No WEBHOOK_URL configured — skipping dispatch");
      return { success: false, message: "No webhook URL configured", durationMs: Date.now() - start };
    }

    try {
      const response = await this.httpAgent.post(this.webhookUrl, payloadStr, {
        "Content-Type": "application/json",
        "User-Agent": `streampay-reconciler/${this.config.reconcilerId}`,
      });

      const success = response.status >= 200 && response.status < 300;
      this.log(success ? "INFO" : "WARN", `Webhook dispatch ${success ? "succeeded" : "failed"}`, {
        status: response.status,
        durationMs: Date.now() - start,
        streamId: d.streamId,
      });

      return {
        success,
        status: response.status,
        message: response.data?.message || response.statusText,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("WARN", `Webhook dispatch failed: ${message}`, {
        durationMs: Date.now() - start,
        streamId: d.streamId,
        error: message,
      });

      return { success: false, message, durationMs: Date.now() - start };
    }
  }

  /**
   * Build a structured webhook payload for the indexer dashboard.
   */
  private buildWebhookPayload(d: DivergenceRecord): WebhookPayload {
    return {
      alert: {
        type: "stream_divergence",
        severity: d.severity,
        timestamp: d.detectedAt,
        source: "reconciler",
        data: {
          streamId: d.streamId,
          divergenceType: d.checkType,
          horizonState: d.indexedValue,
          sorobanState: d.onChainValue,
          lagMs: d.horizonLagMs ?? d.sorobanLagMs ?? 0,
          consequence: d.checkType === "missing_record" ? "index_corruption" : "balance_mismatch",
        },
      },
      metadata: {
        version: "1.0.0",
        environment: this.config.environment,
        reconcilerId: this.config.reconcilerId,
      },
    };
  }

  private shouldLog(level: "DEBUG" | "INFO" | "WARN" | "ERROR"): boolean {
    const order: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    return order[level] >= order[this.config.logLevel];
  }
}

// Lazy import to avoid circular dependency issues
import type { DivergenceRecord } from "./types.js";