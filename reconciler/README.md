# StreamPay Dual-Read Reconciliation Service

Dual-read reconciliation service that compares stream states from **Horizon** (classic-bridge effects) against **Soroban RPC** contract state, accounts for consistency lag windows, and emits structured logs and webhooks on state divergence to detect index corruption or RPC failure.

Integrates with the **Issue #2 indexer dashboard withdrawal panel** via webhook dispatch.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Horizon       │     │   Soroban RPC   │     │  Reconciliation │
│   Reader        │     │   Reader        │     │   Engine        │
│   (effects)     │     │   (contract     │     │   (diff.js)     │
│                 │     │    state)       │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Alerting Module         │
                    │  (Structured Logs +      │
                    │   Webhook Dispatch)      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Indexer Dashboard       │
                    │  (Issue #2 - webhook)    │
                    └──────────────────────────┘
```

### Components

| Component | File | Responsibility |
|-----------|------|----------------|
| Horizon Reader | `src/readers/horizon.js` | Polls Horizon API for classic-bridge effects related to StreamPay streams |
| Soroban RPC Reader | `src/readers/soroban.js` | Queries Soroban RPC `getContractData` for current contract storage state |
| Reconciliation Engine | `src/engine/diff.js` | Compares both sources, applies consistency lag window, detects divergences |
| Alerting Service | `src/alerting.js` | Structured JSON logging + webhook dispatch to indexer dashboard |

---

## Environment Variables

Create a `.env` file in `reconciler/` (copy from `.env.example`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HORIZON_URL` | Yes | `https://horizon-testnet.stellar.org` | Horizon API endpoint |
| `HORIZON_API_TOKEN` | No | — | Optional Horizon API token |
| `SOROBAN_RPC_URL` | Yes | `https://soroban-testnet.stellar.org/rpc` | Soroban RPC endpoint |
| `SOROBAN_RPC_TOKEN` | No | — | Optional Soroban RPC token |
| `WEBHOOK_URL` | Yes | `http://localhost:8080/webhooks/reconciler` | Indexer dashboard webhook endpoint (Issue #2) |
| `CONSISTENCY_WINDOW_MS` | No | `30000` | Maximum acceptable lag between Horizon and Soroban data (ms) |
| `POLL_INTERVAL_MS` | No | `5000` | Delay between reconciliation polls (ms) |
| `LOG_LEVEL` | No | `INFO` | `DEBUG\|INFO\|WARN\|ERROR` |
| `ENVIRONMENT` | No | `testnet` | Deployment environment tag |
| `RECONCILER_ID` | No | `primary-001` | Unique instance identifier for multi-instance deployments |
| `CONTRACT_ID` | No | — | StreamPay Soroban contract ID |
| `STREAM_IDS` | No | — | Comma-separated stream IDs to monitor |

---

## Consistency Lag Window Behavior

The reconciliation engine applies a **consistency lag window** to tolerate temporary asynchrony between Horizon and Soroban RPC:

| Scenario | Behavior |
|----------|----------|
| Both sources agree | No alert; logged as `INFO` |
| Sources disagree, but timestamps within `CONSISTENCY_WINDOW_MS` | Treated as expected lag; logged as `WARN`, no webhook |
| Sources disagree, timestamps outside `CONSISTENCY_WINDOW_MS` | Divergence detected; logged as `ERROR`; webhook dispatched |
| Stream missing from Horizon only | Warning (likely indexing delay) |
| Stream missing from Soroban only | Critical (potential index corruption) |

Default `CONSISTENCY_WINDOW_MS=30000` (30 seconds) reflects typical Horizon indexing lag on Stellar testnet.

---

## Structured Log Format

All logs are emitted as JSON to stderr:

```json
{
  "timestamp": "2026-10-16T16:20:32.123Z",
  "service": "streampay-reconciler",
  "level": "ERROR",
  "message": "Stream 123 divergence detected",
  "details": {
    "streamId": "123",
    "checkType": "stream_balance",
    "indexedValue": {"deposit": "1000", "withdrawn": "200"},
    "onChainValue": {"deposit": "1000", "withdrawn": "500"},
    "lagMs": 45000,
    "webhookSent": true,
    "webhookResponse": {"status": 200, "message": "Alert delivered"}
  }
}
```

Fields: `timestamp`, `service`, `level`, `message`, `details`.

---

## Webhook Payload

Webhooks are dispatched to `WEBHOOK_URL` when a **critical** divergence is detected:

```json
{
  "alert": {
    "type": "stream_divergence",
    "severity": "critical",
    "timestamp": "2026-10-16T16:20:32.123Z",
    "source": "reconciler",
    "data": {
      "streamId": "123",
      "divergenceType": "stream_balance",
      "horizonState": {"deposit": "1000", "withdrawn": "200"},
      "sorobanState": {"deposit": "1000", "withdrawn": "500"},
      "lagMs": 45000,
      "consequence": "index_corruption"
    }
  },
  "metadata": {
    "version": "1.0.0",
    "environment": "testnet",
    "reconcilerId": "primary-001"
  }
}
```

This feeds into the **Issue #2 indexer dashboard withdrawal panel** for operator visibility.

---

## Setup Commands

### Local Development

```bash
# Install dependencies
cd reconciler
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your Horizon URL, Soroban RPC URL, and webhook target

# Typecheck
npm run typecheck

# Run unit tests
npm test

# Run the service
npm start

# Run the soak test (injects stale RPC data to trigger divergence alarm)
npm run soak
```

### Docker Deployment

```bash
# Start reconciler and indexer
docker compose up -d

# View logs
docker compose logs -f reconciler

# Stop
docker compose down
```

---

## Testing

### Unit Tests (`tests/diff.test.js`)

Covers four scenarios:

1. **Perfectly in-sync states** — both sources agree, no alerts
2. **Out-of-sync within consistency lag window** — treated as expected lag, no divergence
3. **True state divergence outside lag window** — triggers ERROR + webhook
4. **Missing or malformed data edge cases** — stream missing from either source, missing deposit fields, status-only mismatches

```bash
npm test
```

### Soak Test (`tests/soak-test.js`)

Deliberately injects stale Soroban RPC responses to trigger real divergence alarms. Tests various delay scenarios and prints a PR-ready report.

```bash
npm run soak
```

Expected scenarios:
- Baseline: both sources fresh and in sync → no divergences
- Soroban delay within window (15s) → no divergences (expected lag)
- Soroban delay outside window (45s) → divergence detected
- Horizon delay causing apparent divergence → divergence detected
- Both sources equally delayed and in agreement → no divergences

---

## Docker Compose

`reconciler/docker-compose.yml` deploys:
- **reconciler** — the dual-read reconciliation daemon (port 9092)
- **indexer** — the webhook target (port 8080, Issue #2 integration)

### Health Checks

The reconciler service includes an HTTP health check at `/health` (configured in docker-compose).

### Networks

All services communicate over the `streampay` bridge network.

---

## Integration Points

- **Horizon API**: `HORIZON_URL` — classic-bridge effects polling
- **Soroban RPC**: `SOROBAN_RPC_URL` — `getContractData` queries
- **Indexer Dashboard (Issue #2)**: `WEBHOOK_URL` — divergence alert delivery
- **Prometheus/Grafana**: via `infra/observability/` — metrics and dashboards

---

## License

Apache-2.0 — see LICENSE at repository root.