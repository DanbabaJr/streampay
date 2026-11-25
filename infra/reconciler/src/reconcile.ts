//! Reconciliation engine: cross-references off-chain indexed state vs Soroban contract on-chain truth.

import { defaultReconcilerMetrics, type ReconcilerMetricsRegistry } from './metrics.js';

export interface StreamSnapshot {
  streamId: number;
  deposit: string;
  withdrawn: string;
  status: 'Active' | 'Cancelled' | 'Depleted';
}

export interface TreasurySnapshot {
  token: string;
  chargedTotal: string;
  withdrawnTotal: string;
}

export interface DivergenceRecord {
  streamId?: number;
  checkType: 'stream_status' | 'stream_balance' | 'treasury_balance' | 'missing_record';
  severity: 'critical' | 'warning';
  indexedValue: string;
  onChainValue: string;
  detectedAt: string;
}

export class ReconciliationEngine {
  private metrics: ReconcilerMetricsRegistry;
  private activeDivergences: DivergenceRecord[] = [];

  constructor(metrics: ReconcilerMetricsRegistry = defaultReconcilerMetrics) {
    this.metrics = metrics;
    // Initialize baseline metrics
    this.metrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
    this.metrics.divergenceCurrent.set({ check_type: 'stream_status' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'stream_balance' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'treasury_balance' }, 0);
  }

  public getActiveDivergences(): DivergenceRecord[] {
    return [...this.activeDivergences];
  }

  public clearDivergences(): void {
    this.activeDivergences = [];
    this.metrics.divergenceCurrent.set({ check_type: 'stream_status' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'stream_balance' }, 0);
    this.metrics.divergenceCurrent.set({ check_type: 'treasury_balance' }, 0);
  }

  public recordDivergence(divergence: DivergenceRecord): void {
    this.activeDivergences.push(divergence);
    this.metrics.divergencesTotal.inc({ check_type: divergence.checkType, severity: divergence.severity }, 1);
    this.metrics.divergenceCurrent.inc({ check_type: divergence.checkType }, 1);
  }

  public async auditStream(indexed: StreamSnapshot, onChain: StreamSnapshot): Promise<DivergenceRecord[]> {
    const findings: DivergenceRecord[] = [];

    // 1. Status Check
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

    // 2. Balance Check
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

  public async runSweep(indexedStreams: StreamSnapshot[], onChainStreams: StreamSnapshot[]): Promise<DivergenceRecord[]> {
    const startTime = Date.now();
    this.metrics.rpcRequestsTotal.inc({ method: 'get_stream', status: 'success' }, indexedStreams.length);

    const onChainMap = new Map(onChainStreams.map(s => [s.streamId, s]));
    const findings: DivergenceRecord[] = [];

    for (const indexed of indexedStreams) {
      const onChain = onChainMap.get(indexed.streamId);
      if (!onChain) {
        const div: DivergenceRecord = {
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
