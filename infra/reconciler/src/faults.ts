//! Fault injection controller for Reconciler daemon sandbox drills.

import { defaultReconcilerMetrics, type ReconcilerMetricsRegistry } from './metrics.js';
import type { ReconciliationEngine } from './reconcile.js';

export interface ReconcilerFaultState {
  syntheticDivergences: number;
  stalledSeconds: number;
  rpcErrorCount: number;
}

export class ReconcilerFaultController {
  private engine: ReconciliationEngine;
  private metrics: ReconcilerMetricsRegistry;
  private state: ReconcilerFaultState = {
    syntheticDivergences: 0,
    stalledSeconds: 0,
    rpcErrorCount: 0,
  };

  constructor(engine: ReconciliationEngine, metrics: ReconcilerMetricsRegistry = defaultReconcilerMetrics) {
    this.engine = engine;
    this.metrics = metrics;
  }

  public getState(): ReconcilerFaultState {
    return { ...this.state };
  }

  public injectDivergence(
    checkType: 'stream_status' | 'stream_balance' | 'treasury_balance' = 'stream_balance',
    count = 1
  ): void {
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

  public injectStall(secondsAgo = 600): void {
    this.state.stalledSeconds = secondsAgo;
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000) - secondsAgo);
  }

  public injectRpcErrors(count = 20): void {
    this.state.rpcErrorCount += count;
    for (let i = 0; i < count; i++) {
      this.metrics.rpcRequestsTotal.inc({ method: 'get_stream', status: 'error' }, 1);
      this.metrics.rpcErrorsTotal.inc({ method: 'get_stream', status_code: '503' }, 1);
    }
  }

  public reset(): void {
    this.state = {
      syntheticDivergences: 0,
      stalledSeconds: 0,
      rpcErrorCount: 0,
    };
    this.engine.clearDivergences();
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
  }
}
