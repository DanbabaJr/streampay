# StreamPay Reconciler Service

Continuous state reconciliation and truth verification daemon for StreamPay. It periodically compares off-chain indexed data against on-chain Soroban contract state (`get_stream`, `treasury_status`, `verify_treasury`) to ensure what users see in the interface is mathematically and provably true.

## Metrics Exposed

The service exposes Prometheus metrics on `/metrics` (default port `9091`):

- `streampay_reconciliation_divergences_total` (Counter): total discrepancies found between off-chain and on-chain state, labeled by `check_type` (`stream_status`, `stream_balance`, `treasury_balance`, `missing_record`) and `severity`.
- `streampay_reconciler_divergence_current` (Gauge): count of active unacknowledged state discrepancies.
- `streampay_reconciler_check_duration_seconds` (Histogram): time taken to perform a full reconciliation sweep.
- `streampay_reconciler_last_run_timestamp_seconds` (Gauge): unix epoch timestamp of the latest completed sweep.
- `streampay_reconciler_items_audited_total` (Counter): cumulative count of verified streams and treasury accounts.
- `streampay_reconciler_rpc_requests_total` (Counter): RPC requests made by reconciler.
- `streampay_reconciler_rpc_errors_total` (Counter): RPC errors encountered during audits.

## Endpoints

- `GET /metrics` - Prometheus text exposition format
- `GET /health` / `GET /healthz` - Health probe
- `GET /divergences` - List active detected divergences
- `POST /reconcile` - Trigger an immediate reconciliation audit
- `POST /fault/divergence` - Inject synthetic divergence for testing
- `POST /fault/stall` - Simulate reconciler daemon stall
- `POST /fault/rpc-error` - Inject Soroban RPC errors
- `POST /fault/reset` - Clear all faults and active divergences
