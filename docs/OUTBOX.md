# Transactional Outbox (Issue #212)

The indexer's transactional outbox gives every downstream consumer (webhooks,
dashboards, analytics, reconciliation) a durable, replayable, dedupe-able view
of chain events. It lives entirely inside the indexer service
([indexer/src/outbox/](../indexer/src/outbox)) and reuses the existing SQLite
database, so no extra infrastructure is required.

## Delivery guarantee — read this precisely

**True exactly-once delivery is impossible end-to-end.** What this system
guarantees instead is:

1. **Delivery intents are never lost.** The event row and its delivery-intent
   rows are written in the *same SQLite transaction* as the ingestion write
   ([indexer/src/store.ts](../indexer/src/store.ts), `ingestWithinTransaction`).
   If ingestion commits, the intent to deliver exists; if the transaction
   rolls back, neither exists. There is no window where an event is stored but
   its delivery obligation is forgotten.
2. **Transport is at-least-once.** A dispatcher killed after a successful HTTP
   call but before recording the completion will re-deliver that intent after
   the claim times out. Consumers must therefore be idempotent.
3. **Duplicate deliveries are always detectable.** Every intent carries a
   stable `idempotency_key` (`<consumer_id>:<event_id>`), sent in the
   `Streampay-Idempotency-Key` header, and every journal row carries the same
   key plus a strictly monotonic `seq`. Two deliveries of the same logical
   event share the same key and the same seq.

Consumer contract for "effective exactly-once": persist `(idempotency_key,
seq)` on first application of an event and no-op on any delivery whose key was
already applied (or whose `seq` is not greater than your durable cursor for
that stream). With that dedupe step, at-least-once transport + never-lost
intents collapses to exactly-once *state application*.

## Schema

Created idempotently at startup by [OutboxStore](../indexer/src/outbox/store.ts):

| Table | Purpose |
|---|---|
| `outbox_events` | Append-only journal. `seq` (rowid, strictly monotonic per commit — the replay cursor), `idempotency_key` UNIQUE = event id, `ledger`, `ledger_cursor` (the ingestion RPC paging token), payload, and reorg tombstones (`retracted_at`, `retract_reason`). |
| `outbox_consumers` | Channel registry. `kind` = `push` (gets intents + dispatcher delivery) or `pull` (replays the journal via cursor), `url`/`secret` for push, `rate_limit_per_sec`, `max_attempts`. |
| `outbox_intents` | Per `(consumer, event)` delivery obligation. State machine `pending → in_flight → delivered | dead` with `attempts`, `next_retry_at`, `claimed_at`, `claim_token`. `idempotency_key` UNIQUE = `consumer:event`. |

State machine:

```
            claim (atomic, token-guarded)          transport 2xx
 pending ───────────────────────────────▶ in_flight ─────────────▶ delivered
   ▲   ▲                                     │
   │   │ claim timeout (crash reclaim)       │ non-2xx / error
   └───┴─────────────────────────────────────┤
   ▲                                          │ attempts ≥ max_attempts
   │ manual replay (dead-letter recovery)    ▼
   └───────────────────────────────────────  dead
```

All transitions are guarded UPDATEs (`WHERE state = ... AND claim_token = ...`),
so a resurrected or duplicate dispatcher can never corrupt another dispatcher's
bookkeeping — the second claim simply loses.

## Dispatcher

[OutboxDispatcher](../indexer/src/outbox/dispatcher.ts) polls every
`OUTBOX_TICK_MS` (default 1000):

- **Crash reclaim first**: `in_flight` intents whose `claimed_at` is older than
  `OUTBOX_CLAIM_TIMEOUT_MS` (default 60s) return to `pending`. This is what
  makes "killed mid-delivery" safe — nothing is stranded.
- **Per-consumer rate budget**: each tick claims at most
  `rate_limit_per_sec × tick_seconds` intents for that consumer (capped by
  `OUTBOX_BATCH_SIZE`, default 200, max 1000). Backpressure: setting
  `OUTBOX_MAX_DEPTH` makes the dispatcher refuse *all* new claims while
  `pending + in_flight` is above the threshold, instead of outrunning a dying
  downstream.
- **Retry with backoff + jitter** ([outbox/retry.ts](../indexer/src/outbox/retry.ts)):
  retry k sleeps `min(500ms × 2^(k-1), 30min)` with ±20% jitter.
- **Dead-letter after N attempts** (per-consumer `max_attempts`, default 8,
  reason `max_attempts`; reorg retractions dead-letter with reason
  `reorg_retracted`). Dead intents are visible via
  `GET /api/outbox/intents?state=dead` and resurrectable via
  `POST /api/outbox/intents/:id/replay`.
- **Poison-pill isolation**: claims and rate budgets are per consumer, so a
  consumer whose endpoint fails every attempt only dead-letters its own
  intents; healthy consumers keep draining on every tick. Verified by the
  chaos test *"a poison consumer dead-letters without blocking healthy
  consumers"*.

The default push transport ([outbox/http-transport.ts](../indexer/src/outbox/http-transport.ts))
POSTs the canonical sorted-key envelope with `Streampay-Signature` (same HMAC
scheme as [WEBHOOKS.md](./WEBHOOKS.md)), `Streampay-Idempotency-Key`,
`Streampay-Seq`, a 10s timeout, no redirect following, and the SSRF guard
applied to every URL.

## HTTP surface

| Endpoint | Purpose |
|---|---|
| `GET /streams/:id/events?after=<seq>&limit=<n>` | Cursor-based replay of the journal for a stream. Returns rows in ascending `seq` with `next_cursor` (null when empty page; poll again with the same cursor). Retracted rows are excluded. |
| `GET/POST /api/outbox/consumers`, `GET/DELETE /api/outbox/consumers/:id`, `POST .../status` | Channel registry. Push URLs pass the same SSRF validation as webhooks. |
| `GET /api/outbox/intents?state=&consumer=&limit=` | Intent visibility, incl. dead-letter queue. |
| `POST /api/outbox/intents/:id/replay` | Reset a dead intent to pending. |
| `POST /api/outbox/retract {after_ledger, reason}` | Reorg retraction hook (see below). |
| `GET /api/outbox/stats` | Depth by state, oldest-pending age, seq high-water. |
| `POST /api/outbox/flush` | Force one dispatcher tick (operational catch-up). |
| `GET /metrics` | Prometheus text exposition of the outbox gauges/counters below. |

Replay protocol for a pull consumer: store your last processed `seq` durably
→ `GET /streams/:id/events?after=<seq>` → apply rows in order, skipping keys
you already applied → advance cursor to `next_cursor`.

## Reorg safety

Every `outbox_events` row carries the ingestion ledger number **and** the
per-event RPC paging cursor (`ledger_cursor`), so intents can be traced back to
the exact ledger boundary they were committed at. When the dual-read
reconciliation service detects divergence above ledger `L`, it calls
`POST /api/outbox/retract {"after_ledger": L}`:

- Journal rows with `ledger > L` get `retracted_at`/`retract_reason` tombstones
  and disappear from replay feeds.
- Their `pending`/`in_flight` intents dead-letter with reason
  `reorg_retracted` (they must not be delivered — the events no longer exist
  on the canonical chain).
- Already-`delivered` intents are *not* revoked (the outbound call already
  happened); consumers learn of the retraction from the tombstoned journal and
  the divergence metric/alarm, then rebuild state from the surviving cursor.

The retraction is a single transaction and idempotent — replaying the same
boundary changes nothing.

## Observability

Emitted on `GET /metrics` (Prometheus text format, same hand-rolled exposition
style as `infra/indexer`):

| Metric | Type | Meaning |
|---|---|---|
| `streampay_outbox_depth{state=...}` | gauge | Intent count per state. |
| `streampay_outbox_lag_seconds` | gauge | Age of the oldest pending intent. |
| `streampay_outbox_dispatch_total{outcome=...}` | counter | delivered / retry / dead / stale / rejected_backpressure. |
| `streampay_outbox_reclaims_total` | counter | Claims reclaimed after crash/timeout. |
| `streampay_outbox_retracted_total` | counter | Journal events retracted by reconciliation. |
| `streampay_outbox_max_seq`, `streampay_outbox_events` | gauge | Journal high-water. |
| `streampay_outbox_divergence_alarm` | gauge | **Divergence alarm**: 1 while depth grows strictly monotonically over `OUTBOX_ALARM_WINDOW` consecutive tick samples (default 8) above `OUTBOX_ALARM_MIN_DEPTH` (default 1000) — i.e. the drain rate has durably fallen below the ingestion rate. Clears immediately on any drop. |

Alert rules live in
[`infra/observability/prometheus/rules/alerts.yml`](../infra/observability/prometheus/rules/alerts.yml)
(group `streampay_outbox_alerts`) with runbook procedures in
[`docs/RUNBOOK.md`](./RUNBOOK.md#5-transactional-outbox-alerts).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OUTBOX_TICK_MS` | 1000 | Dispatcher poll interval. |
| `OUTBOX_BATCH_SIZE` | 200 (≤1000) | Max claims per consumer per tick. |
| `OUTBOX_CLAIM_TIMEOUT_MS` | 60000 | Stale-claim reclaim threshold. |
| `OUTBOX_MAX_DEPTH` | off | Global backpressure threshold. |
| `OUTBOX_ALARM_WINDOW` | 8 | Consecutive growing samples for the divergence alarm. |
| `OUTBOX_ALARM_MIN_DEPTH` | 1000 | Minimum depth for the alarm to fire. |

## Verification

Chaos and load coverage runs in CI with the indexer suite
(`cd indexer && npm test` — [indexer/src/outbox/outbox.test.ts](../indexer/src/outbox/outbox.test.ts)):

- mid-transaction failure rolls back event rows, journal rows and intents
  together (atomicity);
- dispatcher killed mid-delivery → stale claims reclaimed, zero intents lost;
- two dispatcher connections draining the same file concurrently → no intent
  double-delivered (guarded claims);
- retry → backoff window honoured → dead-letter at `max_attempts`; manual
  replay resurrects dead intents;
- rate budget throttles a slow consumer while others drain; `OUTBOX_MAX_DEPTH`
  rejects claims under backlog;
- poison consumer dead-letters in isolation;
- reorg retract hides tombstoned rows from replay and dead-letters their
  pending intents; delivered intents survive as tombstones;
- cursor replay, consumer CRUD, DLQ, retract hook and `/metrics` over HTTP.

Load (measured on a developer laptop, WAL SQLite, in-process success
transport): ingesting and journalling 10,000 events took ≈ 2.7s; draining the
10,000-intent backlog took ≈ 3.5s (**≈ 2,900 intents/sec**), well inside the
~5s ledger cadence, so the outbox does not add steady-state lag at expected
ingestion rates.
