//! Compiled ESM reconcile engine

import { defaultReconcilerMetrics } from './metrics.js';

export class ReconciliationEngine {
  constructor(metrics = defaultReconcilerMetrics) {
    this.metrics = metrics;
    this.activeDivergences = [];
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
    this.metrics.divergenceCurrent.set({ check_type: 'stream_status' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'stream_balance' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'treasury_balance' }, 0);
  }

  getActiveDivergences() {
    return [...this.activeDivergences];
  }

  clearDivergences() {
    this.activeDivergences = [];
    this.metrics.divergenceCurrent.set({ check_type: 'stream_status' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'stream_balance' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'treasury_balance' }, 0);
  }

  recordDivergence(divergence) {
    this.activeDivergences.push(divergence);
    this.metrics.divergencesTotal.inc({ check_type: divergence.checkType, severity: divergence.severity }, 1);
    this.metrics.divergenceCurrent.inc({ check_type: divergence.checkType }, 1);
  }

  async auditStream(indexed, onChain) {
    const findings = [];

    if (indexed.status !== onChain.status) {
      findings.push({
        streamId: indexed.streamId,
        checkType: 'stream_status',
        severity: 'critical',
        indexedValue: indexed.status,
        onChainValue: onChain.status,
        detectedAt: new Date().toISOString(),
      });
    }

    if (indexed.deposit !== onChain.deposit || indexed.withdrawn !== onChain.withdrawn) {
      findings.push({
        streamId: indexed.streamId,
        checkType: 'stream_balance',
        severity: 'critical',
        indexedValue: `dep=${indexed.deposit},wdr=${indexed.withdrawn}`,
        onChainValue: `dep=${onChain.deposit},wdr=${onChain.withdrawn}`,
        detectedAt: new Date().toISOString(),
      });
    }

    for (const f of findings) {
      this.recordDivergence(f);
    }

    this.metrics.itemsAuditedTotal.inc({ entity_type: 'stream' }, 1);
    return findings;
  }

  async runSweep(indexedStreams, onChainStreams) {
    const startTime = Date.now();
    this.metrics.rpcRequestsTotal.inc({ method: 'get_stream', status: 'success' }, indexedStreams.length);

    const onChainMap = new Map(onChainStreams.map(s => [s.streamId, s]));
    const findings = [];

    for (const indexed of indexedStreams) {
      const onChain = onChainMap.get(indexed.streamId);
      if (!onChain) {
        const div = {
          streamId: indexed.streamId,
          checkType: 'missing_record',
          severity: 'critical',
          indexedValue: 'exists',
          onChainValue: 'missing',
          detectedAt: new Date().toISOString(),
        };
        findings.push(div);
        this.recordDivergence(div);
      } else {
        const streamFindings = await this.auditStream(indexed, onChain);
        findings.push(...streamFindings);
      }
    }

    const durationSeconds = (Date.now() - startTime) / 1000;
    this.metrics.checkDurationSeconds.observe({ scope: 'full_sweep' }, durationSeconds);
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));

    return findings;
  }
}
