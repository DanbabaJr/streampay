# Light-Client State & Event Proofs for StreamPay

- **Status**: Prototype & Security Evaluation
- **Issue**: `security: signed event proofs for light clients`
- **Pairs With**: [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) (Row 5: *RPC Liar* & Row 6: *Indexer Compromiser*)

---

## 1. Executive Summary & Honest Evaluation

StreamPay clients (the Next.js frontend, CLI verifiers, and light integrations) read stream state (`DataKey::Stream(u64)`) and historical events (`StreamCreated`, `Withdrawn`, `StreamCancelled`, `StreamToppedUp`) from external Soroban JSON-RPC providers (`getLedgerEntries`, `simulateTransaction`, `getEvents`) or off-chain indexers.

Before writing verification code, we must evaluate the underlying Stellar / Soroban architecture honestly:

### 1.1 How Full Nodes and Stellar Core Verify State
In Stellar Core (Protocol 20+ / Soroban), every closed `LedgerHeader` commits to the entire network state via `bucketListHash` (the SHA-256 root of the hierarchical Bucket List) and to all transactions/events in that ledger via `txSetResultHash` (`TransactionResultSet` / `TransactionMeta`). Validator nodes running the Stellar Consensus Protocol (SCP) sign `StellarValue` envelopes (`LCV_SIGNATURE`) committing to `(ledgerSeq, closeTime, txSetHash, bucketListHash)`.

A **full node** (or a Captive Core instance inside a Soroban RPC host) replays transactions and maintains the Bucket List locally, verifying every ledger entry against the SCP-signed `LedgerHeader`.

### 1.2 Why `getLedgerEntries` and `getEvents` Are NOT Self-Authenticating for Light Clients
While a full node hash-verifies its own Bucket List against ledger headers, **the standard Soroban JSON-RPC API (`getLedgerEntries`, `simulateTransaction`, and `getEvents`) strips all cryptographic inclusion proofs**:

1. **No Bucket List Merkle Path**: `getLedgerEntries` returns `{ entries: [{ key, xdr, lastModifiedLedgerSeq, liveUntilLedgerSeq }], latestLedger }`. The `xdr` field is a raw base64-encoded `LedgerEntryData` XDR payload. The RPC response does **not** include the sibling hashes or Bucket List segment proofs required to link `SHA-256(LedgerEntry)` back to `LedgerHeader.bucketListHash`.
2. **No `TransactionMeta` / SCP Quorum Envelope on Events**: `getEvents` returns `{ events: [{ id, ledger, ledgerClosedAt, contractId, topic, value }], latestLedger }`. It does not return the enclosing `TransactionResultMeta` XDR, the `LedgerHeaderHistoryEntry`, or the SCP `LedgerCloseValueSignature` quorum set.
3. **Simulation Trust**: `simulateTransaction` (used by `frontend/lib/stellar.ts` for `readStream` and `readAvailable`) executes preflight host simulation on the RPC server and returns an unsigned `ScVal` return value.

**Conclusion of Honest Evaluation**:
A thin client talking only to a single untrusted Soroban RPC URL **cannot** verify `getLedgerEntries` or `getEvents` responses against a Stellar ledger header alone, because Soroban RPC does not expose Bucket List Merkle branches. Without an explicit commitment path, an adversarial or compromised RPC / indexer host can forge stream deposits, under-report `withdrawn` amounts, omit cancellation events, or serve stale state snapshots.

---

## 2. Thin-Client Threat Model

### 2.1 System Entities
1. **Light Client (Verifier)**: Browser frontend (`frontend/`) or stateless verification script running in an untrusted network environment. Has no local Bucket List and minimal bandwidth/CPU budget.
2. **Untrusted Transport / RPC / Indexer Host**: The HTTP server delivering stream state (`getLedgerEntries` / `/streams/:id/proof`) to the client. Modeled as a **Byzantine adversary** capable of modifying JSON fields, mutating XDR bytes, omitting entries, or replaying old responses.
3. **Public Checkpoint Anchor**: A compact, publicly auditable commitment `{ ledger, ledgerCloseTime, stateRoot, eventRoot, signature, publicKey }` published by a checkpoint authority (e.g., an independent auditor, multi-region witness, or threshold relayer quorum) whose Ed25519 public key (`G...`) is pinned out-of-band by the client.

### 2.2 Adversarial Capabilities & Attack Vectors

| Attack Vector | Adversary Action | Target Impact | Required Verifier Response |
|---|---|---|---|
| **A1: Modified Amount / State Tampering** | RPC/Indexer alters `deposit`, `withdrawn`, `recipient`, or `status` in the JSON view or mutates the `ContractDataEntry` XDR bytes. | Tricks recipient into believing a stream is funded/unwithdrawn when it is not, or tricks sender into overpaying. | **Reject (`ENTRY_HASH_MISMATCH` / `XDR_DECODE_MISMATCH` / `INVALID_MERKLE_PROOF`)**: Recompute XDR canonical leaf hash and verify both XDR-to-state equivalence and Merkle inclusion against the signed checkpoint root. |
| **A2: Missing / Wrong Entry Substitution** | RPC omits the requested stream entry, substitutes stream `#2` for stream `#1`, or returns an entry for a malicious contract ID. | Client accepts state from a decoy contract or wrong stream ID. | **Reject (`MISSING_ENTRY` / `KEY_MISMATCH` / `CONTRACT_MISMATCH`)**: Rebuild the canonical `LedgerKey::ContractData(contractId, DataKey::Stream(id))` XDR client-side and assert exact byte equality with the proved entry's key. |
| **A3: Stale Proof / Replay Attack** | RPC serves a genuinely signed proof from an older ledger $L_{\text{old}}$ (e.g., before a `cancel_stream` or `withdraw_max` occurred at $L_{\text{new}}$). | Client acts on superseded stream state (e.g., attempting to withdraw already-claimed funds or trusting a cancelled stream). | **Reject (`STALE_PROOF` / `CHECKPOINT_MISMATCH`)**: Enforce `proof.ledger == checkpoint.ledger`, `checkpoint.ledger >= minLedger`, and `now - checkpoint.ledgerCloseTime <= maxAgeSeconds`. |
| **A4: Forged Checkpoint Signature** | RPC generates a fresh Merkle tree over fabricated entries and signs the checkpoint with an attacker-controlled key. | Complete state forgery. | **Reject (`UNTRUSTED_SIGNER` / `INVALID_SIGNATURE`)**: Verify the Ed25519 signature over the domain-separated checkpoint payload against the client's pinned `trustedSigners` set. |
| **A5: Event History Tampering** | Indexer alters an event's `withdrawn_total` or omits a `stream_cancelled` event from the stream's event log proof. | Corrupts audit trail or misleads client about how the stream reached its current state. | **Reject (`EVENT_PROOF_INVALID` / `STATE_EVENT_DIVERGENCE`)**: Verify each event leaf against `checkpoint.eventRoot` and cross-check the projected state against the proved `ContractDataEntry` XDR. |

---

## 3. Comparison of Three Verification Options

We evaluate three candidate architectures for bringing verifiable state proofs to StreamPay light clients:

| Criterion | Option 1: Native Stellar Bucket List Proofs | Option 2: Relayer / Indexer Signed Merkle Checkpoint (Chosen) | Option 3: Multi-RPC Quorum Cross-Checking |
|---|---|---|---|
| **Mechanism** | Client downloads Stellar History Archive Services (HAS) buckets or custom Captive Core Bucket List Merkle branches + SCP `LedgerCloseValueSignature` envelopes. | Indexer/Relayer constructs canonical SHA-256 Merkle trees over `LedgerEntryData` XDRs and `RpcEvent` payloads at ledger $L$, signs a domain-separated checkpoint header with Ed25519, and serves compact Merkle proofs alongside RPC/indexer responses. | Client queries $N \ge 3$ independent Soroban RPC providers (`getLedgerEntries`) and accepts the response only if $k$-of-$N$ endpoints return identical `LedgerEntryData` XDR bytes at the same ledger. |
| **Cryptographic Anchor** | Stellar validator quorum SCP signatures (`LedgerHeader.bucketListHash`). | Ed25519 signature (`@stellar/stellar-sdk` `Keypair`) over `(networkPassphrase, contractId, ledger, closeTime, stateRoot, eventRoot)`. | Transport-layer TLS to $N$ distinct RPC operators (no single cryptographic state root). |
| **Payload Size (per query)** | **10 MB – 250 MB** (Bucket List levels do not expose fine-grained binary Merkle trees over HTTP; requires downloading XDR bucket files). | **~1.2 KB – 2.5 KB** (raw `LedgerEntryData` XDR + 32-byte sibling hashes + 64-byte Ed25519 checkpoint signature). | **~2 KB × $N$** ($N$ parallel HTTP JSON-RPC roundtrips). |
| **Browser Verification Cost** | Prohibitive in browser (streaming multi-megabyte XDR buckets and parsing CAP-0046 bucket merges). | **< 2 ms** (XDR decode via `@stellar/stellar-sdk`, 5–15 SHA-256 hashes, 1 Ed25519 signature verification). | **100 – 500 ms** (network latency of slowest RPC in quorum; fails if providers are on different ledgers). |
| **Works with Existing Soroban RPC?** | **No** — standard `soroban-rpc` does not expose Bucket List inclusion paths. | **Yes** — works directly with captured `getLedgerEntries` XDR and `getEvents` responses. | **Partially** — since ledgers close every ~5s, uncoordinated RPCs often report slightly different `latestLedger` sequences, causing false quorum failures on active streams. |
| **Offline / Auditable Proof?** | Yes (if full bucket files are archived). | **Yes** — a `LightClientStreamProof` JSON bundle is self-contained and verifiable offline against a 200-byte public checkpoint. | **No** — ephemeral transport check; produces no transferable cryptographic proof. |

### Justification for Choosing Option 2 (Relayer / Indexer Signed Merkle Checkpoint over Canonical XDR)
1. **Practicality & Compatibility**: Option 1 is impossible against standard Soroban RPC endpoints without modifying the Rust `soroban-rpc` server to expose internal Bucket List paths. Option 3 suffers from ledger-skew race conditions across public RPCs and produces no transferable proof artifact.
2. **Defense-in-Depth via Canonical XDR Binding**: Rather than signing arbitrary JSON, Option 2 commits directly to the **canonical Soroban `LedgerEntryData` XDR** (matching `getLedgerEntries`) and **canonical `RpcEvent` XDR topics/values** (matching `getEvents`). The client verifier independently decodes the `ContractDataEntry` XDR using `@stellar/stellar-sdk`, verifies the `DataKey::Stream(u64)` key and contract address, checks that the decoded fields match the stream view, verifies the SHA-256 Merkle inclusion path to `checkpoint.stateRoot`, and verifies the Ed25519 signature on the checkpoint.
3. **Zero Trust in the Serving Host / CDN**: Once a checkpoint is published (e.g., pinned in a public log, DNS TXT record, or secondary witness endpoint), the indexer/RPC host serving `/streams/:id/proof` is completely untrusted. Any tampering with amounts, status, XDR bytes, or freshness is deterministically caught by the client verifier.

---

## 4. Cryptographic Specification & Proof Format

### 4.1 Domain Separation Prefixes
To prevent second-preimage and cross-protocol replay attacks, all SHA-256 hashes use explicit ASCII domain prefixes:
- **State Leaf Prefix**: `STREAMPAY_STATE_LEAF_V1\0`
- **Event Leaf Prefix**: `STREAMPAY_EVENT_LEAF_V1\0`
- **Merkle Internal Node Prefix**: `STREAMPAY_MERKLE_NODE_V1\0`
- **Checkpoint Signing Prefix**: `STREAMPAY_CHECKPOINT_V1\0`

### 4.2 Canonical State Leaf Construction
For a stream entry returned by Soroban RPC `getLedgerEntries`:
1. The entry key is the base64 `LedgerKey::ContractData` XDR for `(contractId, ScVec[Symbol("Stream"), U64(streamId)], Persistent)`.
2. The entry value is the base64 `LedgerEntryData::ContractData` XDR (`entryXdr`).
3. The canonical state leaf preimage is:
   $$\text{StateLeafHash} = \text{SHA-256}\Big(\texttt{"STREAMPAY\_STATE\_LEAF\_V1\textbackslash 0"} \;\|\; \text{contractId} \;\|\; \texttt{":"} \;\|\; \text{streamId} \;\|\; \texttt{":"} \;\|\; \text{keyXdr} \;\|\; \texttt{":"} \;\|\; \text{entryXdr} \;\|\; \texttt{":"} \;\|\; \text{lastModifiedLedgerSeq} \;\|\; \texttt{":"} \;\|\; \text{liveUntilLedgerSeq}\Big)$$

### 4.3 Canonical Event Leaf Construction
For a contract event returned by Soroban RPC `getEvents`:
$$\text{EventLeafHash} = \text{SHA-256}\Big(\texttt{"STREAMPAY\_EVENT\_LEAF\_V1\textbackslash 0"} \;\|\; \text{id} \;\|\; \texttt{":"} \;\|\; \text{ledger} \;\|\; \texttt{":"} \;\|\; \text{contractId} \;\|\; \texttt{":"} \;\|\; \text{topicXdrCsv} \;\|\; \texttt{":"} \;\|\; \text{valueXdr}\Big)$$

### 4.4 Binary Merkle Tree Construction
Leaves are sorted lexicographically by their unique identifier (`streamId` for state leaves, `event.id` for event leaves) before tree construction:
- Empty tree root: $\text{SHA-256}(\texttt{"STREAMPAY\_MERKLE\_EMPTY\_V1\textbackslash 0"})$
- Internal node:
  $$\text{ParentHash} = \text{SHA-256}\Big(\texttt{"STREAMPAY\_MERKLE\_NODE\_V1\textbackslash 0"} \;\|\; \text{leftBytes}_{32} \;\|\; \text{rightBytes}_{32}\Big)$$
- Odd nodes at any level are promoted to the next level without duplication (preventing CVE-2012-2459 duplicate-leaf malleable proof attacks).

### 4.5 Public Checkpoint Envelope
```ts
export interface SignedCheckpoint {
  version: 1;
  networkPassphrase: string;   // e.g. "Test SDF Network ; September 2015"
  contractId: string;          // StreamPay contract StrKey (C...)
  ledger: number;              // Ledger sequence number
  ledgerCloseTime: number;     // UNIX timestamp (seconds)
  stateRoot: string;           // Hex-encoded 32-byte Merkle root of stream entries
  eventRoot: string;           // Hex-encoded 32-byte Merkle root of indexed events
  streamCount: number;         // Number of streams committed in stateRoot
  signerPublicKey: string;     // Stellar Ed25519 public key StrKey (G...)
  signature: string;           // Base64 Ed25519 signature over canonical checkpoint digest
}
```
The signed digest is:
$$\text{CheckpointDigest} = \text{SHA-256}\Big(\texttt{"STREAMPAY\_CHECKPOINT\_V1\textbackslash 0"} \;\|\; \text{networkPassphrase} \;\|\; \texttt{"\textbackslash n"} \;\|\; \text{contractId} \;\|\; \texttt{"\textbackslash n"} \;\|\; \text{ledger} \;\|\; \texttt{"\textbackslash n"} \;\|\; \text{ledgerCloseTime} \;\|\; \texttt{"\textbackslash n"} \;\|\; \text{stateRoot} \;\|\; \texttt{"\textbackslash n"} \;\|\; \text{eventRoot} \;\|\; \texttt{"\textbackslash n"} \;\|\; \text{streamCount}\Big)$$

### 4.6 Complete Stream Proof Bundle (`LightClientStreamProof`)
```ts
export interface MerkleStep {
  position: "left" | "right";
  hash: string; // 64-char hex
}

export interface RpcLedgerEntryProofData {
  keyXdr: string;               // Base64 LedgerKey XDR
  entryXdr: string;             // Base64 LedgerEntryData XDR (from getLedgerEntries)
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq: number;
}

export interface EventProofItem {
  event: RpcEvent;              // Raw Soroban RPC getEvents entry (topic + value XDR)
  leafHash: string;
  proof: MerkleStep[];
}

export interface LightClientStreamProof {
  version: 1;
  contractId: string;
  streamId: string;
  ledger: number;
  stream: VerifiedStreamState;
  rpcEntry: RpcLedgerEntryProofData;
  stateLeafHash: string;
  stateProof: MerkleStep[];
  events?: EventProofItem[];
  checkpoint: SignedCheckpoint;
}
```

---

## 5. Verification Algorithm (Frontend TypeScript Verifier)

When the frontendverifier [`verifyStreamProof(proof, checkpoint, options)`](../frontend/lib/light-client-verifier.ts) receives a `LightClientStreamProof` and a pinned `SignedCheckpoint`:

1. **Checkpoint Authenticity & Pinning**:
   - Assert `checkpoint.version === 1` and `proof.version === 1`.
   - Assert `checkpoint.signerPublicKey` is in `options.trustedSigners`.
   - Assert `checkpoint.contractId === options.expectedContractId` and `checkpoint.networkPassphrase === options.expectedNetworkPassphrase`.
   - Recompute `CheckpointDigest` and verify `Keypair.fromPublicKey(checkpoint.signerPublicKey).verify(digest, signature)`.
2. **Freshness / Anti-Replay Checks**:
   - Assert `proof.ledger === checkpoint.ledger` and `proof.checkpoint.stateRoot === checkpoint.stateRoot`.
   - If `options.minLedger` is specified, assert `checkpoint.ledger >= options.minLedger`.
   - If `options.nowTimestamp` and `options.maxAgeSeconds` are specified, assert `options.nowTimestamp - checkpoint.ledgerCloseTime <= options.maxAgeSeconds`.
   - Assert the entry is not expired/archived at the checkpoint ledger: `proof.rpcEntry.liveUntilLedgerSeq >= checkpoint.ledger`.
3. **Canonical Key & XDR Decoding Verification**:
   - Independently construct the expected `LedgerKey` XDR for `(checkpoint.contractId, DataKey::Stream(proof.streamId))` and assert it equals `proof.rpcEntry.keyXdr`.
   - Parse `proof.rpcEntry.entryXdr` via `xdr.LedgerEntryData.fromXDR(..., "base64")`.
   - Assert the entry durability is `Persistent`, the contract address inside the XDR equals `checkpoint.contractId`, and the embedded key inside `ContractDataEntry` matches `DataKey::Stream(proof.streamId)`.
   - Decode the `ScMap` value from the XDR into native fields (`id`, `sender`, `recipient`, `token`, `deposit`, `withdrawn`, `start_time`, `end_time`, `cancelable`, `status`) and assert **exact field-for-field equality** with `proof.stream`. (This defeats any attack where the JSON `stream.deposit` is modified while keeping the original `entryXdr`, or where `entryXdr` is modified without updating the leaf hash).
4. **Merkle Inclusion Verification**:
   - Recompute `expectedLeafHash` from `proof.rpcEntry` and assert `expectedLeafHash === proof.stateLeafHash`.
   - Fold `proof.stateProof` from `expectedLeafHash` and assert the resulting root equals `checkpoint.stateRoot`.
5. **Optional Event Trail Verification**:
   - If `proof.events` is provided, verify each event's XDR topic/value decoding, recompute its `EventLeafHash`, verify its Merkle path against `checkpoint.eventRoot`, and assert that folding the events reproduces the stream's `deposit`, `withdrawn`, and `status`.

---

## 6. Residual Trust Assumptions

In accordance with the audit transparency standards in [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md), we document all residual trust assumptions explicitly:

1. **Checkpoint Signer Honesty (1-of-1 or $k$-of-$n$ Relayer Assumption)**:
   - Because Soroban RPC does not expose native Bucket List Merkle proofs tied to SCP validator quorum signatures, the light client relies on the checkpoint signer (`trustedSigners`) to honestly Commitment-sign the state and event roots at ledger $L$.
   - *Mitigation*: Checkpoints are publicly broadcast and deterministic. Any full node or auditor running `scripts/verify-fees.ts` or the indexer can recompute `stateRoot` and `eventRoot` from chain state at ledger $L$ and immediately detect an equivocating or fraudulent checkpoint signature. Furthermore, the verifier supports pinning multiple independent signer keys or threshold checkpoints.
2. **Freshness / Liveness Window (`maxAgeSeconds`)**:
   - Between checkpoint publications (e.g., if a checkpoint is up to $\Delta t = 60$ seconds old), a stream could be withdrawn from or cancelled on-chain before the client receives a newer checkpoint.
   - *Mitigation*: The verifier enforces strict `minLedger` and `maxAgeSeconds` bounds. For fund-critical mutations, the Soroban smart contract itself (`contracts/streaming-payments/src/lib.rs`) remains the ultimate on-chain authorization and solvency gatekeeper.
3. **Omission / Availability (Censorship)**:
   - A hostile RPC or indexer host can refuse to return a proof (`HTTP 500` / timeout) or claim a newly created stream does not exist yet.
   - *Mitigation*: Availability cannot be solved purely by cryptography against a single host; clients should fail over across secondary RPC/indexer endpoints (tracked in `THREAT_MODEL.md` `GAP-7`).
4. **Wall-Clock Skew on the Client**:
   - Evaluating `nowTimestamp - checkpoint.ledgerCloseTime <= maxAgeSeconds` assumes the client's local system clock is reasonably synchronized (within minutes of UTC). Even if the client clock is skewed, `minLedger` provides a monotonic, clock-independent ratchet against state rollback.
