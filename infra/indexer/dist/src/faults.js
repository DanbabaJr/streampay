//! Compiled ESM faults controller for indexer

import { defaultIndexerMetrics } from './metrics.js';

export class FaultController {
  constructor(store, metrics = defaultIndexerMetrics) {
    this.state = {
      artificialLagSeconds: 0,
      injectedBacklogDepth: 0,
      rpcFailurePercentage: 0,
      cursorLagLedgers: 0,
    };
    this.store = store;
    this.metrics = metrics;
  }

  getState() {
    return { ...this.state };
  }

  injectLag(seconds, topic = 'StreamCreated') {
    this.state.artificialLagSeconds = seconds;
    for (let i = 0; i < 20; i++) {
      this.metrics.eventLagSeconds.observe(
        { source: 'soroban_rpc', topic },
        seconds + (Math.random() * 5 - 2.5)
      );
    }
  }

  injectCursorLag(ledgers) {
    this.state.cursorLagLedgers = ledgers;
    this.metrics.ledgerLag.set({ source: 'soroban_rpc' }, ledgers);
    this.metrics.syncStatus.set(ledgers > 5 ? 0 : 1);
  }

  injectBacklog(depth) {
    this.state.injectedBacklogDepth = depth;
    this.store.setQueueBacklog(depth);
  }

  injectRpcErrors(percentage, count = 30) {
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

  reset() {
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
