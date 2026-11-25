import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AlertEngine,
  ConsoleSink,
  JsonlSink,
  MemorySink,
  MultiSink,
  WebhookSink,
  buildSinks,
  emptyAlertStore,
  type AlertEvent,
} from '../src/alerts.js';
import type { Projection, Severity } from '../src/project.js';

function projection(id: string, severity: Severity, remaining = 1_000): Projection {
  return {
    id,
    cls: 'stream',
    severity,
    remainingLedgers: remaining,
    observedCliffLedgers: 400_000,
    etaSecondsFastest: remaining,
    etaSecondsTarget: remaining * 5,
    etaSecondsMeasured: remaining * 5,
    reason: `test ${severity}`,
  };
}

const CTX = { atLedger: 1_000_000, atIso: '2026-10-15T00:00:00.000Z', contractId: 'C_TEST' };

test('fires once per severity transition and dedupes steady state', () => {
  const sink = new MemorySink();
  const engine = new AlertEngine({ reAlertEveryLedgers: 10_000 }, [sink]);

  const first = engine.evaluate([projection('stream:1', 'warn')], CTX);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.action, 'fired');
  assert.equal(first[0]?.prevSeverity, null);

  // Same severity on the next scan: no event until the re-alert interval.
  assert.equal(engine.evaluate([projection('stream:1', 'warn')], { ...CTX, atLedger: CTX.atLedger + 300 }).length, 0);

  // Escalation always fires.
  const escalated = engine.evaluate([projection('stream:1', 'crit')], { ...CTX, atLedger: CTX.atLedger + 600 });
  assert.equal(escalated[0]?.action, 'escalated');
  assert.equal(escalated[0]?.prevSeverity, 'warn');

  // …and deepens to expired.
  const expired = engine.evaluate([projection('stream:1', 'expired', 0)], { ...CTX, atLedger: CTX.atLedger + 900 });
  assert.equal(expired[0]?.action, 'escalated');
  assert.equal(expired[0]?.severity, 'expired');
});

test('re-alerts critical/expired on the configured cadence', () => {
  const engine = new AlertEngine({ reAlertEveryLedgers: 1_000 }, [new MemorySink()]);
  engine.evaluate([projection('stream:1', 'crit')], CTX);
  const reAlert = engine.evaluate([projection('stream:1', 'crit')], { ...CTX, atLedger: CTX.atLedger + 1_000 });
  assert.equal(reAlert.length, 1);
  assert.equal(reAlert[0]?.action, 're-alert');

  const downgraded = engine.evaluate([projection('stream:1', 'warn')], { ...CTX, atLedger: CTX.atLedger + 1_100 });
  assert.equal(downgraded[0]?.action, 'downgraded');
  assert.equal(downgraded[0]?.prevSeverity, 'crit');
});

test('resolves when an entry recovers, and healthy entries are not tracked', () => {
  const engine = new AlertEngine({ reAlertEveryLedgers: 1_000 }, [new MemorySink()]);
  engine.evaluate([projection('stream:1', 'crit')], CTX);
  const resolved = engine.evaluate([projection('stream:1', 'ok', 480_000)], { ...CTX, atLedger: CTX.atLedger + 10 });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.action, 'resolved');
  assert.equal(resolved[0]?.severity, 'ok');

  // A second healthy scan must not re-fire anything, and state is dropped.
  assert.equal(engine.evaluate([projection('stream:1', 'ok', 480_000)], { ...CTX, atLedger: CTX.atLedger + 20 }).length, 0);
  assert.deepEqual(engine.snapshot(), emptyAlertStore());
});

test('a restart does not re-alert entries already known to be firing', () => {
  const first = new AlertEngine({ reAlertEveryLedgers: 10_000 }, [new MemorySink()]);
  first.evaluate([projection('counter', 'crit')], CTX);
  const persisted = first.snapshot();

  const restarted = new AlertEngine({ reAlertEveryLedgers: 10_000 }, [new MemorySink()], persisted);
  const afterRestart = restarted.evaluate([projection('counter', 'crit')], { ...CTX, atLedger: CTX.atLedger + 1 });
  assert.equal(afterRestart.length, 0, 'duplicate alert after restart');
});

test('sinks receive the fired events (console, jsonl, webhook, multi)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ttl-sentinel-alerts-'));
  const jsonlPath = join(dir, 'alerts.jsonl');
  const lines: string[] = [];
  const posted: { url: string; body: unknown }[] = [];
  const sink = new MultiSink([
    new ConsoleSink((l) => lines.push(l)),
    new JsonlSink(jsonlPath),
    new WebhookSink('https://alerts.example/hook', async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) as unknown });
      return { ok: true, status: 200 };
    }),
  ]);
  const engine = new AlertEngine({ reAlertEveryLedgers: 10_000 }, [sink]);
  const events = engine.evaluate([projection('stream:7', 'crit', 42)], CTX);
  assert.equal(events.length, 1);
  await new Promise((resolve) => setImmediate(resolve)); // let the webhook channel settle

  const jsonl = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AlertEvent);
  assert.equal(jsonl.length, 1);
  assert.equal(jsonl[0]?.id, 'stream:7');
  assert.equal(jsonl[0]?.remainingLedgers, 42);
  assert.ok(lines.some((l) => l.includes('stream:7') && l.includes('CRIT')));
  assert.equal(posted.length, 1);
  const body = posted[0]?.body as { events: AlertEvent[]; context: { contractId: string } };
  assert.equal(body.events[0]?.id, 'stream:7');
  assert.equal(body.context.contractId, 'C_TEST');
});

test('a failing sink never breaks the scan', () => {
  const failing = {
    name: 'boom',
    deliver: () => {
      throw new Error('sink exploded');
    },
  };
  const engine = new AlertEngine({ reAlertEveryLedgers: 10_000 }, [failing, new MemorySink()]);
  const events = engine.evaluate([projection('stream:1', 'warn')], CTX);
  assert.equal(events.length, 1);
});

test('buildSinks always includes the console and only configured extras', () => {
  assert.deepEqual(
    buildSinks({}).map((s) => s.name),
    ['console'],
  );
  const dir = mkdtempSync(join(tmpdir(), 'ttl-sentinel-sinks-'));
  const all = buildSinks({ alertsJsonlPath: join(dir, 'a.jsonl'), webhookUrl: 'https://x.example' });
  assert.deepEqual(
    all.map((s) => s.name),
    ['console', 'jsonl', 'webhook'],
  );
});
