# StreamPay event indexer

Small off-chain service that reads StreamPay contract events from Stellar RPC,
projects current stream state into SQLite, and serves stream lookups over HTTP.
It removes the need for clients to page through `recipient_streams` and
`sender_streams`. It does not change or call the contract.

The service indexes the contract's emitted event topics: `stream_created`,
`withdrawn`, `stream_cancelled`, and `stream_topped_up` (the Rust event types
are `StreamCreated`, `Withdrawn`, `StreamCancelled`, and `StreamToppedUp`).
It also recognizes `stream_paused` and `stream_resumed` for forward-compatible
status updates. Unknown topics are filtered out at RPC.

## Run locally

Requires Node.js 22 or newer.

```sh
cd indexer
cp .env.example .env
# Set CONTRACT_ID to a deployed StreamPay contract. Set START_LEDGER to the
# deployment ledger if you need existing streams indexed on first run.
npm install
npm run typecheck
npm test
npm run build
npm start
```

The service reads `.env` when your shell/environment loader provides it; Node
does not load `.env` automatically. For example, on PowerShell:

```powershell
$env:RPC_URL = "https://soroban-testnet.stellar.org"
$env:CONTRACT_ID = "C..."
$env:START_LEDGER = "123456"
npm start
```

Or use a dotenv tool such as `npx dotenv -e .env -- npm start`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | Testnet RPC | Stellar Soroban RPC URL |
| `CONTRACT_ID` | Required | StreamPay contract StrKey |
| `POLL_INTERVAL_MS` | `5000` | Delay between polls (minimum 250 ms) |
| `PORT` | `8787` | HTTP listen port |
| `DATABASE_PATH` | `./data/streampay.sqlite` | SQLite database file |
| `START_LEDGER` | Latest RPC ledger | Initial ledger to query, inclusive; set to deployment or earlier ledger for backfill |

The SQLite database stores an event log, a stream projection, and the RPC
cursor. Repeated events are safe: event ids are unique and projection updates
are transactional. Preserve the database to resume after restart. If the RPC
provider has pruned the requested historical ledgers, use an archival RPC or
start from a ledger still available from that provider.

## API

`GET /health`

```json
{"ok":true,"lastLedger":"123456"}
```

`GET /streams/:id` returns the latest indexed projection, or `404` if creation
has not been indexed:

```json
{
  "streamId": "7",
  "sender": "G...",
  "recipient": "G...",
  "token": "C...",
  "deposit": "1000000",
  "withdrawn": "250000",
  "startTime": "1760000000",
  "endTime": "1760003600",
  "cancelable": true,
  "status": "active",
  "lastLedger": 123456,
  "updatedAt": "2026-01-01T00:00:00Z"
}
```

Amounts and timestamps are strings to preserve integer precision. `status` is
`active`, `cancelled`, or `paused` when a recognized lifecycle event sets it.

`GET /address/:addr/streams` returns streams where the address is sender or
recipient, ordered newest stream id first:

```json
{"address":"G...","count":1,"streams":[{"streamId":"7","sender":"G...","recipient":"G...","token":"C...","deposit":"1000000","withdrawn":"250000","startTime":"1760000000","endTime":"1760003600","cancelable":true,"status":"active","lastLedger":123456,"updatedAt":"2026-01-01T00:00:00Z"}]}
```

## Notes

- RPC event payloads are decoded from base64 Soroban `ScVal` XDR using
  `@stellar/stellar-sdk`; the projection follows
  [`contracts/streaming-payments/src/events.rs`](../contracts/streaming-payments/src/events.rs).
- The first run starts at the current RPC ledger unless `START_LEDGER` is set.
  Historical discovery requires choosing a ledger at or before the contract's
  first event.
- This is an event-derived view. It reflects only events available from the
  configured RPC provider and is not a replacement for contract state as an
  authorization source.
- Testnet validation requires a deployed contract and an RPC endpoint that
  retains its deployment ledger; the included fixture tests the event XDR
  decoder and SQLite upsert path locally.
