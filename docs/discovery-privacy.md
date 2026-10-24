# Privacy Design: Opt-in Anonymized Stream Discovery Listings

## 1. Executive Summary & Core Objective

StreamPay enables continuous payment streams between senders and recipients on Stellar (Soroban). The **Discovery Directory** provides an off-chain discovery index where stream parties can voluntarily showcase active or completed streaming arrangements (e.g. proof of regular payroll, recurring subscription volume, or contractual escrow activity) without doxxing the involved parties.

Privacy is the primary constraint. Blockchains are permanently transparent public ledgers: every `create_stream`, `withdraw`, `top_up`, and `cancel_stream` invocation is permanently recorded with exact addresses, token contract IDs, stroop amounts, and ledger timestamps.

The Discovery Directory bridges public verifiable assurance with off-chain privacy:
1. **Zero Address Exposure by Default**: No Stellar addresses (`G...` or `C...`) are ever published unless both parties explicitly and independently opt into address disclosure.
2. **Aggregated & Bucketed Attributes**: Exact deposit values, remaining balances, and exact start/end timestamps are discarded; only coarse rate and duration buckets are published.
3. **$k$-Anonymity Protection**: Listings are published only if they meet a configurable $k$-anonymity threshold ($k \ge 3$), guaranteeing that any published listing shares its bucket profile with at least $k-1$ other streams.
4. **Dual Cryptographic Consent**: A listing can only be proposed, indexed, or published if **both** the stream's sender and recipient sign canonical domain-separated authorization payloads using native Stellar Ed25519 keys.
5. **Instant Unilateral Revocation**: Either party can unilaterally revoke publication at any time with a signed withdrawal message, immediately unlisting the record.

---

## 2. Field Allowlist & Data Minimization

The directory maintains a strict separation between public view records and internal authorization proofs.

### 2.1 Public Allowlist (Exposed via API and UI)

Every public response passes through an egress schema filter. Any field not on this allowlist is stripped before serialization:

| Field Name | Type | Description | Privacy Justification |
| :--- | :--- | :--- | :--- |
| `listingId` | `UUIDv4` string | Randomly generated directory listing identifier | Completely detached from on-chain `streamId` to prevent linkability. |
| `asset` | string (Stellar Address) | Soroban token address (e.g. USDC, XLM) | Required for users to filter streams by asset denomination. |
| `rateBucket` | enum / string | Coarse flow rate band (e.g. `[10, 100) / day`) | Masks exact financial commitments while providing economic utility. |
| `durationBucket` | enum / string | Coarse duration band (e.g. `1-7 days`, `30-90 days`) | Masks exact start and end timestamps. |
| `status` | enum (`Active`, `Completed`) | Lifecycle state of the stream | Informs searchers whether the agreement is ongoing or historical. |
| `listedDay` | string (`YYYY-MM-DD`) | Calendar date of listing activation in UTC | Truncates precise time (HH:MM:SS) to break block/ledger timing correlation. |
| `anonymitySetSize` | integer | Number of streams sharing this `(asset, rateBucket, durationBucket)` | Informs consumers of the privacy level of the listing. |
| `anonymityFlag` | enum (`normal`, `low`) | Safety indicator relative to threshold $k$ | Flags listings that fall below the $k$-anonymity threshold. |
| `addressesShared` | `{ sender: boolean, recipient: boolean }` | Status of explicit address opt-in | Discloses whether parties chose transparent identity. |
| `sender` | string (optional) | Sender Stellar public key (`G...`) | **Omitted by default**. Published ONLY IF both parties explicitly opted in. |
| `recipient` | string (optional) | Recipient Stellar public key (`G...`) | **Omitted by default**. Published ONLY IF both parties explicitly opted in. |

### 2.2 Fields NEVER Published

The following fields must **never** appear in public API payloads, browse pages, or open index views:

1. **On-chain `streamId`**: Revealing the numeric stream ID links the listing directly to on-chain state, exposing all parties and transactions immediately.
2. **Exact Deposit Amount (`deposit`)**: High-precision token stroops allow trivial single-record joins with `StreamCreated` event values.
3. **Exact Accrued / Withdrawn Amounts (`withdrawn`)**: Precision accounting values uniquely finger-print streams.
4. **Exact Timestamps (`start_time`, `end_time`)**: Ledger sequence times on Stellar are accurate to within seconds; exact timestamps correlate directly to ledger close times.
5. **Transaction Hashes / Ledger Numbers**: Direct pointers to ledger events.
6. **Raw Signatures and Nonces**: Sender and recipient signatures are stored strictly in private backend verification tables. Exposing raw Ed25519 signatures allows public key recovery and offline correlation.
7. **Single-Party Opt-In Addresses**: If sender opts in to share address but recipient does not (or vice versa), **neither address is published**.

---

## 3. Bucketing Schemes & $k$-Anonymity Guarantees

To prevent re-identification through numerical uniqueness, continuous values are mapped into discrete, standardized bands.

### 3.1 Rate Bucketing Scheme

The stream rate represents token flow per day ($86,400$ seconds):
$$\text{Rate}_{\text{daily}} = \frac{\text{deposit}}{\text{duration in seconds}} \times 86,400$$

Amounts are computed in token base units (e.g. 7 decimal places for Stellar classic/Soroban tokens) and grouped into logarithmic bands:

- **`RATE_MICRO`**: $< 10$ tokens / day ($[0, 10)$)
- **`RATE_LOW`**: $10 - 100$ tokens / day ($[10, 100)$)
- **`RATE_MEDIUM`**: $100 - 1,000$ tokens / day ($[100, 1,000)$)
- **`RATE_HIGH`**: $1,000 - 10,000$ tokens / day ($[1,000, 10,000)$)
- **`RATE_WHALE`**: $\ge 10,000$ tokens / day ($[10,000, \infty)$)

*Rationale*: Logarithmic bands accommodate distributions spanning micro-subscriptions to institutional payroll while masking exact agreements.

### 3.2 Duration Bucketing Scheme

Contract duration is defined as $\Delta t = \text{end\_time} - \text{start\_time}$:

- **`DUR_FLASH`**: $< 24$ hours ($[0, 86,400)$ s)
- **`DUR_WEEK`**: $1 - 7$ days ($[86,400, 604,800)$ s)
- **`DUR_MONTH`**: $7 - 30$ days ($[604,800, 2,592,000)$ s)
- **`DUR_QUARTER`**: $30 - 90$ days ($[2,592,000, 7,776,000)$ s)
- **`DUR_LONG`**: $> 90$ days ($[7,776,000, \infty)$ s)

### 3.3 $k$-Anonymity Model

An equivalence class is defined as the tuple:
$$E = (\text{asset}, \text{rateBucket}, \text{durationBucket})$$

- Let $N(E)$ be the count of verified active streams in the directory sharing equivalence class $E$.
- The system enforces a configurable parameter $k$ (`DISCOVERY_K_ANONYMITY_THRESHOLD`, default $k = 3$).
- **Enforcement Rules**:
  1. If $N(E) \ge k$, all listings in $E$ are served in public browse queries with `anonymityFlag: "normal"`.
  2. If $N(E) < k$, the listings in $E$ are **excluded** from default directory browse listings.
  3. If a client explicitly requests low-anonymity listings via query parameter (`includeLowAnonymity=true`), the directory returns them with `anonymityFlag: "low"` and displays a prominent visual warning in the UI:
     > ⚠️ **Low Anonymity Warning**: Only $N(E)$ stream(s) exist in this category. Observers may be able to correlate this listing with on-chain activity.

---

## 4. Adversarial Reverse-Lookup Analysis

Any attacker with access to both the public Soroban blockchain ledger and the off-chain Discovery Directory will attempt to correlate records. We analyze each attack vector, its mitigation, and residual risk.

### 4.1 Timing Correlation Attack

- **Attack Vector**: The on-chain `create_stream` transaction has an exact ledger timestamp $T_{\text{chain}}$. If a listing is published at $T_{\text{list}}$, an observer calculates $|T_{\text{list}} - T_{\text{chain}}|$. In low-volume protocols, this delta uniquely matches a single creation event.
- **Mitigations**:
  1. **Coarsened Listing Timestamp**: Directory stores and serves only `listedDay` (`YYYY-MM-DD` UTC). All sub-day timestamps are purged.
  2. **Delayed Publication Window**: Directory ingestion imposes a random publication delay jitter (e.g. 1 to 6 hours) or batches publications into scheduled daily windows.
- **Residual Risk**: If a stream is created on a day where only one stream occurred for that token across the entire network, timing correlation is still possible.

### 4.2 Exact-Amount and Rate Matching Attack

- **Attack Vector**: If exact deposit $D$ or exact duration $T$ were published, calculating $D/T$ matches the unique parameters in the on-chain contract storage.
- **Mitigations**:
  - The directory recomputes rate and duration from on-chain contract state and maps them into broad buckets. Exact amounts are dropped.
- **Residual Risk**: In sparsely used token contracts, if only one stream was ever created within a broad bucket (e.g. only one stream in `RATE_WHALE`), bucketing alone does not prevent isolation unless $k$-anonymity suppression is active.

### 4.3 Rare Bucket & Niche Asset Combinations

- **Attack Vector**: A custom or low-volume token $T_{\text{rare}}$ with a single active stream creates an equivalence class of size 1 ($N(E) = 1$).
- **Mitigations**:
  - Strict $k$-anonymity suppression ($k \ge 3$) by default. The listing remains unindexed until at least 2 other streams enter that exact band.
- **Residual Risk**: If parties deliberately bypass $k$-anonymity warnings by opting to view low-anonymity streams, correlation risk is substantial.

### 4.4 Longitudinal Correlation & Listing Graph Linkability

- **Attack Vector**: If listings carry persistent pseudonym IDs or party handles, an observer builds a graph of recurring payments (e.g. monthly payroll patterns from company A to employee B).
- **Mitigations**:
  - Every listing is assigned an ephemeral `listingId` (random UUIDv4).
  - No user identifiers or cross-listing links are retained or exposed.
- **Residual Risk**: If a party always creates streams with the exact same combination of rare parameters at regular calendar intervals, statistical pattern analysis across ledger epochs may reveal identity.

### 4.5 The Stream ID Verification Deep-Link as a De-Anonymizer

- **Attack Vector**: If the directory provides a link: `https://stellar.expert/.../contract?stream_id=42`, any user clicking that link instantly retrieves the on-chain struct: `{ sender, recipient, deposit, start_time, end_time }`, completely destroying anonymity.
- **Mitigations & Trade-Off Analysis**:
  - **The directory browse API never includes on-chain `streamId`**.
  - **Two-Tier Verification Design**:
    - **Tier 1 (Public Blind Attestation)**: The directory service itself performs on-chain verification against Soroban RPC, verifying contract state, signer validity, and bucket consistency. The directory issues a signed attestation hash:
      $$\text{Attestation} = \text{HMAC-SHA256}(\text{listingId} \mathbin{\Vert} \text{asset} \mathbin{\Vert} \text{rateBucket} \mathbin{\Vert} \text{durationBucket} \mathbin{\Vert} \text{status}, K_{\text{service}})$$
      This proves the listing has been verified against on-chain reality without exposing `streamId`.
    - **Tier 2 (Counterparty Proof / Targeted Verification)**: If a party wants to prove ownership of a listing to an external auditor or prospective counterparty, they can export a **Verification Package** containing the `streamId` and dual consent signatures.
    - **Tier 3 (Explicit Opt-In Disclosure)**: If both parties explicitly toggle `shareAddresses: true`, the on-chain `streamId` and Stellar addresses are published, and a direct Stellar.Expert block explorer deep link is rendered.
- **Residual Risk**: When parties choose Tier 3 (address sharing), anonymity is deliberately waived by mutual consent.

---

## 5. Dual-Consent Lifecycle & Cryptographic Protocol

### 5.1 Listing State Machine

A discovery listing transitions through the following formal states:

```
                  ┌──────────────┐
                  │   PROPOSED   │ (Created by Sender or Recipient)
                  └──────┬───────┘
                         │ Signed by Party A
                         ▼
               ┌──────────────────┐
               │ CONSENTED_BY_ONE │ (Pending signature from Party B)
               └─────────┬────────┘
                         │ Signed by Party B
                         ▼
              ┌────────────────────┐
              │ CONSENTED_BY_BOTH  │ (Verified against On-Chain RPC)
              └──────────┬─────────┘
                         │ Meets k-anonymity threshold / scheduled
                         ▼
                 ┌───────────────┐
                 │   PUBLISHED   │ (Visible in Public Directory)
                 └───────┬───────┘
                         │ Revoked by either Party (unilateral)
                         ▼
                 ┌───────────────┐
                 │   WITHDRAWN   │ (Permanently removed from index)
                 └───────────────┘
```

### 5.2 Consent States

1. **`PROPOSED`**: Stream party initiates listing creation. Payload is assembled.
2. **`CONSENTED_BY_ONE`**: Either sender or recipient signs the canonical listing authorization. The other party's signature is pending.
3. **`CONSENTED_BY_BOTH`**: Both parties have signed identical listing commitments. The indexer verifies the signatures and checks that stream parameters match contract state.
4. **`PUBLISHED`**: The listing is active in the directory.
5. **`WITHDRAWN`**: Either party submitted a signed withdrawal payload. The listing is immediately removed from the active directory.

### 5.3 Revocation & Unilateral Withdrawal

Privacy consent must be revocable at will.
- **Unilateral Action**: Either the sender OR the recipient can withdraw a listing at any time without the other party's permission.
- **Revocation Message**: Requires a signed `WITHDRAW` message from either party's Stellar keypair.
- **Immediate Effect**: Upon receipt of a valid withdrawal message, the directory updates the record to `WITHDRAWN`, removes it from search indexes, and purges any cached representations.
- **No Resuscitation**: A withdrawn listing cannot be reopened. If the parties wish to list the stream again, a fresh proposal with new nonces and signatures from both parties is mandatory.

### 5.4 Address Sharing Opt-In Protocol

Address exposure is strictly decoupled from listing consent:
- Party A submits: `shareAddress: boolean`
- Party B submits: `shareAddress: boolean`
- **Rule of Dual Consent for Identity**:
  $$\text{PublishAddresses} = \text{PartyA.shareAddress} \land \text{PartyB.shareAddress}$$
- If Party A chooses `true` and Party B chooses `false`, **neither address is published**.
- The UI must make this toggle explicit, off by default, accompanied by an explicit warning:
  > *"Sharing addresses will link your Stellar public key to this stream listing permanently on the discovery directory."*

---

## 6. Cryptographic Signature Scheme

All authorizations utilize native Stellar Ed25519 signatures over SHA-256 digests of domain-separated, canonical JSON payloads.

### 6.1 Domain Separation & Anti-Replay

To prevent cross-chain replays, cross-contract replays, and signature reuse across different listing attempts:
- **Domain Tag**: `"StreamPayDiscovery:v1"`
- **Network Passphrase**: e.g. `"Test SDF Network ; September 2015"` or `"Public Global Stellar Network ; September 2015"`
- **Contract Address**: The deployed Soroban StreamPay contract address.
- **Stream ID**: The specific on-chain `u64` stream ID.
- **Nonce**: A cryptographic random 32-byte hex string generated per listing proposal.
- **Expiry**: Unix timestamp (seconds) after which unconfirmed proposals expire (default: 7 days).

### 6.2 Canonical Listing Authorization Payload

The canonical payload signed by both parties:

```json
{
  "action": "STREAM_DISCOVERY_CONSENT",
  "domain": "StreamPayDiscovery:v1",
  "network": "Test SDF Network ; September 2015",
  "contractId": "CC...",
  "streamId": "42",
  "nonce": "a7f4e9102c89b823e593d14210e7b99c084f7b649d28a1c93710dbf120e98a31",
  "expiry": 1792195200,
  "shareAddress": false
}
```

### 6.3 Canonical Withdrawal Payload

The canonical withdrawal payload signed by either party:

```json
{
  "action": "STREAM_DISCOVERY_WITHDRAW",
  "domain": "StreamPayDiscovery:v1",
  "network": "Test SDF Network ; September 2015",
  "contractId": "CC...",
  "streamId": "42",
  "listingId": "c85d7b32-901e-4581-81f7-e23a45610bc9",
  "timestamp": 1792108800
}
```

### 6.4 Verification Protocol

The directory service validates submissions by executing the following steps in sequence:
1. Parse submission and verify schema validity.
2. Check `expiry`: Reject if `now() > expiry`.
3. Check `network`: Must match the directory service's configured network passphrase.
4. Check `contractId`: Must match the active StreamPay contract address.
5. Reconstruct the canonical JSON string (deterministic key ordering, no extraneous whitespace).
6. Compute message hash $H = \text{SHA-256}(\text{canonicalMessage})$.
7. Fetch stream `#streamId` directly from Soroban RPC:
   - Verify stream exists and is not `StreamStatus::Cancelled`.
   - Extract on-chain `stream.sender` and `stream.recipient`.
8. Verify Ed25519 signatures:
   - Sender signature verified against `stream.sender`.
   - Recipient signature verified against `stream.recipient`.
9. Recompute rate bucket and duration bucket from contract `stream.deposit`, `stream.start_time`, and `stream.end_time`. **Never trust client-supplied buckets**.
10. Store verified consent in private proof storage and index public projection in directory.

---

## 7. Verification Trade-off Summary Matrix

| Mode | Verifiable Attributes | Address Privacy | $k$-Anonymity Preserved | Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Public Directory Listing** | Rate bucket, duration bucket, asset, status, directory attestation | **Complete (0% exposed)** | **Yes ($k \ge 3$)** | General browsing, public market discovery |
| **Private Counterparty Proof** | Full stream parameters, verified on-chain | Restricted to counterparty | N/A (point-to-point) | Credit checks, payroll validation, B2B diligence |
| **Dual Opt-In Transparent** | Full stream parameters, direct block explorer deep link | **None (100% exposed by mutual consent)** | No | Public sponsorship, grants, open-source bounties |

---

## 8. Storage Durability, Rate Limiting & Deployment Topology

### 8.1 Prototype-Grade Durability (Reference Implementation)

The reference discovery directory service in the frontend application (`frontend/lib/discovery/store.ts` and `frontend/lib/discovery/rateLimit.ts`) operates with **in-memory process-local storage** via `globalThis`:
- **Directory Records & Proposals**: Stored in JavaScript `Map` collections.
- **Rate Limit Buckets**: Stored in a process-local IP map (`ipBuckets`).
- **API Visibility & Nonce Replay Durability**: All discovery HTTP endpoints emit an `X-Discovery-Durability: prototype-in-memory` header to explicitly advertise this persistence level to API consumers. Note: nonce replay protection is only as durable as the in-memory store — consumed nonces die with the process, so nobody should read the replay defense as production-grade until backed by persistent storage.

### 8.2 Operational Caveats in Serverless & Distributed Environments

Deploying process-local in-memory stores in serverless or multi-instance environments introduces specific operational limitations:
1. **Serverless Cold Starts (Netlify Functions, AWS Lambda, Vercel)**:
   Serverless runtimes spin up isolated execution environments on demand. When an instance undergoes a cold start or container recycle, process memory is erased. Directory listings published in an earlier execution instance will vanish from the directory until re-submitted.
2. **Multi-Instance Cluster State Fragmentation**:
   When running multiple concurrent server instances (e.g. behind a load balancer), each instance maintains an isolated in-memory `Map`. A listing saved on Instance A is not immediately queryable on Instance B.
3. **Ephemeral Rate Limit Budgets**:
   Process-local rate limiting buckets reset upon container recycling, allowing clients to reset their request quota by routing through newly spawned serverless instances.
4. **Consent Record Auditability**:
   Consent and withdrawal signatures stored solely in ephemeral memory are purged across process lifecycles, which undermines long-term non-repudiation and consent audit trails.
5. **Nonce Replay Protection Durability**:
   Nonce replay protection is only as durable as the in-memory store. The `usedNonces` set dies with the process and is not synchronized across serverless execution instances, so the replay defense is strictly prototype-grade until persisted (e.g., via the `discovery_nonces` table in `indexer/db/schema.sql`).

### 8.3 Production Architecture: Moving Storage Behind the Indexer Store

For production deployments, the `IDiscoveryStore` interface must be backed by persistent, ACID-compliant storage integrated into the StreamPay Indexer service (`indexer/`):

```
                        ┌────────────────────────────────────────────────────────┐
                        │              Frontend / API Gateway                     │
                        │      (Next.js Server / Edge API Handlers)              │
                        └──────────┬─────────────────────────────────┬───────────┘
                                   │                                 │
                 Public Queries    │               Private Proof Ingestion / Verif.
                                   ▼                                 ▼
         ┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
         │     `discovery_listings` Table       │  │    `discovery_consent_vault` Table   │
         │   (Indexer SQLite / PostgreSQL)      │  │    (Encrypted / Access-Gated Store)  │
         ├──────────────────────────────────────┤  ├──────────────────────────────────────┤
         │ • listing_id (UUIDv4)                │  │ • listing_id (FK)                    │
         │ • asset (Token address)              │  │ • stream_id (On-chain ID)            │
         │ • rate_bucket (RATE_LOW, etc.)       │  │ • deposit_raw (Exact stroop amount)  │
         │ • duration_bucket (DUR_WEEK, etc.)   │  │ • sender / recipient addresses       │
         │ • state (PUBLISHED / WITHDRAWN)      │  │ • Ed25519 signatures & nonces        │
         │ • listed_day (YYYY-MM-DD)            │  │ • expiry / timestamp                 │
         │ • verification_hash (HMAC)           │  │                                      │
         └──────────────────────────────────────┘  └──────────────────────────────────────┘
```

#### Dedicated Persistent Schema (`indexer/db/schema.sql`):
1. **`discovery_listings`**: Stores coarsened, allowlisted public projections. Queryable by equivalence class `(asset, rate_bucket, duration_bucket, state)` to enable efficient $k$-anonymity counting and filtering.
2. **`discovery_consent_vault`**: Stores private authorization proofs (raw `stream_id`, exact deposit amounts, Ed25519 signature strings, and nonces). Strictly partitioned from public API search queries.
3. **`discovery_nonces`**: Persistent table for consumed replay nonces across proposals, listings, and withdrawals.
4. **Distributed Rate Limiting**: Production rate limiting should be delegated to centralized atomic storage (e.g. Redis `INCR` with sliding TTL or Cloudflare / Upstash rate limiting) to enforce global rate budgets uniformly across all serverless nodes.

---

## 9. Conclusion

The privacy-preserving discovery directory guarantees that participants retain total sovereignty over their financial privacy. Anonymity is preserved mathematically and procedurally through data minimization, coarse aggregation, $k$-anonymity suppression, dual-consent authorization, and unilateral revocation. In production environments, backing the discovery abstraction with the indexer store ensures durable persistence of public listings and consent audit records across serverless process recycles.

