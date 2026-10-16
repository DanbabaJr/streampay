# StreamPay Operations & Observability Runbook

Operational runbook for StreamPay off-chain services: **Event Indexer**, **State Reconciler**, and **Observability Stack**.
This runbook answers the fundamental operational question: **"Is what users see true?"**

Every Prometheus alert in `infra/observability/prometheus/rules/alerts.yml` links directly to a diagnosis and remediation procedure in this document.

---

## Quick Reference: Alerts & Severities

| Alert Name | Severity | Service | Soak Baseline (Issue #27) | Runbook Link |
|---|---|---|---|---|
| `IndexerEventLagHigh` | Warning (P2) | Indexer | P95 lag ≤ 8.2s (normal ~5s ledger) | [#indexereventlaghigh](#indexereventlaghigh) |
| `IndexerEventLagCritical` | Critical (P1) | Indexer | P99 lag ≤ 12.4s (max transient 25s) | [#indexereventlagcritical](#indexereventlagcritical) |
| `IndexerLedgerLagCritical` | Critical (P1) | Indexer | Steady-state lag ≤ 1 ledger | [#indexerledgerlagcritical](#indexerledgerlagcritical) |
| `IndexerDBDepthGrowing` | Warning (P2) | Indexer | Queue drains < 50 items/batch | [#indexerdbdepthgrowing](#indexerdbdepthgrowing) |
| `IndexerDBDepthCritical` | Critical (P1) | Indexer | Max burst depth observed = 120 | [#indexerdbdepthcritical](#indexerdbdepthcritical) |
| `SorobanRPCErrorRateHigh` | Warning (P2) | RPC Client | Normal baseline error rate = 0.04% | [#sorobanrpcerrorratehigh](#sorobanrpcerrorratehigh) |
| `SorobanRPCErrorRateCritical` | Critical (P1) | RPC Client | Rate limit / node outage threshold > 20% | [#sorobanrpcerrorratecritical](#sorobanrpcerrorratecritical) |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler | **0 divergences** across 10,000 txs | [#reconciliationdivergencedetected](#reconciliationdivergencedetected) |
| `ReconcilerJobStalled` | Critical (P1) | Reconciler | Scheduled run interval = 60s | [#reconcilerjobstalled](#reconcilerjobstalled) |

---

## 1. Indexer Alerts

### `IndexerEventLagHigh`

- **Severity**: Warning (P2)
- **Condition**: P95 event ingestion lag exceeds 30 seconds for > 2 minutes.
- **Soak Data Justification (Issue #27)**:
  Under continuous load testing (50 streams/minute against Stellar Testnet), 95% of events were processed within 8.2 seconds of ledger close. A sustained 30-second lag represents a delay of 6+ ledger closes, indicating worker degradation or upstream polling slowdowns.
- **User Impact**:
  Users experience delayed UI state updates after transaction confirmation (e.g. newly created streams do not appear immediately in the stream list).

#### Diagnosis
1. Check indexer service health and logs:
   ```bash
   curl -s http://localhost:9090/health
   docker logs --tail 100 streampay-indexer
   ```
2. Inspect the current event lag breakdown by event topic:
   ```promql
   histogram_quantile(0.95, sum(rate(streampay_indexer_event_lag_seconds_bucket[2m])) by (le, topic))
   ```
3. Check upstream Soroban RPC responsiveness:
   ```bash
   curl -X POST "$RPC_URL" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'
   ```

#### Remediation
1. If the lag is isolated to a specific high-volume topic, verify SQLite write concurrency.
2. If RPC latency is high (> 1500ms), switch to a backup RPC provider:
   ```bash
   # Update RPC_URL in deployment or .env
   docker compose restart indexer
   ```
3. If the indexer process is memory constrained, restart the container:
   ```bash
   docker restart streampay-indexer
   ```

---

### `IndexerEventLagCritical`

- **Severity**: Critical (P1)
- **Condition**: P95 event ingestion lag exceeds 60 seconds for > 1 minute.
- **Soak Data Justification (Issue #27)**:
  During soak tests, event lag never exceeded 25 seconds even under 3x traffic bursts. A 60-second delay means indexer state is over 12 ledgers stale. At this stage, user workflows (such as withdrawals or balance checking) become visibly corrupted.
- **User Impact**:
  Frontend displays completely stale data. Users attempting to withdraw funds may see error codes because the client acts on outdated balances.

#### Diagnosis
1. Query current ledger lag:
   ```bash
   curl -s http://localhost:9090/metrics | grep streampay_indexer_ledger_lag
   ```
2. Verify if the polling loop is stuck:
   ```bash
   docker logs --since 5m streampay-indexer | grep "poll"
   ```

#### Remediation
1. Verify network connectivity to Soroban RPC node.
2. Restart the indexer service:
   ```bash
   docker compose restart indexer
   ```
3. If indexer cannot catch up due to backlog, run in catchup mode or trigger an indexer rebuild:
   ```bash
   ./scripts/drill_indexer_corruption.sh $CONTRACT_ID $TOKEN_ID
   ```

---

### `IndexerLedgerLagCritical`

- **Severity**: Critical (P1)
- **Condition**: The indexer cursor is more than 5 ledgers behind the chain tip for > 2 minutes.
- **Soak Data Justification (Issue #27)**:
  Ledger close on Stellar is ~5s. The indexer steady-state cursor delta is ≤ 1 ledger. A gap of > 5 ledgers indicates the poller has halted or is throwing unhandled exceptions.
- **User Impact**:
  All new on-chain events are completely invisible off-chain.

#### Diagnosis
1. Query indexer cursor vs tip:
   ```bash
   curl -s http://localhost:9090/metrics | grep -E "streampay_indexer_latest_ledger|streampay_chain_tip_ledger"
   ```
2. Check for unhandled exceptions in indexer logs:
   ```bash
   docker logs --tail 200 streampay-indexer | grep -E "ERROR|Unhandled|Exception"
   ```

#### Remediation
1. Check if Soroban RPC `getEvents` cursor pagination failed or returned an invalid cursor token.
2. Restart indexer with the last acknowledged ledger checkpoint:
   ```bash
   docker compose restart indexer
   ```

---

### `IndexerDBDepthGrowing`

- **Severity**: Warning (P2)
- **Condition**: Uncommitted SQLite write queue depth > 500 items for > 2 minutes.
- **Soak Data Justification (Issue #27)**:
  The soak test verified SQLite batch flushes keep pending queue depth below 50 items. A queue above 500 indicates disk I/O bottlenecks or SQLite lock contention (`SQLITE_BUSY`).
- **User Impact**:
  Memory footprint increases; slight latency in event persistence.

#### Diagnosis
1. Check current DB depth metrics:
   ```bash
   curl -s http://localhost:9090/metrics | grep streampay_indexer_db_depth
   ```
2. Check disk I/O and SQLite lock status:
   ```bash
   lsof | grep indexer.db
   df -h /var/lib/streampay-indexer
   ```

#### Remediation
1. Ensure WAL mode is active on SQLite database:
   ```bash
   sqlite3 /data/indexer.db "PRAGMA journal_mode=WAL;"
   ```
2. Increase write batch flush interval or allocate faster storage volume.

---

### `IndexerDBDepthCritical`

- **Severity**: Critical (P1)
- **Condition**: Uncommitted DB queue backlog > 2000 items for > 1 minute.
- **Soak Data Justification (Issue #27)**:
  Max burst queue depth recorded in issue #27 soak tests was 120 items during a simulated 500-tx ledger burst. A queue of 2000 indicates a stalled writer thread or filesystem failure.
- **User Impact**:
  Imminent risk of process OOM crash and data loss for in-memory buffer.

#### Diagnosis & Remediation
1. Inspect process memory consumption:
   ```bash
   docker stats streampay-indexer --no-stream
   ```
2. Force sync queue to disk or restart with clean snapshot if DB is corrupted.
3. Follow indexer recovery steps in `docs/INCIDENT_RUNBOOK.md` § Scenario 3.

---

## 2. Soroban RPC Client Alerts

### `SorobanRPCErrorRateHigh`

- **Severity**: Warning (P2)
- **Condition**: Failed RPC request rate > 5% over 2 minutes.
- **Soak Data Justification (Issue #27)**:
  Baseline soak testing showed an RPC error rate of 0.04% (primarily transient 429 rate-limiting handled cleanly via jittered exponential backoff). > 5% indicates persistent throttling or node degradation.
- **User Impact**:
  Slight delay in indexing and reconciliation checks.

#### Diagnosis
1. Identify failing RPC methods and HTTP status codes:
   ```promql
   sum(rate(streampay_indexer_rpc_errors_total[2m])) by (method, status_code)
   ```
2. Check whether errors are 429 (Rate Limit) or 503 (Service Unavailable).

#### Remediation
1. **If HTTP 429 (Rate Limit)**:
   - Adjust poller backoff interval (`POLL_INTERVAL_MS=3000`).
   - Rotate RPC API key or add secondary RPC endpoints.
2. **If HTTP 503 / 502**:
   - Verify status of upstream Soroban RPC provider (e.g. Stellar Horizon / RPC status page).
   - Switch active provider to fallback URL.

---

### `SorobanRPCErrorRateCritical`

- **Severity**: Critical (P1)
- **Condition**: Failed RPC request rate > 20% over 1 minute.
- **Soak Data Justification (Issue #27)**:
  Sustained > 20% error rate implies total communication loss with the Soroban network.
- **User Impact**:
  Complete disruption of event indexing and state verification.

#### Diagnosis & Remediation
1. Check public RPC status:
   ```bash
   curl -I https://soroban-testnet.stellar.org
   ```
2. Switch RPC endpoint in `docker-compose.yml` to secondary node.
3. Restart services:
   ```bash
   docker compose up -d --force-recreate
   ```

---

## 3. Reconciliation & Consistency Alerts

### `ReconciliationDivergenceDetected`

- **Severity**: **CRITICAL (P0)**
- **Condition**: Any discrepancy between indexed off-chain state and canonical on-chain contract state (`streampay_reconciler_divergence_current > 0`).
- **Soak Data Justification (Issue #27)**:
  Issue #27 soak tests executed 10,000 synthetic operations across multiple tokens, verifying 100% agreement between off-chain database and Soroban contract state (`get_stream`, `treasury_status`, `verify_treasury`). **There is zero acceptable tolerance for divergence.** Any divergence means users are seeing falsehoods ("is what users see true?"), creating legal and financial liability.
- **User Impact**:
  Users see incorrect stream balances, phantom streams, or false status. Withdrawals may fail or dispute resolution may trigger.

#### Immediate Diagnosis (First 5 Minutes)
1. Query active divergences from reconciler:
   ```bash
   curl -s http://localhost:9091/divergences
   ```
2. Inspect reconciler divergence metrics:
   ```promql
   streampay_reconciliation_divergences_total
   ```
3. Check affected stream ID directly on-chain:
   ```bash
   stellar contract invoke \
     --id "$CONTRACT_ID" \
     --source monitor \
     --network testnet \
     -- get_stream --stream_id "$STREAM_ID"
   ```
4. Query the indexer's record for that same stream:
   ```bash
   curl -s "http://localhost:9090/streams/$STREAM_ID"
   ```

#### Remediation & Containment
1. **Quarantine or Flag**:
   - If UI allows, mark affected stream ID as "Auditing / Syncing" in the frontend cache.
2. **Determine Source of Truth**:
   - Soroban contract storage is the immutable truth.
   - If indexer missed an event (e.g. reorganization or dropped RPC page), trigger an immediate re-index of the affected ledger range:
     ```bash
     curl -X POST http://localhost:9090/sync-range -d '{"start_ledger": <LEDGER>, "end_ledger": <LEDGER>}'
     ```
3. **Trigger Indexer Rebuild if Widespread**:
   - If ≥ 3 streams diverge, follow the rebuild procedure in `scripts/drill_indexer_corruption.sh`:
     ```bash
     ./scripts/drill_indexer_corruption.sh "$CONTRACT_ID" "$TOKEN_ID"
     ```
4. **Treasury Invariant Divergence**:
   - If divergence is `check_type="treasury_balance"`, run contract verification scan:
     ```bash
     stellar contract invoke --id "$CONTRACT_ID" --source monitor --network testnet -- verify_treasury --token "$TOKEN_ID" --start_id 1 --limit 50
     ```

---

### `ReconcilerJobStalled`

- **Severity**: Critical (P1)
- **Condition**: `time() - streampay_reconciler_last_run_timestamp_seconds > 300` (no reconciliation completed in 5 minutes).
- **Soak Data Justification (Issue #27)**:
  Reconciler runs every 60 seconds by default. A 5-minute silence indicates process death, unhandled rejection, or network deadlock.
- **User Impact**:
  Silent failure of safety net; undetected divergences may persist.

#### Diagnosis & Remediation
1. Check reconciler container status:
   ```bash
   docker ps -a | grep reconciler
   docker logs --tail 100 streampay-reconciler
   ```
2. Restart reconciler daemon:
   ```bash
   docker compose restart reconciler
   ```

---

## 4. Sandbox Fault Injection & Alert Testing

To verify all alerts in a sandbox without affecting production, use the automated drill script:

```bash
# Run the fault injection drill harness
node infra/observability/scripts/sandbox_drill.mjs
```

The script will:
1. Boot mock indexer and reconciler endpoints exposing Prometheus `/metrics`.
2. Inject each simulated fault:
   - High event lag (`P95 > 30s`)
   - Queue depth surge (`depth = 1200`)
   - RPC error burst (`error_rate = 25%`)
   - State divergence (`stream_balance divergence detected`)
3. Validate alert trigger criteria and verify metrics exposition syntax.
4. Reset faults and assert recovery.
