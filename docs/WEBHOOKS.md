# StreamPay Outbound Webhooks Specification & Integration Guide

StreamPay delivers real-time, deterministic HTTP notifications to subscriber endpoints as on-chain events occur on Stellar Soroban.
Webhooks are signed using HMAC-SHA256, protected against replay attacks, hardened against Server-Side Request Forgery (SSRF), automatically retried over an exponential-backoff schedule with jitter, and routed to an observable Dead-Letter Queue (DLQ) if unacknowledged.

---

## 1. Canonical Event Envelope

Every webhook POST body contains a deterministic JSON payload formatted with sorted keys:

```json
{
  "event_id": "evt_019283a4b5c6",
  "event_type": "stream_created",
  "stream_id": "42",
  "timestamp": 1729180800,
  "payload": {
    "cancelable": true,
    "deposit": "1000000000",
    "end_time": "1729267200",
    "recipient": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "sender": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    "start_time": "1729180800",
    "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
  }
}
```

`stream_id` is the stream the event is about, or `null` when the event is not about a
stream at all — fee, governance, oracle, policy and index events carry `null`, since the
schema registry declares a stream id topic for only part of the event surface. The key is
always present, so a consumer can branch on it without guessing.

### Supported Event Types
- `stream_created`: New stream opened and funded on-chain.
- `withdrawn`: Recipient claimed accrued funds via `withdraw` or `withdraw_max`.
- `stream_topped_up`: Sender deposited additional tokens.
- `stream_cancelled`: Stream closed with pro-rata split between recipient and sender.
- `stream_paused` / `stream_resumed`: Stream state toggled.
- `stream_ping`: Test fire ping emitted from dashboard.

---

## 2. Cryptographic Signature & Replay Protection

Each request includes the HTTP header:
```http
Streampay-Signature: t=1729180800,v1=9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b
```

### 2.1 Signing Algorithm
$$\text{Signature} = \text{HMAC-SHA256}_{\text{secret}}\big(\text{timestamp} \mathbin{\Vert} \text{"."} \mathbin{\Vert} \text{raw\_body}\big)$$

Where:
- `secret`: Endpoint secret (prefixed with `whsec_`).
- `timestamp`: Integer unix seconds matching `t=` in the header.
- `raw_body`: The exact bytes sent in the HTTP POST body. The dispatcher canonicalizes
  the event envelope before it sends the body, so receivers must use the received raw
  bytes without re-parsing and re-serializing JSON.
- `prefix`: No `sha256=` prefix is used. `v1` values are lowercase hexadecimal SHA-256
  HMAC digests (64 hex characters).
- `secret`: The complete stored secret string, used exactly as-is with UTF-8 encoding.
  Do not strip the optional `whsec_` prefix.

### 2.2 Replay Protection
Receivers must verify that:
$$|\text{current\_time} - \text{timestamp}| \le 300 \text{ seconds (5 minutes)}$$
Requests with timestamps outside this tolerance window must be rejected to prevent replay attacks.
The value comes from the default argument `toleranceSec = 300` in
[`verifySignatureHeader`](../indexer/src/webhooks/hmac.ts), and is 300 seconds (5 minutes).
Reject stale or future-out-of-window deliveries: log the reason, return an HTTP 4xx
(normally `400` or `401`), and do not enqueue or process the event. A stale delivery
may safely remain in the sender's retry/DLQ lifecycle; signature failures and replay
failures are receiver-side and should not be retried indefinitely.

### 2.3 Zero-Downtime Secret Rotation
When a secret is rotated in the dashboard or API, StreamPay provides an overlap window by sending dual signatures:
```http
Streampay-Signature: t=1729180800,v1=new_signature_hex,v1=previous_signature_hex
```
The receiving service can verify against either its old or new secret, allowing seamless rollover with zero dropped events.

---

## 3. Signature Verification Examples

The exact HTTP headers are `Streampay-Signature`, `Streampay-Event`, and
`Streampay-Delivery`. Signature verification uses only `Streampay-Signature`;
the latter two headers identify the event and delivery.

For an endpoint configuration and delivery UI, see
[Webhook Settings](../frontend/app/settings/webhooks/page.tsx).

The following examples verify the pinned fixture in
[`test_fixtures/webhook-signature.json`](../test_fixtures/webhook-signature.json).
The fixture timestamp is `1700000000`, and the test secret is
`whsec_fixture_secret`. The fixture was generated with
[`generateSignatureHeader`](../indexer/src/webhooks/hmac.ts), not by hand-computing
the signature. Run `npm run fixture:webhook:generate` in `indexer/` to regenerate it.

### TypeScript / Node.js

This implementation is also available as the tested
[`verifyStreampayWebhook`](../indexer/src/webhooks/verify-example.ts) reference module.
Its raw-body parameter is deliberately `Uint8Array`; re-parsing JSON and serializing
it again can change whitespace or key order and invalidate the signature.

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStreampayWebhook(
  header: string,
  rawBody: Uint8Array,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300
): boolean {
  if (!header) return false;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value.trim());
  }

  if (
    timestamp === null ||
    !Number.isSafeInteger(timestamp) ||
    signatures.length === 0 ||
    Math.abs(nowSec - timestamp) > toleranceSec
  ) {
    return false;
  }

  // The signing payload is: timestamp + "." + exact raw request body bytes.
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf-8")
    .update(rawBody)
    .digest();

  return signatures.some((sig) => {
    try {
      if (!/^[0-9a-fA-F]{64}$/.test(sig)) return false;
      const provided = Buffer.from(sig, "hex");
      // Length guard is required before timingSafeEqual.
      return provided.length === expected.length &&
        timingSafeEqual(provided, expected);
    } catch {
      return false;
    }
  });
}
```

### Python

The stdlib implementation below reads the raw POST body bytes unchanged:

```python
import hmac
import hashlib
import time

def verify_streampay_webhook(
    header: str,
    raw_body: bytes,
    secret: str,
    now_sec: int | None = None,
    tolerance_sec: int = 300,
) -> bool:
    if not header:
        return False

    timestamp = None
    signatures = []

    for part in header.split(","):
        k, _, v = part.partition("=")
        k = k.strip()
        v = v.strip()
        if k == "t":
            try:
                timestamp = int(v)
            except ValueError:
                return False
        elif k == "v1" and v:
            signatures.append(v)

    if timestamp is None or not signatures:
        return False

    if now_sec is None:
        now_sec = int(time.time())
    if abs(now_sec - timestamp) > tolerance_sec:
        return False

    message = f"{timestamp}.".encode("utf-8") + raw_body
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    for signature in signatures:
        if len(signature) != len(expected):
            continue
        if hmac.compare_digest(expected, signature.lower()):
            return True
    return False
```

To verify a captured delivery against the pinned fixture:

```bash
python3 scripts/verify_webhook_fixture.py
```

### curl + openssl debugging recipe

This is a debugging recipe, not production verification. It is not constant-time.
Capture the exact body and header from a delivery, then recompute with the test or
endpoint secret:

```bash
SECRET='whsec_fixture_secret'
TIMESTAMP='1700000000'

# Save the exact captured POST body without JSON formatting changes.
curl --fail-with-body \
  --data-binary @captured-body.json \
  https://example.invalid/debug-receiver

# Read raw_body from the fixture or replace this with the captured file's bytes.
RAW_BODY='{"event_id":"evt_fixture_535","event_type":"stream_created","payload":{"deposit":"1000000000","recipient":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5","sender":"GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"},"stream_id":"42","timestamp":1700000000}'
HEADER='t=1700000000,v1=2cfc46ae1f21bf23ea1af74430abfce8c57d46ad54c05570a75034f5c848f16c'

EXPECTED=$(printf '%s' "${TIMESTAMP}.${RAW_BODY}" |
  openssl dgst -sha256 -hmac "$SECRET" |
  sed 's/^.*= //')
PROVIDED=$(printf '%s' "$HEADER" |
  sed -n 's/^.*v1=\([0-9a-fA-F][0-9a-fA-F]*\).*$/\1/p')

printf 'expected=%s\nprovided=%s\n' "$EXPECTED" "$PROVIDED"
test "$EXPECTED" = "$PROVIDED" && echo 'match'
```

Use only as a debugging aid. Production verification must parse `Streampay-Signature`,
check the replay window first, compare each `v1` value with a constant-time primitive,
and verify the raw request body bytes.

Failure cases:

- Wrong secret: signature mismatch; reject with `401` or `400`.
- Tampered body or re-serialized JSON: signing payload differs; reject.
- Expired timestamp or timestamp more than 300 seconds in the future: replay check fails;
  reject stale/future deliveries and log the timestamp drift.
- Missing or malformed `Streampay-Signature`: reject before signature comparison.
- A `v1` value that is not 64 hexadecimal characters: reject or skip it.

---

## 4. SSRF Hardening Guard

StreamPay's webhook engine checks all destination endpoints prior to initial dispatch and re-checks every redirect hop.
Disallowed IP ranges and hostnames are immediately dropped:
- **Loopback**: `127.0.0.0/8`, `::1`, `localhost`
- **Private RFC-1918**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **Link-Local & Cloud Metadata**: `169.254.0.0/16`, `169.254.169.254`, `metadata.google.internal`, `fe80::/10`
- **Carrier NAT & Reserved**: `100.64.0.0/10`, `224.0.0.0/4`, `240.0.0.0/4`, `0.0.0.0/8`

---

## 5. Retry Policy & Jitter

When a destination returns non-2xx status codes (4xx, 5xx) or encounters network timeouts:

| Attempt | Base Delay | Jitter ($\pm 20\%$) | Approx. Elapsed |
|---|---|---|---|
| **1** | Immediate (0s) | — | 0s |
| **2** | 60 seconds (1m) | 48s – 72s | ~1m |
| **3** | 300 seconds (5m) | 240s – 360s | ~6m |
| **4** | 900 seconds (15m) | 720s – 1080s | ~21m |
| **5** | 1800 seconds (30m)| 1440s – 2160s | ~51m |

### Jitter Formulation
$$\text{Delay} = \text{BaseDelay} \times \big(0.80 + 0.40 \times \text{random}()\big)$$

---

## 6. Dead-Letter Queue (DLQ) Runbook

After attempt 5 fails, the delivery transitions to `dead_letter` and an entry is placed into the `webhook_dead_letter` table.

### Observability API
- `GET /api/webhooks/dlq`: Returns dead-letter items including failure error and status codes.
- `POST /api/webhooks/dlq/:id/retry`: Replays the event, creating a fresh delivery with attempt 1.
