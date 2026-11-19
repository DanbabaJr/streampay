# StreamPay Observability Stack

Metrics, alerting rules, and Grafana dashboards-as-code for StreamPay's off-chain services (**Indexer** and **Reconciler**).

This stack answers the fundamental question: **"Is what users see true?"**

---

## Architecture Overview

```
                                      +---------------------------------+
                                      |      Stellar / Soroban RPC      |
                                      +----------------+----------------+
                                                       |
                             +-------------------------+-------------------------+
                             |                                                   |
                             v                                                   v
                +-------------------------+                         +-------------------------+
                |    StreamPay Indexer    |                         |   StreamPay Reconciler  |
                |  (Event Lag & DB Depth) |                         |  (Divergence Detector)  |
                |  Port: 9090 /metrics    |                         |  Port: 9091 /metrics    |
                +------------+------------+                         +------------+------------+
                             |                                                   |
                             +-------------------------+-------------------------+
                                                       | scrape
                                                       v
                                          +-------------------------+
                                          |        Prometheus       |
                                          |  (Rule Evaluation 5s)   |
                                          +------------+------------+
                                                       |
                                  +--------------------+--------------------+
                                  |                                         |
                                  v                                         v
                     +-------------------------+               +-------------------------+
                     |         Grafana         |               |       Alertmanager      |
                     |   Dashboards-as-Code    |               |  Routing & Runbook URL  |
                     |       Port: 3001        |               |       Port: 9093        |
                     +-------------------------+               +-------------------------+
```

---

## Key Metrics Instrumented at the Seams

1. **Per-Source Event Ingestion Lag (`streampay_indexer_event_lag_seconds`)**:
   - Histogram bucketed across `[0.5, 1, 2.5, 5, 10, 15, 30, 60, 120, 300]` seconds.
   - Measures time between block/ledger timestamp on Soroban and off-chain indexing.
2. **Ledger Cursor Lag (`streampay_indexer_ledger_lag`)**:
   - Number of ledgers the indexer is behind the chain tip.
3. **Database Write Backlog (`streampay_indexer_db_queue_backlog`)**:
   - Depth of uncommitted SQLite write buffer.
4. **Soroban RPC Error Rate (`streampay_indexer_rpc_errors_total` / `requests_total`)**:
   - Tracks 429 rate limits, 503 gateway timeouts, and network errors.
5. **Reconciliation Divergences (`streampay_reconciliation_divergences_total`)**:
   - **Critical (P0)** invariant tracker comparing indexed state against Soroban contract storage.

---

## Alert Rules & Empirical Soak Data Justification (Issue #27)

All alerting thresholds are justified from Issue #27 soak tests (50 streams/minute sustained across 10,000 transactions on Stellar Testnet):

| Alert | Condition | Severity | Soak Test Justification | Runbook Link |
|---|---|---|---|---|
| `IndexerEventLagHigh` | P95 lag > 30s for 2m | Warning | Soak baseline P95 is 8.2s (< 2 ledgers). 30s represents > 6 ledgers delayed. | [`docs/RUNBOOK.md#indexereventlaghigh`](../../docs/RUNBOOK.md#indexereventlaghigh) |
| `IndexerEventLagCritical` | P95 lag > 60s for 1m | Critical | Soak burst peak was 25s. 60s means indexer is severely lagging. | [`docs/RUNBOOK.md#indexereventlagcritical`](../../docs/RUNBOOK.md#indexereventlagcritical) |
| `IndexerLedgerLagCritical` | Cursor lag > 5 for 2m | Critical | Steady-state lag is ≤ 1 ledger. > 5 indicates poller stall. | [`docs/RUNBOOK.md#indexerledgerlagcritical`](../../docs/RUNBOOK.md#indexerledgerlagcritical) |
| `IndexerDBDepthGrowing` | Backlog > 500 for 2m | Warning | SQLite batch flushes keep depth < 50 items. > 500 indicates disk contention. | [`docs/RUNBOOK.md#indexerdbdepthgrowing`](../../docs/RUNBOOK.md#indexerdbdepthgrowing) |
| `IndexerDBDepthCritical` | Backlog > 2000 for 1m | Critical | Max burst depth was 120 items. 2000 items risks memory exhaustion. | [`docs/RUNBOOK.md#indexerdbdepthcritical`](../../docs/RUNBOOK.md#indexerdbdepthcritical) |
| `SorobanRPCErrorRateHigh` | Error rate > 5% for 2m | Warning | Soak error baseline was 0.04% (occasional 429). > 5% indicates throttling. | [`docs/RUNBOOK.md#sorobanrpcerrorratehigh`](../../docs/RUNBOOK.md#sorobanrpcerrorratehigh) |
| `SorobanRPCErrorRateCritical` | Error rate > 20% for 1m | Critical | > 20% failure indicates complete RPC loss of communication. | [`docs/RUNBOOK.md#sorobanrpcerrorratecritical`](../../docs/RUNBOOK.md#sorobanrpcerrorratecritical) |
| `ReconciliationDivergenceDetected` | Divergence > 0 for 30s | **P0 Critical** | **Zero tolerance.** 10,000 operations had 0 mismatches. | [`docs/RUNBOOK.md#reconciliationdivergencedetected`](../../docs/RUNBOOK.md#reconciliationdivergencedetected) |
| `ReconcilerJobStalled` | Last run > 300s ago | Critical | Verification sweeps run every 60s. > 300s indicates daemon crash. | [`docs/RUNBOOK.md#reconcilerjobstalled`](../../docs/RUNBOOK.md#reconcilerjobstalled) |

---

## Deploying the Stack

### Option A: Docker Compose Bundle

```bash
cd infra/observability
docker compose up -d
```

Services exposed:
- **Grafana**: `http://localhost:3001` (admin / admin)
- **Jaeger Tracing UI**: `http://localhost:16686`
- **OpenTelemetry Collector**: `localhost:4317` (OTLP gRPC) / `localhost:4318` (OTLP HTTP)
- **Prometheus**: `http://localhost:9092`
- **Alertmanager**: `http://localhost:9093`
- **Indexer API & Metrics**: `http://localhost:9090/metrics`
- **Reconciler API & Metrics**: `http://localhost:9091/metrics`

### Option B: Kubernetes / Kustomize Bundle

Deployable to any Kubernetes cluster without cloud-specific dependencies:

```bash
kubectl apply -k infra/observability/kustomize
```

---

## Distributed Tracing & Async Event Seam Verification

StreamPay is instrumented with OpenTelemetry to trace user operations across the full distributed stack:
- **Trace Propagation**: W3C `traceparent` headers propagate context from browser client to server route (`POST /api/claim`).
- **Async Event Seam**: Cross-process continuation for ledger-delayed block consensus uses **Span Links** (not parent-child) to link off-chain indexer event ingestion and push notifications back to the originating claim trace without timeline distortion.
- **Sampling Guarantee**: Tail-based sampling in the OpenTelemetry Collector guarantees **100% of error traces are retained**.
- **Privacy Line**: Stellar account addresses are truncated to 8-character prefixes (`addr.slice(0, 8) + "..."`), secrets/tokens are redacted, and notification URLs are sanitized. See [`docs/PRIVACY.md`](../../docs/PRIVACY.md).
- **Architecture Documentation**: Comprehensive specification in [`docs/TRACING.md`](../../docs/TRACING.md).

To run the end-to-end claim trace simulation and verify all seams:

```bash
node infra/observability/scripts/e2e_claim_trace_demo.mjs
```

---

## Sandbox Fault Injection Drill

To verify all alert rules and dashboard states in a sandbox:

```bash
node infra/observability/scripts/sandbox_drill.mjs
```
