# Indexer Operations Guide: Configuration, Backfill and Replay

Audience: an operator running `indexer/` against testnet or mainnet. The
[service README](../indexer/README.md) covers local development and the HTTP
API; this guide covers the knobs, the startup/restart procedures, and what the
service actually does when it is behind, interrupted or poisoned.

Every configuration key and procedure below is taken from the code, not from
intent. The relevant paths:

| Concern | Source of truth |
|---|---|
| Env var parsing, defaults, startup order, shutdown | [`indexer/src/index.ts`](../indexer/src/index.ts) |
| Ledger windows, resume position, gap/reorder accounting | [`indexer/src/ingest/pipeline.ts`](../indexer/src/ingest/pipeline.ts), [`indexer/src/ingest/planner.ts`](../indexer/src/ingest/planner.ts), [`indexer/src/ingest/sequencer.ts`](../indexer/src/ingest/sequencer.ts) |
| Idempotent journal, monotonic projection, state keys | [`indexer/src/store.ts`](../indexer/src/store.ts) |
| Outbox schema, claims, dead letters | [`indexer/src/outbox/store.ts`](../indexer/src/outbox/store.ts), [`indexer/src/outbox/dispatcher.ts`](../indexer/src/outbox/dispatcher.ts), [`indexer/src/outbox/retry.ts`](../indexer/src/outbox/retry.ts) |
| RPC failover, token bucket, endpoint health | [`indexer/src/rpc-manager.ts`](../indexer/src/rpc-manager.ts) |
| Spans and trace correlation | [`indexer/src/telemetry.ts`](../indexer/src/telemetry.ts) |
| Outbox contract and guarantees | [`docs/OUTBOX.md`](./OUTBOX.md) |
| Ingestion design and benchmark | [`docs/INDEXER_INGEST.md`](./INDEXER_INGEST.md) |

---

## 1. Configuration

### 1.1 Every variable shipped in `indexer/.env.example`

These are the variables the maintainers ship as the reference environment
([`indexer/.env.example`](../indexer/.env.example)). Node does **not** load
`.env` by itself — `npm start` runs `node dist/index.js` with no dotenv loader,
so export the variables in the process environment or pass `--env-file`.

| Variable | Default | Read at | Behaviour |
|---|---|---|---|
| `RPC_URL` | `https://soroban-testnet.stellar.org` | boot | Primary Soroban RPC endpoint. The first endpoint in the manager's pool. |
| `CONTRACT_ID` | **required** | boot | StreamPay contract (`C...`). Used both as the `getEvents` contract filter and as the proof-endpoint contract id. Missing value throws `CONTRACT_ID is required` and the process exits. |
| `POLL_INTERVAL_MS` | `5000` | boot | Delay between ingestion ticks. Values below `250` throw `POLL_INTERVAL_MS must be at least 250`. |
| `PORT` | `8787` | boot | HTTP listen port (`app.listen`). No host flag: the server binds the default address, so put a proxy in front of it rather than exposing it directly. |
| `DATABASE_PATH` | `./data/streampay.sqlite` | boot | SQLite file. The parent directory is created if missing. The connection sets `journal_mode = WAL` and `busy_timeout = 5000`. |
| `START_LEDGER` | unset (start at tip) | boot, then once per tick | Ledger to begin from **on a fresh database**. Must match `^\d+$` or boot throws `START_LEDGER must be an integer ledger sequence`; `0` and empty are treated as unset. Ignored once a resume position exists — see §2. |
| `OUTBOX_TICK_MS` | `1000` | boot | Outbox dispatcher interval. Also the divisor that turns a consumer's `rate_limit_per_sec` into a per-tick claim budget. |
| `OUTBOX_BATCH_SIZE` | `200` | boot | Max intents claimed per consumer per tick, hard-capped to `1000`. Must be a positive integer or boot throws. |
| `OUTBOX_CLAIM_TIMEOUT_MS` | `60000` | each dispatcher tick | Age after which an `in_flight` intent is reclaimed to `pending`. This is the crash-recovery window: a killed dispatcher can delay redelivery by up to this value. |
| `OUTBOX_MAX_DEPTH` | unset (off) | each dispatcher tick | Global backpressure. While `pending + in_flight >= OUTBOX_MAX_DEPTH` the dispatcher claims nothing and reports `rejected_backpressure`. `0` is rejected at boot (positive integer required), so disable by leaving it unset. |
| `OUTBOX_ALARM_WINDOW` | `8` | boot | Consecutive depth samples that must grow for `streampay_outbox_divergence_alarm` to fire. |
| `OUTBOX_ALARM_MIN_DEPTH` | `1000` | boot | Minimum depth before the divergence alarm can fire. |
| `CHECKPOINT_SIGNER_SECRET` | unset → `Keypair.random()` | boot | Signs `/streams/:id/proof`. Without it a throwaway key is generated **per process**, so clients cannot pin the key across restarts and `/health` reports a different `checkpointSigner` every boot. Set it for any real deployment. |
| `NETWORK_PASSPHRASE` | `Networks.TESTNET` | boot | Passphrase used when building the proof checkpoint. Testnet: `Test SDF Network ; September 2015`. Mainnet: `Public Global Stellar Network ; September 2015`. |

Validation style matters operationally: `POLL_INTERVAL_MS`, `CONTRACT_ID` and
`START_LEDGER` are checked with explicit messages; the `OUTBOX_*` integers go
through `envInt`, which throws `"<NAME> must be a positive integer"`. A typo in
any of them is a boot failure, not a silent default.

### 1.2 Variables read by the config code but not shipped in `.env.example`

These are real (`indexer/src/index.ts`) and safe to set; they are simply absent
from the example file.

| Variable | Default | Effect |
|---|---|---|
| `RPC_URL_FALLBACK_1` … `RPC_URL_FALLBACK_5` | unset | Additional endpoints in the manager pool. Loop stops at the first gap: setting only `_2` leaves the pool at primary + `_2`. |
| `RPC_MAX_RPS` | `10` | Global token bucket. The bucket holds `2 × RPC_MAX_RPS` tokens and refills at `RPC_MAX_RPS/1000` per ms. This is the ceiling the ingester's in-flight depth is derived from; raising `INGEST_MAX_IN_FLIGHT` cannot exceed it. |
| `INGEST_PAGE_LIMIT` | `1000` | `getEvents` page size, and the target events-per-window when sizing windows. |
| `INGEST_WINDOW_LEDGERS` | `20` | Cold-start window floor, before density is measured. |
| `INGEST_MAX_WINDOW_LEDGERS` | `5000` | Ceiling on an adaptive window. A very sparse backlog with a tight ceiling takes several ticks to reach the tip. |
| `INGEST_MAX_WINDOWS_PER_TICK` | `200` | Windows planned per tick; on the serial path, requests per tick. |
| `INGEST_MAX_IN_FLIGHT` | `8` | Ceiling the budget-derived concurrency may be lowered to. Never raises the budget. |
| `INGEST_CONFIRMATIONS` | `0` | Ledgers withheld from the tip (`0` is accepted here, unlike `envInt`). Use only if your endpoint advertises a tip it has not finished indexing. |
| `INGEST_MAX_PAGES_PER_WINDOW` | `8` | Pages a single dense window may consume before it commits a partial range. |
| `INGEST_PARALLEL` | enabled | `0` pins the pipeline to the legacy serial cursor walk. This is the rollback switch for ingestion. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP traces endpoint; `/v1/traces` is appended if absent. Export is fire-and-forget: failures are swallowed, so a dead collector never stalls ingestion — and never tells you it is dead either. |

### 1.3 Minimal profiles

```bash
# Testnet, full history from the contract's first event
CONTRACT_ID=C...
RPC_URL=https://soroban-testnet.stellar.org
START_LEDGER=1234567

# Mainnet, production hardening
CONTRACT_ID=C...
RPC_URL=https://<primary>
RPC_URL_FALLBACK_1=https://<secondary>
RPC_MAX_RPS=10
OUTBOX_MAX_DEPTH=5000
OUTBOX_ALARM_WINDOW=8
OUTBOX_ALARM_MIN_DEPTH=1000
CHECKPOINT_SIGNER_SECRET=S...
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
DATABASE_PATH=/var/lib/streampay/indexer.sqlite
```

`NETWORK_PASSPHRASE` affects only the proof checkpoint. It does not select the
network you poll — `RPC_URL` and `CONTRACT_ID` do. A mainnet deployment pointed
at a testnet RPC will index nothing and report no error.

---

## 2. Initial backfill from a chosen ledger

`START_LEDGER` is consulted on the first tick of a **fresh** database. The
resume position is the `indexer_state` key `ingest_ledger`, written after every
proven-complete window. Precedence in `runTick`:

```text
position = indexer_state['ingest_ledger']
if position exists            -> start = position + 1          (START_LEDGER ignored)
else if legacy 'cursor' exists -> serial cursor walk for one tick (pre-windowing DB migration)
else                          -> start = max(1, START_LEDGER ?? current tip)
```

Procedure:

1. Stop the service and confirm no process holds the database.
2. Choose a ledger **at or before the contract's first event**. Starting later is
   a deliberate, permanent hole — see §4.
3. Point `DATABASE_PATH` at a new file (or move the old one aside). This is the
   step that makes `START_LEDGER` authoritative; an existing database with an
   `ingest_ledger` value ignores it.
4. Start the service and watch the backlog close:

   ```bash
   curl -s localhost:8787/api/ingest/stats | jq '{caughtUp: .lastTick.caughtUp, resumeAt: .lastTick.resumeAt, requests: .lastTick.requests, windows: .lastTick.windowsCommitted, windowLedgers: .lastTick.windowLedgers}'
   ```

What a backfill looks like while it runs:

- The first tick has no density estimate, so it plans at most **4** wide windows
  (`PROBE_WINDOWS`) to sample the range instead of grinding one configured
  window at a time. `windowLedgers` on the tick report is the size it actually
  used, which is usually far larger than `INGEST_WINDOW_LEDGERS`.
- Subsequent ticks size windows from the durable `ingest_density` EWMA so each
  window holds roughly one page of events. `windowLedgers` shrinking or growing
  between ticks is normal adaptation, not instability.
- Concurrency starts at 1 and widens within the tick as the RPC manager measures
  latency; `maxInFlightObserved` shows the real reorder depth it reached.
- `caughtUp` is `false` until the last planned window reaches the tip. A plan
  truncated by `INGEST_MAX_WINDOWS_PER_TICK` also reports `caughtUp: false` —
  that is progress, not lag. Judge progress by `resumeAt` increasing.
- Every window is committed in a single SQLite transaction together with its
  event rows, outbox journal rows and delivery intents. Killing the process
  mid-backfill loses at most the in-flight windows, which are re-read.

To bound the backfill's blast radius, lower `RPC_MAX_RPS` rather than
`INGEST_MAX_IN_FLIGHT`: the depth is derived from the budget, so the budget is
the only knob that actually throttles endpoint load.

---

## 3. Catch-up after downtime

The durable position advances only over ledgers **proven** complete, so a
restart resumes exactly where the last committed window ended:

1. `runTick` reads the tip, computes `start = ingest_ledger + 1`, and tiles
   `[start .. tip - INGEST_CONFIRMATIONS]` into disjoint, contiguous windows.
2. It commits them in plan order through a reorder buffer, no matter which read
   answers first.
3. After each window it rewrites `ingest_ledger` and the density estimate.

Consequences an operator should expect:

- **A long outage is a backlog, not a special mode.** A 150k-ledger gap is closed
  by wide windows, not 150k requests. Watch `requests` per tick and `resumeAt`.
- **A lagging endpoint cannot silently skip ledgers.** A short page only proves a
  window complete if that endpoint's own `latestLedger` is at or past the
  window's upper bound. Otherwise the tick commits only up to the endpoint's tip,
  sets `caughtUp: false`, and logs:

  ```text
  [indexer] tick stopped at ledger <N> with a lagging endpoint or dense window; resuming next tick
  ```

  The next tick re-plans the remainder. This is expected when a fallback endpoint
  is behind; it is not data loss.
- **Ticks do not overlap.** `pollSafely` guards with an in-process flag, so a tick
  that outlives `POLL_INTERVAL_MS` simply delays the next one. A slow tick is
  visible as a flat `resumeAt` and a large `durationMs`, not as queue growth.
- **Rate pressure is backpressure, not failure.** When the bucket is empty the
  pipeline waits (up to 4 budget waits, each capped at 5 s) rather than
  hammering the endpoint; the manager raises `RATE_EXHAUSTED` with a
  `retryAfterMs` hint that the pipeline honours.
- **`confirmations` is a lag knob, not a safety knob.** `getEvents` only reports
  closed ledgers, so `0` is correct for stock RPC endpoints.

---

## 4. Gaps: what they mean and how to close one

There is exactly one way the pipeline creates a hole, and it is deliberate: you
told it to start after the history you wanted. Everything else is designed to
prevent one:

- Windows are disjoint and contiguous, so no ledger inside a plan is skipped.
- A window that cannot be proven complete is not committed, and the position
  does not move past it.
- `events.id` (a `ledger-tx-op-event` triple) is the journal's primary key with
  `INSERT OR IGNORE`, so a re-read boundary cannot double-count.

The sequencer counts what it sees anyway. `gapLedgers` and `gapWindows` on
`/api/ingest/stats` increment when a committed window starts past
`contiguousThrough + 1` — i.e. the process was handed a resume point that skips
ledgers. They are cumulative per process, so restart resets them to `0` while
the hole itself persists. That is why the durable position is the thing to
inspect, not just the counter.

Causes and responses:

| Cause | Symptom | Response |
|---|---|---|
| `START_LEDGER` above the contract's first event | `streams` rows missing for early IDs; `GET /streams/:id` 404 for old streams | Re-backfill from a lower ledger — see below. |
| `indexer_state` restored from a different/newer snapshot than `streams`/`events` | `gapLedgers > 0` right after boot | Restore a consistent backup of the whole file, not just a table. |
| RPC refuses a `startLedger` older than its history retention | Tick errors (`Indexer poll failed:`), `resumeAt` stuck | Use an endpoint with deeper history, or re-backfill from within retention. |
| Legitimate chain reorg above a ledger | Divergence from the reconciler, `reorg_retracted` dead letters | Use `POST /api/outbox/retract` — see §6.4. |

Re-indexing a range is safe because ingestion is idempotent end to end: event
rows are `INSERT OR IGNORE` on the event id, outbox journal rows are
`INSERT OR IGNORE` on the same key, delivery intents are unique per
`consumer:event`, and the stream projection refuses to move backwards
(`WHERE excluded.last_ledger >= streams.last_ledger`). SSE subscribers are only
notified for events that were newly journalled, so a re-read does not replay to
live clients.

Offline procedure to force a re-read (stop the service first):

```bash
# 1. Back up the database including WAL — use sqlite's own backup, not cp
sqlite3 "$DATABASE_PATH" ".backup 'indexer-backup-$(date +%Y%m%dT%H%M%S).sqlite'"

# 2. Move the windowed position back one ledger before the hole,
#    and drop the density estimate so windows re-probe.
sqlite3 "$DATABASE_PATH" <<'SQL'
UPDATE indexer_state SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = 'ingest_ledger';
DELETE FROM indexer_state WHERE key = 'ingest_density';
SQL

# 3. Start, then confirm the position advances and gaps stop accruing
curl -s localhost:8787/api/ingest/stats | jq '.lastTick.resumeAt, .sequencer.gapLedgers'
```

Set the value to the exact ledger *before* the first missing one if you know it.
Do not delete the database to "reset" a running deployment: that discards the
outbox journal and its undelivered intents as well.

A database written by a pre-windowing indexer has `cursor` but no `ingest_ledger`.
Its first tick runs the serial cursor walk to migrate, then records a windowed
position; no operator action is required.

---

## 5. Outbox: why downstream delivery is safe to retry

The precise guarantee is in [docs/OUTBOX.md](./OUTBOX.md): **true end-to-end
exactly-once delivery is impossible**, and the system does not pretend
otherwise. What it gives you is:

1. **Intents are never lost.** The event row, the outbox journal row and one
   delivery intent per active push consumer are written inside the *same* SQLite
   transaction as the stream projection
   (`ingestPage` → `ingestWithinTransaction` → `enqueueWithinTransaction`). If
   the transaction commits, the obligation to deliver exists; if it rolls back,
   neither exists. There is no "event stored, intent forgotten" window.
2. **Transport is at-least-once.** A dispatcher killed after a `2xx` but before
   recording success redelivers after `OUTBOX_CLAIM_TIMEOUT_MS`. Consumers must
   be idempotent.
3. **Duplicates are always detectable.** Each intent carries
   `idempotency_key = <consumer_id>:<event_id>`, sent as
   `Streampay-Idempotency-Key`, alongside the journal's monotonic
   `Streampay-Seq`. Two deliveries of one logical event share both.

At-least-once transport plus never-lost intents plus consumer-side
`(idempotency_key, seq)` dedupe collapses to **exactly-once state application**
— which is the property to design consumers against.

Mechanics worth knowing when paging:

- **Claims are atomic and token-guarded.** `claimIntent` only succeeds while the
  row is `pending`; `markDelivered` and `recordFailure` only apply to the
  matching `claim_token`. Two dispatchers on the same file cannot both deliver
  one intent — the loser reports `stale`.
- **Reclaim runs first on every tick**, before new claims, so crash recovery is
  not starved by fresh work.
- **Retry backoff**: retry `k` waits `min(500 ms × 2^(k-1), 30 min)` with ±20%
  jitter. The first retry is immediate, the second waits ~500 ms.
- **Dead-letter** happens when attempts reach the consumer's `max_attempts`
  (default `8`) with reason `max_attempts`, or on a reorg retraction with reason
  `reorg_retracted`.
- **Poison isolation is per consumer**: each active push consumer has its own
  claim budget of `rate_limit_per_sec × OUTBOX_TICK_MS/1000` (capped by
  `OUTBOX_BATCH_SIZE`), so one dead endpoint only dead-letters its own intents.
- **A new push consumer starts from "now".** Intents are created at ingest time,
  so registering a push consumer does not backfill history. To backfill, register
  a `pull` consumer and replay the journal: `GET /streams/:id/events?after=<seq>`
  per stream, advancing to `next_cursor`.
- **Webhooks are a separate queue** (`webhook_deliveries` / `webhook_dead_letter`,
  `GET /api/webhooks/dlq`, `POST /api/webhooks/dlq/:id/retry`). Do not confuse
  its DLQ with the outbox dead-letter list.

---

## 6. Replay and recovery procedures

### 6.1 Inspect before you act

```bash
curl -s localhost:8787/api/outbox/stats | jq
curl -s 'localhost:8787/api/outbox/intents?state=dead&limit=50' | jq '.[] | {id, consumer_id, event_id, event_seq, attempts, dead_reason, last_error}'
curl -s localhost:8787/api/outbox/consumers | jq '.[] | {id, kind, status, url, max_attempts, rate_limit_per_sec}'
```

`dead_reason` separates the two cases that need opposite responses:

- `max_attempts` — the endpoint failed. Fix the endpoint first, then replay.
- `reorg_retracted` — the events no longer exist on the canonical chain. Do
  **not** replay them; reconcile from the retraction boundary (§6.4).

### 6.2 Replay a dead letter

```bash
curl -s -X POST localhost:8787/api/outbox/intents/<intent_id>/replay | jq
```

The endpoint resets the intent to `pending` with `next_retry_at = 0`, so the next
dispatcher tick claims it. This HTTP route is the replay tool that has landed;
there is no separate CLI binary in the repository.

**Caveat that surprises operators:** replay does **not** reset `attempts`. A
replayed intent keeps its count, so one more failure immediately dead-letters it
again (`attempts + 1 >= max_attempts`). Replay is therefore "one more delivery
attempt", not "a fresh retry budget". If you need a longer grace period, fix the
consumer's `max_attempts` (or recreate the consumer) rather than replaying in a
loop.

### 6.3 Drain and retry in bulk

```bash
# Force one dispatcher tick instead of waiting for OUTBOX_TICK_MS (operational catch-up)
curl -s -X POST localhost:8787/api/outbox/flush | jq

# Replay every dead intent for one consumer (inspect first — see 6.1)
curl -s 'localhost:8787/api/outbox/intents?state=dead&consumer=<consumer_id>&limit=500' \
  | jq -r '.[].id' \
  | while read -r id; do curl -s -X POST "localhost:8787/api/outbox/intents/$id/replay"; echo; done
```

If a consumer is degraded, disable it before replaying so its backlog does not
mask healthy channels, then re-enable:

```bash
curl -s -X POST localhost:8787/api/outbox/consumers/<id>/status -H 'content-type: application/json' -d '{"status":"disabled"}'
curl -s -X POST localhost:8787/api/outbox/consumers/<id>/status -H 'content-type: application/json' -d '{"status":"active"}'
```

### 6.4 Reorg retraction

When the reconciler detects divergence above ledger `L`:

```bash
curl -s -X POST localhost:8787/api/outbox/retract \
  -H 'content-type: application/json' \
  -d '{"after_ledger": L, "reason": "reorg"}'
```

Journal rows with `ledger > L` get tombstones and disappear from replay feeds;
their `pending`/`in_flight` intents dead-letter as `reorg_retracted`; already
`delivered` intents are not revoked, because the outbound call already happened.
The retraction is one transaction and idempotent. Then let ingestion re-read the
canonical range (§4) before consumers rebuild from the surviving cursor.

### 6.5 Replay a pull consumer from its own cursor

```bash
seq=0
while :; do
  page=$(curl -s "localhost:8787/streams/<stream_id>/events?after=$seq&limit=500")
  count=$(jq '.events | length' <<<"$page")
  [ "$count" -eq 0 ] && break
  # apply .events in order, skipping idempotency_key values already applied
  seq=$(jq -r '.next_cursor' <<<"$page")
done
```

Poll again with the same cursor when `next_cursor` is `null`: that means an empty
page, not the end of the journal.

---

## 7. Shutdown, restart and drain semantics

Shutdown is **fast, not graceful**. On `SIGINT` or `SIGTERM` the handler calls
`dispatcher.stop()`, `outboxDispatcher.stop()`, `store.close()` and
`process.exit(0)`. It does not wait for an in-flight ingestion tick, an in-flight
HTTP delivery, or open SSE connections.

What that means for each queue:

| In flight at shutdown | Outcome |
|---|---|
| Ingestion window | Its SQLite transaction either committed or did not. The position moves only with the commit, so the next boot re-reads what was lost. Safe. |
| SSE connections | Dropped. Clients must reconnect with `Last-Event-ID` (or `?lastEventId=`) to resume. |
| Webhook delivery | Rows stay due in `webhook_deliveries`; the dispatcher picks them up on the next tick after restart. |
| Outbox delivery | An intent left `in_flight` is reclaimed on the first dispatcher tick after `OUTBOX_CLAIM_TIMEOUT_MS` elapses — a redelivery, not a loss. Consumers dedupe. |

Restart checklist:

1. Send `SIGTERM` and wait for the process to exit; confirm no other process
   holds the database.
2. Back up with `sqlite3 "$DATABASE_PATH" ".backup '...'"` — copying the file
   without the `-wal`/`-shm` can lose the most recent commits.
3. Start the service and verify, in order:
   ```bash
   curl -s localhost:8787/health | jq '{ok, lastLedger, cursor, signer: .checkpointSigner, ingest: {caughtUp: .ingest.lastTick.caughtUp, resumeAt: .ingest.lastTick.resumeAt}}'
   curl -s localhost:8787/api/ingest/stats | jq '{serial: .lastTick.serial, healthy: .budget.healthyEndpoints, tokens: .budget.availableTokens, gaps: .sequencer.gapLedgers}'
   curl -s localhost:8787/api/outbox/stats | jq
   curl -s localhost:8787/metrics | grep -E 'streampay_outbox_(depth|lag_seconds|reclaims_total)'
   ```
4. Expect `caughtUp: false` while the backlog drains; expect
   `streampay_outbox_reclaims_total` to be non-zero once after a hard kill.
5. If `checkpointSigner` changed and you did not set
   `CHECKPOINT_SIGNER_SECRET`, clients pinning the old key will reject proofs.

`serial: true` on the first tick after boot is expected for a pre-windowing
database (the migration), and permanent if `INGEST_PARALLEL=0`.

---

## 8. Troubleshooting by emitted name

Two rules before the table: the service has **no structured logger** — it emits
OTLP spans plus `console` lines — and `GET /metrics` serves **only** the outbox
series. Ingestion and RPC health are on `/health` and `/api/ingest/stats`, not on
Prometheus. Alert rules that reference `streampay_indexer_*` series therefore
describe a different exporter; do not expect those names on this port.

| Emitted name | Kind | Where | Meaning / action |
|---|---|---|---|
| `Indexer poll failed:` | console error | `index.ts` | A tick threw. The wrapped message names the cause; see the specific rows below. Ingestion keeps running on the next interval. |
| `[indexer] tick stopped at ledger <N> …` | console warn | `index.ts` | `caughtUp: false`. A lagging endpoint cut the window, or a window hit `INGEST_MAX_PAGES_PER_WINDOW`. Next tick resumes at `N`; if it never advances, check `rpcEndpoints[].latestLedger`. |
| `ledger <N> holds more than <X> events; raise INGEST_PAGE_LIMIT or INGEST_MAX_PAGES_PER_WINDOW` | tick error | `pipeline.ts` | A single ledger is denser than one window's page budget, so committing would skip the rest of it. Raise one of the two knobs. The position is unchanged. |
| `rate budget did not free up after 4 waits` | tick error | `pipeline.ts` | `availableTokens` stayed at 0 across the retry budget. Lower `INGEST_MAX_WINDOWS_PER_TICK`, lower `RPC_MAX_RPS` contention from other callers, or raise `POLL_INTERVAL_MS`. |
| `RPC rate budget exhausted; retry after ~N ms` (`code: RATE_EXHAUSTED`) | thrown by manager | `rpc-manager.ts` | Normal backpressure. The pipeline waits `retryAfterMs` (capped at 5 s) and retries; only escalates if waits are exhausted (row above). |
| `RpcManager: no healthy endpoints available` | tick error | `rpc-manager.ts` | Every endpoint is marked unhealthy (3 consecutive failures each). Check `rpcEndpoints` on `/health`. Recovery is automatic: a down endpoint is re-probed 30 s after being marked unhealthy. |
| `[RpcManager] <url> failure (<reason>); failure count: <n>` | console warn | `rpc-manager.ts` | One failure recorded. Three in a row removes the endpoint from rotation. `reason` carries HTTP status, `HTTP 429 rate limited`, or the RPC error message. |
| `[RpcManager] <url> is lagging <N>s behind tip` | console warn | `rpc-manager.ts` | Approximate lag, computed as `(bestLedger − endpoint.latestLedger) × 5 s`; warns above 60 s. The endpoint stays in the pool but is deprioritised, and its short pages stop windows early (see the tick-stopped row). |
| `Outbox dispatch tick failed:` | console error | `outbox/dispatcher.ts` | A dispatcher tick threw (typically SQLite). Intents stay `pending`/`in_flight`; the next tick retries. If it repeats, check disk and WAL health. |
| `Webhook dispatch loop error:` | console error | `webhooks/dispatcher.ts` | The legacy webhook loop threw. Independent of the outbox; deliveries remain queued. |
| `Failed to queue webhook delivery for event:` | console error | `store.ts` | Webhook enqueue failed *inside* an ingestion transaction. The outbox intent still committed; only the legacy webhook queue missed the event. |
| `indexer.ingest_event` (span, `CONSUMER`) | OTLP span | `telemetry.ts` / `store.ts` | One span per event, attributes `event.name`, `ledger.sequence`, `soroban.tx_hash`, `stream.id`, plus a link to the originating trace when one was correlated. `status.code = ERROR` carries `exception.message`. |
| `indexer.db_write` (span, `INTERNAL`) | OTLP span | `store.ts` | Child of the ingest span covering the row write, outbox enqueue and projection. Its error status is the one to alert on for store faults. |
| `streampay_outbox_depth{state="…"}` | gauge | `/metrics` | Intent count per state. `pending` + `in_flight` sustained growth is the divergence condition. |
| `streampay_outbox_lag_seconds` | gauge | `/metrics` | Age of the oldest pending intent. Alert above 60 s; check a slow consumer's `rate_limit_per_sec`. |
| `streampay_outbox_dispatch_total{outcome="…"}` | counter | `/metrics` | `delivered` / `retry` / `dead` / `stale` / `rejected_backpressure`. `stale` climbing means claims are being reclaimed (timeouts or a second dispatcher). `rejected_backpressure` means `OUTBOX_MAX_DEPTH` engaged. |
| `streampay_outbox_reclaims_total` | counter | `/metrics` | Claims reclaimed after a crash or timeout. Non-zero after a hard kill is expected; a steady climb means deliveries exceed `OUTBOX_CLAIM_TIMEOUT_MS`. |
| `streampay_outbox_retracted_total` | counter | `/metrics` | Journal events tombstoned by reorg reconciliation. Cross-check with the reconciler's report before replaying anything. |
| `streampay_outbox_divergence_alarm` | gauge | `/metrics` | `1` while depth grows strictly monotonically for `OUTBOX_ALARM_WINDOW` samples above `OUTBOX_ALARM_MIN_DEPTH`. Clears on any drop. |
| `streampay_outbox_max_seq`, `streampay_outbox_events` | gauge | `/metrics` | Journal high-water markers. A frozen `max_seq` with a moving chain tip means ingestion, not delivery, has stalled. |
| `/health` → `ingest.lastTick` | JSON | `/health` | The last `TickReport`, including `ok`, `error`, `caughtUp`, `resumeAt`, `duplicates`, `projectionSkips`, `lateEvents`, `gapLedgers`. |
| `/api/ingest/stats` → `budget` | JSON | route | `availableTokens: 0` explains rate waits; `healthyEndpoints: 0` explains total RPC failure; `hedgedReads: true` means each read can cost two endpoint requests. |
| `/api/ingest/stats` → `sequencer` | JSON | route | `lateEvents` > 0 is the reorder window doing its job (the projection guard rejected an older event). `gapLedgers` > 0 is a resume-point hole and needs §4. |

Diagnostic order that resolves most pages: `/health` (`ok`, `caughtUp`,
`resumeAt`) → `/api/ingest/stats` (`error`, `budget`) → `/api/outbox/stats`
(`dead`, `pending`) → `/metrics` (outbox trend) → the console lines above.

---

## 9. Cross-references

- Delivery contract, schema and state machine: [docs/OUTBOX.md](./OUTBOX.md).
- Why parallel windows produce the same database as the serial walk, and the
  measured throughput: [docs/INDEXER_INGEST.md](./INDEXER_INGEST.md).
- Outbox alert runbooks: [docs/RUNBOOK.md](./RUNBOOK.md#5-transactional-outbox-alerts).
- Webhook signatures and SSRF rules: [docs/WEBHOOKS.md](./WEBHOOKS.md).
- Light-client checkpoint proofs: [docs/SECURITY_LIGHT_CLIENT.md](./SECURITY_LIGHT_CLIENT.md).
- Whole-system operations handbook: [docs/OPERATIONS.md](./OPERATIONS.md).
- Development setup and HTTP API: [indexer/README.md](../indexer/README.md).

---

## 10. What was verified for this guide

| Claim | Verified against |
|---|---|
| Env var names, defaults, validation and boot order | `indexer/.env.example`, `indexer/src/index.ts` (`run`, `envInt`, `envNonNegativeInt`, `configuredStartLedger`) |
| `START_LEDGER` precedence and the legacy-cursor migration | `IngestPipeline.runTick` / `runSerial` in `indexer/src/ingest/pipeline.ts` |
| Window sizing, probe ticks, budget-derived depth | `indexer/src/ingest/planner.ts`, `/api/ingest/stats` fields in `indexer/src/index.ts` |
| Gap accounting and late-event classification | `indexer/src/ingest/sequencer.ts` |
| Idempotent journal, monotonic projection, `indexer_state` keys | `indexer/src/store.ts` |
| Outbox atomicity, claims, backoff, dead-letter, replay semantics (including the preserved `attempts` count) | `indexer/src/outbox/store.ts`, `dispatcher.ts`, `retry.ts` |
| Rate budget, failover thresholds, warning strings | `indexer/src/rpc-manager.ts` |
| Span names, link attributes and OTLP export behaviour | `indexer/src/telemetry.ts`, `indexer/src/store.ts` |
| Shutdown order | signal handler in `indexer/src/index.ts` |
| Metric and endpoint names | `indexer/src/outbox/metrics.ts`, routes in `indexer/src/index.ts` |
