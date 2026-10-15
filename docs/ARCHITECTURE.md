# StreamPay architecture

How StreamPay works internally: the storage model, the accrual math, auth and
reentrancy, TTL strategy, and the design decisions behind the v1 API. Read the
[README](../README.md) first for the overview.

## 1. Components

```text
┌────────────────────────────────────────────────────────────────────┐
│                        StreamingPayments                           │
│                                                                    │
│  lib.rs      entrypoints: create_stream / withdraw / withdraw_max / │
│              cancel_stream / top_up / get_stream / available /      │
│              recipient_streams / sender_streams / attach_metadata / │
│              stream_attestations / attestation_count /              │
│              party_attestations                                   │
│  stream.rs   Stream type, storage, checked accrual math            │
│  metadata.rs hash-linked attestations (attach, read, party index)  │
│  errors.rs   StreamError — stable numeric codes, append-only       │
│  events.rs   StreamCreated / Withdrawn / StreamCancelled /         │
│              StreamToppedUp / MetadataAttached (stream_id topic)   │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ token interface (SAC-compatible)
                           ▼
              Stellar Asset Contract / custom token
```

## 2. Storage model

| Key | Value | Purpose |
|---|---|---|
| `DataKey::NextStreamId` | `u64` | monotonic id counter (ids start at 1) |
| `DataKey::Stream(id)` | `Stream` | full per-stream state |
| `DataKey::RecipientStreams(addr)` | `Vec<u64>` | append-only ids where `addr` receives |
| `DataKey::SenderStreams(addr)` | `Vec<u64>` | append-only ids created by `addr` |
| `DataKey::Attestations(stream_id)` | `Vec<Attestation>` | append-only metadata attestations for a stream |
| `DataKey::PartyAttestations(addr)` | `Vec<AttestationRef>` | refs to attestations on streams where `addr` is a party |

Streams live in **persistent** storage. Every mutating entrypoint that touches
a stream extends its TTL (`TTL_THRESHOLD_LEDGERS = 200_000`, extend to
`500_000` ≈ 29 days), so a stream that is being used never goes cold, while
abandoned streams naturally archive to off-chain recovery — the Soroban-native
way to bound state bloat without penalizing active users. Index entries get
the same TTL treatment on write *and* on read, so an actively-queried address
stays hot.

Nothing extends `DataKey::NextStreamId`, the contract instance entry or the
Wasm code entry, and invoking a contract does not auto-extend instance/code
entries either. All three therefore expire `min_persistent_entry_ttl - 1` =
4,095 ledgers (~5.7 h) after creation unless something extends them — an
operational constraint §11 covers in detail.

There is still **no global registry** of all streams (no contract-wide
`Vec<u64>`): that would make `create_stream` cost grow with total stream count.
Instead, discovery is **per-address**: `create_stream` appends the new id to
the sender's and the recipient's own index lists — each bounded by that one
user's activity, written only at creation, and paginated on read
(`recipient_streams` / `sender_streams`, `limit` clamped to
`MAX_PAGE_SIZE = 50`). The indexes are *advisory*: never authorize against
them; the `Stream` entry is the source of truth, and `StreamCreated` events
remain the complete audit trail (an external indexer can still rebuild or
cross-check the lists).

**Attestations** follow the same pattern. `attach_metadata` appends one
`Attestation` (a 32-byte content hash, a byte length bounded `tag`, an attester,
a timestamp, and the index in the list) to `DataKey::Attestations(stream_id)`
and one `AttestationRef` to *both* parties' `PartyAttestations` index. The list
is never rewritten in place — a second attach appends, it does not overwrite —
and is capped at `MAX_ATTESTATIONS_PER_STREAM` (32) so per-stream storage cost
is bounded (32-byte hash × the cap). The entrypoints move no tokens, so there
is no CEI concern; the emitted `MetadataAttached` event is the durable record.
This is *attestation*, not verification: the contract stores no document and
cannot check that any document hashes to the value — see
[`VERIFYING_ATTESTATIONS.md`](./VERIFYING_ATTESTATIONS.md) for what a verifier
can and cannot conclude, and the runnable recipe.

## 3. Accrual math

Everything reduces to one pure function (`stream.rs`):

```rust
streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError>
```

- `elapsed == 0` (before `start_time`) → `0`
- `elapsed >= duration` (at/after `end_time`) → `deposit`
- otherwise → `deposit * elapsed / duration`, floored

Safety properties:

1. **Capacity pre-check at creation/top-up.** `validate_capacity` requires
   `deposit ≤ u128::MAX / duration`, so the worst-case product can never
   overflow *later* — turning per-call overflow handling into a one-time
   admission check.
2. **Widened products.** The product is computed in `u128`; a result is capped
   at `deposit` before narrowing back to `i128` (safe: `deposit ≤ i128::MAX`
   was checked on admission).
3. **Checked everywhere.** All `+`/`-` on user-relevant amounts use
   `checked_add` / `checked_sub` and map failure to
   `StreamError::MathOverflow`. No arithmetic operator in the contract can
   panic.
4. **Rounding never benefits the sender.** Floor division means a partial
   second is *never* counted as streamed; over the full window
   `streamed(duration) = deposit` exactly, so the recipient is always made
   whole by the end. The floor dust accumulates to the recipient, not the
   sender — verified by the property test (partial withdrawals ≤ full-window
   accrual).

The window is **half-open** `[start_time, end_time)`: at `now == start_time`
nothing has accrued, at `now ≥ end_time` the full duration has elapsed.

## 4. Auth model

| Action | who may call | auth consumed |
|---|---|---|
| `create_stream` | anyone; `sender` must authorize | sender |
| `withdraw` | recipient only | recipient |
| `cancel_stream` | sender always; recipient iff `cancelable` | caller |
| `top_up` | sender only | sender |
| `attach_metadata` | sender or recipient | attester |

The `cancelable` flag is chosen per stream at creation: payroll senders often
want sender-only cancellation, while vesting recipients may want the right to
walk away with what they've earned.

`require_auth()` is called *before* any state reads that depend on the caller's
identity, and errors use `StreamError` codes rather than SDK auth panics where
the condition is a business rule (e.g. `NotAuthorized` for a stranger calling
`cancel_stream`).

## 5. Reentrancy: checks-effects-interactions

Every entrypoint follows CEI ordering — all storage writes and event emissions
happen **before** the token transfers:

- `withdraw`: mark `withdrawn += amount`, set `Depleted` if fully drained,
  emit `Withdrawn`, *then* `token.transfer`.
- `cancel_stream`: set `Cancelled`, record the payout as withdrawn, emit
  `StreamCancelled`, *then* the two transfers.
- `create_stream` / `top_up`: pull tokens first, persist after — if a
  reentrant callback abused the transfer-in, the persisted state still
  reconciles with the balance (invariant below).

Additionally, `withdraw` and `cancel_stream` re-read `status` after auth: a
malicious token contract that reenters `withdraw` during its own transfer
callback finds `withdrawn` already updated, and `available_amount` reverts to
the *post-write* (smaller or zero) value. The suite contains a
malicious-token test that attempts exactly this reentry.

**Balance invariant:** the contract's token balance is always
`≥ Σ (deposit − withdrawn)` across live streams. Funds enter only via
`create_stream`/`top_up` and leave only via `withdraw`/`cancel_stream`, and
every exit is bounded by the invariant `0 ≤ withdrawn ≤ streamed ≤ deposit`.

## 6. Lifecycle states

```text
            create_stream
                 │
                 ▼
              Active ──── cancel_stream ────▶ Cancelled (terminal)
                 │        (pro-rata split:
                 │         recipient ← available,
                 │         sender ← deposit − streamed)
                 │
                 ├─ withdrawn == deposit ──▶ Depleted (terminal)
                 │
                 └─ top_up allowed while Active (even after end_time:
                    funds become fully accrued → recipient withdraws)
```

- Cancelling a `Depleted` stream reverts (`StreamNotActive`) — there is
  nothing left to split.
- Cancelling a not-yet-started stream is a 100 % refund to the sender.
- `top_up` on a cancelled/depleted stream reverts.

## 7. Error surface

`StreamError` variants carry explicit numeric codes (`contracterror`), part of
the public interface:

| Code | Variant | Raised when |
|---|---|---|
| 1 | `StreamNotFound` | no stream with this id |
| 2–3 | `NotStreamSender` / `NotStreamRecipient` | reserved role checks |
| 4 | `StreamNotCancellable` | recipient cancels a non-cancelable stream |
| 5 | `StreamNotActive` | cancelled/depleted stream mutated |
| 6 | `StartTimeInPast` | `start_time` before current ledger timestamp |
| 7 | `InvalidTimeRange` | `end_time ≤ start_time` (zero duration) |
| 8 | `DurationTooLong` | window exceeds `MAX_DURATION_SECONDS` (100 y) |
| 9 | `ZeroAmount` | deposit / withdrawal / top-up `≤ 0` |
| 10 | `AmountExceedsAvailable` | withdrawal above accrued balance |
| 11 | `MathOverflow` | a checked computation would overflow |
| 12 | `NotAuthorized` | caller is neither sender nor (cancelable) recipient |
| 13 | `NothingToWithdraw` | `withdraw_max` with an empty accrued balance |
| 14 | `MetadataTagTooLong` | `attach_metadata` tag exceeds `MAX_TAG_LEN` (32 bytes) |
| 15 | `MetadataLimitReached` | `attach_metadata` on a stream already holding `MAX_ATTESTATIONS_PER_STREAM` (32) |

Codes are **append-only**: never renumber or reuse a variant. Codes 2
(`NotStreamSender`) and 3 (`NotStreamRecipient`) are **retired**: they were
reserved role checks that no entrypoint ever produced, so they are kept (never
renumbered or reused) but marked unreachable.

The authoritative, machine-generated view of this surface lives in
[`docs/ERRORS.md`](./ERRORS.md): a per-branch table mapping every
`(entrypoint, condition)` decision to its code, emitted from the contract's own
instrumentation (`src/surface.rs`) by `cargo run -p streampay-contract --example
error_surface_doc`, with a CI step that regenerates it and fails on drift. Each
rejection site calls `surface::reject(Branch::…)` instead of returning a raw
code, so the mapping is generated rather than hand-maintained; the
`error_surface_test.rs` matrix proves every reachable branch fires its declared
code, and the coverage test fails CI on any error code with zero reachable
branches (unless explicitly retired) or any branch that lacks a code.

## 8. Design decisions (and rejected alternatives)

**Wall-clock accrual (`timestamp`), not per-ledger counters.** Streams are
expressed in seconds so a stream behaves identically on testnet, mainnet, and
in tests. On mainnet ledgers are ~5 s, so granularity is bounded by the
ledger cadence; the floor division in `streamed_at` makes under-granular
ledger boundaries always conservative.

**Sender pulls via `transfer_from` (approval), not first-class
`TokenInterface::approve`+escrow flows.** One approval + one create tx; the
contract is the escrow. This matches SAC semantics (`transfer_from` consumes a
real allowance) and keeps `create_stream` atomic.

**Top-up does not extend `end_time`.** Extending would re-baseline accrual and
can retroactively *reduce* the recipient's available balance (the extra funds
spread over a longer window). v1 keeps top-up strictly additive — accrued
amounts only grow. If demand exists, a `create_stream` from the remainder of a
fully-streamed stream is the clean composition (roadmap).

**No global stream registry; per-address append-only indexes instead.** See
§2. A contract-wide id vector couples `create_stream` cost to total adoption
and re-reads everything on every query; per-address lists keep writes O(1)
for the one user involved and reads paginated. Discovery remains safe because
the indexes are advisory only — auth and payouts always read the `Stream`
entry itself.

**Terminal states are terminal.** No reactivation, no partial cancellation.
Simplicity is a security feature; richer flows belong in composing contracts
or off-chain UX.

## 9. Testing strategy

- **Unit tests** (`test.rs`) cover every spec edge case: withdraw before
  start / at / after end, sequential partial withdrawals, cancel before start
  / fully-withdrawn / not-cancelable, top-up after end, zero-duration and
  zero-amount rejection, `i128::MAX`-scale checked math, event emission
  (typed, per-contract-filtered), and a malicious-token reentrancy attempt.
- **Property test**: random `(deposit, duration)` — for random sample points
  `t ≤ duration`, the sum of payouts up to `t` never exceeds
  `streamed_at(deposit, duration, t)`, and `streamed_at(..., duration) ==
  deposit` exactly.
- **Rate math is pure** (`streamed_at` takes no `Env`), so the `cargo-fuzz`
  target in [`fuzz/`](../fuzz/fuzz_targets/streamed_at.rs) hammers it without
  a Soroban host: bounds, exact floor-ratio reference comparison,
  monotonicity, and "errors are only ever genuine `MathOverflow`". CI runs a
  scheduled session (`fuzz.yml`, non-blocking); any crash becomes a regression
  unit test.
- **Metadata attestations** (`metadata_test.rs`): both-party attribution,
  append-not-overwrite on repeated attestation, oversized-tag and per-stream-cap
  rejection, non-party / unknown-stream / missing-auth rejection, event payload,
  and the paginated per-stream and per-party reads.
- **Error surface** (`error_surface_test.rs`): the branch registry in
  `surface.rs` is walked by generated tests — one probe per branch asserts the
  exact branch fires its declared code — plus coverage tests proving no code is
  dead and no branch uncoded. `docs/ERRORS.md` is generated from the same table
  and diffed in CI.
- **`withdraw_max`** shares the `withdraw` payout tail (`pay_out`) so both
  paths inherit the same CEI ordering and reentrancy proof; index pagination
  and TTL behavior have dedicated tests in `test.rs`.

## 10. Open problems / roadmap hooks

- `pause_stream` (sender-initiated temporary hold) — needs a fourth status and
  careful `cancel_amounts` treatment; drafted as a good-first-issue.
- Multi-token batch creation — one tx, N streams; watch the instruction
  budget, likely `try_create_batch` with per-item results.
- Gas optimization pass on storage reads — `cancel_stream` does one
  read-modify-write; a `Stream` split into hot/cold fields could shave bytes.
- Event indexer service — TypeScript worker polling `getEvents` per topic
  `stream_id`, materializing stream history for the UI.
- Contract-side TTL maintenance — extend `NextStreamId`, the instance entry and
  the code entry from inside the contract (or from the deploy path) instead of
  relying on the external sentinel. Costs rent on the write path but removes
  the ~5.7 h cliff in §11 entirely.

## 11. TTL and rent operations

§2 describes what the contract extends. This section is the other half: what
it never touches, and the operational tooling that exists because of it —
[`infra/ttl-sentinel/`](../infra/ttl-sentinel/README.md).

| Entry | Extended on-chain? | Worst-case cliff | At 5 s/ledger |
|---|---|---:|---:|
| `Stream(id)` | yes, every mutating entrypoint | 200,000 ledgers | 11.6 d |
| `SenderStreams` / `RecipientStreams` | yes, on write **and** on page read | 200,000 ledgers | 11.6 d |
| `NextStreamId` | **never** | 4,095 ledgers | **5.7 h** |
| contract instance | **never** | 4,095 ledgers | **5.7 h** |
| Wasm code | **never** | 4,095 ledgers | **5.7 h** |

Two properties with real consequences:

- **The extension threshold is a cliff, not a target.** `extend_ttl(200_000,
  500_000)` only fires when the remaining TTL is already below the threshold,
  and then sets `liveUntil = now + 500_000`. The last write that ever extends
  a stream can land as late as `L_ext + 300_000`, which leaves exactly  200,000 ledgers: the worst case is *tight*, so alert thresholds must be
  derived from the 200,000 cliff rather than from the comfortable 500,000
  extension target.
- **Never-extended entries are the sharp edge.** `next_stream_id` reads the
  counter with `get().unwrap_or(1)` and writes it back without extending it,
  and a plain `stellar contract deploy` (or
  [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh)) leaves the
  instance and code entries un-extended. Every deployment therefore has a
  ~5.7-hour window before stream creation and *all* reads — `get_stream`
  included — start failing on archived entries, until the entry is restored
  (a paid operation) and extended.

`infra/ttl-sentinel` scans every class, reads `liveUntilLedgerSeq` for each
key, projects expiry per class against a sampled ledger cadence, and alerts on
`warn` / `crit` / `expired` transitions (console, JSONL, webhook sinks).
Alerting is read-only and key-less; enumeration is counter-driven
(`1..next_id-1`, batched `getLedgerEntries`) so it never depends on event
retention. Extension is a **separate, off-by-default** component with its own
funded key, a per-transaction entry cap, dry-run default and a persisted
monthly budget meter — the protocol lets anyone extend anyone's entry, so that
key only ever needs to cover fees.

The same module projects rent from *measured* entry sizes (504 B per stream
entry; index entries by id count) against the CAP-0066 fee curve. That is
direct input for pricing and dust economics: ~0.021 XLM per live stream per
month at the floor fee, plus ~14.6 XLM per MiB of Wasm per month — code rent
is scale-invariant, so bytecode is the dominant cost centre below roughly 80
live streams.

`cargo test` cannot cover any of this today: the contract's tests advance
`ledger().timestamp()` but never the ledger sequence, so no test archives an
entry. The sentinel's own suite fast-forwards a fake chain ledger-by-ledger
and asserts the observed alert timing, plus a constants-sync test that fails
if `TTL_THRESHOLD_LEDGERS` / `TTL_EXTEND_LEDGERS`, the extension call sites or
the never-extended counter drift from what this section documents.
