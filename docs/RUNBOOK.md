# ⚡ StreamPay Integrator & Operations Runbook

Comprehensive operational runbook and troubleshooting decision tree for StreamPay integrators, payroll operations teams, and on-call engineers.

This runbook carries an end-to-end worked example of onboarding a **50-employee payroll** onto Stellar Testnet, operating continuous streams through a full monthly cycle, and diagnosing issues across the contract, CLI, indexer, and RPC stack.

---

## Quick Reference: Alerts & Severities

| Alert Name | Severity | Service | Soak Baseline (Issue #27) | Runbook Link |
|---|---|---|---|---|
| `IndexerEventLagHigh` | Warning (P2) | Indexer | P95 lag ≤ 8.2s (normal ~5s ledger) | §4 decision tree |
| `IndexerEventLagCritical` | Critical (P1) | Indexer | P99 lag ≤ 12.4s (max transient 25s) | §4 decision tree |
| `IndexerLedgerLagCritical` | Critical (P1) | Indexer | Steady-state lag ≤ 1 ledger | §4 decision tree |
| `IndexerDBDepthGrowing` | Warning (P2) | Indexer | Queue drains < 50 items/batch | §4 decision tree |
| `IndexerDBDepthCritical` | Critical (P1) | Indexer | Max burst depth observed = 120 | §4 decision tree |
| `SorobanRPCErrorRateHigh` | Warning (P2) | RPC Client | Normal baseline error rate = 0.04% | §4 decision tree |
| `SorobanRPCErrorRateCritical` | Critical (P1) | RPC Client | Rate limit / node outage threshold > 20% | §4 decision tree |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler | **0 divergences** across 10,000 txs | §4 decision tree |
| `ReconcilerJobStalled` | Critical (P1) | Reconciler | Scheduled run interval = 60s | §4 decision tree |
| `IndexerOutboxDepthDiverging` | Critical (P1) | Indexer Outbox | 10k-intent backlog drains in ~3.5s | [#indexeroutboxdepthdiverging](#indexeroutboxdepthdiverging) |
| `IndexerOutboxDeliveryLagHigh` | Warning (P2) | Indexer Outbox | Oldest pending intent < 5s at steady state | [#indexeroutboxdeliverylaghigh](#indexeroutboxdeliverylaghigh) |
| `IndexerOutboxDeadLetterRateHigh` | Warning (P2) | Indexer Outbox | 0 dead letters for healthy endpoints | [#indexeroutboxdeadletterratehigh](#indexeroutboxdeadletterratehigh) |
| `IndexerOutboxBackpressured` | Warning (P2) | Indexer Outbox | Never engages at soak ingestion rates | [#indexeroutboxbackpressured](#indexeroutboxbackpressured) |
## Table of Contents

1. [Executive Overview & Operational Model](#1-executive-overview--operational-model)
2. [50-Employee Payroll Migration Walkthrough](#2-50-employee-payroll-migration-walkthrough)
   - [Step 1: Ingesting & Validating Payroll CSV](#step-1-ingesting--validating-payroll-csv)
   - [Step 2: SAC Token Allowance Approval](#step-2-sac-token-allowance-approval)
   - [Step 3: Batch Stream Creation](#step-3-batch-stream-creation)
   - [Step 4: Real-Time Accrual & Verification](#step-4-real-time-accrual--verification)
3. [Month-of-Production Lifecycle Operations](#3-month-of-production-lifecycle-operations)
   - [Day 7: Mid-Month Recipient Withdrawal](#day-7-mid-month-recipient-withdrawal)
   - [Day 14: Employee Offboarding & Pro-Rata Cancellation](#day-14-employee-offboarding--pro-rata-cancellation)
   - [Day 21: Performance Promotion & Stream Top-Up](#day-21-performance-promotion--stream-top-up)
   - [Day 30: Final Settlement & Batch Claim](#day-30-final-settlement--batch-claim)
4. [Troubleshooting Decision Tree](#4-troubleshooting-decision-tree)
   - [Node A: Validation Rejections](#node-a-validation-rejections)
   - [Node B: Wallet & Signature Failures](#node-b-wallet--signature-failures)
   - [Node C: TTL & Storage Expiry Surprises](#node-c-ttl--storage-expiry-surprises)
   - [Node D: Index Discovery Gaps](#node-d-index-discovery-gaps)
   - [Node E: Refund & Partial-State Confusion](#node-e-refund--partial-state-confusion)
   - [Node F: RPC Degradation & Throttling](#node-f-rpc-degradation--throttling)
5. [Incident Escalation & Security Policy](#5-incident-escalation--security-policy)
6. [Observability & Service Alerts Reference](#6-observability--service-alerts-reference)

---

## 1. Executive Overview & Operational Model

StreamPay replaces traditional bi-weekly or monthly payroll lump-sum transfers with continuous, per-second streaming payments escrowed inside Soroban smart contracts on the Stellar network.

```text
 ┌──────────────────────┐      1. Approve SAC Allowance       ┌──────────────────────┐
 │  Employer Treasury   │ ─────────────────────────────────>  │ Stellar Asset (SAC)  │
 │ (GD3K5V2X6M7N...DEMO)│                                     │ (CDLZFC3SYJYD...SC)  │
 └──────────┬───────────┘                                     └──────────┬───────────┘
            │                                                            │
            │ 2. create_stream(recipient, deposit, duration)             │ Pulls deposit
            ▼                                                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │                     StreamPay Smart Contract (CA3D52RZ...ZA)                     │
 │  - Accrual math: streamed(t) = deposit * (now - start) / (end - start)           │
 │  - Escrow invariant: contract_balance >= sum(deposit - withdrawn)               │
 └──────────────────────┬───────────────────────────────────┬───────────────────────┘
                        │                                   │
       3. withdraw(stream_id, amount)      4. cancel_stream(caller, stream_id)
                        ▼                                   ▼
 ┌──────────────────────────────┐          ┌────────────────────────────────────────┐
 │ Employee (GBSNPDOVQIS...ODT) │          │ Pro-Rata Split:                        │
 │ Accrued funds claimable 24/7 │          │  - Recipient <- accrued balance        │
 └──────────────────────────────┘          │  - Sender    <- unaccrued remainder    │
                                           └────────────────────────────────────────┘
```

### Core Invariants Guaranteed by Contract

Every payroll operation is subject to formal verification invariants:
1. **Per-Stream Invariant**: `0 <= withdrawn <= streamed <= deposit` at every ledger sequence.
2. **Conservation of Funds Invariant**: Contract token balance $\ge \sum (\text{deposit} - \text{withdrawn})$ across all active streams.
3. **Deterministic CEI Ordering**: All payouts follow strict Checks-Effects-Interactions (CEI) to preclude reentrancy windows.
4. **No Silent Panics**: All operational rejections emit explicit `StreamError` codes (1..48) defined in [`docs/ERROR_SURFACE.md`](./ERROR_SURFACE.md) and [`frontend/lib/errors.ts`](../frontend/lib/errors.ts).

---

## 2. 50-Employee Payroll Migration Walkthrough

This walkthrough demonstrates the exact operational procedure for onboarding 50 employees using the synthetic payroll dataset located at [`docs/runbook/payroll_50_employees.csv`](runbook/payroll_50_employees.csv).

All operations are reproducible against Stellar Testnet using the headless [`tools/streampay-cli`](../tools/streampay-cli) or `stellar contract invoke`.

### Step 1: Ingesting & Validating Payroll CSV

Before submitting any transactions, the operations team runs preflight linting on the input CSV:

```bash
# Validate format, addresses, and sum payroll deposit units
./docs/runbook/batch_payroll_migration.sh docs/runbook/payroll_50_employees.csv
```

#### Verification Checklist
- [x] All 50 employee public keys conform to StrKey format (`G` followed by 55 characters in Base32 alphabet `[A-Z2-7]`).
- [x] No duplicate Stellar public keys exist within the batch.
- [x] Deposit amounts are positive integers expressed in 7-decimal smallest units ($1.00\text{ USDC} = 10{,}000{,}000\text{ units}$).
- [x] Duration is 30 days ($2{,}592{,}000\text{ seconds}$).
- [x] Total payroll deposit equals $458{,}000.00\text{ USDC}$ ($4{,}580{,}000{,}000{,}000\text{ units}$).

### Step 2: SAC Token Allowance Approval

StreamPay contracts pull funds during `create_stream`. The employer treasury account must approve an allowance to the StreamPay contract:

```bash
# Set environment signer
export STREAMPAY_SECRET_KEY="S..."
export CONTRACT_ID="CA3D52RZWTGQ7DCU5E7JNKDMXY5L4N6ZQRJ4V7W5KLMNOPTUVWXYZA"
export TOKEN_ID="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

# Check employer USDC balance
stellar contract invoke \
  --id "$TOKEN_ID" \
  --source env \
  --network testnet \
  -- balance --id "GD3K5V2X6M7NJJ4L6N6A6W43I7KVU55M7A4PY2K6QZ8W5N3T7R1QDEMO"

# Approve StreamPay contract as spender for total payroll batch (4,580,000.00 USDC)
stellar contract invoke \
  --id "$TOKEN_ID" \
  --source env \
  --network testnet \
  -- approve \
  --from "GD3K5V2X6M7NJJ4L6N6A6W43I7KVU55M7A4PY2K6QZ8W5N3T7R1QDEMO" \
  --spender "$CONTRACT_ID" \
  --amount 4580000000000 \
  --expiration_ledger 10552000
```

### Step 3: Batch Stream Creation

Execute the batch migration script or iterate records using `streampay create`:

```bash
# Example single invocation for Employee #1 (Alex Chen)
streampay --contract "$CONTRACT_ID" --signer env create \
  --token "$TOKEN_ID" \
  --recipient "GBSNPDOVQISUCBYWYQCZUYDZDJNT2Q3HGYR2Q4WO367PRQANI32INODT" \
  --deposit 50000000000 \
  --days 30 \
  --cancelable
```

The migration harness submits the batch throttled at 2 transactions per ledger close to avoid sequence number collisions. Output is recorded in [`docs/runbook/migration_manifest.json`](runbook/migration_manifest.json) and [`docs/runbook/testnet_migration_execution.log`](runbook/testnet_migration_execution.log).

### Step 4: Real-Time Accrual & Verification

Once created, verify that continuous accrual is functioning on-chain:

```bash
# Query stream metadata for Stream #101
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source env \
  --network testnet \
  -- get_stream --stream_id 101

# Inspect available accrued balance in real time
streampay --contract "$CONTRACT_ID" --signer env --dry-run --json \
  withdraw --stream-id 101 --amount 1000
```

---

## 3. Month-of-Production Lifecycle Operations

Continuous payment streams introduce mid-cycle interactions not present in batch payroll. This section details operational handling for events during the 30-day period.

### Day 7: Mid-Month Recipient Withdrawal

Employees can withdraw accrued wages on demand at any time without HR intervention:

```bash
# Recipient executes withdrawal of accrued wages
streampay --contract "$CONTRACT_ID" --signer env withdraw \
  --stream-id 101 \
  --amount 10000000000
```

**Diagnostic Audit:**
- The contract verifies: `amount <= available(stream_id)`.
- Updates internal state: `withdrawn = withdrawn + amount`.
- Transfers tokens from contract to recipient.

### Day 14: Employee Offboarding & Pro-Rata Cancellation

When an employee departs mid-month (e.g. EMP-007, George Clark, on Day 14), either the employer or employee can cancel the stream. The contract atomically splits the balance:

```bash
# Execute pro-rata cancellation
streampay --contract "$CONTRACT_ID" --signer env cancel \
  --stream-id 107
```

**Mathematical Split (Day 14 / Day 30):**
- Total Deposit: $8{,}500.00\text{ USDC}$
- Elapsed Time: $1{,}209{,}600\text{ s}$ out of $2{,}592{,}000\text{ s}$ ($46.67\%$)
- Accrued to Employee: $3{,}966.67\text{ USDC}$ (transferred to recipient immediately)
- Unaccrued Refund to Employer: $4{,}533.33\text{ USDC}$ (refunded to employer immediately)
- Stream Status: Transitioned from `Active` to `Cancelled`.

### Day 21: Performance Promotion & Stream Top-Up

If an employee receives a salary adjustment or bonus mid-stream (e.g. EMP-010, Julia Roberts, $+2{,}500.00\text{ USDC}$):

```bash
# Top up existing active stream
streampay --contract "$CONTRACT_ID" --signer env top-up \
  --stream-id 110 \
  --amount 25000000000
```

**Contract Behavior:**
- Employer must have approved SAC allowance for top-up amount.
- `deposit = deposit + amount`.
- Remaining duration recalculated; stream rate per second increases proportionally to ensure new total is fully released by `end_time`.

### Day 30: Final Settlement & Batch Claim

At $t \ge \text{end\_time}$, accrual reaches 100%. Employees or aggregators can sweep all remaining balances using `claim-all`:

```bash
# Batch claim all mature recipient balances
streampay --contract "$CONTRACT_ID" --signer env claim-all
```

---

## 4. Troubleshooting Decision Tree

When an operational failure occurs, engineers and operators must follow this decision tree. Every symptom is mapped to diagnostic commands, root causes, exact fixes, and escalation paths.

```text
                                 [ OPERATIONAL SYMPTOM DETECTED ]
                                                │
         ┌──────────────────┬───────────────────┼───────────────────┬──────────────────┐
         ▼                  ▼                   ▼                   ▼                  ▼
    [Validation]         [Wallet /]          [TTL /]             [Index /]          [Refund /]
     Rejection           Signature           Storage             Discovery          Partial
    (Error 1..46)         Failure            Surprise              Gap               State
         │                  │                   │                   │                  │
      Node A              Node B              Node C              Node D             Node E
```

---

### Node A: Validation Rejections

| Symptom / Error Code | Diagnostic Command | Root Cause | Immediate Fix | Escalation |
|---|---|---|---|---|
| **Code 4: `DepositZero`** | Inspect CSV `deposit_units` column | Deposit amount passed was 0 or negative | Set deposit to positive integer $> 0$. | Public issue / Ops fix |
| **Code 5: `InvalidDuration`** | Inspect start/end parameters | Duration $< 60\text{ s}$ or $> 5\text{ years}$ | Adjust `days` parameter to valid range. | Public issue / Ops fix |
| **Code 6: `StartTimePast`** | `date +%s` vs `start_time` | Start timestamp is $> 300\text{ s}$ before ledger time | Use CLI default (now $+ 60\text{ s}$). | Public issue / Ops fix |
| **Code 16: `InsufficientAllowance`** | `stellar contract invoke --id $TOKEN_ID -- allowance --from $SENDER --spender $CONTRACT_ID` | SAC token allowance lower than deposit | Execute `Token.approve` with sufficient amount and expiry ledger. | Ops fix |
| **Code 22: `StreamNotActive`** | `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID` | Attempted withdrawal/top-up on cancelled or completed stream | Confirm stream ID. Stream is immutable once finalized. | Ops fix |

---

### Node B: Wallet & Signature Failures

| Symptom | Diagnostic Command | Root Cause | Immediate Fix | Escalation |
|---|---|---|---|---|
| **`txBAD_SEQ` (Sequence Number Mismatch)** | `curl -s -X POST "$RPC_URL" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'` | Concurrent transactions submitted from same account | Re-fetch source account sequence from Horizon/RPC before building transaction. | Ops retry |
| **Simulation Rejection (HostError)** | `streampay --contract $CONTRACT_ID --signer env --dry-run --json create ...` | Soroban host rejected call during `simulateTransaction` | Inspect `eventXdr` and simulation report error code. | Check Node A |
| **Hardware Wallet Payload Mismatch** | Compare `unsignedXdr` hash vs device prompt | Signer mode `ledger` generated XDR modified before submission | Never modify unsigned XDR envelope. Submit raw signed XDR via `--signed-xdr`. | Hardware wallet guide |
| **Missing Signer Permission** | `stellar keys address env` vs contract governor | Caller is neither sender, recipient, nor contract governor | Switch signer to the authorized account address for that specific stream. | Security boundary |

---

### Node C: TTL & Storage Expiry Surprises

Soroban state entries require rent maintenance. If an entry reaches its TTL cliff without renewal, reads fail.

| Symptom | Diagnostic Command | Root Cause | Immediate Fix | Escalation |
|---|---|---|---|---|
| **`MissingValue` on active stream ID** | `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID` | Data entry TTL expired due to sentinel gap | Run `extend_footprint` on contract instance and entry key via TTL sentinel. | On-call P1 |
| **Sentinel Budget Alert (`BurnExceedsBudget`)** | `curl -s http://localhost:9095/metrics \| grep streampay_sentinel_burn_vs_budget_ratio` | Network rent surge or sudden influx of live streams | Increase sentinel treasury allocation or enable `expire-demo-first` degradation policy. | Infrastructure Lead |
| **Poison Account in Renewal Queue** | Check sentinel log: `Account quarantined` | Deleted or malformed key blocking renewal batch | Sentinel quarantines poison key automatically without stalling queue. Verify in health surface. | Issue #219 planner |

---

### Node D: Index Discovery Gaps

| Symptom | Diagnostic Command | Root Cause | Immediate Fix | Escalation |
|---|---|---|---|---|
| **Stream exists on-chain but absent in UI** | 1. `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`<br>2. `curl -s http://localhost:9090/streams/$ID` | Indexer event poller has lagged behind chain tip | Query `IndexerEventLag` metric; check if indexer cursor is advancing. | Indexer Ops |
| **Indexer cursor stalled > 5 ledgers** | `curl -s http://localhost:9090/health` | Unhandled RPC exception or network disconnect | Restart indexer daemon: `docker compose restart indexer`. | Ops runbook § 1 |
| **SQLite DB locked (`SQLITE_BUSY`)** | `lsof \| grep indexer.db` | High-volume write contention without WAL mode | Enable WAL mode: `sqlite3 /data/indexer.db "PRAGMA journal_mode=WAL;"`. | Ops runbook § 1 |

---

### Node E: Refund & Partial-State Confusion

| Symptom | Diagnostic Command | Root Cause | Immediate Fix | Escalation |
|---|---|---|---|---|
| **"Employee claimed they did not get full salary on cancel"** | Inspect contract events for `StreamCancelled` topic | Unaccrued remainder correctly refunded to employer | Check accrual elapsed ratio: recipient receives `streamed - withdrawn`; unstreamed portion returns to employer. | Expected behavior |
| **Contract balance mismatch (`ReconciliationDivergence`)** | Run reconciler verification scan: `stellar contract invoke --id $CONTRACT_ID -- verify_treasury --token $TOKEN_ID --start_id 1 --limit 50` | Divergence between off-chain database and Soroban state | Soroban state is immutable source of truth. Re-index affected ledger range. | **P0 Alert** (§ 5) |

---

### Node F: RPC Degradation & Throttling

| Symptom | Diagnostic Command | Root Cause | Immediate Fix | Escalation |
|---|---|---|---|---|
| **HTTP 429 Too Many Requests** | Check response headers: `Retry-After` | Public Soroban RPC rate limit exceeded | Configure private RPC endpoint or increase backoff interval (`POLL_INTERVAL_MS=3000`). | Infra / RPC provider |
| **HTTP 503 / 502 Bad Gateway** | `curl -I https://soroban-testnet.stellar.org` | RPC node experiencing infrastructure downtime | Failover to secondary RPC node provider. | Infra failover |
| **Transaction inclusion timeout** | `streampay --contract $CONTRACT_ID ...` returns exit code 5 | Ledger surge; transaction did not include in 10 ledgers | Query transaction status by hash before resubmitting to avoid duplicate creation. | Soroban timeout |

---

## 5. Incident Escalation & Security Policy

Escalation boundaries are strictly wired to [`SECURITY.md`](../SECURITY.md):

```text
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                            INCIDENT CLASSIFICATION                              │
 └────────────────────────┬───────────────────────────────────────┬────────────────┘
                          │                                       │
                CRITICAL / SECURITY RISK               NON-EXPLOITABLE / OPERATIONAL
                          │                                       │
                          ▼                                       ▼
             [ PRIVATE DISCLOSURE ONLY ]                 [ PUBLIC ISSUE TRACKER ]
             - Potential funds movement bug              - Documentation drift / typos
             - Invariant violation (balance coverage)    - CLI usability improvements
             - Authentication / authorization bypass     - Public security report form
             - Reentrancy / CEI sequence flaw            - Routine RPC node maintenance
                          │                                       │
                          ▼                                       ▼
             GitHub Private Security Advisory             GitHub Issues / Discussions
             Direct maintainer escalation                 Standard sprint triage
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

---

## 5. Transactional Outbox Alerts

These alerts cover the transactional outbox inside the production indexer
(`GET /metrics` on the indexer port, spec in [docs/OUTBOX.md](./OUTBOX.md)).
Delivery intents are never lost — an alarm here means consumers are receiving
events late, duplicating, or dead-lettering, not that data is gone.

### `IndexerOutboxDepthDiverging`

- **Severity**: Critical (P1)
- **Condition**: `streampay_outbox_divergence_alarm == 1` for > 1 minute — total outbox depth has grown strictly monotonically across every tick sample above `OUTBOX_ALARM_MIN_DEPTH`.
- **User Impact**: Replay feeds (`GET /streams/:id/events?after=`) and push consumers fall progressively further behind chain truth. Nothing is lost (intents are durable), but staleness is unbounded until it is addressed.

#### Diagnosis
1. See which state is accumulating:
   ```bash
   curl -s http://localhost:8787/api/outbox/stats
   ```
2. Check per-consumer health and rate budgets:
   ```bash
   curl -s http://localhost:8787/api/outbox/consumers
   curl -s http://localhost:8787/api/outbox/intents?state=dead
   ```
3. Confirm the dispatcher is alive (`streampay_outbox_dispatch_total` must advance).

#### Remediation
1. Disable the failing consumer channel so healthy ones drain:
   `POST /api/outbox/consumers/:id/status {"status":"disabled"}`.
2. Raise dispatcher throughput (`OUTBOX_BATCH_SIZE`, `OUTBOX_TICK_MS`) or scale the consumer.
3. After endpoint recovery, replay dead letters: `POST /api/outbox/intents/:id/replay`.
4. If ingestion itself outran drain durably, replay pull consumers from their cursors — the journal retains everything.

### `IndexerOutboxDeliveryLagHigh`

- **Severity**: Warning (P2)
- **Condition**: Oldest pending intent older than 60s for > 3 minutes.
- **Diagnosis / Remediation**: Same sequence as above; typically one slow endpoint or an over-throttled `rate_limit_per_sec`. Force a catch-up tick with `POST /api/outbox/flush`.

### `IndexerOutboxDeadLetterRateHigh`

- **Severity**: Warning (P2)
- **Condition**: > 50 intents dead-lettered within 10 minutes.
- **Diagnosis / Remediation**: Inspect `dead_reason` on the DLQ rows (`max_attempts` vs `reorg_retracted`). Reorg retractions are expected after a chain reorg coordinated by the reconciler — verify `streampay_outbox_retracted_total` matches the reconciler's divergence report before replaying anything. Consumer endpoint failures require fixing the endpoint first, then batch-replaying dead intents.

### `IndexerOutboxBackpressured`

- **Severity**: Warning (P2)
- **Condition**: Any `rejected_backpressure` dispatch outcome within 5 minutes.
- **Diagnosis / Remediation**: `OUTBOX_MAX_DEPTH` engaged intentionally to protect a degraded downstream. Confirm which consumer is degraded, clear it, and depth will drain at ~2,900 intents/sec. If the threshold is chronically low for your ingestion rate, raise `OUTBOX_MAX_DEPTH`.
### Absolute Rules
1. **Never open a public issue** for any bug that could misplace funds or break contract accounting invariants.
2. **Use GitHub Private Vulnerability Reporting** to reach core maintainers under confidential disclosure.
3. **Pre-v1.0 Unsupported Boundary**: Mainnet deployments prior to the v1.0 audited release are unsupported. All live operations must remain on Stellar Testnet.

---

## 6. Observability & Service Alerts Reference

Every Prometheus alert configured in `infra/observability/prometheus/rules/alerts.yml` links to a specific diagnosis and remediation procedure below:

| Alert Name | Severity | Service | Baseline Soak Target | Immediate Action |
|---|---|---|---|---|
| `IndexerEventLagHigh` | Warning (P2) | Indexer | P95 lag $\le 8.2\text{ s}$ | Check RPC responsiveness; inspect SQLite write queue |
| `IndexerEventLagCritical` | Critical (P1) | Indexer | P99 lag $\le 12.4\text{ s}$ | Inspect indexer logs; restart container if poller stalled |
| `IndexerLedgerLagCritical` | Critical (P1) | Indexer | Cursor delta $\le 1$ ledger | Re-fetch Soroban RPC cursor; restart indexer |
| `IndexerDBDepthGrowing` | Warning (P2) | Indexer | Queue drains $< 50$ items/batch | Ensure WAL mode active; allocate faster storage volume |
| `IndexerDBDepthCritical` | Critical (P1) | Indexer | Max burst depth observed $= 120$ | Force queue sync; follow `docs/INCIDENT_RUNBOOK.md` |
| `SorobanRPCErrorRateHigh` | Warning (P2) | RPC Client | Error rate $\le 0.04\%$ | If 429, adjust backoff; rotate RPC keys |
| `SorobanRPCErrorRateCritical` | Critical (P1) | RPC Client | Error rate $> 20\%$ | Total network disruption; failover to secondary RPC |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler | **0 divergences** across 10,000 txs | **Immediate containment**: Soroban state is truth; re-index |
| `ReconcilerJobStalled` | Critical (P1) | Reconciler | Run interval $= 60\text{ s}$ | Restart reconciler daemon container |
