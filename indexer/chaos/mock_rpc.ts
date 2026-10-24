export type FaultType = 
  | 'cursor_rewind'
  | 'late_tx_drop'
  | 'ledger_gap_skip'
  | 'horizon_rpc_divergence'
  | 'delay_to_finality'
  | 'duplicate_ledger'
  | 'invalid_cursor'
  | 'stale_state_cache'
  | 'state_hydration_failure'
  | 'rpc_timeout'
  | 'partial_batch_drop'
  | 'consensus_fork';

export interface ChaosScenario {
  id: string;
  name: string;
  fault: FaultType;
  expectedInvariant: string;
}

export const SCENARIOS: ChaosScenario[] = [
  { id: 'SC-01', name: 'Cursor Rewind During Ingestion', fault: 'cursor_rewind', expectedInvariant: 'Replay is idempotent & no duplicate outbox event' },
  { id: 'SC-02', name: 'Late Transaction Drop', fault: 'late_tx_drop', expectedInvariant: 'Event held until finality proof' },
  { id: 'SC-03', name: 'Ledger Gap Skip', fault: 'ledger_gap_skip', expectedInvariant: 'Reconciler triggers backfill alarm' },
  { id: 'SC-04', name: 'Horizon vs RPC State Divergence', fault: 'horizon_rpc_divergence', expectedInvariant: 'Dual-read path produces alarm row, never silent pick' },
  { id: 'SC-05', name: 'Delay to Finality Spike', fault: 'delay_to_finality', expectedInvariant: 'Consumer-visible event suppressed until finalized' },
  { id: 'SC-06', name: 'Duplicate Ledger Injection', fault: 'duplicate_ledger', expectedInvariant: 'Processed ledger deduplicated gracefully' },
  { id: 'SC-07', name: 'Invalid Cursor Pagination', fault: 'invalid_cursor', expectedInvariant: 'Cursor checkpoint recovers correctly' },
  { id: 'SC-08', name: 'Stale State Cache Hit', fault: 'stale_state_cache', expectedInvariant: 'Forced revalidation catches stale data' },
  { id: 'SC-09', name: 'State Hydration Failure', fault: 'state_hydration_failure', expectedInvariant: 'Circuit breaker trips and alarms' },
  { id: 'SC-10', name: 'RPC Timeout Under Load', fault: 'rpc_timeout', expectedInvariant: 'Exponential backoff succeeds without data loss' },
  { id: 'SC-11', name: 'Partial Batch Drop', fault: 'partial_batch_drop', expectedInvariant: 'Missing gap detected and re-fetched' },
  { id: 'SC-12', name: 'Consensus Fork Simulation', fault: 'consensus_fork', expectedInvariant: 'Reorg handler reverts uncommitted state' },
];

export class MockSorobanRpc {
  private currentLedger = 1000;

  constructor(public activeFault: FaultType | null) {}

  public fetchLedgerData(ledgerSeq: number) {
    if (this.activeFault === 'cursor_rewind' && ledgerSeq >= 1005) {
      return { ledger: ledgerSeq - 3, status: 'rewound' };
    }
    if (this.activeFault === 'horizon_rpc_divergence') {
      return { rpcBalance: '500', horizonBalance: '450', divergent: true };
    }
    return { ledger: ledgerSeq, status: 'finalized', divergent: false };
  }
}
