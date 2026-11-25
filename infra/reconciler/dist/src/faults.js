//! Compiled ESM faults controller for reconciler

import { defaultReconcilerMetrics } from './metrics.js';

export class ReconcilerFaultController {
  constructor(engine, metrics = defaultReconcilerMetrics) {
    this.engine = engine;
    this.metrics = metrics;
    this.state = {
      syntheticDivergences: 0,
      stalledSeconds: 0,
      rpcErrorCount: 0,
    };
  }

  getState() {
    return { ...this.state };
  }

  injectDivergence(checkType = 'stream_balance', count = 1) {
    this.state.syntheticDivergences += count;
    for (let i = 0; i < count; i++) {
      this.engine.recordDivergence({
        streamId: 999 + i,
        checkType,
        severity: 'critical',
        indexedValue: 'withdrawn=500',
        onChainValue: 'withdrawn=1000',
        detectedAt: new Date().toISOString(),
      });
    }
  }

  injectStall(secondsAgo = 600) {
    this.state.stalledSeconds = secondsAgo;
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000) - secondsAgo);
  }

  injectRpcErrors(count = 20) {
    this.state.rpcErrorCount += count;
    for (let i = 0; i < count; i++) {
      this.metrics.rpcRequestsTotal.inc({ method: 'get_stream', status: 'error' }, 1);
      this.metrics.rpcErrorsTotal.inc({ method: 'get_stream', status_code: '503' }, 1);
    }
  }

  reset() {
    this.state = {
      syntheticDivergences: 0,
      stalledSeconds: 0,
      rpcErrorCount: 0,
    };
    this.engine.clearDivergences();
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
  }
}
