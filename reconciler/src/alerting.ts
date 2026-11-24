//! Structured logging and webhook dispatch for the dual-read reconciliation service.

import { createHttpAgent } from "./http.js";
import type { DivergenceRecord, WebhookPayload } from "./types.js";

/**
 * Alert de-duplication and flap suppression knobs.
 *
 * A divergence is only paged once it has been observed in `confirmPasses`
 * consecutive reconciliation passes, so a value that oscillates around the
 * tolerance boundary (present, clean, present, clean...) never reaches the
 * threshold and never alerts. Once open, it alerts once and then only repeats
 * on the `reminderCadenceMs` cadence. It resolves — and its state is dropped —
 * after `resolvePasses` consecutive clean passes, so a divergence that comes
 * back afterwards is a fresh alert rather than a suppressed duplicate.
 */
export interface AlertDedupeConfig {
  /** Consecutive passes a divergence must be seen in before the first alert. */
  confirmPasses: number;
  /** Consecutive clean passes before an open divergence resolves. */
  resolvePasses: number;
  /** How often an open divergence re-alerts. 0 disables reminders. */
  reminderCadenceMs: number;
  /** Clock override for tests. */
  now: () => number;
}

export type AlertDedupeReason =
  | "new"
  | "reminder"
  | "pending_confirmation"
  | "duplicate";

export interface AlertDedupeDecision {
  action: "alert" | "suppress";
  reason: AlertDedupeReason;
  key: string;
  open: boolean;
  occurrences: number;
  firstSeenAt: string;
  suppressedUntil?: string;
}

export interface OpenDivergenceState {
  key: string;
  streamId: string;
  checkType: string;
  classification: string;
  openSince: string;
  lastAlertAt: string | null;
  alerts: number;
}

export const DEFAULT_ALERT_DEDUPE: Omit<AlertDedupeConfig, "now"> = {
  confirmPasses: 2,
  resolvePasses: 2,
  reminderCadenceMs: 30 * 60_000,
};

/**
 * Identity of one open divergence: a stream and the check that diverged. A
 * classification change is a different divergence, so it opens its own alert.
 */
export function divergenceAlertKey(
  d: Pick<DivergenceRecord, "streamId" | "checkType" | "classification">
): string {
  return `${d.streamId}:${d.checkType}:${d.classification}`;
}

interface DivergenceAlertEntry {
  key: string;
  streamId: string;
  checkType: string;
  classification: string;
  presentStreak: number;
  cleanStreak: number;
  open: boolean;
  openSince: number | null;
  lastSeenPass: number;
  lastAlertAt: number | null;
  alerts: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * Per-key alert state machine driven by explicit reconciliation passes.
 *
 * Call `beginPass()` once per cycle, `observe()` for every divergence found in
 * that cycle (webhook dispatch does it), and `endPass()` when the cycle ends so
 * keys that were not observed count as clean passes.
 */
export class DivergenceAlertDedupe {
  private confirmPasses: number;
  private resolvePasses: number;
  private reminderCadenceMs: number;
  private now: () => number;
  private entries = new Map<string, DivergenceAlertEntry>();
  private pass = 0;
  private passOpen = false;

  constructor(options: Partial<AlertDedupeConfig> = {}) {
    this.confirmPasses = positiveInt(options.confirmPasses, DEFAULT_ALERT_DEDUPE.confirmPasses);
    this.resolvePasses = positiveInt(options.resolvePasses, DEFAULT_ALERT_DEDUPE.resolvePasses);
    this.reminderCadenceMs =
      options.reminderCadenceMs === undefined || !Number.isFinite(options.reminderCadenceMs)
        ? DEFAULT_ALERT_DEDUPE.reminderCadenceMs
        : Math.max(0, Math.floor(options.reminderCadenceMs));
    this.now = options.now ?? (() => Date.now());
  }

  /** Open a new reconciliation pass. A pass left open is closed first. */
  beginPass(): number {
    if (this.passOpen) this.endPass();
    this.passOpen = true;
    this.pass += 1;
    return this.pass;
  }

  /**
   * Close the current pass and age every key that was not observed in it.
   * Returns the keys that resolved on this pass.
   */
  endPass(): string[] {
    const resolved: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.lastSeenPass === this.pass) continue;
      entry.presentStreak = 0;
      entry.cleanStreak += 1;
      if (!entry.open || entry.cleanStreak >= this.resolvePasses) {
        this.entries.delete(key);
        if (entry.open) resolved.push(key);
      }
    }
    this.passOpen = false;
    return resolved;
  }

  /** Record one observation and decide whether it should page. */
  observe(d: DivergenceRecord): AlertDedupeDecision {
    if (!this.passOpen) this.beginPass();

    const key = divergenceAlertKey(d);
    const at = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        streamId: d.streamId,
        checkType: d.checkType,
        classification: d.classification,
        presentStreak: 0,
        cleanStreak: 0,
        open: false,
        openSince: null,
        // A new entry has not been observed yet in this pass.
        lastSeenPass: this.pass - 1,
        lastAlertAt: null,
        alerts: 0,
      };
      this.entries.set(key, entry);
    }

    // One observation per key per pass: a duplicate inside one cycle must not
    // count as the second consecutive pass.
    if (entry.lastSeenPass !== this.pass) {
      entry.lastSeenPass = this.pass;
      entry.presentStreak += 1;
      entry.cleanStreak = 0;
    }

    const firstSeenAt = new Date(at).toISOString();

    if (!entry.open) {
      if (entry.presentStreak < this.confirmPasses) {
        return {
          action: "suppress",
          reason: "pending_confirmation",
          key,
          open: false,
          occurrences: entry.presentStreak,
          firstSeenAt,
        };
      }
      entry.open = true;
      entry.openSince = at;
      entry.lastAlertAt = at;
      entry.alerts = 1;
      return {
        action: "alert",
        reason: "new",
        key,
        open: true,
        occurrences: entry.presentStreak,
        firstSeenAt,
      };
    }

    entry.cleanStreak = 0;
    if (
      this.reminderCadenceMs > 0 &&
      entry.lastAlertAt !== null &&
      at - entry.lastAlertAt >= this.reminderCadenceMs
    ) {
      entry.lastAlertAt = at;
      entry.alerts += 1;
      return {
        action: "alert",
        reason: "reminder",
        key,
        open: true,
        occurrences: entry.presentStreak,
        firstSeenAt,
      };
    }

    return {
      action: "suppress",
      reason: "duplicate",
      key,
      open: true,
      occurrences: entry.presentStreak,
      firstSeenAt,
      suppressedUntil:
        entry.lastAlertAt !== null && this.reminderCadenceMs > 0
          ? new Date(entry.lastAlertAt + this.reminderCadenceMs).toISOString()
          : undefined,
    };
  }

  /** Currently open divergences, in insertion order. */
  openDivergences(): OpenDivergenceState[] {
    const open: OpenDivergenceState[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.open || entry.openSince === null) continue;
      open.push({
        key: entry.key,
        streamId: entry.streamId,
        checkType: entry.checkType,
        classification: entry.classification,
        openSince: new Date(entry.openSince).toISOString(),
        lastAlertAt: entry.lastAlertAt === null ? null : new Date(entry.lastAlertAt).toISOString(),
        alerts: entry.alerts,
      });
    }
    return open;
  }

  /** All tracked keys, open or still awaiting confirmation. */
  size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
    this.pass = 0;
    this.passOpen = false;
  }
}

export interface AlertingConfig {
  webhookUrl?: string;
  consistencyWindowMs: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  serviceName: string;
  environment: string;
  reconcilerId: string;
  dedupe?: Partial<AlertDedupeConfig>;
}

export interface WebhookDispatchResult {
  success: boolean;
  status?: number;
  message?: string;
  durationMs: number;
}

export interface ReconcilerAlertingMetrics {
  roundingWithinToleranceCount: number;
  realDivergenceCount: number;
  webhooksDispatchedCount: number;
  webhooksFailedCount: number;
  alertsEmittedCount: number;
  alertsRemindedCount: number;
  alertsSuppressedDuplicateCount: number;
  alertsSuppressedPendingCount: number;
}

export class AlertingService {
  private config: AlertingConfig;
  private webhookUrl?: string;
  private httpAgent = createHttpAgent();
  private dedupe: DivergenceAlertDedupe;
  private metrics: ReconcilerAlertingMetrics = {
    roundingWithinToleranceCount: 0,
    realDivergenceCount: 0,
    webhooksDispatchedCount: 0,
    webhooksFailedCount: 0,
    alertsEmittedCount: 0,
    alertsRemindedCount: 0,
    alertsSuppressedDuplicateCount: 0,
    alertsSuppressedPendingCount: 0,
  };

  constructor(config: AlertingConfig) {
    this.config = config;
    this.webhookUrl = config.webhookUrl;
    this.dedupe = new DivergenceAlertDedupe(config.dedupe);
  }

  /**
   * Open a reconciliation pass. Every cycle must call this before dispatching
   * the divergences it found, then `endPass()` once the cycle is done.
   */
  beginPass(): void {
    this.dedupe.beginPass();
  }

  /** Close the pass; keys unseen this cycle age towards resolution. */
  endPass(): string[] {
    return this.dedupe.endPass();
  }

  /** Open divergences currently tracked by the de-duplicator. */
  getOpenDivergences(): OpenDivergenceState[] {
    return this.dedupe.openDivergences();
  }

  /**
   * Record a rounding within epsilon event in metrics without paging/webhook dispatch.
   */
  recordRounding(d: DivergenceRecord): void {
    this.metrics.roundingWithinToleranceCount++;
    this.log("INFO", `Rounding tolerance within epsilon detected for stream ${d.streamId}`, {
      streamId: d.streamId,
      classification: d.classification,
      delta: d.delta,
      toleranceEpsilon: d.toleranceEpsilon,
      checkType: d.checkType,
    });
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics(): ReconcilerAlertingMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics counters (useful between test runs or audit cycles).
   */
  resetMetrics(): void {
    this.metrics = {
      roundingWithinToleranceCount: 0,
      realDivergenceCount: 0,
      webhooksDispatchedCount: 0,
      webhooksFailedCount: 0,
      alertsEmittedCount: 0,
      alertsRemindedCount: 0,
      alertsSuppressedDuplicateCount: 0,
      alertsSuppressedPendingCount: 0,
    };
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
   * Only pages on real divergences (suppresses webhooks for rounding within epsilon),
   * once per open divergence, after it has persisted across the configured
   * confirmation passes, and re-pages only on the reminder cadence.
   */
  async dispatchWebhook(d: DivergenceRecord): Promise<WebhookDispatchResult> {
    const start = Date.now();

    // Guard: Suppress paging/webhook dispatch for rounding within tolerance epsilon
    if (d.classification === "rounding_within_epsilon") {
      this.recordRounding(d);
      return {
        success: true,
        message: "Suppressed: rounding within epsilon",
        durationMs: Date.now() - start,
      };
    }

    this.metrics.realDivergenceCount++;

    const decision = this.dedupe.observe(d);
    if (decision.action === "suppress") {
      if (decision.reason === "pending_confirmation") {
        this.metrics.alertsSuppressedPendingCount++;
        this.log("DEBUG", `Divergence alert pending confirmation for stream ${d.streamId}`, {
          streamId: d.streamId,
          checkType: d.checkType,
          classification: d.classification,
          passes: decision.occurrences,
        });
        return {
          success: true,
          message: `Suppressed: pending confirmation (${decision.occurrences} pass(es))`,
          durationMs: Date.now() - start,
        };
      }
      this.metrics.alertsSuppressedDuplicateCount++;
      this.log("DEBUG", `Duplicate divergence alert suppressed for stream ${d.streamId}`, {
        streamId: d.streamId,
        checkType: d.checkType,
        classification: d.classification,
        suppressedUntil: decision.suppressedUntil ?? null,
      });
      return {
        success: true,
        message: "Suppressed: duplicate open divergence",
        durationMs: Date.now() - start,
      };
    }

    this.metrics.alertsEmittedCount++;
    if (decision.reason === "reminder") {
      this.metrics.alertsRemindedCount++;
    }

    const payload = this.buildWebhookPayload(d);
    const payloadStr = JSON.stringify(payload);

    this.log("WARN", `Webhook dispatch initiated for stream ${d.streamId}`, {
      payloadSize: payloadStr.length,
      checkType: d.checkType,
      severity: d.severity,
      classification: d.classification,
      alertReason: decision.reason,
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
      if (success) {
        this.metrics.webhooksDispatchedCount++;
      } else {
        this.metrics.webhooksFailedCount++;
      }

      this.log(success ? "INFO" : "WARN", `Webhook dispatch ${success ? "succeeded" : "failed"}`, {
        status: response.status,
        durationMs: Date.now() - start,
        streamId: d.streamId,
      });

      let responseMessage: string | undefined;
      if (typeof response.data === "object" && response.data !== null && "message" in response.data) {
        const msg = (response.data as { message: unknown }).message;
        if (typeof msg === "string") {
          responseMessage = msg;
        }
      }

      return {
        success,
        status: response.status,
        message: responseMessage,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      this.metrics.webhooksFailedCount++;
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
   * Dispatch a three-way diagnosis with its layer attribution and evidence.
   */
  async dispatchDiagnosis(
    diagnosis: {
      recordId?: string;
      severity?: string;
      detectedAt?: string;
      checkType?: string;
      disagreeingPairs?: string[];
      suspectedLayer?: string;
      owner?: string;
      confidence?: string;
      evidence?: unknown;
    },
    report: { generatedAt?: string; asOfLedger?: number | null; mode?: string; caveats?: string[] }
  ): Promise<WebhookDispatchResult> {
    const start = Date.now();
    const payload = {
      alert: {
        type: "reconciliation_diagnosis",
        severity: diagnosis.severity,
        timestamp: diagnosis.detectedAt ?? report.generatedAt,
        source: "reconciler",
        data: {
          recordId: diagnosis.recordId,
          divergenceType: diagnosis.checkType,
          disagreeingPairs: diagnosis.disagreeingPairs,
          suspectedLayer: diagnosis.suspectedLayer,
          owner: diagnosis.owner,
          confidence: diagnosis.confidence,
          asOfLedger: report.asOfLedger,
          mode: report.mode,
          caveats: report.caveats,
          evidence: diagnosis.evidence,
        },
      },
      metadata: {
        version: "2.0.0",
        environment: this.config.environment,
        reconcilerId: this.config.reconcilerId,
      },
    };

    if (!this.webhookUrl) {
      this.log("WARN", "No WEBHOOK_URL configured — diagnosis not dispatched", {
        recordId: diagnosis.recordId,
        suspectedLayer: diagnosis.suspectedLayer,
      });
      return { success: false, message: "No webhook URL configured", durationMs: Date.now() - start };
    }

    try {
      const response = await this.httpAgent.post(this.webhookUrl, JSON.stringify(payload), {
        "Content-Type": "application/json",
        "User-Agent": `streampay-reconciler/${this.config.reconcilerId}`,
      });
      const success = response.status >= 200 && response.status < 300;
      this.log(success ? "INFO" : "WARN", `Diagnosis webhook ${success ? "succeeded" : "failed"}`, {
        status: response.status,
        recordId: diagnosis.recordId,
        suspectedLayer: diagnosis.suspectedLayer,
        durationMs: Date.now() - start,
      });
      return {
        success,
        status: response.status,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("WARN", `Diagnosis webhook failed: ${message}`, {
        recordId: diagnosis.recordId,
        durationMs: Date.now() - start,
      });
      return { success: false, message, durationMs: Date.now() - start };
    }
  }

  /**
   * Build a structured webhook payload for the indexer dashboard.
   * The alert envelope is frozen: consumers only depend on `alert.*` and
   * `metadata.*`, so de-duplication never changes the payload shape.
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
          classification: d.classification,
          delta: d.delta,
          toleranceEpsilon: d.toleranceEpsilon,
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
