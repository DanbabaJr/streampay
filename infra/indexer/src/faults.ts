//! Fault injection controls for sandbox testing and drill validation.

import { defaultIndexerMetrics, type IndexerMetricsRegistry } from './metrics.js';
import type { IndexerStore } from './store.js';

export interface FaultState {
  artificialLagSeconds: number;
  injectedBacklogDepth: number;
  rpcFailurePercentage: number;
  cursorLagLedgers: number;
}

export class FaultController {
  private state: FaultState = {
    artificialLagSeconds: 0,
    injectedBacklogDepth: 0,
    rpcFailurePercentage: 0,
    cursorLagLedgers: 0,
  };
  private metrics: IndexerMetricsRegistry;
  private store: IndexerStore;

  constructor(store: IndexerStore, metrics: IndexerMetricsRegistry = defaultIndexerMetrics) {
    this.store = store;
    this.metrics = metrics;
  }

  public getState(): FaultState {
    return { ...this.state };
  }

  public injectLag(seconds: number, topic = 'StreamCreated'): void {
    this.state.artificialLagSeconds = seconds;
    // Directly observe into lag histogram to simulate high latency
    for (let i = 0; i < 20; i++) {
      this.metrics.eventLagSeconds.observe(
        { source: 'soroban_rpc', topic },
        seconds + (Math.random() * 5 - 2.5)
      );
    }
  }

  public injectCursorLag(ledgers: number): void {
    this.state.cursorLagLedgers = ledgers;
    this.metrics.ledgerLag.set({ source: 'soroban_rpc' }, ledgers);
    this.metrics.syncStatus.set(ledgers > 5 ? 0 : 1);
  }

  public injectBacklog(depth: number): void {
    this.state.injectedBacklogDepth = depth;
    this.store.setQueueBacklog(depth);
  }

  public injectRpcErrors(percentage: number, count = 30): void {
    this.state.rpcFailurePercentage = percentage;
    const failures = Math.round((count * percentage) / 100);
    const successes = count - failures;

    for (let i = 0; i < successes; i++) {
      this.metrics.rpcRequestsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'success' },
        1
      );
    }
    for (let i = 0; i < failures; i++) {
      this.metrics.rpcRequestsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'error' },
        1
      );
      this.metrics.rpcErrorsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status_code: '503' },
        1
      );
    }
  }

  public reset(): void {
    this.state = {
      artificialLagSeconds: 0,
      injectedBacklogDepth: 0,
      rpcFailurePercentage: 0,
      cursorLagLedgers: 0,
    };
    this.metrics.ledgerLag.set({ source: 'soroban_rpc' }, 0);
    this.metrics.syncStatus.set(1);
    this.store.syncMetrics();
  }
}
