# StreamPay Event Indexer

> **Running this against testnet or mainnet?** The development notes below are
> not an operations runbook. Configuration (every env var), initial backfill from
> a chosen ledger, catch-up after downtime, outbox replay and shutdown semantics
> are in [docs/INDEXER_OPERATIONS.md](../docs/INDEXER_OPERATIONS.md).

The StreamPay Event Indexer is a standalone TypeScript Node.js service that polls Soroban RPC `getEvents` for StreamPay smart contract events, decodes the contract's typed XDR event payloads using `@stellar/stellar-sdk`, persists stream metadata and an append-only event log in SQLite, maintains cursor persistence, and serves a lightweight HTTP query API.

The service indexes the contract's emitted event topics: `stream_created`, `withdrawn`, `stream_cancelled`, and `stream_topped_up` (the Rust event types are `StreamCreated`, `Withdrawn`, `StreamCancelled`, and `StreamToppedUp`). It also recognizes `stream_paused` and `stream_resumed` for forward-compatible status updates. Unknown topics are filtered out at RPC.

---

## 1. Prerequisites

- **Node.js**: `v22.0.0` or higher
- **npm**: `v10+` or `v11+`

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `RPC_URL` | `https://soroban-testnet.stellar.org` | Stellar Soroban RPC URL |
| `CONTRACT_ID` | Required | StreamPay contract address (`C...`) |
| `POLL_INTERVAL_MS` | `5000` | Delay between polls (minimum 250 ms) |
| `PORT` | `8787` | HTTP listen port |
| `DATABASE_PATH` | `./data/streampay.sqlite` | SQLite database file |
| `START_LEDGER` | Latest RPC ledger | Initial ledger sequence if starting fresh without a saved cursor |
| `OUTBOX_TICK_MS` | `1000` | Transactional-outbox dispatcher poll interval |
| `OUTBOX_BATCH_SIZE` | `200` | Max intent claims per consumer per tick (cap 1000) |
| `OUTBOX_CLAIM_TIMEOUT_MS` | `60000` | Stale-claim reclaim threshold (crash recovery) |
| `OUTBOX_MAX_DEPTH` | off | Global backpressure threshold for pending+in-flight intents |
| `SHUTDOWN_DRAIN_MS` | `10000` | On SIGTERM/SIGINT, how long in-flight ingest and outbox dispatch may finish before the process exits (exit code `0` if drained, `1` if the window expired). Keep it below your orchestrator's kill grace period |

This table is the short version. [docs/INDEXER_OPERATIONS.md §1](../docs/INDEXER_OPERATIONS.md#1-configuration) explains each variable's behaviour, its validation, the ingest/RPC knobs read by the config code (`INGEST_*`, `RPC_MAX_RPS`, `RPC_URL_FALLBACK_n`), and deployment profiles.

---

## 2. How to Run Locally

### Installation & Build

```bash
cd indexer
npm install
npm run typecheck
npm test
npm run build
npm start
```

### Running with Environment Variables

The service reads `.env` when your shell/environment loader provides it; Node does not load `.env` automatically. For example, on PowerShell:

```powershell
$env:RPC_URL = "https://soroban-testnet.stellar.org"
$env:CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4"
$env:PORT = "8787"
npm start
```

Or on Linux / macOS:

```bash
export RPC_URL="https://soroban-testnet.stellar.org"
export CONTRACT_ID="<YOUR_TESTNET_CONTRACT_ADDRESS>"
npm start
```

---

## 3. Database Persistence & Restarts

The SQLite database stores:
- **`streams` table**: Latest materialized state per stream (`stream_id`, `sender`, `recipient`, `deposit`, `withdrawn`, `status`, cancel amounts).
- **`events` table**: Append-only log of every received event (`id`, `stream_id`, `name`, `ledger`, `ledger_closed_at`, `payload`).
- **`indexer_state` table**: Persisted `cursor` and `lastLedger`.

Repeated events are safe and idempotent: event IDs are unique, preventing double-counting across service restarts.

---

## 4. HTTP API Reference

### Health Check
`GET /health`

```json
{
  "ok": true,
  "status": "ok",
  "lastLedger": "123456",
  "cursor": "0000000123456"
}
```

### Real-Time Event Stream (Server-Sent Events)
`GET /events/stream[?address=<address>][&streamId=<id>][&lastEventId=<id>]`

Streams live contract events as Server-Sent Events (`text/event-stream`). Supports address scoping, specific stream filtering, and resumption via `Last-Event-ID` header or query parameter. Emits heartbeat `: ping\n\n` frames every 15s.

```http
id: 0000000123456-00001
event: stream_created
data: {"id":"0000000123456-00001","streamId":"1","eventType":"stream_created","ledger":123456,"data":{...},"stream":{...}}
```

### Recipient Stream Query (Frontend discovery)
`GET /streams?recipient=<address>`

Returns all streams for the given recipient address. Returns `[]` if none found.

```json
[
  {
    "streamId": "1",
    "id": "1",
    "sender": "G...",
    "recipient": "G...",
    "token": "C...",
    "deposit": "1000000",
    "withdrawn": "250000",
    "status": "active"
  }
]
```

### Stream Event History
`GET /streams/:id/history`

Returns the full event log for a stream ID in ledger sequence order. Returns `[]` if not found.

```json
[
  {
    "id": "event-1",
    "stream_id": "1",
    "event_type": "stream_created",
    "ledger": 100,
    "payload": { ... }
  },
  {
    "id": "event-2",
    "stream_id": "1",
    "event_type": "withdrawn",
    "ledger": 105,
    "payload": { ... }
  }
]
```

### Stream Details by ID
`GET /streams/:id`

Returns the latest indexed projection, or `404` if not found:

```json
{
  "streamId": "7",
  "sender": "G...",
  "recipient": "G...",
  "token": "C...",
  "deposit": "1000000",
  "withdrawn": "250000",
  "status": "active",
  "lastLedger": 123456,
  "updatedAt": "2026-01-01T00:00:00Z"
}
```

### Streams by Address
`GET /address/:addr/streams`

Returns streams where the address is sender or recipient:

```json
{
  "address": "G...",
  "count": 1,
  "streams": [...]
}
```

---

### GraphQL Read API (persisted queries only)
`POST /graphql` — body `{ "queryId": "<id>", "variables": { ... }, "tenant": "<tenant>" }`.
Only allowlisted persisted queries run; ad-hoc `query` text, unknown
`queryId`s and `GET /graphql` are rejected with `400`. Responses are
GraphQL-shaped `{ "data": { ... } }` (or `{ "data": null, "errors": [...] }`).

`GET /graphql/schema` — returns the schema SDL as plain text.

Available persisted queries (`indexer/src/graphql/persisted.ts`):

| queryId | What it returns |
|---|---|
| `GetStream` | One stream by id (all scalar fields) |
| `GetStreamWithForecast` | Stream + `forecast(at)` |
| `GetStreamWithRelations` | Stream + sender/recipient `Address` nodes + first 10 events |
| `GetStreamHistory` | `streamHistory` event connection (offset cursor) |
| `GetStreamEvents` | `streamEvents` outbox connection (reuses the outbox `seq` cursor from `GET /streams/:id/events`) |
| `GetStreamsByRecipient` | Streams for a recipient (cursor connection) |
| `GetAddressStreams` | `Address` node with its streams |
| `GetForecast` | `Forecast` for one stream at a time |
| `ListWebhookSubscriptions` | Webhook endpoints (never includes the secret) |

Types: `Stream` (with `senderAddress`/`recipientAddress` relations, `events`,
`forecast`), `Address`, `Event`, `Forecast` (linear streamed accrual:
`accrued = deposit * elapsed / duration`, floored — the same math as
`frontend/lib/analytics.ts`), `WebhookSubscription`, and cursor connections
(`edges { node cursor }`, `pageInfo { hasNextPage nextCursor }`).

Limits: query depth ≤ 5, complexity ≤ 80 (checked at boot — an allowlisted
query that exceeds them fails startup), per-tenant token-bucket rate budget
(default 600 complexity units/minute; exhaustion returns `429` with
`retryAfter`). Privacy redaction (#487) is shared with REST via
`src/redaction.ts`: set `GRAPHQL_REDACT_ADDRESSES=1` (or pass
`redactAddresses: true` to `createApp`) and Stellar addresses are truncated
to their 8-character prefix on the GraphQL path exactly as the helper does
for REST rows; webhook URLs are masked and secrets are never exposed.

To add a persisted query: add an entry to `PERSISTED_QUERIES` in
`src/graphql/persisted.ts`, keep it inside the depth/complexity limits, and
add a contract test in `src/graphql.test.ts` asserting it matches the REST
response for the same fixture. The freshness-gate test asserts every
`Stream` field in the SDL exists on the `Stream` projection, so schema
drift fails CI.

```bash
curl -X POST localhost:8787/graphql \
  -H 'Content-Type: application/json' \
  -d '{"queryId":"GetStream","variables":{"id":"1"}}'
```

---

### Transactional Outbox

Every ingested event is journalled with a monotonic `seq` and per-consumer
delivery intents inside the same database transaction, giving consumers a
replayable, dedupe-able, at-least-once event feed. Full contract and
guarantees: [docs/OUTBOX.md](../docs/OUTBOX.md).

- `GET /streams/:id/events?after=<seq>&limit=<n>` — cursor-based replay (`next_cursor` included)
- `GET/POST /api/outbox/consumers` — push/pull channel registry
- `GET /api/outbox/intents?state=dead` — outbox dead-letter queue
- `POST /api/outbox/intents/:id/replay` — resurrect a dead intent
- `POST /api/outbox/retract` — reorg retraction hook (reconciler)
- `GET /api/outbox/stats` — depth by state and replay high-water
- `GET /metrics` — Prometheus exposition (`streampay_outbox_*`)

---

### Event Shapes Come From the Schema Registry

The names and fields this indexer decodes are not hand-maintained here: they
are generated from the contract's `#[contractevent]` structs into
`src/generated/events.ts` by `npm run generated:events` (source of truth:
[`schemas/events/`](../schemas/events/README.md), issue
[#213](https://github.com/Neziahtech/streampay/issues/213)).

- `decodeEvent` validates every registry-known event: the positional topic
  count must match the registry and each declared data field must be present,
  so a contract/registry drift surfaces as a decode error naming the schema
  file instead of silently indexing a half-shaped stream row.
- Extra data keys are tolerated — the registry evolves additively, and old
  indexers keep working against a newly upgraded contract.
- `src/registry.test.ts` asserts the generated table matches the committed
  `schemas/events/registry.json` field-for-field.

---

## 5. Testing

Run all unit, decoder, database, and integration tests:

```bash
npm test
```

---

## 6. Horizontal Sharding (issue #578)

The indexer can partition ingestion and projections by stream-id range so
throughput scales beyond a single node. The implementation lives in
`src/sharding/` (`ShardMap`, `ShardedStore`, `ShardRebalancer`, metrics)
and is covered by `src/sharding.test.ts`. The single-node `StreamStore` is
unchanged: one shard *is* a `StreamStore`, and all of its guarantees
(duplicate detection by event id, monotonic projection, transactional
outbox) are reused per shard.

### Shard map

Stream ids are numeric (`u64`, e.g. `"7"`). The id space is cut into
contiguous blocks of `rangeSize` ids (default 1000) — `[0, 1000)`,
`[1000, 2000)`, … — assigned round-robin to shards: block `k` belongs to
shard `k % shardCount` by default. A block is the unit of movement, and a
single stream id belongs to exactly one block, so a shard boundary can
never split a single stream's event order.

```ts
import { ShardedStore } from "./sharding/index.js";
const store = new ShardedStore({ shardCount: 4, rangeSize: 1000 });
// or one SQLite file per shard:
const fileStore = new ShardedStore({ shardCount: 4, basePath: "./data/shard" });
//   -> ./data/shard-shard-0.sqlite, ./data/shard-shard-1.sqlite, …
```

- **Routing:** every event is routed by its stream id; a stream's events
  always land in the same shard, in ledger order. `ShardedStore` keeps one
  `IngestSequencer` (seeded from the merged `maxLedgerByStream()` of all
  shards) so per-stream ordering and ledger-gap detection (#117 / #483)
  are reported across shards, exactly as on a single node.
- **Stream-less events** (`streamId === null`) go to the designated shard
  0 (`STREAMLESS_SHARD`); they touch no projection, as before.
- **Non-numeric stream ids** (e.g. `batch_withdraw_summary`, published
  keyed by a recipient address) are placed by an FNV-1a hash of the id, so
  they are still deterministic and still land on exactly one shard.
- **Global state:** `ShardedStore` implements the pipeline's `IngestSink`
  (`ingestPage`, `getState`, `setState`, `maxLedgerByStream`), so
  `IngestPipeline` runs unchanged on top of it. Global keys (`cursor`,
  `lastLedger`, `ingest_ledger`) live on shard 0, the coordinator shard.

### Cross-shard reads

Single-stream reads (`getStream`, `getStreamHistory`, per-stream outbox
replay) route to exactly one shard. Address portfolios (`listAddress`,
`listStreamsByRecipient`, `listAllStreams`) fan out to all shards, dedup
by stream id (keeping the highest `lastLedger`), and merge in one stable
order: numeric stream ids ascending, then non-numeric ids
lexicographically. `getEventsAfter` merges the per-shard journals in
`(ledger, id)` order and dedups by event id.

`listAddressPaged(address, { limit, cursor })` pages that same total
order, so a cursor handed out before a rebalance still addresses the same
position afterwards, and re-reading a cursor returns the same page.

Exactly-once outbox (#212) holds per shard (journal + intents in the same
transaction, `idempotency_key` unique) and across shards: merged outbox
reads (`listOutboxEvents`) dedup by `idempotency_key`, so a row a rebalance
transiently leaves on two shards is delivered once.

### Rebalancer

```ts
import { ShardRebalancer } from "./sharding/index.js";
const rebalancer = new ShardRebalancer(store);
// Move the block [1000, 2000) to shard 2, checkpointing every 5 streams.
rebalancer.startMove(1000n, 2, { batchSize: 5 });
// After a crash, resume every incomplete move from its checkpoint:
rebalancer.resumeAllIncomplete();
```

A move runs in five steps: **copy** the block's streams, events, outbox
journal rows and outbox intents to the target in batches (all copies
idempotent — `INSERT OR IGNORE` / monotonic upsert, and outbox intents are
re-pointed at the target's own `seq` values); **catch-up** re-copy passes
until a pass inserts nothing new; **verify** stream ids, event ids and
per-stream `lastLedger` match between source and target (on mismatch the
move fails *without* switching the map, so the source stays
authoritative); **switch** the shard-map override for the block (the
commit point); **delete** the source copy.

Checkpoints are durable: after every batch the move's checkpoint
(`shard_move:<moveId>` in shard 0's `indexer_state` table) records the
last copied stream id, streams/events copied, and totals. A crash at any
point — including a full node loss and reopen of file-backed databases —
resumes from that checkpoint: already-copied streams are skipped, the
move proceeds to switch/delete, and the result has no lost or duplicated
streams or events (`sharding.test.ts` covers this end to end, including a
close + reopen mid-move).

The move runs synchronously in one JS turn, so no ingestion can interleave
between verify and switch in-process. Known limitations, see below.

### Metrics

```ts
import { collectShardingMetrics, renderShardingMetricsPrometheus } from "./sharding/index.js";
const metrics = collectShardingMetrics(store, { tipLedger: latestLedger });
renderShardingMetricsPrometheus(metrics);
```

Per shard: stream/event/outbox counts, `lastLedger` (highest projected
ledger on that shard), and `lag` (`tipLedger - lastLedger`, when a tip is
supplied). Prometheus gauges: `streampay_shard_streams`,
`streampay_shard_events`, `streampay_shard_last_ledger`,
`streampay_shard_lag_ledgers`, plus `streampay_rebalance_events_copied` /
`streampay_rebalance_streams_copied` per move. `ShardRebalancer.progress(moveId)`
reports ranges moved/total, events/streams copied, and the current
checkpoint for an in-flight move.

### Limitations / follow-ups

- **Webhook deliveries are not moved.** They are per-endpoint dispatch
  state, not projections; moving them would risk duplicate sends and
  deleting them would lose pending deliveries. They stay on the source
  shard. If a moved stream's pending webhook deliveries must follow it,
  that needs a dispatch-aware migration.
- **Multi-process write fence.** In-process the synchronous move makes
  verify → switch → delete atomic w.r.t. ingestion. A deployment with
  several indexer processes writing the same shard databases would need a
  distributed lock / write fence for the moving range during that window.
- **No HTTP wiring yet.** The sharding layer is a library (`ShardedStore`
  as the pipeline sink); the HTTP server in `src/index.ts` still uses a
  single `StreamStore`, and there is no `/metrics` sharding endpoint or
  operator CLI for moves yet. Wiring those up is the natural follow-up.
