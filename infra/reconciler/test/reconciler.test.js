import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconcilerMetricsRegistry } from '../dist/src/metrics.js';
import { ReconciliationEngine } from '../dist/src/reconcile.js';
import { ReconcilerFaultController } from '../dist/src/faults.js';

test('ReconcilerMetricsRegistry exports standard Prometheus exposition format', () => {
  const registry = new ReconcilerMetricsRegistry();
  registry.divergencesTotal.inc({ check_type: 'stream_balance', severity: 'critical' }, 2);
  registry.divergenceCurrent.set({ check_type: 'stream_balance' }, 2);
  registry.itemsAuditedTotal.inc({ entity_type: 'stream' }, 15);
  registry.lastRunTimestampSeconds.set(1700000000);
  registry.checkDurationSeconds.observe({ scope: 'full_sweep' }, 0.45);

  const output = registry.exportMetrics();

  assert.ok(output.includes('# TYPE streampay_reconciliation_divergences_total counter'));
  assert.ok(output.includes('streampay_reconciliation_divergences_total{check_type="stream_balance",severity="critical"} 2'));
  assert.ok(output.includes('streampay_reconciler_divergence_current{check_type="stream_balance"} 2'));
  assert.ok(output.includes('streampay_reconciler_last_run_timestamp_seconds 1700000000'));
  assert.ok(output.includes('streampay_reconciler_items_audited_total{entity_type="stream"} 15'));
});

test('ReconciliationEngine detects and tracks state divergences accurately', async () => {
  const registry = new ReconcilerMetricsRegistry();
  const engine = new ReconciliationEngine(registry);

  const indexedStreams = [
    { streamId: 1, deposit: '1000', withdrawn: '200', status: 'Active' },
    { streamId: 2, deposit: '2000', withdrawn: '500', status: 'Active' },
  ];

  // Stream 1 matches; Stream 2 has on-chain withdrawn = 1000 (mismatch!)
  const onChainStreams = [
    { streamId: 1, deposit: '1000', withdrawn: '200', status: 'Active' },
    { streamId: 2, deposit: '2000', withdrawn: '1000', status: 'Active' },
  ];

  const findings = await engine.runSweep(indexedStreams, onChainStreams);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].streamId, 2);
  assert.equal(findings[0].checkType, 'stream_balance');
  assert.equal(registry.divergencesTotal.get({ check_type: 'stream_balance', severity: 'critical' }), 1);
  assert.equal(registry.divergenceCurrent.get({ check_type: 'stream_balance' }), 1);
});

test('ReconcilerFaultController injects divergence and stall faults', () => {
  const registry = new ReconcilerMetricsRegistry();
  const engine = new ReconciliationEngine(registry);
  const faults = new ReconcilerFaultController(engine, registry);

  faults.injectDivergence('stream_status', 3);
  faults.injectStall(600);
  faults.injectRpcErrors(10);

  const output = registry.exportMetrics();
  assert.ok(output.includes('streampay_reconciler_divergence_current{check_type="stream_status"} 3'));
  assert.equal(registry.rpcErrorsTotal.get({ method: 'get_stream', status_code: '503' }), 10);

  faults.reset();
  assert.equal(registry.divergenceCurrent.get({ check_type: 'stream_status' }), 0);
});
