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
- `raw_body`: Exact, unparsed UTF-8 request body bytes.

### 2.2 Replay Protection
Receivers must verify that:
$$|\text{current\_time} - \text{timestamp}| \le 300 \text{ seconds (5 minutes)}$$
Requests with timestamps outside this tolerance window must be rejected to prevent replay attacks.

### 2.3 Zero-Downtime Secret Rotation
When a secret is rotated in the dashboard or API, StreamPay provides an overlap window by sending dual signatures:
```http
Streampay-Signature: t=1729180800,v1=new_signature_hex,v1=previous_signature_hex
```
The receiving service can verify against either its old or new secret, allowing seamless rollover with zero dropped events.

---

## 3. Signature Verification Examples

### TypeScript / Node.js
```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStreampayWebhook(
  header: string,
  rawBody: string,
  secret: string,
  toleranceSec = 300
): boolean {
  const parts = header.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const [k, ...v] = part.trim().split("=");
    if (k === "t") timestamp = Number(v.join("="));
    if (k === "v1") signatures.push(v.join("="));
  }

  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf-8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  return signatures.some((sig) => {
    try {
      const sigBuf = Buffer.from(sig, "hex");
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  });
}
```

### Rust
```rust
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

pub fn verify_streampay_webhook(
    header: &str,
    raw_body: &[u8],
    secret: &str,
    tolerance_secs: u64,
) -> bool {
    let mut timestamp = None;
    let mut signatures = Vec::new();

    for part in header.split(',') {
        let mut kv = part.splitn(2, '=');
        match (kv.next().map(str::trim), kv.next().map(str::trim)) {
            (Some("t"), Some(t)) => timestamp = t.parse::<u64>().ok(),
            (Some("v1"), Some(sig)) => signatures.push(sig),
            _ => {}
        }
    }

    let t = match timestamp {
        Some(t) => t,
        None => return false,
    };

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    if now.abs_diff(t) > tolerance_secs {
        return false;
    }

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take any size");
    mac.update(format!("{t}.").as_bytes());
    mac.update(raw_body);
    let expected_hex = hex::encode(mac.finalize().into_bytes());

    signatures.iter().any(|sig| sig.as_bytes().ct_eq(expected_hex.as_bytes()).into())
}
```

### Python
```python
import hmac
import hashlib
import time

def verify_streampay_webhook(header: str, raw_body: bytes, secret: str, tolerance_sec: int = 300) -> bool:
    parts = header.split(",")
    timestamp = None
    signatures = []

    for part in parts:
        k, _, v = part.partition("=")
        k = k.strip()
        v = v.strip()
        if k == "t":
            timestamp = int(v)
        elif k == "v1":
            signatures.append(v)

    if timestamp is None or not signatures:
        return False

    if abs(time.time() - timestamp) > tolerance_sec:
        return False

    message = f"{timestamp}.".encode("utf-8") + raw_body
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    return any(hmac.compare_digest(expected, sig) for sig in signatures)
```

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
