# StreamPay Event Indexer

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

## 5. Testing

Run all unit, decoder, database, and integration tests:

```bash
npm test
```
