# ⚡ StreamPay Time-Series Accrual Curve API

High-performance, rate-budgeted time-series accrual curve endpoint for StreamPay continuous payment streams.

## Endpoint Specification

```http
GET /accrual/:id?from={from}&to={to}&step={step}
```

### Route Parameters
| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | **Yes** | Numeric stream ID (`u64`) |

### Query Parameters
| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | `integer` | **Yes** | Start timestamp in Unix seconds (`>= 0`, `from <= to`) |
| `to` | `integer` | **Yes** | End timestamp in Unix seconds (`>= 0`, `to >= from`) |
| `step` | `integer` | **Yes** | Sampling interval in seconds (`step > 0`). Maximum point limit: 1,000 points |

---

## Architectural Guarantees

### 1. Computed, Never Stored
The curve is computed dynamically on-the-fly using the contract’s canonical rate math (`computeAccruedAt` mirroring Soroban's `stream::streamed_at`):

$$\text{streamed}(t) = \min\left(\text{deposit}, \frac{\text{deposit} \times \text{elapsed}}{\text{duration}}\right)$$

Where $\text{elapsed} = \max(0, \min(\text{duration}, t - \text{start}))$.
No curve data is persisted in any database, Redis cache, or disk storage.

### 2. State Hash & ETag Derivation
Every response returns the exact cryptographic state hash and deterministic entity tag:

1. **State Hash (`X-State-Hash`)**:
   SHA-256 digest computed across canonical JSON of the on-chain stream state:
   ```json
   {
     "id": "1",
     "token": "CB...",
     "sender": "GB...",
     "recipient": "GB...",
     "deposit": "10000000000",
     "withdrawn": "0",
     "startTime": 1700000000,
     "endTime": 1700086400,
     "cancelable": true,
     "status": "Active",
     "asOfLedger": 1045230,
     "asOfTimestamp": 1700000000
   }
   ```
2. **ETag (`ETag`)**:
   Deterministic weak ETag derived from the state hash and exact request parameters:
   $$\text{ETag} = \text{W/}"\text{sha256}(\text{stateHash} : \text{id} : \text{from} : \text{to} : \text{step})[0..32]"$$
   Identical stream state and query parameters always yield the identical ETag.

### 3. Caching & Conditional Requests (`If-None-Match`)
Clients sending `If-None-Match: <etag>` receive an immediate:
```http
HTTP/1.1 304 Not Modified
ETag: W/"..."
X-State-Hash: ...
Cache-Control: public, max-age=5, stale-while-revalidate=15
```
with an empty body, eliminating redundant network bandwidth and client deserialization overhead.

- **Active Streams**: `Cache-Control: public, max-age=5, stale-while-revalidate=15`
- **Terminal Streams (`Cancelled` / `Depleted`)**: `Cache-Control: public, max-age=3600, immutable`

### 4. Honest Staleness Headers
The API explicitly discloses freshness metrics and never claims fresher data than the indexer has:

| Header | Description |
|---|---|
| `X-As-Of-Ledger` | Ledger sequence number as of which contract state was read |
| `X-As-Of-Timestamp` | ISO-8601 timestamp of indexed contract state |
| `Age` | Age in seconds of indexed state compared to wall-clock time |
| `X-Indexer-Lag` | Emitted when indexer lag exceeds threshold (&gt;60s) |
| `Warning` | RFC 9110 warning emitted when lagging: `199 - "Indexer state lagging behind tip by X seconds"` |
| `X-Cache` | Set to `STALE` if served from transient snapshot under rate budget pressure |

### 5. Shared RPC Budget Manager (#56 Integration)
The API protects both server resources and the upstream Soroban RPC node from rate bans:
- **Per-Client Budget**: Rate bucket per IP / client token (default 60 req/min).
- **Shared Node RPC Budget**: Every RPC call triggered by this API draws from a shared upstream budget pool.
- **Throttling & 429**: When client or node budget is exhausted, returns `429 Too Many Requests` with a standard `Retry-After: <seconds>` header.
- **Stale Fallback**: If safe and honest, a previously cached snapshot is served with `X-Cache: STALE` and honest staleness headers.

---

### 6. Renegotiated streams (#54) — current limitation
Since issue #54, a stream's rate is no longer fixed at creation: an accepted
`propose_rate_change` / `accept_rate_change` pair replaces the remaining window
with a new one, and the schedule is stored under
`DataKey::RateSegments(stream_id)` (readable with the `rate_segments` view).

This endpoint still prices its curve from `(deposit, start_time, end_time)`
alone, so for a stream that renegotiated:

- the curve is the *pre-renegotiation* line. It is correct up to the boundary
  (the head of a schedule is clipped with its original `allocation` /
  `basis_seconds` pair, so past accrual never changes) and wrong after it;
- `X-State-Hash`/`ETag` do capture the change whenever it moved `deposit`,
  which is every case except an adjustment of exactly zero — a new rate whose
  reserve equals the remaining escrow to the token. That single case can serve
  a stale curve from cache until the request parameters change.

`available` from the contract is always the truth: the on-chain payout paths
price the schedule, and the frontend must never use this curve to decide a
claim. Closing the gap means feeding `rate_segments` into
`frontend/lib/accrual.ts` and the state hash — tracked as a follow-up to #54,
not part of it.

---

## Interactive Documentation & OpenAPI Specification

- **Public Interactive Docs Page**: `/docs` (rendered via Swagger UI)
- **Raw OpenAPI 3.1 Spec**: `/openapi.json` and [`docs/openapi.json`](./openapi.json)
- **Regenerate Spec**: `npm run generate:openapi` in `frontend/`

---

## Sample Request & Response

### Request
```bash
curl -i "http://localhost:3000/accrual/1?from=1700000000&to=1700000180&step=60"
```

### Response (200 OK)
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: W/"9f3a8b2c1d4e5f6a7b8c9d0e1f2a3b4c"
X-State-Hash: 4a2f8c7b6d1e0f3a5c8e9b2d4f6a1c8e3b5d7a9f0c2e4b6d8a1c3e5f7a9b0d2e
X-As-Of-Ledger: 1045230
X-As-Of-Timestamp: 2026-10-16T00:00:00.000Z
Age: 5
Cache-Control: public, max-age=5, stale-while-revalidate=15
X-RateLimit-Remaining: 59

{
  "streamId": "1",
  "asOfLedger": 1045230,
  "asOfTimestamp": 1700000000,
  "stateHash": "4a2f8c7b6d1e0f3a5c8e9b2d4f6a1c8e3b5d7a9f0c2e4b6d8a1c3e5f7a9b0d2e",
  "params": {
    "from": 1700000000,
    "to": 1700000180,
    "step": 60,
    "count": 4
  },
  "points": [
    { "timestamp": 1700000000, "accrued": "0" },
    { "timestamp": 1700000060, "accrued": "6944444" },
    { "timestamp": 1700000120, "accrued": "13888888" },
    { "timestamp": 1700000180, "accrued": "20833333" }
  ]
}
```

### Conditional Request (304 Not Modified)
```bash
curl -i "http://localhost:3000/accrual/1?from=1700000000&to=1700000180&step=60" \
  -H 'If-None-Match: W/"9f3a8b2c1d4e5f6a7b8c9d0e1f2a3b4c"'
```

```http
HTTP/1.1 304 Not Modified
ETag: W/"9f3a8b2c1d4e5f6a7b8c9d0e1f2a3b4c"
X-State-Hash: 4a2f8c7b6d1e0f3a5c8e9b2d4f6a1c8e3b5d7a9f0c2e4b6d8a1c3e5f7a9b0d2e
Cache-Control: public, max-age=5, stale-while-revalidate=15
```
