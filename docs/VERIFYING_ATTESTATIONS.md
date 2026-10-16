# Verifying StreamPay attestations

StreamPay lets either party to a stream attach a **content hash** (plus a short
tag) to that stream — for example the SHA-256 of an invoice the stream is
paying, or of a payslip, a contract, or a CSV export. This document explains
exactly what that on-chain record proves, what it does **not** prove, and walks
through verifying a document against it with a runnable example.

## Scope: attestation, not verification

The contract is deliberately dumb about the content. `attach_metadata` records:

- **who** attached it (the attester — a sender or recipient of the stream),
- **which** 32-byte hash they committed to,
- a short **tag** they chose,
- **when** (ledger timestamp), and
- that it was the *n*-th attestation on that stream (append-only index).

It does **not** store the document, and it cannot check that any document hashes
to the value — it never sees one. It is a signed, timestamped *claim*.

### What a verifier CAN conclude

Given the document `D` and the on-chain attestation `(attester A, hash H, time
T)`:

1. **The hash matches.** If `sha256(D) == H`, then `D` is byte-for-byte the
   document that `A` committed to at time `T` (SHA-256 is collision-resistant;
   a matching digest means the same bytes, barring a cryptographic break).
2. **Attribution.** `A` is a party to this stream (sender or recipient), and
   `A` personally authorized the `attach_metadata` call — the contract required
   `A`'s signature.
3. **Ordering / non-repudiation.** The attestation is in an append-only list and
   emitted as an event whose topic is the `stream_id`. Neither party can
   overwrite or delete it, and a second attestation never replaces the first.
4. **Time bound.** Every attestation records the ledger timestamp at which it
   was accepted.

### What a verifier CANNOT conclude

- **Authenticity or correctness of the document.** A matching hash only shows
  the document is the one that was committed to; it says nothing about whether
  the invoice amount is right, whether the work was done, or whether the
  document is legally valid.
- **That the attester told the truth.** A party can attest any hash they like.
  If it does not correspond to a real document, verification simply fails —
  the contract never vouches for content.
- **Confidentiality from the hash.** Hashing does not hide content; low-entropy
  documents can be brute-forced. Never attest secret material's raw hash if the
  document is guessable.
- **That an un-attested document is invalid.** Absence of an attestation is not
  evidence of anything.

In short: the chain gives you a tamper-evident *commitment*. Trust in the
document itself still comes from the parties and their context.

## The API

| Function | Caller | Returns |
|---|---|---|
| `attach_metadata(attester, stream_id, content_hash: BytesN<32>, tag: String)` | sender or recipient | the new attestation's `index` (u32) |
| `stream_attestations(stream_id, offset, limit)` | anyone (read-only) | page of `Attestation` (`index`, `attester`, `content_hash`, `tag`, `timestamp`) |
| `attestation_count(stream_id)` | anyone (read-only) | number of attestations (u32) |
| `party_attestations(party, offset, limit)` | anyone (read-only) | page of `AttestationRef` (`stream_id`, `index`) for streams where `party` is a sender or recipient |

Each attach also emits a `MetadataAttached` event with `stream_id` as its first
topic, so an indexer can follow attestations without polling storage.

**Size bounds (storage cost):**

- `content_hash` is exactly 32 bytes.
- `tag` is at most `MAX_TAG_LEN = 32` bytes (UTF-8); longer is rejected with
  `MetadataTagTooLong` (#18).
- A stream holds at most `MAX_ATTESTATIONS_PER_STREAM = 32` attestations;
  further attaches are rejected with `MetadataLimitReached` (#19). Attaching
  never overwrites, so the cap is what bounds per-stream growth.
- Reads paginate with `limit` clamped to `MAX_PAGE_SIZE = 50`.

Both parties are indexed: every attestation is recorded under the sender's *and*
the recipient's `party_attestations` list, regardless of who attached it.

## Worked example: an invoice

The repo ships [`docs/examples/invoice-0042.txt`](./examples/invoice-0042.txt).
Its SHA-256 is:

```text
a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf
```

### 1. Hash the document and attach it

With the [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
and a deployed StreamPay contract:

```bash
# Hash the invoice locally (this is the value that goes on-chain).
sha256sum docs/examples/invoice-0042.txt
# a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf  docs/examples/invoice-0042.txt

# Attach it as the sender of stream 7 (the sender must sign).
stellar contract invoke \
  --id "$CONTRACT_ID" --network testnet --source sender \
  -- attach_metadata \
  --attester "$SENDER_ADDRESS" \
  --stream_id 7 \
  --content_hash a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf \
  --tag invoice-0042
# → 0   (the attestation index)
```

### 2. Read the attestation back

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" --network testnet \
  -- stream_attestations --stream_id 7 --offset 0 --limit 50
```

```json
[
  {
    "index": 0,
    "attester": "G…SENDER",
    "content_hash": "a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf",
    "tag": "invoice-0042",
    "timestamp": 1759267200
  }
]
```

Anyone can run this read call; no key is required.

### 3. Verify a document against the on-chain hash

[`scripts/verify_attestation.sh`](../scripts/verify_attestation.sh) recomputes a
file's SHA-256 and compares it to a hash you pass in (typically the one you just
read back):

```bash
./scripts/verify_attestation.sh \
  docs/examples/invoice-0042.txt \
  a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf
# file:     docs/examples/invoice-0042.txt
# expected: a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf
# actual:   a0f1670088b87cbb44297f1dd3aae819406ad200ac171955a95fc52a31b6d7bf
# MATCH: the document's SHA-256 equals the attested hash.
```

Change one byte of the file and the same command exits non-zero with
`MISMATCH` — that is the guarantee: the document you hold is, or is not, the one
the party committed to. (The script is case-insensitive and accepts an optional
`0x` prefix.)

### 4. See it in the UI

The stream detail page (`/stream/[id]`) lists a stream's attestations with their
attester, tag, and timestamp, and lets a connected party attach a new one. See
[`frontend/app/stream/[id]/page.tsx`](../frontend/app/stream/[id]/page.tsx).

## Double-attestation policy

Attestations are **append-only**. Attaching a second hash — even the same one —
adds a new entry with a new index; it never overwrites or edits an existing
entry. If a document is superseded, attach the new hash; the verifier reads the
history and decides which one is current. `stream_attestations` returns entries
in attach order.
