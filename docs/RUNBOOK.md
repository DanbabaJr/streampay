# ⚡ StreamPay Integrator & Operations Runbook

Comprehensive operational runbook and troubleshooting decision tree for StreamPay integrators, payroll operations teams, and on-call engineers.

This runbook carries an end-to-end worked example of onboarding a **50-employee payroll** onto Stellar Testnet, operating continuous streams through a full monthly cycle, and diagnosing issues across the contract, CLI, indexer, and RPC stack.

---

## Quick Reference: Alerts & Severities

| Alert Name                         | Severity          | Service        | Soak Baseline (Issue #27)                  | Runbook Link                                                         |
| ---------------------------------- | ----------------- | -------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `IndexerEventLagHigh`              | Warning (P2)      | Indexer        | P95 lag ≤ 8.2s (normal ~5s ledger)         | §4 decision tree                                                     |
| `IndexerEventLagCritical`          | Critical (P1)     | Indexer        | P99 lag ≤ 12.4s (max transient 25s)        | §4 decision tree                                                     |
| `IndexerLedgerLagCritical`         | Critical (P1)     | Indexer        | Steady-state lag ≤ 1 ledger                | §4 decision tree                                                     |
| `IndexerDBDepthGrowing`            | Warning (P2)      | Indexer        | Queue drains < 50 items/batch              | §4 decision tree                                                     |
| `IndexerDBDepthCritical`           | Critical (P1)     | Indexer        | Max burst depth observed = 120             | §4 decision tree                                                     |
| `SorobanRPCErrorRateHigh`          | Warning (P2)      | RPC Client     | Normal baseline error rate = 0.04%         | §4 decision tree                                                     |
| `SorobanRPCErrorRateCritical`      | Critical (P1)     | RPC Client     | Rate limit / node outage threshold > 20%   | §4 decision tree                                                     |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler     | **0 divergences** across 10,000 txs        | §4 decision tree                                                     |
| `ReconcilerJobStalled`             | Critical (P1)     | Reconciler     | Scheduled run interval = 60s               | §4 decision tree                                                     |
| `IndexerOutboxDepthDiverging`      | Critical (P1)     | Indexer Outbox | 10k-intent backlog drains in ~3.5s         | [#indexeroutboxdepthdiverging](#indexeroutboxdepthdiverging)         |
| `IndexerOutboxDeliveryLagHigh`     | Warning (P2)      | Indexer Outbox | Oldest pending intent < 5s at steady state | [#indexeroutboxdeliverylaghigh](#indexeroutboxdeliverylaghigh)       |
| `IndexerOutboxDeadLetterRateHigh`  | Warning (P2)      | Indexer Outbox | 0 dead letters for healthy endpoints       | [#indexeroutboxdeadletterratehigh](#indexeroutboxdeadletterratehigh) |
| `IndexerOutboxBackpressured`       | Warning (P2)      | Indexer Outbox | Never engages at soak ingestion rates      | [#indexeroutboxbackpressured](#indexeroutboxbackpressured)           |

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
7. [TTL-Sentinel Expiry Alert Triage](#7-ttl-sentinel-expiry-alert-triage)
   - [7.1 Decision tree](#71-decision-tree)
   - [7.2 Step 1: Verify the ledger view](#72-step-1--verify-the-ledger-view)
   - [7.3 Step 2: Re-scan and compare](#73-step-2--re-scan-and-compare)
   - [7.4 Step 3: Check for a recent extension](#74-step-3--check-for-a-recent-extension)
   - [7.5 Step 4: Recompute the rent estimate](#75-step-4--recompute-the-rent-estimate)
   - [7.6 Step 5: Escalate only on confirmed risk](#76-step-5--escalate-only-on-confirmed-risk)
   - [7.7 Worked example A: false positive](#77-worked-example-a--false-positive-stream-already-extended)
   - [7.8 Worked example B: real positive](#78-worked-example-b--real-positive-counter-near-its-4095-ledger-cliff)

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

### State snapshots: `streampay-state verify`

Before and after an upgrade or migration, export the contract's storage with the
`streampay-state` tool and verify the snapshot's invariants. Scripts and drills
should read its machine-readable report (`verify --format json`) rather than the
text output: the report shape is a versioned contract, with a published JSON
Schema and an additive-only compatibility policy, documented in
[`tools/streampay-state/README.md`](../tools/streampay-state/README.md).

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

| Symptom / Error Code                 | Diagnostic Command                                                                          | Root Cause                                                   | Immediate Fix                                                     | Escalation             |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------- |
| **Code 4: `DepositZero`**            | Inspect CSV `deposit_units` column                                                          | Deposit amount passed was 0 or negative                      | Set deposit to positive integer $> 0$.                            | Public issue / Ops fix |
| **Code 5: `InvalidDuration`**        | Inspect start/end parameters                                                                | Duration $< 60\text{ s}$ or $> 5\text{ years}$               | Adjust `days` parameter to valid range.                           | Public issue / Ops fix |
| **Code 6: `StartTimePast`**          | `date +%s` vs `start_time`                                                                  | Start timestamp is $> 300\text{ s}$ before ledger time       | Use CLI default (now $+ 60\text{ s}$).                            | Public issue / Ops fix |
| **Code 16: `InsufficientAllowance`** | `stellar contract invoke --id $TOKEN_ID -- allowance --from $SENDER --spender $CONTRACT_ID` | SAC token allowance lower than deposit                       | Execute `Token.approve` with sufficient amount and expiry ledger. | Ops fix                |
| **Code 22: `StreamNotActive`**       | `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`                   | Attempted withdrawal/top-up on cancelled or completed stream | Confirm stream ID. Stream is immutable once finalized.            | Ops fix                |

---

### Node B: Wallet & Signature Failures

| Symptom                                    | Diagnostic Command                                                                                                        | Root Cause                                                    | Immediate Fix                                                                  | Escalation            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| **`txBAD_SEQ` (Sequence Number Mismatch)** | `curl -s -X POST "$RPC_URL" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'` | Concurrent transactions submitted from same account           | Re-fetch source account sequence from Horizon/RPC before building transaction. | Ops retry             |
| **Simulation Rejection (HostError)**       | `streampay --contract $CONTRACT_ID --signer env --dry-run --json create ...`                                              | Soroban host rejected call during `simulateTransaction`       | Inspect `eventXdr` and simulation report error code.                           | Check Node A          |
| **Hardware Wallet Payload Mismatch**       | Compare `unsignedXdr` hash vs device prompt                                                                               | Signer mode `ledger` generated XDR modified before submission | Never modify unsigned XDR envelope. Submit raw signed XDR via `--signed-xdr`.  | Hardware wallet guide |
| **Missing Signer Permission**              | `stellar keys address env` vs contract governor                                                                           | Caller is neither sender, recipient, nor contract governor    | Switch signer to the authorized account address for that specific stream.      | Security boundary     |

---

### Node C: TTL & Storage Expiry Surprises

A TTL alert is a prediction from one RPC read, not proof of imminent expiry: before paging, work the [§7 TTL-sentinel triage decision tree](#7-ttl-sentinel-expiry-alert-triage).

Soroban state entries require rent maintenance. If an entry reaches its TTL cliff without renewal, reads fail. Preview the exact write-free extension plan with `node infra/ttl-sentinel/dist/src/cli.js extend --dry-run --json`; see the [sentinel README](../infra/ttl-sentinel/README.md#dry-run-report-mode).

| Symptom                                         | Diagnostic Command                                                                      | Root Cause                                          | Immediate Fix                                                                                   | Escalation          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| **`MissingValue` on active stream ID**          | `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`               | Data entry TTL expired due to sentinel gap          | Run `extend_footprint` on contract instance and entry key via TTL sentinel.                     | On-call P1          |
| **Sentinel Budget Alert (`BurnExceedsBudget`)** | `curl -s http://localhost:9095/metrics \| grep streampay_sentinel_burn_vs_budget_ratio` | Network rent surge or sudden influx of live streams | Increase sentinel treasury allocation or enable `expire-demo-first` degradation policy.         | Infrastructure Lead |
| **Poison Account in Renewal Queue**             | Check sentinel log: `Account quarantined`                                               | Deleted or malformed key blocking renewal batch     | Sentinel quarantines poison key automatically without stalling queue. Verify in health surface. | Issue #219 planner  |

---

### Node D: Index Discovery Gaps

| Symptom                                     | Diagnostic Command                                                                                                             | Root Cause                                       | Immediate Fix                                                           | Escalation      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- | --------------- |
| **Stream exists on-chain but absent in UI** | 1. `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`<br>2. `curl -s http://localhost:9090/streams/$ID` | Indexer event poller has lagged behind chain tip | Query `IndexerEventLag` metric; check if indexer cursor is advancing.   | Indexer Ops     |
| **Indexer cursor stalled > 5 ledgers**      | `curl -s http://localhost:9090/health`                                                                                         | Unhandled RPC exception or network disconnect    | Restart indexer daemon: `docker compose restart indexer`.               | Ops runbook § 1 |
| **SQLite DB locked (`SQLITE_BUSY`)**        | `lsof \| grep indexer.db`                                                                                                      | High-volume write contention without WAL mode    | Enable WAL mode: `sqlite3 /data/indexer.db "PRAGMA journal_mode=WAL;"`. | Ops runbook § 1 |

---

### Node E: Refund & Partial-State Confusion

| Symptom                                                       | Diagnostic Command                                                                                                                         | Root Cause                                              | Immediate Fix                                                                                                   | Escalation         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| **"Employee claimed they did not get full salary on cancel"** | Inspect contract events for `StreamCancelled` topic                                                                                        | Unaccrued remainder correctly refunded to employer      | Check accrual elapsed ratio: recipient receives `streamed - withdrawn`; unstreamed portion returns to employer. | Expected behavior  |
| **Contract balance mismatch (`ReconciliationDivergence`)**    | Run reconciler verification scan: `stellar contract invoke --id $CONTRACT_ID -- verify_treasury --token $TOKEN_ID --start_id 1 --limit 50` | Divergence between off-chain database and Soroban state | Soroban state is immutable source of truth. Re-index affected ledger range.                                     | **P0 Alert** (§ 5) |

---

### Node F: RPC Degradation & Throttling

| Symptom                           | Diagnostic Command                                          | Root Cause                                              | Immediate Fix                                                                          | Escalation           |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| **HTTP 429 Too Many Requests**    | Check response headers: `Retry-After`                       | Public Soroban RPC rate limit exceeded                  | Configure private RPC endpoint or increase backoff interval (`POLL_INTERVAL_MS=3000`). | Infra / RPC provider |
| **HTTP 503 / 502 Bad Gateway**    | `curl -I https://soroban-testnet.stellar.org`               | RPC node experiencing infrastructure downtime           | Failover to secondary RPC node provider.                                               | Infra failover       |
| **Transaction inclusion timeout** | `streampay --contract $CONTRACT_ID ...` returns exit code 5 | Ledger surge; transaction did not include in 10 ledgers | Query transaction status by hash before resubmitting to avoid duplicate creation.      | Soroban timeout      |

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

| Alert Name                         | Severity          | Service    | Baseline Soak Target                | Immediate Action                                            |
| ---------------------------------- | ----------------- | ---------- | ----------------------------------- | ----------------------------------------------------------- |
| `IndexerEventLagHigh`              | Warning (P2)      | Indexer    | P95 lag $\le 8.2\text{ s}$          | Check RPC responsiveness; inspect SQLite write queue        |
| `IndexerEventLagCritical`          | Critical (P1)     | Indexer    | P99 lag $\le 12.4\text{ s}$         | Inspect indexer logs; restart container if poller stalled   |
| `IndexerLedgerLagCritical`         | Critical (P1)     | Indexer    | Cursor delta $\le 1$ ledger         | Re-fetch Soroban RPC cursor; restart indexer                |
| `IndexerDBDepthGrowing`            | Warning (P2)      | Indexer    | Queue drains $< 50$ items/batch     | Ensure WAL mode active; allocate faster storage volume      |
| `IndexerDBDepthCritical`           | Critical (P1)     | Indexer    | Max burst depth observed $= 120$    | Force queue sync; follow `docs/INCIDENT_RUNBOOK.md`         |
| `SorobanRPCErrorRateHigh`          | Warning (P2)      | RPC Client | Error rate $\le 0.04\%$             | If 429, adjust backoff; rotate RPC keys                     |
| `SorobanRPCErrorRateCritical`      | Critical (P1)     | RPC Client | Error rate $> 20\%$                 | Total network disruption; failover to secondary RPC         |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler | **0 divergences** across 10,000 txs | **Immediate containment**: Soroban state is truth; re-index |
| `ReconcilerJobStalled`             | Critical (P1)     | Reconciler | Run interval $= 60\text{ s}$        | Restart reconciler daemon container                         |

---

## 7. TTL-Sentinel Expiry Alert Triage

The TTL sentinel ([`infra/ttl-sentinel/`](../infra/ttl-sentinel/README.md)) alerts on
severity *transitions* per storage-entry class. Every alert is a projection from
one `getLedgerEntries` read, so it can be wrong in five specific ways: the RPC
view was stale, the entry was extended after the read, another writer (a
contract write, or any operator's `ExtendFootprintTTL`) already did the work, the
rent model used the wrong fee curve, or the entry really is about to archive.
Work the tree in order and escalate only at step 5.

| Class | Worst-case cliff | Warn | Crit | Why the cliff is what it is |
|---|---:|---:|---:|---|
| `stream` / `index` | 200,000 ledgers | 150,000 | 60,000 | The contract extends on write with `extend_ttl(200_000, 500_000)`; a write at exactly the 200,000 threshold leaves exactly the cliff |
| `counter` / `instance` / `code` | 4,095 ledgers | 3,000 | 1,200 | `DataKey::NextStreamId`, the contract instance and the Wasm code entry are never extended on-chain, so they keep `min_persistent_entry_ttl - 1` |

At the 5 s protocol target the never-extended cliff is ≈5.7 hours, which is why
counter/instance/code alerts are the ones that matter most and also the ones
most often mis-attributed. The full derivation (and the 1 s/ledger worst-case
scan-gap margins) is in the sentinel README, "The math: true worst-case cliffs".

### 7.1 Decision tree

```text
TTL alert (console / JSONL / webhook)
   │
   ├─ 1. Is the ledger view current? ────────────────── no → stale RPC view:
   │      getLatestLedger advances; get_stream answers         false positive, stop
   │
   ├─ 2. Re-scan: is remainingLedgers still below the threshold? ─ no → already resolved:
   │      compare two scans ≥1 scan interval apart                       record and close
   │
   ├─ 3. Did something extend this entry since the alert? ──────── yes → false positive:
   │      remaining rose ~300k; observed cliff ≈500k;                 note who/when
   │      Horizon shows extend_footprint_ttl or an invoke
   │
   ├─ 4. Does the rent estimate match the planner's fee curve? ─── no → rent-model drift:
   │      compare scan --json .rent with `rent --streams N`               fix state size / sizes,
   │      at the configured state size                                    re-check; not an expiry risk
   │
   └─ 5. Remaining still below crit, no extension, reads still work → REAL RISK: escalate P1
```

### 7.2 Step 1 — Verify the ledger view

A cached or rate-limited RPC can serve an old `getLatestLedger`, which makes every
ETA and every "remaining" figure look worse than it is. Two reads must advance,
and the contract must answer a read call.

```bash
export RPC_URL="${TTL_SENTINEL_RPC_URL:-https://soroban-rpc.stellar.org}"
export CONTRACT_ID="${STREAMPAY_CONTRACT_ID:?export STREAMPAY_CONTRACT_ID first}"

# Two reads ten seconds apart: a frozen sequence means the view is stale.
for i in 1 2; do
  curl -s -X POST "$RPC_URL" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq -r '.result.sequence'
  sleep 10
done

# Prove the contract answers at all; a missing entry is the archive case, not a TTL warning.
stellar contract invoke --id "$CONTRACT_ID" --source "$STELLAR_SOURCE" --network testnet \
  -- get_stream --stream_id "${STREAM_ID:?export STREAM_ID first}"
```

If the sequence is frozen, fix the RPC path (see the RPC row in
[OPERATIONS.md](./OPERATIONS.md#32-ordered-failure-table-what-breaks-what)) and
re-run the sentinel before treating the alert as real. Do not escalate on a
stale view.

### 7.3 Step 2 — Re-scan and compare

Run the sentinel yourself, twice. It reads the same entries the alert did and
prints the exact fields the alert was built from.

```bash
cd infra/ttl-sentinel
npm ci
npm run build
node dist/src/cli.js scan --contract "$CONTRACT_ID" --rpc "$RPC_URL" --json > /tmp/ttl-scan-1.json

# Non-ok projections: the alerted entry, its class and the observed cliff per entry.
jq '.projections[] | select(.severity != "ok")
    | {id, cls, severity, remainingLedgers, observedCliffLedgers}' /tmp/ttl-scan-1.json

# Was the counter readable? A fallback scan cannot see streams created during downtime.
jq '{atLedger, usedCounterFallback: .report.usedCounterFallback, counterLive: .report.counter.present}' \
  /tmp/ttl-scan-1.json

sleep 60
node dist/src/cli.js scan --contract "$CONTRACT_ID" --rpc "$RPC_URL" --json > /tmp/ttl-scan-2.json

# remainingLedgers must fall by exactly (ledger2 - ledger1). A rise is an extension.
jq -s '[.[] | {atLedger, worst: (.projections | sort_by(.remainingLedgers) | first
    | {id, cls, severity, remainingLedgers, observedCliffLedgers})}]' \
  /tmp/ttl-scan-1.json /tmp/ttl-scan-2.json
```

Read the pair like this:

- **Fell by the ledger delta** — the projection is true; continue to step 3.
- **Rose, or `observedCliffLedgers` jumped from ≈200,000 to ≈500,000** — the entry
  was extended between scans. False positive; record what extended it and close.
- **`usedCounterFallback: true`** — the counter entry was unreadable, so the scan
  cannot enumerate streams created while it was down. Treat the count as a lower
  bound and check the counter entry itself before escalating.

### 7.4 Step 3 — Check for a recent extension

Two different things extend an entry, and only one of them is a Soroban
operation:

- a **contract write** (`create_stream`, `withdraw`, `top_up`, `cancel_stream`)
  calls `extend_ttl` internally — it appears on Horizon as `invoke_host_function`,
  and in the sentinel output as a higher `observedCliffLedgers`;
- an **out-of-band `ExtendFootprintTTL`** from any account (the protocol allows
  anyone to extend anyone's entry) — it appears as `extend_footprint_ttl`.

```bash
# Out-of-band extensions in the alert window. Horizon keeps roughly 24 h of history.
curl -s "https://horizon-testnet.stellar.org/operations?type=extend_footprint_ttl&order=desc&limit=200" \
  | jq --argjson since "$(($(date +%s) - 7200))" \
    '[._embedded.records[] | select((.created_at | fromdateiso8601) >= $since)
      | {created_at, source_account, extend_to, transaction_hash}]'

# Confirm the storage itself is intact and readable. Export is simulation-only; it signs nothing.
cargo run -q -p streampay-state -- export \
  --rpc "$RPC_URL" --contract "$CONTRACT_ID" --out /tmp/streampay-state.json
cargo run -q -p streampay-state -- verify --snapshot /tmp/streampay-state.json
jq '{latest_ledger, streams: (.streams | length), contract_frozen}' /tmp/streampay-state.json
```

If an extension landed for the alerted entry, this is a false positive: the
alert was true when it fired and was resolved by the extension. Nothing to
page. If `streampay-state verify` fails, that is a storage-consistency incident,
not a TTL one — follow [INCIDENT_RUNBOOK.md](./INCIDENT_RUNBOOK.md) instead.

### 7.5 Step 4 — Recompute the rent estimate

The alert answers "how long", not "how much". Rent only enters triage when the
budget alarm (`streampay_sentinel_burn_vs_budget_ratio`) or a `BurnExceedsBudget`
alert is in play, because a stale fee curve makes the planner look over budget
when it is not.

The model is the one in [`infra/ttl-sentinel/src/rent.ts`](../infra/ttl-sentinel/src/rent.ts)
(`rs-soroban-env` `fees.rs`, CAP-0066/protocol-23 values):

```text
rent_stroops = ceil(size_bytes × fee_per_1kb × ledgers / (1024 × 1215))
```

`fee_per_1kb` is 1,000 stroops on the floor, rises linearly to 10,000 at the 3 GB
live-state target, then grows 5× faster; code entries pay one third. Sizes are
measured, not guessed: 504 B per `Stream` entry, 92 B counter, 96 B instance,
136 + 12 × ids per index entry, and the Wasm size for the code entry. Those come
from `src/sizes.ts`; [`FOOTPRINT.md`](./FOOTPRINT.md) records the same entry at
484 B of ledger footprint (444 B value + 40 B key) — the sentinel measures the
whole `LedgerEntryData`, envelope included, which is why it prices at 504 B.
Both agree the `Stream` entry dominates per-stream cost.

[`src/planner.ts`](../infra/ttl-sentinel/src/planner.ts) turns that into a
schedule: candidates below `thresholdLedgers`, grouped by account, ≤ 50 keys per
transaction, priced as `rentStroops(size, extendTo - remaining, feePer1Kb)` plus
one `extensionOverheadStroops()` per key (the 48-byte TTL entry write), against a
600-ledger window, a 1,000 XLM treasury, a 50 XLM/day burn limit and an 85 %
alarm threshold. Rent is linear per ledger, so steady-state monthly upkeep is
`rent(size, ledgers in a month)` — it does not compound.

```bash
cd infra/ttl-sentinel

# Offline projection at the state size you believe the network is at.
node dist/src/cli.js rent --streams "${STREAM_COUNT:-1000}" \
  --state-size "${SOROBAN_STATE_BYTES:-0}" --json \
  | jq '{feePer1KbAtState: .rent.feePer1KbAtState, totalXlmAtState: .rent.totalXlmAtState,
         perStream: .rent.perStreamMonthlyXlmAtState}'

# What the last scan actually measured and priced.
jq '{feePer1KbAtState: .rent.feePer1KbAtState, rows: .rent.rows,
     totalXlmAtState: .rent.totalXlmAtState}' /tmp/ttl-scan-1.json
```

How to read the result:

- `feePer1KbAtState: 1000` is the floor. That is correct while live Soroban state
  is under ~2 GB, and it is what the README's 0.021 XLM/stream/month figure
  assumes.
- If the two runs disagree, the `sorobanStateSizeBytes` input is stale (or was
  taken from a different network). Fix the config and re-run; this is model
  drift, not an expiry risk. Do not raise the budget to match a stale curve.
- If the projection and the scan agree and burn still exceeds the monthly cap,
  the risk is financial, not archival: use the `expire-demo-first` degradation
  policy and the budget meter (`.spender.json`) instead of extending everything.

### 7.6 Step 5 — Escalate only on confirmed risk

Escalate when all of the following hold:

- the ledger view advances (step 1);
- two scans show `remainingLedgers` falling by exactly the ledger delta, below
  the class `critLedgers` (step 2);
- no extension landed in the window and `observedCliffLedgers` still equals the
  class cliff (step 3);
- the contract still answers reads, but the next write would fail once the entry
  archives.

That is a P1 by the [OPERATIONS escalation ladder](./OPERATIONS.md#42-escalation-hierarchy)
when the entry is `counter`, `instance` or `code` (< 1,200 ledgers), and a P2 for
a `stream`/`index` warning with days of runway. Attach both scan JSON files, the
Horizon window and the `streampay-state` snapshot to the incident.

Remediation is a TTL extension, not a rollback and not a redeploy:

```bash
cd infra/ttl-sentinel

# Dry run: prints the plan and submits nothing (extender.enabled=true in config).
node dist/src/cli.js extend --config ./ttl-sentinel.config.json --json

# Submit only after the plan looks right, with the funded key in the env var named
# by extender.secretKeyEnv (default TTL_SENTINEL_EXTENDER_SECRET).
node dist/src/cli.js extend --config ./ttl-sentinel.config.json --execute --json

# The instance and code entries have no storage key; extend them directly.
stellar contract extend --id "$CONTRACT_ID" --source-account "$STELLAR_SOURCE" \
  --network testnet --ledgers-to-extend 500000

# Only if the entry already archived: restore it first, then extend.
stellar contract restore --id "$CONTRACT_ID" --source-account "$STELLAR_SOURCE" \
  --network testnet
```

### 7.7 Worked example A — false positive (stream already extended)

The sentinel alerted on a stream, and a `withdraw` extended it before the
operator looked. Console output of the alert:

```text
[2026-11-18T09:12:04Z] FIRED WARN stream/stream:1841 remaining=149600 (~2.5d fastest) observed-cliff=200000 — below warn threshold: 149600 ledgers remain (live until 1479600)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=1330000
```

Step 2's second scan, eight ledgers after the first (≈40 s at 5 s/ledger):

```text
[2026-11-18T09:37:10Z] RESOLVED OK stream/stream:1841 remaining=499840 (~28.9d fastest) observed-cliff=500000 — monitoring: 499840 ledgers remain (live until 1829840)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=1330008
```

`remaining` rose by 350,240 and `observed-cliff` moved from 200,000 to 500,000:
the entry was written while the alert was in flight, so `extend_ttl` bumped it to
the 500,000-ledger target. Step 3 found the corresponding contract write and no
out-of-band extension. False positive; the sentinel's own `RESOLVED` transition
is the record. No page, no extension, no budget spend.

### 7.8 Worked example B — real positive (counter near its 4,095-ledger cliff)

The counter entry is never extended on-chain, so its whole life is 4,095 ledgers
from creation. A critical alert:

```text
[2026-11-19T02:40:11Z] FIRED CRIT counter/counter remaining=1180 (~98m fastest) observed-cliff=4095 — below critical threshold: 1180 ledgers remain (live until 451180)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=450000
```

Step 2, 5 minutes (60 ledgers) later:

```text
[2026-11-19T02:45:20Z] RE-ALERT CRIT counter/counter remaining=1120 (~93m fastest) observed-cliff=4095 — below critical threshold: 1120 ledgers remain (live until 451180)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=450060
```

`remaining` fell by exactly 60, `observed-cliff` is still 4,095, step 3 found no
extension, and `get_stream` still answers. The projection is true. Once this
entry archives, `create_stream` fails until it is restored — a P1. Dry-run the
extender, then extend; the send raises the cliff to the configured `extendTo`
(500,000), and the next scan emits the matching `RESOLVED` transition.

---
