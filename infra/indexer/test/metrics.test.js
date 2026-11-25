import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexerMetricsRegistry } from '../dist/src/metrics.js';
import { IndexerStore } from '../dist/src/store.js';
import { FaultController } from '../dist/src/faults.js';

test('IndexerMetricsRegistry exports standard Prometheus exposition format', () => {
  const registry = new IndexerMetricsRegistry();
  registry.eventLagSeconds.observe({ source: 'soroban_rpc', topic: 'StreamCreated' }, 8.5);
  registry.ledgerLag.set({ source: 'soroban_rpc' }, 1);
  registry.dbDepth.set({ table: 'streams', state: 'persisted' }, 10);
  registry.rpcRequestsTotal.inc({ service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'success' }, 5);
  registry.rpcErrorsTotal.inc({ service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status_code: '503' }, 1);

  const output = registry.exportMetrics();

  assert.ok(output.includes('# TYPE streampay_indexer_event_lag_seconds histogram'));
  assert.ok(output.includes('streampay_indexer_event_lag_seconds_bucket{source="soroban_rpc",topic="StreamCreated",le="10"} 1'));
  assert.ok(output.includes('streampay_indexer_ledger_lag{source="soroban_rpc"} 1'));
  assert.ok(output.includes('streampay_indexer_db_depth{table="streams",state="persisted"} 10'));
  assert.ok(output.includes('streampay_indexer_rpc_requests_total{service="indexer",endpoint="soroban_rpc",method="getEvents",status="success"} 5'));
  assert.ok(output.includes('streampay_indexer_rpc_errors_total{service="indexer",endpoint="soroban_rpc",method="getEvents",status_code="503"} 1'));
});

test('FaultController accurately injects lag, backlog and RPC error spikes', () => {
  const registry = new IndexerMetricsRegistry();
  const store = new IndexerStore(registry);
  const faults = new FaultController(store, registry);

  faults.injectLag(45, 'StreamCreated');
  faults.injectBacklog(800);
  faults.injectRpcErrors(50, 20);
  faults.injectCursorLag(8);

  const output = registry.exportMetrics();
  assert.ok(output.includes('streampay_indexer_db_queue_backlog 800'));
  assert.ok(output.includes('streampay_indexer_ledger_lag{source="soroban_rpc"} 8'));
  assert.ok(output.includes('streampay_indexer_sync_status 0'));
  assert.equal(registry.rpcErrorsTotal.get({ service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status_code: '503' }), 10);

  faults.reset();
  assert.equal(registry.ledgerLag.get({ source: 'soroban_rpc' }), 0);
  assert.equal(registry.syncStatus.get(), 1);
});
