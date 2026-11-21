# ADR 0010: Shareable Payment Link Reference Format and Privacy Blinding

Status: Accepted
Date: 2026-10-17
Deciders: StreamPay Engineering Team

## Context
Freelancers and DAOs frequently invoice clients with shareable links rather than guiding payers through complex wallet setup tutorials.
When a payment stream is created on StreamPay, the sender needs a human-shareable, deterministic URL (`/pay/[ref]`) that:
1. Resolves client-side directly against Stellar Soroban without requiring a backend database.
2. Displays a minimal, pre-filled claim surface where visitors can inspect the stream's active progress without logging in or connecting a wallet.
3. Protects the payee's privacy: pasting links into chat platforms (Slack, Discord, Telegram, Twitter/X) must not leak the recipient's public key in plain text to web crawlers or intermediaries.
4. Validates claimant identity automatically upon Freighter connection before submitting the claim transaction.

## Decision

We adopt a compact, base64url-encoded reference format incorporating cryptographic recipient blinding and tamper-evident checksums.

### 1. Reference Payload Structure
The decoded reference structure is versioned and structured as follows:

```typescript
export interface PaymentLinkData {
  version: 1;              // Schema version
  streamId: string;         // On-chain Stream ID (u64 string)
  contractHint: string;     // First 6 characters of streaming contract ID
  blindedRecipient: string; // 16-hex char (64-bit) SHA-256 commitment
  salt: string;             // 8-hex char unique entropy
}
```

The outer envelope includes an integrity checksum:
```json
{
  "d": {
    "version": 1,
    "streamId": "1042",
    "contractHint": "CDLZFC",
    "blindedRecipient": "7a8f3b2c1d0e9a4f",
    "salt": "a1b2c3d4"
  },
  "c": "e8d21f0b"
}
```
This payload is serialized to JSON and encoded as a standard URL-safe Base64 (`base64url`) string.

### 2. Recipient Privacy Blinding Scheme
The recipient address is blinded using a salted cryptographic commitment:
$$\text{blindedRecipient} = \text{SHA256}(\text{recipient} \mathbin{\Vert} \text{":"} \mathbin{\Vert} \text{streamId} \mathbin{\Vert} \text{":"} \mathbin{\Vert} \text{salt})[0..16]$$

#### Security & Privacy Properties:
- **Pre-image resistance**: Intermediaries (messengers, URL unfurlers, network proxies) cannot invert the 64-bit truncated hash to deduce the recipient's Stellar public key.
- **Cross-stream unlikability**: The random per-link salt ensures that two payment links created for the same recipient produce completely distinct blinded values.
- **Client-side verification**: When the claimant connects Freighter, the client recomputes the commitment with the active wallet address. Only matching claimants are authorized to trigger the pre-filled `withdraw` / `withdraw_max` transaction.

### 3. OpenGraph Dynamic Previews
A Next.js server-side layout intercepts `/pay/[ref]`, reads the on-chain stream status via simulated Soroban RPC read, and dynamically renders OpenGraph and Twitter card metadata:
- Active stream: `"Active Stream — 100 USDC | StreamPay"`
- Completed stream: `"Completed Stream — 100 USDC | StreamPay"`
- Cancelled stream: `"Cancelled Stream | StreamPay"`

### 4. Dead-State Handling
If a stream has been cancelled, depleted, or concluded with 0 remaining balance, the link renders an explicit terminal status card explaining that no further funds can be claimed.

## Consequences

### Positive
- Zero login or account creation required for recipients to inspect invoices.
- Payee address is never broadcast in plain text across communication channels.
- Full client-side decentralization: resolves directly against Stellar RPC nodes.
- Tamper-evident checksum eliminates unnecessary failed RPC calls on typos.

### Negative
- If the sender modifies the reference string in transit, the checksum invalidates the link, requiring the sender to re-share the valid URL.

## Alternatives Considered

### Option 2: Plaintext Public Keys in URL Query Parameters (`/pay?recipient=G...&stream=123`)
- Good, because it requires zero encoding or client-side blinding math.
- Bad, because sharing the link on communication channels (Slack, Discord, Twitter) leaks the payee's full Stellar public key to crawler scrapers and preview unfurlers, compromising address privacy.

### Option 3: Centralized Backend Database URL Shortener
- Good, because URLs can be arbitrarily short (e.g. `/pay/abc1234`).
- Bad, because it introduces a centralized database dependency and single point of failure, violating the protocol's trust-minimized, direct-to-RPC architecture.
