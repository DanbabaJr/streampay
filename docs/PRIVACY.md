# StreamPay Telemetry Privacy Line & Data Classification

This document formally establishes the **Privacy Line** for all OpenTelemetry (OTel) instrumentation across the StreamPay stack (browser client, Next.js server routes, Soroban RPC interactions, indexer ingestion, and push notifications).

---

## 1. Threat Model & Rationale

OpenTelemetry traces traverse multiple infrastructure layers, including browser network transports, reverse proxies, OpenTelemetry Collectors, Jaeger/Tempo distributed storage, Grafana dashboards, and long-term analytical sinks.

While Stellar on-chain transactions are publicly auditable, **distributed trace telemetry combines application-level metadata (timing, user-agent, IP, routing paths, failure diagnostics) with blockchain identifiers**. If full wallet addresses and sensitive identifiers were attached to traces:
1. **Deanonymization**: Correlation of client IP and browser session with full public keys would trivially de-anonymize pseudonymous blockchain participants.
2. **Credential Leakage**: Webhook URLs and notification endpoints often embed bearer tokens, basic auth credentials, or query parameters in URLs.
3. **Data Spill Liability**: PII (emails, Telegram IDs) and cryptographic secrets (private keys, signer seeds) stored in trace backends create compliance risks (GDPR, CCPA) and security vulnerabilities.

---

## 2. Identifier Taxonomy & The Privacy Line

Every span attribute, event attribute, and span link attribute must strictly adhere to the following classification:

| Identifier Type | Raw Example | Permitted in Traces? | Transformed Representation | Rationale |
|---|---|:---:|---|---|
| **Stellar Public Key (Sender/Recipient)** | `GDJ6...7XYZ` (56 chars) | **Prefix Only** | `GDJ61234...` (First 8 chars + `...`) | Allows operational debugging of account type/family without uniquely identifying the user across telemetry sinks. |
| **Contract ID** | `CA3B...9QWE` (56 chars) | **Yes** | `CA3B...9QWE` (Full ID) | Protocol contracts are public, immutable code addresses. |
| **Transaction Hash** | `4f8c2b7e...3a1` (64 hex) | **Yes** | `4f8c2b7e...3a1` (Full Hash) | Public on-chain ledger reference; required for async seam SpanLink correlation. |
| **Stream ID** | `42` (u64 integer) | **Yes** | `42` (string or int) | Non-sensitive public identifier of the stream. |
| **Stellar Secret Key / Seed** | `SB...` / `SC...` | **NEVER (P0)** | `[REDACTED]` | Catastrophic credential compromise if leaked. |
| **Freighter / Wallet Signature** | Base64 signature bytes | **NEVER** | `[REDACTED]` | Cryptographic signatures belong on-chain only. |
| **Webhook Endpoint URL** | `https://api.acme.com/v1/hook?token=secret123` | **Masked** | `https://api.acme.com/***` | Strips all path credentials, tokens, and query parameters. |
| **Email Address** | `alice.smith@company.org` | **Masked** | `***@company.org` | Prevents email harvesting while allowing domain diagnosis. |
| **Telegram Chat ID** | `123456789` | **Masked** | `chat_***6789` (Last 4 digits only) | Prevents user tracking while verifying notification routing. |
| **Stream Deposit/Claim Amount** | `50000000` (5 XLM in stroops) | **NEVER** | `[OMITTED]` | Financial amounts and balances are omitted from traces to preserve transaction confidentiality. |
| **Error Messages / Stack Traces** | Revert message or RPC error | **Sanitized** | Filtered via `sanitizeError()` | Strips accidental keys, secrets, or bearer tokens. |

---

## 3. Enforcement in Code

Privacy rules are enforced **at the source** in the telemetry layer (`privacy.ts`) using automated sanitizers:

```typescript
// Truncates any Stellar address (G... or C...) to 8 characters + ellipsis
export function sanitizeAddress(address?: string | null): string {
  if (!address) return "unknown";
  const trimmed = address.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 8)}...`;
}

// Strips query parameters, tokens, and paths from webhook URLs
export function sanitizeWebhookUrl(rawUrl?: string | null): string {
  if (!rawUrl) return "unknown";
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "invalid_url";
  }
}
```

No raw Stellar address may ever be passed to `span.setAttribute()`. All instrumentation calls must pipe addresses through `sanitizeAddress()`.

---

## 4. Audit & Verification

The test harness (`test/telemetry/privacy.test.ts`) verifies:
1. Full 56-character addresses are never present in span attribute dumps.
2. Webhook credentials and query parameters are stripped.
3. Secret keys (`S...`) are detected and rejected.
4. Error stacks containing secret-like strings are sanitized before span status recording.
