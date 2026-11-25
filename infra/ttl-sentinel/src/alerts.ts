//! Alert state machine + delivery sinks.
//!
//! The core sentinel is **read-only**: it never loads keys. Alerts fire on
//! severity *transitions* (deduplicated), re-fire on a slow cadence while
//! critical/expired persists, and resolve when an entry recovers (e.g. after
//! a contract write or an off-chain extension bumps the TTL).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { formatDuration } from './cadence.js';
import type { EntryClass } from './cliff.js';
import { SEVERITY_RANK, type Projection, type Severity } from './project.js';

export interface AlertEvent {
  id: string;
  cls: EntryClass;
  severity: Severity;
  prevSeverity: Severity | null;
  action: 'fired' | 'escalated' | 'downgraded' | 're-alert' | 'resolved';
  remainingLedgers: number;
  observedCliffLedgers: number | null;
  etaSecondsFastest: number | null;
  etaSecondsTarget: number | null;
  atLedger: number;
  atIso: string;
  reason: string;
}

export interface AlertContext {
  atLedger: number;
  atIso: string;
  contractId: string;
}

export interface AlertSink {
  readonly name: string;
  deliver(events: AlertEvent[], ctx: AlertContext): void | Promise<void>;
}

/** Persisted per-id alert state so restarts don't re-fire everything. */
export interface AlertStoreState {
  entries: Record<string, { severity: Severity; lastFiredLedger: number }>;
}

export function emptyAlertStore(): AlertStoreState {
  return { entries: {} };
}

const ACTION_RANK: Record<AlertEvent['action'], number> = {
  fired: 0,
  escalated: 1,
  downgraded: 2,
  're-alert': 3,
  resolved: 4,
};

export class AlertEngine {
  private readonly state: Map<string, { severity: Severity; lastFiredLedger: number }>;

  constructor(
    private readonly opts: { reAlertEveryLedgers: number },
    private readonly sinks: AlertSink[],
    initial?: AlertStoreState,
  ) {
    if (opts.reAlertEveryLedgers <= 0) throw new Error('reAlertEveryLedgers must be > 0');
    this.state = new Map(Object.entries(initial?.entries ?? {}));
  }

  snapshot(): AlertStoreState {
    return { entries: Object.fromEntries(this.state) };
  }

  /**
   * Evaluate this scan's projections and emit transitions. Returns the
   * events (also delivered to sinks).
   */
  evaluate(projections: Projection[], ctx: AlertContext): AlertEvent[] {
    const events: AlertEvent[] = [];

    for (const p of projections) {
      const prev = this.state.get(p.id) ?? null;

      if (p.severity === 'ok') {
        if (prev && prev.severity !== 'ok') {
          events.push(this.event(p, prev.severity, 'resolved', ctx));
          this.state.delete(p.id); // fully reset: no stale re-alerts after recovery
        }
        continue; // healthy entries are not tracked (keeps state small)
      }

      if (!prev) {
        events.push(this.event(p, null, 'fired', ctx));
        this.state.set(p.id, { severity: p.severity, lastFiredLedger: ctx.atLedger });
        continue;
      }

      if (SEVERITY_RANK[p.severity] > SEVERITY_RANK[prev.severity]) {
        events.push(this.event(p, prev.severity, 'escalated', ctx));
        this.state.set(p.id, { severity: p.severity, lastFiredLedger: ctx.atLedger });
        continue;
      }

      if (SEVERITY_RANK[p.severity] < SEVERITY_RANK[prev.severity]) {
        // Downgrade (e.g. crit → warn after a partial off-chain extension):
        // still surfaced, because it changes the remediation window.
        events.push(this.event(p, prev.severity, 'downgraded', ctx));
        this.state.set(p.id, { severity: p.severity, lastFiredLedger: ctx.atLedger });
        continue;
      }

      const age = ctx.atLedger - prev.lastFiredLedger;
      if (age >= this.opts.reAlertEveryLedgers) {
        events.push(this.event(p, prev.severity, 're-alert', ctx));
        this.state.set(p.id, { severity: p.severity, lastFiredLedger: ctx.atLedger });
      }
    }

    if (events.length > 0) {
      events.sort((a, b) => a.id.localeCompare(b.id) || ACTION_RANK[a.action] - ACTION_RANK[b.action]);
      for (const sink of this.sinks) {
        // Synchronous sinks (console, jsonl, memory) deliver inline so callers
        // observe the write; async sinks (webhook) are fire-and-forget. Either
        // way a failing channel must never take the scan down.
        const failed = (err: unknown): void => {
          process.stderr.write(`ttl-sentinel: sink ${sink.name} failed: ${String(err)}\n`);
        };
        try {
          const result = sink.deliver(events, ctx);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            void (result as Promise<void>).catch(failed);
          }
        } catch (err) {
          failed(err);
        }
      }
    }
    return events;
  }

  private event(p: Projection, prevSeverity: Severity | null, action: AlertEvent['action'], ctx: AlertContext): AlertEvent {
    return {
      id: p.id,
      cls: p.cls,
      severity: p.severity,
      prevSeverity,
      action,
      remainingLedgers: p.remainingLedgers,
      observedCliffLedgers: p.observedCliffLedgers,
      etaSecondsFastest: p.etaSecondsFastest,
      etaSecondsTarget: p.etaSecondsTarget,
      atLedger: ctx.atLedger,
      atIso: ctx.atIso,
      reason: p.reason,
    };
  }
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

export class ConsoleSink implements AlertSink {
  readonly name = 'console';

  // Alerts are diagnostics: they go to stderr, so `scan --json` keeps stdout
  // machine-readable.
  constructor(private readonly write: (line: string) => void = (l) => process.stderr.write(l)) {}

  deliver(events: AlertEvent[], ctx: AlertContext): void {
    for (const e of events) {
      const eta = e.etaSecondsFastest !== null ? formatDuration(e.etaSecondsFastest) : 'n/a';
      const cliff = e.observedCliffLedgers !== null ? ` observed-cliff=${e.observedCliffLedgers}` : '';
      const line =
        `[${e.atIso}] ${e.action.toUpperCase()} ${e.severity.toUpperCase()} ${e.cls}/${e.id} ` +
        `remaining=${e.remainingLedgers} (~${eta} fastest)${cliff} — ${e.reason}\n`;
      this.write(line);
    }
    if (events.length > 0) {
      this.write(`  contract=${ctx.contractId} ledger=${ctx.atLedger}\n`);
    }
  }
}

export class JsonlSink implements AlertSink {
  readonly name = 'jsonl';

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  deliver(events: AlertEvent[], ctx: AlertContext): void {
    const lines = events.map((e) => JSON.stringify({ ...e, contractId: ctx.contractId }));
    appendFileSync(this.path, lines.join('\n') + '\n', 'utf8');
  }
}

export type WebhookFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export class WebhookSink implements AlertSink {
  readonly name = 'webhook';

  constructor(
    private readonly url: string,
    private readonly fetchImpl: WebhookFetch = globalThis.fetch as WebhookFetch,
  ) {}

  async deliver(events: AlertEvent[], ctx: AlertContext): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'streampay-ttl-sentinel', context: ctx, events }),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }
}

export class MultiSink implements AlertSink {
  readonly name = 'multi';

  constructor(private readonly sinks: AlertSink[]) {}

  /**
   * Sync sinks run inline (so a file write is visible when `deliver` returns);
   * async sinks are chained in order and their promise is returned.
   */
  deliver(events: AlertEvent[], ctx: AlertContext): void | Promise<void> {
    let chain: Promise<void> | null = null;
    for (const sink of this.sinks) {
      if (chain) {
        chain = chain.then(() => Promise.resolve(sink.deliver(events, ctx))).then(() => undefined);
        continue;
      }
      const result = sink.deliver(events, ctx);
      if (result && typeof (result as Promise<void>).then === 'function') chain = Promise.resolve(result);
    }
    return chain ?? undefined;
  }
}

export class MemorySink implements AlertSink {
  readonly name = 'memory';
  readonly received: { events: AlertEvent[]; ctx: AlertContext }[] = [];

  deliver(events: AlertEvent[], ctx: AlertContext): void {
    this.received.push({ events, ctx });
  }

  flat(): AlertEvent[] {
    return this.received.flatMap((r) => r.events);
  }
}

/** Build the configured sink stack (console always; jsonl/webhook optional). */
export function buildSinks(opts: { alertsJsonlPath?: string; webhookUrl?: string }): AlertSink[] {
  const sinks: AlertSink[] = [new ConsoleSink()];
  if (opts.alertsJsonlPath) sinks.push(new JsonlSink(opts.alertsJsonlPath));
  if (opts.webhookUrl) sinks.push(new WebhookSink(opts.webhookUrl));
  return sinks;
}
