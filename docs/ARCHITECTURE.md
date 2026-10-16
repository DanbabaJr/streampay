# StreamPay architecture

How StreamPay works internally: the storage model, the accrual math, auth and
reentrancy, TTL strategy, and the design decisions behind the v1 API. Read the
[README](../README.md) first for the overview.

## 1. Components

```text
┌────────────────────────────────────────────────────────────────────┐
│                        StreamingPayments                           │
│                                                                    │
│  lib.rs      entrypoints: create_stream(s) / withdraw / withdraw_max /│
│              cancel_stream / top_up / get_stream / available /      │
│              recipient_streams / sender_streams / attach_metadata / │
│              stream_attestations / attestation_count /              │
│              party_attestations                                   │
│  stream.rs   Stream type, storage, checked accrual math            │
│  metadata.rs hash-linked attestations (attach, read, party index)  │
│  errors.rs   StreamError — stable numeric codes, append-only       │
│  events.rs   StreamCreated / Withdrawn / StreamCancelled /         │
│              StreamToppedUp / MetadataAttached (stream_id topic)   │
│              recipient_streams / sender_streams / set_fee_bps /    │
│              nominate_governor / accept_governor / withdraw_treasury│
│              treasury_status / stream_fee / verify_treasury /       │
│              total_streams                                         │
│              recipient_streams / sender_streams / schedule_stream / │
│              execute_scheduled / cancel_scheduled / reclaim_expired │
│              set_fee_bps / nominate_governor / accept_governor /    │
│              withdraw_treasury / treasury_status / stream_fee /     │
│              verify_treasury / total_streams                        │
│  stream.rs   Stream type, storage, checked accrual math            │
│  schedule.rs ScheduledIntent type, validation, timing, escrow      │
│  treasury.rs protocol-fee math, per-token accounting, governor,    │
│              verification scan (see §11)                           │
│  errors.rs   StreamError — stable numeric codes, append-only       │
│  events.rs   StreamCreated / Withdrawn / StreamCancelled /         │
│              StreamToppedUp / StreamScheduled /                    │
│              ScheduledStreamExecuted / ScheduledIntentCancelled /  │
│              ScheduledIntentExpired / FeeCharged / StreamsCreated /│
│              FeeWithdrawn                                          │
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
| `DataKey::NextIntentId` | `u64` | monotonic scheduled-intent id counter |
| `DataKey::Intent(id)` | `ScheduledIntent` | full per-intent state (escrow, timing, `params_hash`) |
| `DataKey::SenderIntents(addr)` | `Vec<u64>` | append-only intent ids scheduled by `addr` |
| `DataKey::Governor` *(instance)* | `Address` | treasury governor (constructor-set, two-step rotated) |
| `DataKey::PendingGovernor` *(instance)* | `Address` | rotation in progress |
| `DataKey::FeeBps` *(instance)* | `u32` | fee rate in basis points; absent = 0 (disabled) |
| `DataKey::Treasury(token)` | `Treasury` | per-token fee accounting (`charged_total`, `withdrawn_total`) |
| `DataKey::StreamFee(id)` | `StreamFeeRecord` | fee charged at creation: amount + token; absent = 0 |

Streams live in **persistent** storage. Every mutating entrypoint that touches
a stream extends its TTL (`TTL_THRESHOLD_LEDGERS = 200_000`, extend to
`500_000` ≈ 29 days), so a stream that is being used never goes cold, while
abandoned streams naturally archive to off-chain recovery — the Soroban-native
way to bound state bloat without penalizing active users. Index entries get
the same TTL treatment on write *and* on read, so an actively-queried address
stays hot. Scheduled intents reuse the same persistent-storage + TTL regime
(`schedule.rs`), so an unfunded intents registry is bounded the same way.

Nothing extends `DataKey::NextStreamId`, the contract instance entry or the
Wasm code entry, and invoking a contract does not auto-extend instance/code
entries either. All three therefore expire `min_persistent_entry_ttl - 1` =
4,095 ledgers (~5.7 h) after creation unless something extends them — an
operational constraint §12 covers in detail.

There is still **no global registry** of all streams (no contract-wide
`Vec<u64>`): that would make `create_stream` cost grow with total stream count.
Instead, discovery is **per-address**: `create_stream` appends the new id to
the sender's and the recipient's own index lists — each bounded by that one
user's activity, written only at creation, and paginated on read
(`recipient_streams` / `sender_streams`, `limit` clamped to
`MAX_PAGE_SIZE = 50`). `create_streams` reserves its contiguous id range with
one counter write and groups token pulls by token; stream records and address
indexes remain per stream. The indexes are *advisory*: never authorize against
them; the `Stream` entry is the source of truth. A single-stream call emits
`StreamCreated`; a batch emits one `StreamsCreated` event listing its ids.
Fee-enabled batches retain one `FeeCharged` event per charged stream, keeping
the fee ledger independently auditable.

### Storage layout decision & read/write profiling

A gas optimization evaluation (`scripts/benchmark_storage.sh`, benchmark harness at `contracts/streaming-payments/examples/storage_benchmark.rs`) profiled resource consumption across stream lifecycle operations and evaluated splitting hot mutable fields (`withdrawn`, `status`) from cold immutable fields (`sender`, `recipient`, `token`, `deposit`, `start_time`, `end_time`, `cancelable`).

#### Lifecycle Resource Costs (Monolithic Layout)

| Operation | Type | Storage Footprint | CPU Instructions | Memory (Bytes) |
|---|---|---|---:|---:|
| `create_stream` | Write | 1 Stream + 2 Indexes | 509,718 | 201,404 |
| `get_stream` | Read | 1 Stream Entry | 61,239 | 38,379 |
| `available` | Read | 1 Stream Entry | 54,361 | 37,727 |
| `withdraw` | RMW | 1 Stream Entry | 333,895 | 135,533 |
| `top_up` | RMW | 1 Stream Entry | 419,382 | 159,563 |
| `cancel_stream` | RMW | 1 Stream Entry | 504,711 | 167,915 |
| `withdraw_max` | RMW | 1 Stream Entry | 330,953 | 131,167 |

#### Architecture Comparison: Monolithic vs Split (Hot/Cold)

| Storage Pattern | Entry Count | Keys Written/Read | CPU Instructions | Memory (Bytes) |
|---|:---:|:---:|---:|---:|
| Monolithic `Stream` Write | 1 | 1 key | 54,004 | 39,817 |
| Split (Cold + Hot) Write | 2 | 2 keys | 90,988 *(+68.5%)* | 57,315 |
| Monolithic `Stream` Read | 1 | 1 key | 45,094 | 34,207 |
| Split Read (Both: required by `withdraw`/`cancel`) | 2 | 2 keys | 71,030 *(+57.5%)* | 47,314 |
| Split Read (Hot-only: status check) | 1 | 1 key | 39,009 | 25,013 |

#### Storage Layout Decision & Negative Result

1. **Monolithic Layout Retained:** Stream state remains in a single `DataKey::Stream(u64)` persistent entry (~188 bytes XDR).
2. **Negative Result for Hot/Cold Splitting:** In Soroban's storage and metering architecture, ledger entry overhead, storage keys, and per-entry footprint fees heavily outweigh minor payload byte differences. Every mutating entrypoint (`withdraw`, `withdraw_max`, `cancel_stream`, `top_up`) strictly requires both configuration fields (token, deposit, window, recipient/sender authorization) and state fields (`withdrawn`, `status`). Splitting state forces two ledger reads and one write across two keys, incurring a **+57.5% CPU read penalty** and a **+68.5% CPU write penalty** without saving gas on any mutation path.
3. **Double-Read Elimination:** The contract avoids double reads in `withdraw`: `authorize_withdrawal` loads `s` once and passes `&mut s` directly to `pay_out`, preventing redundant re-reads.


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
| `create_streams` | anyone; `sender` must authorize once for the batch | sender |
| `withdraw` | recipient only | recipient |
| `cancel_stream` | sender always; recipient iff `cancelable` | caller |
| `top_up` | sender only | sender |
| `attach_metadata` | sender or recipient | attester |
| `schedule_stream` | anyone; `sender` must authorize | sender |
| `execute_scheduled` | anyone (keeper) | keeper (the caller) |
| `cancel_scheduled` | intent sender, before the window opens | sender |
| `reclaim_expired` | anyone, after `expires_at` | none |

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
- `create_stream` / `create_streams` / `top_up`: pull tokens first, persist after — if a
  reentrant callback abused the transfer-in, the persisted state still
  reconciles with the balance (invariant below).
- `schedule_stream`: validates, commits `params_hash`, persists the intent,
  emits, *then* pulls the escrow. A failed transfer rolls the invocation back.
- `execute_scheduled`: decrements `occurrences_remaining` (terminal when it hits
  zero), persists, creates the stream, emits, *then* pays the keeper. A
  reentrant token callback finds the occurrence already consumed.
- `cancel_scheduled` / `reclaim_expired`: mark terminal, refund, then emit.

Additionally, `withdraw` and `cancel_stream` re-read `status` after auth: a
malicious token contract that reenters `withdraw` during its own transfer
callback finds `withdrawn` already updated, and `available_amount` reverts to
the *post-write* (smaller or zero) value. The suite contains a
malicious-token test that attempts exactly this reentry.

**Token failures are caught and re-typed, never swallowed.** Every token call
goes through the SDK's fallible (`try_`) client; any failure — missing
allowance or balance, an asset that refuses to move, a non-SEP-41 callee — is
re-raised as the matching `*TransferFailed` code (26–30, §7). The mapping is
necessary because contract error numbers share the `Error(Contract, #N)`
namespace: without it, a token's own `#5` would surface to clients as
StreamPay's `StreamNotActive`. The mapped error is still returned as `Err`,
so the host rolls back the *entire* invocation — effects already written and
the event log included — exactly as an uncaught token error would have.
Tests assert this rollback per entrypoint (state, balances, and events after
a refused transfer).

**Balance invariant:** the contract's token balance is always
`≥ Σ (deposit − withdrawn)` across live streams **plus** `Σ (charged_total −
withdrawn_total)` across token treasuries. Funds enter only via
`create_stream`/`top_up` and leave only via `withdraw`/`cancel_stream`
(stream leg) and `withdraw_treasury` (fee leg), and every exit is bounded
by `0 ≤ withdrawn ≤ streamed ≤ deposit` or by the collectible fee balance
respectively. The two ledgers never mix: the fee a sender paid at creation
is never part of any stream's `deposit`, so no payout path can reach it.

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
| 18 | `MetadataTagTooLong` | `attach_metadata` tag exceeds `MAX_TAG_LEN` (32 bytes) |
| 19 | `MetadataLimitReached` | `attach_metadata` on a stream already holding `MAX_ATTESTATIONS_PER_STREAM` (32) |

| 14 | `FeeRateTooHigh` | `set_fee_bps` above `MAX_FEE_BPS` |
| 15 | `NotGovernor` | non-governor calls a governor-gated function (also: non-nominee `accept_governor`) |
| 16 | `NoPendingGovernor` | `accept_governor` with no nomination pending |
| 17 | `InsufficientTreasuryBalance` | treasury withdrawal above fees collected minus fees withdrawn |
| 18 | `IntentNotFound` | no scheduled intent with this id |
| 19 | `IntentNotPending` | intent already executed / cancelled / expired |
| 20 | `IntentNotYetExecutable` | before the occurrence's `due` time |
| 21 | `IntentExpired` | `now ≥ expires_at` on execute/cancel |
| 22 | `IntentNotCancellable` | cancel after the execution window opened |
| 23 | `InvalidScheduleParameters` | bad interval/occurrences/`execute_after`/`expires_at` |
| 24 | `IntentParamsMismatch` | stored params no longer match `params_hash` |
| 25 | `IntentNotExpired` | `reclaim_expired` before `expires_at` |
| 26 | `DepositTransferFailed` | `create_stream` / `create_streams` token pull failed (allowance/balance, or the asset refused the transfer) |
| 27 | `TopUpTransferFailed` | `top_up`'s token pull failed; `deposit` left unchanged |
| 28 | `RecipientPayoutFailed` | token refused a payout to the recipient (`withdraw`, `withdraw_max`, or the recipient leg of `cancel_stream`) |
| 29 | `SenderRefundFailed` | token refused the sender's refund at cancellation; the cancellation rolls back |
| 30 | `TreasuryPayoutFailed` | token refused the payout of collected protocol fees in `withdraw_treasury`; the withdrawal record and event roll back |

Codes 26–30 are *transfer-failure* codes: a token's own error number is
deliberately never propagated (see §5), so clients can always branch on these
instead of parsing an opaque `Error(Contract, #N)`.

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

**Scheduled intents: native auth at schedule time, funds escrowed up front.**
The sender authorizes the *scheduling* call (a normal Soroban
`require_auth()`), and the contract commits the exact parameters into a SHA-256
`params_hash` and pulls `(deposit + fee) × occurrences` immediately. Execution
is then permissionless and needs no sender key: the keeper authorizes only its
own call (which is what entitles it to the fee and prevents front-running).
Escrowing up front is the load-bearing choice — it removes the "keeper executes
an unfunded intent and wastes gas" failure mode entirely, at the cost of
locking the sender's capital from scheduling until the last occurrence (or
expiry). Recurring intents are modeled as N independent one-shot executions of
a fixed-window recurrence, so catch-up and partial progress need no migration
state. The full threat model (replay, front-running, under-funded-keeper
griefing) is in [`SCHEDULED_INTENTS.md`](./SCHEDULED_INTENTS.md).

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
  a Soroban host: bounds (`0 <= result <= deposit`), exact floor-ratio
  reference comparison, monotonicity in elapsed time, full-duration exactness
  (`streamed_at(d, dur, dur) == d` for admissible pairs), and no panics for
  arbitrary inputs (including negative deposits and zero duration where
  the function returns `Ok(0)` or `Err(MathOverflow)`). CI runs a scheduled
  session (`fuzz.yml`, non-blocking); any crash becomes a regression unit test.
- **Error surface** (`error_surface_test.rs`): the branch registry in
  `surface.rs` is walked by generated tests — one probe per branch asserts the
  exact branch fires its declared code — plus coverage tests proving no code is
  dead and no branch uncoded. `docs/ERRORS.md` is generated from the same table
  and diffed in CI.
- **`withdraw_max`** shares the `withdraw` payout tail (`pay_out`) so both
  paths inherit the same CEI ordering and reentrancy proof; index pagination
  and TTL behavior have dedicated tests in `test.rs`.
- **Scheduled intents** (`schedule_test.rs`) cover the full lifecycle:
  one-shot and recurring execution, double-execution rejection, the
  cancel/execute race, expired-auth replay, permissionless reclaim, refund
  accounting, and every validation/error path.
- **Treasury property test** (`property_random_activity_sequences_keep_the_verifier_in_agreement`):
  seeded (reproducible) random activity sequences — creates, partial/full
  withdrawals, over-withdraw attempts, cancels by both parties, top-ups,
  fee reconfigurations, treasury drains and guaranteed-fail treasury
  attempts, across two tokens — assert after **every** step that
  `treasury_status` equals an independent off-chain model, the paged
  `verify_treasury` scan sums exactly to `charged_total` (the verifier
  always agrees), per-stream `stream_fee` reads match the model, and the
  contract's token balance equals outstanding stream funds plus collectible
  fees — the fee ledger and the stream ledger never mix.

## 10. Open problems / roadmap hooks

- `pause_stream` (sender-initiated temporary hold) — needs a fourth status and
  careful `cancel_amounts` treatment; drafted as a good-first-issue.
- Multi-token batch creation — one tx, N streams; watch the instruction
  budget, likely `try_create_batch` with per-item results.
- Gas optimization pass on storage reads — `cancel_stream` does one
  read-modify-write; a `Stream` split into hot/cold fields could shave bytes.
- Event indexer & reconciler services — TypeScript workers polling `getEvents` per topic
  `stream_id`, materializing stream history for the UI, and continuously auditing on-chain truth.
  Instrumented with Prometheus metrics, Grafana dashboards, and alert rules (see [`infra/observability`](../infra/observability/README.md)
  and [`docs/RUNBOOK.md`](./RUNBOOK.md)).
- Contract-side TTL maintenance — extend `NextStreamId`, the instance entry and
  the code entry from inside the contract (or from the deploy path) instead of
  relying on the external sentinel. Costs rent on the write path but removes
  the ~5.7 h cliff in §12 entirely.

## 11. Treasury: protocol fees and their auditable distribution

An **optional** fee layer, on by default *off* (`fee_bps = 0`), that funds
protocol sustainability without touching a single line of the per-second
accrual math.

### 11.1 Fee model — charged at the deposit boundary only

When (and only when) a stream is created while `fee_bps > 0`, the sender
pays `deposit + fee` in a single `transfer_from` pull, where

```text
fee = deposit × fee_bps / 10_000        (floored; fee_bps ≤ MAX_FEE_BPS = 100)
```

- The stream's stored `deposit` is exactly the requested amount. `streamed_at`,
  `available`, `withdraw`, `withdraw_max` and `cancel_amounts` are byte-for-byte
  the v0.3 code paths — the fee is invisible to accrual and payout.
- **Non-refundable, outside the stream.** The fee is never split, never
  refunded, and never enters either leg of a cancellation.
- **Floored to zero ⇒ no fee.** A fee that rounds below one whole token unit
  charges nothing, stores nothing (`StreamFee` entry absent), and emits no
  `FeeCharged` event.
- **Top-ups are fee-free.** The fee is charged once, at creation; `top_up`
  pulls face value only. (Charging per top-up would make the fee a tax on
  *changing* a payroll, not on opening one; rejected for v1.)
- **Only new streams pay.** `set_fee_bps` applies to streams created
  afterwards; existing streams' economics are frozen at their creation-time
  boundary.
- **`fee_bps == 0` (the default, and the only mode any v0.3 deployment ran)
  is bit-for-bit backward compatible:** no extra pull, no treasury writes,
  no extra event, identical balances.

Economic defaults are deliberately conservative: the protocol cap
`MAX_FEE_BPS = 100` (1 %) is a hard constant, not governor-settable —
raising it requires a new Wasm release and is an auditable interface change.

### 11.2 Accumulation account

Fees accumulate per token in `DataKey::Treasury(token) → { charged_total,
withdrawn_total }`, written only in lockstep with the fee events:
`charged_total` moves exactly when a `FeeCharged` is emitted,
`withdrawn_total` exactly when a `FeeWithdrawn` is. Each funded stream also
stores its own fee under `DataKey::StreamFee(id) → { token, amount }`, so
the per-stream record and the per-token totals are two independent records
of the same fact.

### 11.3 Withdrawal governance

- The governor is bound **at deploy time** by `__constructor(governor)` —
  no `initialize()` call to front-run, no admin-less window.
- Rotation is **two-step** (`nominate_governor` → `accept_governor`): only
  an address that can prove control by authorizing the acceptance becomes
  governor, so a typo'd nomination can never strand the treasury.
- `withdraw_treasury(token, recipient, amount)` is governor-only, bounded
  by `charged_total − withdrawn_total` (`InsufficientTreasuryBalance`), and
  follows CEI: accounting + `FeeWithdrawn` event before the transfer.
- `set_fee_bps` is governor-only and capped at `MAX_FEE_BPS`.

### 11.4 Cancel-refund decision table (fees × cancellation)

| State at cancel | Recipient leg | Sender leg | Treasury |
|---|---|---|---|
| before `start_time` | 0 | full `deposit` | keeps the fee (not refunded) |
| mid-stream | `streamed − withdrawn` | `deposit − streamed` | keeps the fee |
| at/after `end_time` | `deposit − withdrawn` | 0 | keeps the fee |
| cancelled/depleted stream | reverts `StreamNotActive` — unchanged | — | — |

The split legs are exactly the fee-less formulas; the fee sits outside
both. Proof: `cancel_amounts` operates solely on `deposit`, `withdrawn` and
`streamed_at` — none of which the fee layer ever mutates.

### 11.5 Open verification — `fee_total == Σ fee events`, from public reads

Three independently readable records must always agree:

1. **Stored totals:** `treasury_status(token)` → `charged_total`,
   `withdrawn_total`, `collectible`.
2. **Stored per-stream fees:** `verify_treasury(token, start_id, count)`
   pages over the stream-id space (`count` clamped to `MAX_PAGE_SIZE`),
   summing `StreamFee` entries for that token (the record carries its
   token, so interleaved multi-token ids filter correctly). Page from id 1
   until `done`; the Σ must equal `charged_total`. `stream_fee(stream_id)`
   gives the per-stream value, and `total_streams()` gives the scan range.
3. **Event trail:** `FeeCharged` (topic: `stream_id`; data: token, payer,
   amount, effective `fee_bps`) and `FeeWithdrawn` (topic: `token`; data:
   governor, recipient, amount, cumulative `withdrawn_total`) via RPC
   `getEvents`.

`scripts/verify-fees.ts` automates all three cross-checks against a public
RPC endpoint; anyone can run it with no keys. The scan extends the TTL of
every fee entry it touches, so an actively-verified ledger stays hot; an
old, unverified range may have archived entries — same recovery story as
an abandoned stream (restore via RPC before re-verifying that range).

### 11.6 Rejected alternatives

- **Fee out of the deposit** (recipient receives `deposit − fee`): couples
  the fee to accrual, retroactively complicates every payout formula and
  the cancel split, and violates "fees never touch the accrual math".
  Rejected.
- **Fee on top-ups as well:** turns the fee into a tax on payroll
  adjustments; the sender's ongoing cost becomes unpredictable. Rejected
  for v1 (documented; would need its own event and decision table).
- **Governor-less or deploy-script-initialized treasury:** any post-deploy
  `initialize` has a front-running window on a public chain. Rejected in
  favor of a constructor.
- **One-step governor transfer:** a typo'd address irreversibly strands
  all future fees. Rejected in favor of nominate/accept.
- **Unbounded in-contract `verify_all` scan:** violates the "no unbounded
  scans" rule (instruction budget); the bounded paged scan composes to a
  full verification at the client layer instead.

## 12. TTL and rent operations

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
