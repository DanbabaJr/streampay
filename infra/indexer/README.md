# StreamPay Indexer Service

Event indexer service for StreamPay Soroban contracts with built-in Prometheus metrics instrumentation and fault injection for chaos testing.

## Metrics Exposed

The service exposes Prometheus metrics on `/metrics` (default port `9090`):

- `streampay_indexer_event_lag_seconds` (Histogram): per-source and per-topic event ingestion lag in seconds (buckets: `0.5`, `1`, `2.5`, `5`, `10`, `15`, `30`, `60`, `120`, `300`).
- `streampay_indexer_ledger_lag` (Gauge): number of ledgers the indexer cursor is behind the chain tip.
- `streampay_indexer_latest_ledger` (Gauge): highest ledger processed by the indexer.
- `streampay_chain_tip_ledger` (Gauge): highest known ledger on the network.
- `streampay_indexer_db_depth` (Gauge): counts of persisted entities (`streams`, `events`) and uncommitted items.
- `streampay_indexer_db_queue_backlog` (Gauge): number of events in memory awaiting persistence to SQLite.
- `streampay_indexer_rpc_requests_total` (Counter): total RPC requests by endpoint, method, and status.
- `streampay_indexer_rpc_errors_total` (Counter): total RPC errors by endpoint, method, and HTTP status code.
- `streampay_indexer_events_processed_total` (Counter): total events ingested by topic.
- `streampay_indexer_sync_status` (Gauge): 1 when synchronized, 0 when lagging.

## Endpoints

- `GET /metrics` - Prometheus text exposition format
- `GET /health` / `GET /healthz` - Health probe
- `GET /streams` - List indexed streams
- `GET /streams/:id` - Query stream by ID
- `POST /fault/lag` - Inject artificial event ingestion lag
- `POST /fault/cursor-lag` - Inject ledger cursor lag
- `POST /fault/backlog` - Inject SQLite write backlog
- `POST /fault/rpc-error` - Inject Soroban RPC error rate
- `POST /fault/reset` - Reset all active faults
