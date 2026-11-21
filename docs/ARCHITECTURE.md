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
│              cancel_stream / top_up / raise_dispute /              │
│              resolve_dispute / expire_dispute / get_stream /       │
│              available / get_dispute / required_dispute_bond /     │
│              recipient_streams / sender_streams / set_fee_bps /    │
│              nominate_governor / accept_governor / withdraw_treasury│
│              treasury_status / stream_fee / verify_treasury /       │
│              total_streams                                         │
│  stream.rs   Stream type, storage, checked accrual math            │
│  dispute.rs  Dispute state, escalating bond math, expiry split     │
│  lib.rs      entrypoints: create_stream(s) / withdraw / withdraw_max /│
│  lib.rs      entrypoints: create_stream / create_streams /          │
│              create_streams_batch / withdraw / withdraw_max /       │
│              withdraw_all / cancel_stream / top_up / get_stream /   │
│              recipient_streams / sender_streams / schedule_stream / │
│              execute_scheduled / cancel_scheduled / reclaim_expired │
│              set_fee_bps / nominate_governor / accept_governor /    │
│              withdraw_treasury / treasury_status / stream_fee /     │
│              verify_treasury / total_streams /                      │
│              propose_ownership_transfer / accept_ownership_transfer │
│              cancel_ownership_transfer / pending_ownership_transfer │
│              propose_rate_change / accept_rate_change /             │
│              cancel_rate_change / rate_segments /                   │
│              pending_rate_change (views)                            │
│  stream.rs   Stream + ownership/rate types, piecewise accrual       │
│              RateSegment = (allocation, basis_seconds) per window   │
│  schedule.rs ScheduledIntent type, validation, timing, escrow      │
│  treasury.rs protocol-fee math, per-token accounting, governor,    │
│              verification scan (see §11)                           │
│  errors.rs   StreamError — stable numeric codes, append-only       │
│  events.rs   StreamCreated / Withdrawn / StreamCancelled /         │
│              StreamToppedUp / DisputeRaised / DisputeResolved /    │
│              DisputeExpired (stream_id as topic), FeeCharged       │
│              (stream_id as topic), FeeWithdrawn (token as topic)   │
│              StreamToppedUp / StreamScheduled /                    │
│              ScheduledStreamExecuted / ScheduledIntentCancelled /  │
│              ScheduledIntentExpired / FeeCharged / StreamsCreated /│
│              FeeWithdrawn / OwnershipProposed / Accepted /          │
│              RateChangeProposed / RateChangeAccepted                │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ token interface (SAC-compatible)
                           ▼
              Stellar Asset Contract / custom token
```

## 2. Storage model

| Key | Value | Purpose |
|---|---|---|
| `DataKey::NextStreamId` | `u64` | monotonic id counter (ids start at 1) |
| `DataKey::Stream(id)` | `VersionedStream` | tagged envelope (`{ version, stream }`) holding the full per-stream state; a legacy untagged `Stream` map still decodes as v1 (see [`UPGRADES.md`](./UPGRADES.md)) |
| `DataKey::RecipientStreams(addr)` | `Vec<u64>` | append-only ids where `addr` receives |
| `DataKey::SenderStreams(addr)` | `Vec<u64>` | ids `addr` currently pays: append-only, except that a consented sender-role transfer prunes the outgoing holder's entry (§19) |
| `DataKey::NextIntentId` | `u64` | monotonic scheduled-intent id counter |
| `DataKey::Intent(id)` | `ScheduledIntent` | full per-intent state (escrow, timing, `params_hash`) |
| `DataKey::SenderIntents(addr)` | `Vec<u64>` | append-only intent ids scheduled by `addr` |
| `DataKey::Governor` *(instance)* | `Address` | treasury governor (constructor-set, two-step rotated) |
| `DataKey::PendingGovernor` *(instance)* | `Address` | rotation in progress |
| `DataKey::FeeBps` *(instance)* | `u32` | fee rate in basis points; absent = 0 (disabled) |
| `DataKey::Treasury(token)` | `Treasury` | per-token fee accounting (`charged_total`, `withdrawn_total`) |
| `DataKey::StreamFee(id)` | `StreamFeeRecord` | fee charged at creation: amount + token; absent = 0 |
| `DisputeKey::Active(id)` | `Dispute` | the open dispute on `id` (bond, window) — its presence *is* the freeze flag |
| `DisputeKey::Count(id)` | `u32` | disputes ever raised on `id`; persists across resolution, drives the escalating bond |
| `DataKey::PendingOwnership(id)` | `PendingOwnership` | at most one unexpired role-proposal per stream |
| `DataKey::PendingRateChange(id)` | `PendingRateChange` | at most one unexpired rate-proposal per stream; absent = no offer |
| `DataKey::RateSegments(id)` | `Vec<RateSegment>` | accepted rate schedule, ≤ `MAX_RATE_SEGMENTS` windows; absent = never renegotiated |
| `DataKey::PendingSenderTransfer(id)` | `PendingSenderTransfer` | at most one unexpired sender-role proposal per stream |
| `DataKey::SenderHistory(id)` | `SenderHistory` | append-only log: sender at creation + every consented hop |
| `DataKey::RefundTarget(id)` | `Address` | who owns the cancellation remainder; absent = the current `sender`; re-pointable by the sender (§20) |

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
user's activity, written at creation and on an accepted role transfer, and
paginated on read
(`recipient_streams` / `sender_streams`, `limit` clamped to
`MAX_PAGE_SIZE = 50`). `create_streams` reserves its contiguous id range with
one counter write and groups token pulls by token; stream records and address
indexes remain per stream. The indexes are *advisory*: never authorize against
them; the `Stream` entry is the source of truth. A single-stream call emits
`StreamCreated`; a batch emits one `StreamsCreated` event listing its ids.
Fee-enabled batches retain one `FeeCharged` event per charged stream, keeping
the fee ledger independently auditable.

### Storage layout decision & read/write profiling

A gas optimization evaluation (`contracts/streaming-payments/examples/storage_benchmark.rs`; detailed report in [`docs/FOOTPRINT.md`](FOOTPRINT.md)) profiled resource consumption across stream lifecycle operations and evaluated candidate optimizations including splitting hot mutable fields (`withdrawn`, `status`) from cold immutable fields (`sender`, `recipient`, `token`, `deposit`, `start_time`, `end_time`, `cancelable`).

#### Lifecycle Resource Costs (Monolithic Layout)

| Operation | Type | Storage Footprint | CPU Instructions | Memory (Bytes) | Event Bytes (XDR) |
|---|---|---|---:|---:|---:|
| `create_stream` | Write | 1 Stream + 2 Indexes | 541,598 | 210,434 | 396 B |
| `get_stream` | Read | 1 Stream Entry | 66,664 | 40,243 | 0 B |
| `available` | Read | 1 Stream Entry | 58,284 | 39,461 | 0 B |
| `withdraw` | RMW | 1 Stream Entry | 347,082 | 138,899 | 236 B |
| `top_up` | RMW | 1 Stream Entry | 447,290 | 167,390 | ~76 B |
| `cancel_stream` | RMW | 1 Stream Entry | 523,563 | 171,201 | 248 B |
| `withdraw_max` | RMW | 1 Stream Entry | 338,663 | 134,329 | 236 B |
| `sender_streams (5 ids)` | Read | 1 Index Entry | 52,369 | 25,006 | 0 B |

#### Architecture Comparison: Monolithic vs Split (Hot/Cold)

| Storage Pattern | Entry Count | Keys Written/Read | CPU Instructions | Memory (Bytes) |
|---|:---:|:---:|---:|---:|
| Monolithic `Stream` Write | 1 | 1 key | 60,956 | 43,537 |
| Split (Cold + Hot) Write | 2 | 2 keys | 98,480 *(+61.6%)* | 60,375 |
| Monolithic `Stream` Read | 1 | 1 key | 48,319 | 36,485 |
| Split Read (Both: required by `withdraw`/`cancel`) | 2 | 2 keys | 73,200 *(+51.5%)* | 47,926 |
| Split Read (Hot-only: status check) | 1 | 1 key | 41,123 | 25,625 |

#### Storage Layout Decision & Tradeoff Evaluation

1. **Monolithic Layout Retained:** Stream state remains in a single `DataKey::Stream(u64)` persistent entry (444 bytes XDR payload + 40 bytes key = 484 bytes total).
2. **Negative Result for Hot/Cold Splitting:** In Soroban's storage and metering architecture, ledger entry overhead, storage keys, and per-entry footprint fees heavily outweigh minor payload byte differences. Every mutating entrypoint (`withdraw`, `withdraw_max`, `cancel_stream`, `top_up`) strictly requires both configuration fields (token, deposit, window, recipient/sender authorization) and state fields (`withdrawn`, `status`). Splitting state forces two ledger reads and one write across two keys, incurring a **+51.5% CPU read penalty** and a **+61.6% CPU write penalty** without saving gas on any mutation path.
3. **Double-Read & Host Resolution Elimination:** The contract avoids double reads in `withdraw`: `authorize_withdrawal` loads `s` once and passes `&mut s` directly to `pay_out`. In `pull` and `cancel_stream`, `env.current_contract_address()` is resolved once and cached across transfers, saving 548 CPU instructions and 80 memory bytes.
4. **Native Index Slicing:** In `page_stream_ids`, pagination utilizes native `ids.slice(start..end)`, eliminating manual looping and intermediate allocation overhead.



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

### 3.1 Piecewise rates: a stream that renegotiated (issue #54)

A renegotiation replaces the rate for the *remainder* of the window. The stream
therefore carries a schedule of `RateSegment { start_time, end_time, allocation,
basis_seconds }` windows that partition `[start_time, end_time)`, and accrual
becomes a sum over them — still one pure function, still `streamed_at`:

```rust
streamed_amount_at_segments(stream, now, segments)
    = Σ segment_accrual(segment, now)          // each is streamed_at(
                                               //   allocation, basis_seconds,
                                               //   elapsed inside its window)
```

- **An empty schedule is not a special case.** It short-circuits to
  `streamed_amount_at`, the pre-#54 path, so a stream that never renegotiated
  prices identically, to the token unit, error included.
- **The past is not re-priced.** The window that existed before the change is
  *clipped* at the boundary: only `end_time` moves, while `allocation` and
  `basis_seconds` carry over untouched. Accrual at any `now ≤ boundary` is what
  it would have been had no change happened — the property
  `rate_change_never_reprices_the_past` pins, against the original
  `(deposit, duration)` pair rather than against a second reading of contract
  state.
- **The new window has no rounding residue.** `accept_rate_change` writes
  `allocation = amount_per_second * window_seconds` and `basis_seconds =
  window_seconds`, so `streamed_at` divides an integer product by the very
  number it was multiplied by: accrual is exactly `rate * elapsed`, and the
  window reaches exactly `allocation` at `end_time`. The floor dust stays in the
  original window, where property 4 above already accounts for it.
- **Escrow and schedule always agree.** At acceptance, `owed` is the schedule's
  accrual at the boundary and `reserved = new_rate * remaining_seconds`; the
  deposit becomes `owed + reserved`, and the difference
  `reserved − (deposit − owed)` is pulled from the sender (increase) or refunded
  to them (decrease). `deposit == Σ allocations` therefore holds after the
  change, which is what keeps `withdraw_max`, `cancel_stream` and the
  conservation fuzz oracle exact at the endpoint.
- **Bounded.** `MAX_RATE_SEGMENTS = 32` windows; past the cap acceptance reverts
  with `TooManyRateSegments` (83) and the offer survives, so the worst-case
  pricing cost is measurable rather than assumed
  (`full_schedule_pricing_is_bounded`, `docs/FOOTPRINT.md`).

## 4. Auth model

| Action | who may call | auth consumed |
|---|---|---|
| `create_stream` | anyone; `sender` must authorize | sender |
| `create_streams` | anyone; `sender` must authorize once for the batch | sender |
| `withdraw` | recipient only | recipient |
| `cancel_stream` | sender always; recipient iff `cancelable` | caller |
| `top_up` | sender only | sender |
| `propose_ownership_transfer` | current sender or recipient | caller |
| `accept_ownership_transfer` | named pending `new_owner` only | new owner |
| `cancel_ownership_transfer` | pending proposer only | proposer |
| `propose_rate_change` | current sender or recipient | caller |
| `accept_rate_change` | the offer's named counterparty only; an increase additionally consumes the sender's auth, since funds move from them | counterparty (+ sender on an increase) |
| `cancel_rate_change` | pending proposer only | proposer |
| `propose_sender_transfer` | the stream's current sender only | caller (the outgoing sender) |
| `accept_sender_transfer` | the stream's recipient only, with the stored nonce | recipient |
| `expire_sender_transfer` | anyone, after the proposal window | none |
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
- `create_stream` / `create_streams` / `top_up`: pull tokens before persisting
  stream records — if a reentrant callback abused the transfer-in, the
  persisted state still reconciles with the balance (invariant below).
- `withdraw_treasury`: bump `withdrawn_total`, persist the treasury, emit
  `FeeWithdrawn`, *then* `token.transfer` (§11.3).
- `create_stream` / `top_up`: pull tokens first, persist after — if a
  reentrant callback abused the transfer-in, the persisted state still
  reconciles with the balance (invariant below).
- `create_stream` / `create_streams` / `top_up`: pull tokens first, persist after — if a
  reentrant callback abused the transfer-in, the persisted state still
  reconciles with the balance (invariant below).
- `schedule_stream`: validates, commits `params_hash`, persists the intent,
  emits, *then* pulls the escrow. A failed transfer rolls the invocation back.
- `execute_scheduled`: decrements `occurrences_remaining` (terminal when it hits
  zero), persists, creates the stream, emits, *then* pays the keeper. A
  reentrant token callback finds the occurrence already consumed.
- `cancel_scheduled` / `reclaim_expired`: mark terminal, refund, then emit.
- `accept_rate_change` splits by direction, because the two directions move funds
  to different counterparties. An **increase** is a top-up wearing a schedule:
  price the change, `transfer_from` the shortfall from the sender, *then* write
  `deposit` and the schedule, clear the offer, emit — so a reentrant token
  callback can only ever see a stream whose escrow already covers it
  (`accept_rate_increase_operation_order_matches_golden`). A **decrease** frees
  escrow the new rate no longer needs, so it is effects-first: write the schedule
  and the smaller `deposit`, emit, *then* `transfer` the refund — were the refund
  to fail, the whole acceptance rolls back rather than half-applying a schedule
  (`accept_rate_decrease_operation_order_matches_golden`). A failed pull is
  checked *before* any effect, which is why "rate increase without funds" leaves
  the stream, the schedule and the open offer exactly as they were.

Additionally, `withdraw` and `cancel_stream` re-read `status` after auth: a
malicious token contract that reenters `withdraw` during its own transfer
callback finds `withdrawn` already updated, and `available_amount` reverts to
the *post-write* (smaller or zero) value. The suite contains a
malicious-token test that attempts exactly this reentry.

The dispute paths follow the same ordering: `resolve_dispute` deletes the
`Dispute` entry and (on accept) finalizes the `Stream` **before** any of the
bond/settlement transfers; `expire_dispute` deletes the entry before paying
the split. A reentrant token callback during a bond transfer therefore never
sees a half-closed dispute — and the freeze checks in `cancel_stream` /
`top_up` re-read the dispute entry rather than trusting a caller-supplied
state.
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
`≥ Σ (deposit − withdrawn)` across live (non-cancelled) streams, **plus** the
sum of the outstanding dispute bonds, **plus** `Σ (charged_total −
withdrawn_total)` across token treasuries. Funds enter only via
`create_stream`/`top_up`/`raise_dispute` and leave only via
`withdraw`/`cancel_stream`/`resolve_dispute`/`expire_dispute` (stream and
bond legs) and `withdraw_treasury` (fee leg), and every exit is bounded by
`0 ≤ withdrawn ≤ streamed ≤ deposit` or by the collectible fee balance
respectively. The ledgers never mix: the fee a sender paid at creation and
the bond a recipient posts are never part of any stream's `deposit`, so no
payout path can reach them. A seeded random-scenario property test re-checks
this exact equality after every operation
(`property_contract_balance_equals_locks_plus_outstanding_bonds`).

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
- Ownership transfers are proposed and accepted only on `Active` streams; a
  pending proposal for a stream that later becomes terminal can never move a
  role (the failed call reverts, and a later proposal is rejected).

### Disputed: an overlay, not a status

A dispute never changes `StreamStatus`. It is an orthogonal *overlay* — the
existence of a `DisputeKey::Active(id)` entry — layered on top of `Active`:

```text
 Active ──raise_dispute(bond)──▶ Active + Dispute ──resolve(accept=false)──▶ Active (bond → sender)
    │                                 │     │
    │                                 │     ├─resolve(accept=true)──▶ Cancelled (pro-rata unwind,
    │                                 │     │                         bond → recipient)
    │                                 │     └─expire_dispute (after 7 d)──▶ Active
    │                                 │                                    (bond split 50/50)
    │                                 └── withdraw / accrual keep working ──▶ (possibly Depleted)
```

While disputed: `cancel_stream` and `top_up` revert with `DisputeActive`;
`withdraw`, `withdraw_max`, and accrual are unaffected. A stream *can* reach
`Depleted` underneath an open dispute (the recipient withdrew everything);
resolution then only settles the bond. `Depleted` and `Cancelled` streams can
never be disputed (`StreamNotActive`).
### 6.1 Withdraw / cancel race semantics

`withdraw` (recipient) and `cancel_stream` (sender) are strictly serial: each
invocation runs to completion — CEI state writes included — before the next
begins, even when both land in the same ledger. There is no interleaving and
no partial application: **last write wins in execution order**, the losing
call observes the post-write state, and the losing call never mutates
balances. No dedicated race error code exists; the loser always receives the
existing `StreamNotActive` (**code 5**).

| # | First call | Second call | Result of second call | Recipient balance | Sender balance |
|---|---|---|---|---|---|
| 1 | `withdraw(a)`, partial (`a < streamed`) | `cancel_stream` | succeeds — splits the remainder: `streamed − a` to recipient, `deposit − streamed` to sender | `streamed` at cancel time (conserved exactly) | `headroom + (deposit − streamed)` |
| 2 | `withdraw_max` (drains to `Depleted`) | `cancel_stream` | reverts `StreamNotActive` (5) | unchanged by the loser | unchanged by the loser |
| 3 | `cancel_stream` | `withdraw` / `withdraw_max` | reverts `StreamNotActive` (5) | cancel payout only | cancel refund only |

Properties pinned by the `race_*` regression tests in `src/test.rs`:

- **Conservation across the overlap** (row 1): the recipient's total across
  both calls equals the amount accrued at the later call; the sender's refund
  is exactly the unaccrued remainder. No unit is lost or double-paid.
- **The loser is a no-op** (rows 2–3): state, balances, and the event log
  after the reverting call are identical to the state right after the winner.
- **Ordering is temporal, not identity-based**: the same table applies whether
  the recipient or a `cancelable` stream's recipient cancels; authorization
  is checked independently of the race (§4).

This table is normative for future entrypoints too: any `pause_stream`-like
or batched lifecycle operation must preserve "loser reverts with an existing
code, state untouched" rather than introducing a new interleaving case; if it
cannot, it needs an append-only error code and an updated table, not a silent
drift. The same-ledger ordering is documented in the rustdoc of `withdraw` and
`cancel_stream`.

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
| 14 | `DisputeActive` | cancel/top-up attempted while a dispute is open (also: second `raise_dispute`) |
| 15 | `DisputeNotFound` | resolve/expire/get a stream without an open dispute |
| 16 | `DisputeNotExpired` | `expire_dispute` called before the timelock elapsed |

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
| 27 | `TopUpTransferFailed` | `top_up`'s or `accept_rate_change`'s token pull failed; `deposit` left unchanged |
| 28 | `RecipientPayoutFailed` | token refused a payout to the recipient (`withdraw`, `withdraw_max`, or the recipient leg of `cancel_stream`) |
| 29 | `SenderRefundFailed` | token refused the sender's refund at cancellation or at a rate decrease; the operation rolls back |
| 30 | `TreasuryPayoutFailed` | token refused the payout of collected protocol fees in `withdraw_treasury`; the withdrawal record and event roll back |
| 60 | `NoPendingOwnership` | accept/cancel called with no proposal stored |
| 61 | `OwnershipProposalExpired` | accept after the proposal's seven-day window |
| 62 | `InvalidTransferTarget` | proposing to the role's current holder |
| 63 | `OwnershipProposalPending` | proposing while an unexpired proposal exists |
| 83 | `NoPendingRateChange` | accept/cancel called with no rate offer stored |
| 84 | `RateProposalExpired` | accept after the offer's seven-day window |
| 85 | `RateProposalPending` | proposing while an unexpired offer exists |
| 86 | `TooManyRateSegments` | acceptance would exceed `MAX_RATE_SEGMENTS` (32) windows; the offer survives |
| 87 | `SchemaVersionUnsupported` | a stored stream record decodes as neither known layout, or names a version this build cannot read |
| 88 | `SenderTransferNotFound` | `accept_sender_transfer` / `expire_sender_transfer` with no proposal stored |
| 89 | `SenderTransferExpired` | consent after the proposal's seven-day window |
| 90 | `SenderTransferNotExpired` | `expire_sender_transfer` while the window is still open |
| 91 | `SenderTransferNonceMismatch` | consent presenting a nonce that is not the stored proposal's |
| 92 | `SenderTransferPending` | proposing while an unexpired sender-transfer proposal exists |
| 93 | `SenderTransferNotConsenter` | anyone but the stream's recipient executing a sender transfer |
| 94 | `RefundTargetNotSender` | refund routing attempted by a caller who no longer holds the sender role |
| 95 | `RefundTargetUnchanged` | routing to the address that already holds the refund claim |
| 96 | `WithdrawBatchEmpty` | `withdraw_many` with an empty stream list |
| 97 | `WithdrawBatchTooLarge` | `withdraw_many` with more than `MAX_WITHDRAW_BATCH` (20) ids |
| 98 | `WithdrawDuplicateStreamIds` | `withdraw_many` with a repeated id |

Codes 31–59 (policy, upgrades, batch limits, sponsorship, and oracle), the
two-key governance codes 64–79 and the dispute codes 80–82 are catalogued in
[`docs/errors.md`](./errors.md). 87 is the storage-versioning tail
([`UPGRADES.md`](./UPGRADES.md)); 88–93 are the sender-transfer surface (§19),
94–95 the refund-routing surface (§20) and 96–98 the `withdraw_many` bounds.

Codes 26–30 are *transfer-failure* codes: a token's own error number is
deliberately never propagated (see §5), so clients can always branch on these
instead of parsing an opaque `Error(Contract, #N)`.

Codes are **append-only**: never renumber or reuse a variant. Codes 2
(`NotStreamSender`) and 3 (`NotStreamRecipient`) are **retired**: they were
reserved role checks that no entrypoint ever produced, so they are kept (never
renumbered or reused) but marked unreachable.

The authoritative, machine-generated view of this surface lives in
[`docs/ERROR_SURFACE.md`](./ERROR_SURFACE.md): a per-branch table mapping every
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

**Two-step ownership transfer with a single pending slot.** A one-step
`transfer_ownership(new_owner)` is rejected: a typo or a compromised signer
could redirect all future claims irreversibly, and the target might not
control the address. Requiring the target's authorization makes acceptance a
positive confirmation. One slot per stream (rather than one per role) keeps the
state machine small and prevents either party from stacking proposals;
proposing is cheap to retry after cancel/expiry. Proposals expire after seven
days so a forgotten target cannot block a stream forever — the owner can
cancel or replace — while the target cannot accept a stale offer. Indexes stay
append-only (see §2) instead of removing the old holder's id: the removal cost
grows with that address's stream count and would break replay-based readers.

**Terminal states are terminal.** No reactivation, no partial cancellation.
Simplicity is a security feature; richer flows belong in composing contracts
or off-chain UX.

**Recipient-initiated disputes: freeze the lifecycle, never the earnings.**
The recipient can flag an active stream (wrong address, coerced creation),
which freezes `cancel_stream` and `top_up` for up to one timelock window.
What the freeze *excludes* is deliberate: accrual keeps running and the
recipient keeps full access to `withdraw` / `withdraw_max`. Reasoning — (a)
accrued funds are property the recipient already earned by the stream's own
rules; seizing them during a dispute the recipient initiated would punish
the party we are trying to protect, and would make "coerced creation"
strictly worse for the victim; (b) the dispute is a *hold on mutations*, not
a clawback: the sender's funds keep flowing exactly as scheduled, so nothing
about the stream's economics changes while the parties sort things out; (c)
freezing withdrawals would also freeze the only action a disputed recipient
can use to mitigate harm. A dispute is stored as a separate `Dispute` entry
rather than a fourth `StreamStatus`, which keeps existing stream
serialization stable and makes the withdraw path provably untouched.

**Disputes are economically bounded, never free.** A free flag lets a
recipient grief any sender — so raising pulls a bond via `transfer_from`:
`bondₙ = max(1 unit, 5 % of deposit × n)`, where `n` is the dispute count on
*that stream* (persisted in `DisputeKey::Count`). Outcomes: sender rejects
(bad faith) → the bond is slashed to the sender as compensation for the
frozen window and the stream resumes; sender accepts → the bond is refunded
and the stream unwinds with the normal pro-rata cancel split; timelock
expires with no verdict → the bond is **split 50/50** (sender rounds up).

*Griefing-threshold math* (cost per blocked hour vs stream value `D`,
timelock `T` = 7 days = 168 h, base bond `b` = 5 %·D):

- Cheapest attack — the sender stays passive and every dispute dies at
  expiry: the attacker loses `ceil(n·b/2)` per blocked week, i.e.
  `n·b/(2·168) ≈ 0.0149 %·D·n` **per blocked hour** on round `n`.
- Cumulative attacker cost after `k` griefing weeks:
  `Σ n·b/2 = b·k(k+1)/4 ≈ 1.25 %·D·k²`. It crosses the *entire stream value*
  at `k = 2·√(D/b) ≈ 9` weeks — after ~9 rounds the attacker has burned more
  than the stream is worth, while the beneficiary (the recipient) has
  meanwhile withdrawn everything accrued anyway.
- If the sender instead actively rejects each dispute, the cost doubles
  (full bond `n·b`, not half), crossing `D` after ≈ 6 rounds. The sender's
  defense is therefore either one cheap transaction (`resolve_dispute`) or
  simply waiting — both put the escalating cost on the attacker.
- The passive-sender half-slashed expiry is the compromise that keeps the
  legitimate case bounded too: a genuine victim whose coercer never responds
  loses only half an escalating bond per window and always keeps accrued
  funds; rejecting to zero (full refund at expiry) would make serial disputes
  free, and full slashing at expiry would over-punish legitimate recipients
  of unresponsive senders.

Rejected alternatives: a fixed non-escalating bond (serial griefing settles
into a constant hourly price); disputes as a `StreamStatus` variant (breaks
"withdrawals always work" or requires special-casing the status enum);
recipient-initiated *bond withdrawal* before expiry (turns the bond into a
free option: freeze the stream, refund yourself, repeat); on-chain
arbitration committees (out of scope — a dispute hold only needs to be long
enough for the sender to choose: accept and unwind at the normal pro-rata
cost, or reject and put the conflict on record while collecting the bond).
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
  a Soroban host: bounds (`0 <= result <= deposit`), exact floor-ratio
  reference comparison, monotonicity in elapsed time, full-duration exactness
  (`streamed_at(d, dur, dur) == d` for admissible pairs), and no panics for
  arbitrary inputs (including negative deposits and zero duration where
  the function returns `Ok(0)` or `Err(MathOverflow)`). CI runs a scheduled
  session (`fuzz.yml`, non-blocking); any crash becomes a regression unit test.
- **Rate math is pure** (`streamed_at` takes no `Env`), so it runs anywhere a
  plain Rust function runs — no Soroban host required. That is why the
  contract crate is built as `rlib` alongside `cdylib`
  (`contracts/streaming-payments/Cargo.toml`): the `cargo-fuzz` harness in
  [`fuzz/`](../fuzz/fuzz_targets/streamed_at.rs) (its own workspace, excluded
  from the root one because cargo-fuzz needs nightly-only settings) links
  `streamed_at` natively and hammers it with five oracles asserted on every
  input `(deposit, duration, elapsed)`:
  1. no panics, ever (including negatives and zeros);
  2. `Ok(result)` implies `0 <= result <= max(deposit, 0)`;
  3. when `deposit × elapsed` fits in `u128`, the result equals an
     independent floor-ratio reference implementation exactly;
  4. `Err` is *only ever* `MathOverflow`, and only when that product
     genuinely overflows (degenerate inputs return `Ok(0)`);
  5. monotonicity: one more elapsed second never pays out less.

  CI runs a scheduled session (`fuzz.yml`, non-blocking); any crash becomes a
  regression unit test.
- **Error surface** (`error_surface_test.rs`): the branch registry in
  `surface.rs` is walked by generated tests — one probe per branch asserts the
  exact branch fires its declared code — plus coverage tests proving no code is
  dead and no branch uncoded. `docs/ERROR_SURFACE.md` is generated from the same table
  and diffed in CI.
- **`withdraw_max`** shares the `withdraw` payout tail (`pay_out`) so both
  paths inherit the same CEI ordering and reentrancy proof; `withdraw_many`
  (#205) runs that same tail once per requested id, so a batch claim differs
  from twenty single claims only in its per-transaction overhead, never in
  accrual math or event shape. Index pagination and TTL behavior have dedicated
  tests in `test.rs`.
- **Ownership transfer** tests cover propose → accept for both roles,
  propose → cancel → re-propose, expiry at the exact seven-day boundary
  (including lazy replacement and explicit cancellation), rejection of
  strangers/non-targets/self-targets, terminal-stream rejection, mid-accrual
  transfers with exact balance and `withdrawn` assertions, and index contents
  for both the old and new holders. The unknown-key read test pins the
  `extend_ttl` existence check.
- **Rate renegotiation** (`test.rs`) covers the two-step handshake and its
  money: an increase that pulls the exact shortfall, an increase that cannot be
  funded and therefore changes nothing (stream, schedule and open offer all left
  as they were), a decrease that refunds exactly the freed escrow, a decrease
  accepted mid-second on a deposit that does not divide by its duration,
  stranger/non-counterparty/expired/replacement/cancel paths, rejection on a
  terminal stream and on one whose window already elapsed, invalidation of a
  pending offer by a role transfer, the frozen gate, the 32-segment cap, event
  payloads, and `available` / `withdraw_max` / the cancellation split all pricing
  the same schedule.
  - *Backwards compatibility by differential, not by assertion of
    self-consistency*: `empty_plan_matches_single_window_formula` checks an empty
    schedule against the single-window formula, the pure `streamed_at` and the
    cancel split across 144 duration/deposit/offset combinations, and
    `rate_change_never_reprices_the_past` checks the clipped head against the
    original `(deposit, duration)` pair — a model that shares no code with the
    contract path.
  - *Rounding analysis*: `piecewise_accrual_matches_the_reference_models` prices
    20,000 randomly shaped schedules at randomly probed timestamps against two
    models at once — a `u128` long-division floor model for head-shaped windows
    and a division-free `Σ rate × elapsed` model for windows a renegotiation
    wrote — with zero divergence, plus monotonicity and the
    `0 ≤ accrued ≤ Σ allocations` bound. The `--ignored` sibling repeats the same
    analysis over 1,000,000 schedules for release evidence.
  - *Fuzzing*: `fuzz/fuzz_targets/rate_schedule.rs` runs those oracles on
    coverage-guided segment sequences, and `conservation.rs` now renegotiates
    streams inside its random operation sequence and re-prices every stored
    schedule against the reference model.
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

- **Disputes** are covered end to end in `test.rs`: the freeze policy
  (cancel/top-up blocked, withdrawals and accrual alive), auth, double-raise
  rejection, both resolution outcomes with exact bond accounting, expiry
  timing and the odd-bond split, serial-griefing bond escalation, expiry on
  a stream the recipient drained mid-dispute, and the event payloads. The
  balance invariant is re-asserted after every step of a seeded random
  operation script — `sum(deposit − withdrawn)` over live streams plus the
  outstanding dispute bonds.
- **Dispute-bond math is pure** (`required_bond`, `bond_shares` take no
  `Env`), so the `dispute_bond` `cargo-fuzz` target
  ([`fuzz/`](../fuzz/fuzz_targets/dispute_bond.rs)) fuzzes the anti-griefing
  core: the floor, monotonic escalation in rounds and deposit, genuine
  `MathOverflow` only, and the expiry split's conservation
  (`sender + recipient == bond`).

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

## 13. Gas sponsorship: relayed claims without a mempool relayer

Recipients who have never held XLM cannot pay a Soroban transaction fee, so a
first payroll or subscription claim dead-ends at "insufficient funds to claim
funds". Soroban offers no protocol-level relayer and a contract cannot meter
another account's fee, so [`sponsor.rs`](../contracts/streaming-payments/src/sponsor.rs)
implements sponsorship as **inner authorization by dual ed25519 signature**:
the two parties who *would* have signed the transaction sign a canonical
off-chain intent, and any operator may submit it.

### 13.1 Roles

| Role | Key | Signs | Pays |
|---|---|---|---|
| Sponsor | owner key (kept cold) | registration, pause/resume, rotation | budget in the funded token |
| Operator (relayer) | one registered `OperatorKey` per sponsor | the claim intent | the Soroban transaction fee |
| Beneficiary | one enrolled consent key per address | the claim intent | nothing (except the one-time enrollment) |

The sponsor's owner key and the operator key are deliberately separate: the
hot key that submits transactions is never the key that authorizes budget
changes, so a compromised relayer can spend at most the configured cap and can
be rotated out in one call (`rotate_operator_key`).

### 13.2 The exact mechanism chosen

`require_auth` on a plain account cannot be satisfied by a third party, and
`authorize_as_current_contract` (Soroban account contracts) would require every
beneficiary to deploy *and fund* a contract wallet — the opposite of claiming
for free. Instead the contract rebuilds the signed payload itself:

| # | Field | XDR form |
|---:|---|---|
| 1 | `"StreamPay/sponsored-withdraw/v1"` | `ScVal::String` (domain tag) |
| 2–5 | contract id, sponsor, beneficiary, token strkeys | `ScVal::String` |
| 6 | `stream_id` | `ScVal::U64` |
| 7 | `amount` | `ScVal::I128` |
| 8 | `nonce` | `ScVal::U64` |
| 9 | `deadline` | `ScVal::U64` |

`sponsor::message` assembles that `Vec<Val>`; `signature_digest` takes
`Vec<Val>.to_xdr(env)` → `sha256` and both `ed25519_verify` calls run over the
32-byte digest (hash-first, the SDK's recommended posture for auth payloads).
Every field is inside the digest, so a signature cannot be replayed across
streams, amounts, sponsors, tokens, contracts, networks, or time.

The XDR form is pinned twice, once per language: the Rust test
`canonical_relay_message_has_a_frozen_wire_form` (`sponsor_test.rs`) and
`frontend/lib/sponsor.test.ts` assert the same 364-byte message and the same
digest. Rewriting the message on one side alone fails that side's suite rather
than silently invalidating sponsors' signatures.

### 13.3 Check order in `sponsored_withdraw`

`env.crypto().ed25519_verify` **traps** on a bad signature; it is not a
`Result`. All code-returning checks therefore run first, so business failures
stay explainable on the wire and a forged signature simply never lands:

| Order | Check | Failure |
|---:|---|---|
| 1 | sponsor registered | `SponsorNotFound` (49) |
| 2 | sponsor active | `SponsorInactive` (50) |
| 3 | operator key present | `SponsorNotFound` (49) |
| 4–5 | stream exists; token, recipient and status match the claim | `StreamNotFound` (1) / `StreamNotActive` (5) |
| 6 | amount > 0 and ≤ available | `ZeroAmount` (9) / `AmountExceedsAvailable` (10) |
| 7 | beneficiary enrolled | `BeneficiaryNotEnrolled` (51) |
| 8 | `deadline` not passed | `ClaimExpired` (52) |
| 9 | nonce unspent for `(sponsor, beneficiary)` | `ClaimNonceReplay` (53) |
| 10 | sponsor period spend + amount ≤ `per_period_limit` | `SponsorBudgetExceeded` (54) |
| 11 | beneficiary period spend + amount ≤ `per_beneficiary_limit` | `BeneficiaryBudgetExceeded` (55) |
| 12 | both ed25519 signatures over the digest | host trap, all effects rolled back |
| 13 | effects, then `transfer` (interaction last, per §5) | — |

A trap at step 12 rolls back the nonce marker too, so a relayed-but-tampered
payload does not burn the beneficiary's nonce.

### 13.4 Budget accounting

`SponsorConfig { token, per_period_limit, per_beneficiary_limit,
window_seconds, active }` plus two `PeriodSpend { period_start, spend }`
counters (sponsor-wide, per beneficiary). A counter whose window elapsed is
treated as zero and re-bases on the next accepted claim, so caps are rolling
windows rather than calendar buckets. Caps are per-token: a sponsor funds one
token only, so a cheap-token cap cannot be drained on an expensive asset.

Nonces are stored as `ClaimNonce(sponsor, beneficiary, nonce)` → `bool` and are
never freed: replay protection survives window rollover, sponsor pauses, and
key rotation.

### 13.5 The relay endpoint (operator side)

The frontend's "Claim for free" button POSTs
`{ intent, beneficiarySig }` (JSON; `streamId`/`amount`/`nonce` as decimal
strings) to `NEXT_PUBLIC_SPONSOR_RELAY_URL` and expects `{ txHash }`. The
operator, for its part, must: verify `beneficiarySig` against the beneficiary's
enrolled consent key (the contract checks it too, but a relay that skips it
burns its own fee), confirm the deadline is still fresh, never reuse a nonce it
has already relayed for that beneficiary, sign the same digest with its
registered operator key, submit
`sponsored_withdraw(sponsor, beneficiary, stream_id, amount, nonce, deadline,
operator_sig, beneficiary_sig)` with its own account as the fee payer, and
respond with the transaction hash.

The contract assumes nothing about the operator's honesty: the caps, the nonce
map and the deadline are the entire exposure envelope, which is why
`per_period_limit` is the recommended blast-radius control (see
[`THREAT_MODEL.md`](THREAT_MODEL.md) §11).

### 13.6 Rejected alternatives

- **Smart-account beneficiaries** (`authorize_as_current_contract`): needs a
  deployed, funded wallet per recipient.
- **Sponsor-owned stream balances / pull-payment sub-accounts**: duplicates the
  stream ledger and breaks §1's per-stream rate conservation.
- **Single signature from the sponsor only**: would let the relayer move any
  accrued balance the sponsor registers, with no beneficiary consent.
- **`require_auth`-style session authorization**: Soroban auth is per
  transaction and per address; a relayer cannot carry a third party's
  authorization without an on-chain account contract.
## 13. Append-only public interface: storage keys, event shapes, error codes

Three wire surfaces are promises to already-deployed clients, indexers, and —
most strictly — to data already sitting in persistent storage. The CHANGELOG
states the rule up front ("only ever appended to, never renumbered or
reused"); this section is the contributor-facing detail of what counts as
which surface and how each one may evolve.

### 13.1 Error codes (§7)

- Append new `StreamError` variants at the tail with the next free code.
  Never renumber, never reuse a retired code. Codes 2 and 3
  (`NotStreamSender` / `NotStreamRecipient`) are retired-but-sacred: kept,
  documented, unreachable.
- `NothingToWithdraw = 13` was the tail of the pre-treasury surface; the
  treasury layer then *appended* 14–17, so the current tail is
  `InsufficientTreasuryBalance = 17`. That is exactly how evolution is meant
  to look: 13's meaning never moved while the tail advanced past it.
- The plumbing keeps the table honest: every variant is mirrored in
  `StreamError::ALL`, an exhaustive-match test forces new variants into that
  list in the same change, the `surface.rs` branch registry ties each variant
  to reachable `(entrypoint, condition)` branches, and CI diffs the generated
  `docs/ERROR_SURFACE.md` for drift (§7).

### 13.2 Storage keys

`DataKey` (stream.rs) is XDR-encoded **by variant name**, so:

- Append new variants; never rename, retype, or remove existing ones. A
  rename would orphan every already-stored entry under the old name.
- Reordering variants is harmless (names, not indices, are on the wire) —
  but keep the table in §2 updated either way.

Value types are the stricter case: `#[contracttype]` structs (`Stream`,
`Treasury`, `StreamFeeRecord`, `TreasuryStatus`, `FeeScan`) encode
**positionally** as an XDR vector — field order, count, and types are all
load-bearing for decoding entries written by older Wasm. In practice a
stored struct's field list is frozen: to evolve one, add a new key carrying
a new struct and migrate/cross-read deliberately, rather than editing the
existing type. `StreamStatus` is name-encoded like `DataKey`, but is nested
inside stored `Stream` values — same practical freeze.

### 13.3 Event shapes

Events are the off-chain ledger indexers consume; fields decode by position
(`#[topic]` fields first, then data fields, in declaration order):

| Event | Topic | Data, in declaration order |
|---|---|---|
| `StreamCreated` | `stream_id: u64` | `sender`, `recipient`, `token: Address`; `deposit: i128`; `start_time`, `end_time: u64`; `cancelable: bool` |
| `Withdrawn` | `stream_id: u64` | `recipient: Address`; `amount: i128`; `withdrawn_total: i128` |
| `BatchWithdrawSummary` | `recipient: Address` | `settled: Vec<WithdrawOutcome>` (each `stream_id: u64`; `amount: i128`); `total: i128`; `requested: u32`; `skipped: u32` |
| `StreamCancelled` | `stream_id: u64` | `cancelled_by: Address`; `recipient_amount: i128`; `sender_amount: i128` |
| `StreamToppedUp` | `stream_id: u64` | `sender: Address`; `amount: i128`; `new_deposit: i128` |
| `FeeCharged` | `stream_id: u64` | `token: Address`; `payer: Address`; `amount: i128`; `fee_bps: u32` |
| `FeeWithdrawn` | `token: Address` | `governor: Address`; `recipient: Address`; `amount: i128`; `withdrawn_total: i128` |
| `RateChangeProposed` | `stream_id: u64` | `proposed_by`, `counterparty: Address`; `amount_per_second: i128`; `expires_at: u64` |
| `RateChangeAccepted` | `stream_id: u64` | `accepted_by: Address`; `new_amount_per_second`, `owed_at_change`, `reserved_at_new_rate`, `adjustment`, `deposit: i128`; `effective_from: u64` |
| `SenderTransferProposed` | `stream_id: u64` | `sender_from: Address`; `new_sender: Address`; `nonce: u64`; `expires_at: u64`; `transfer_refund_rights: bool` |
| `SenderTransferred` | `stream_id: u64` | `sender_from: Address`; `sender_to: Address`; `nonce: u64`; `refund_rights_transferred: bool` |
| `SenderTransferExpired` | `stream_id: u64` | `sender_from: Address`; `new_sender: Address`; `nonce: u64` |
| `StreamRefundTargetChanged` | `stream_id: u64` | `previous_target: Address`; `new_target: Address`; `at_creation: bool` |

Never add, remove, reorder, or retype fields of an existing event; emit a
new event type instead. Tests must filter by contract and compare typed XDR
values, not stringified output (see CONTRIBUTING).

## 14. Soroban-specific traps we've hit

Everything here was re-verified against the current source and toolchain;
each item names the code that demonstrates the safe pattern.

### 14.1 `extend_ttl` panics on a never-written key — existence-check first

`extend_ttl` is not a no-op for absent entries: calling it on a persistent
key that was never written **panics** with

```text
HostError: Error(Storage, MissingValue)
["trying to get non-existing value for contract data key", [NextStreamId]]
```

(verified against `soroban-env-host` 28.0.2). The consequences:

- **Every read path that extends a TTL must existence-check before
  extending.** Both read-extending paths do, and a new one must copy the
  pattern:
  - `page_stream_ids` (stream.rs): `let Some(ids) = storage.get(key) else
    { return Vec::new(env) }` — an address with no streams returns an empty
    page *without* touching `extend_ttl`, precisely because the key was
    never written. Without that early return, the most common probe of all
    — "what streams does this unknown address have?" — would panic.
  - `scan_fees` (treasury.rs): extends a `StreamFee(id)` entry only inside
    `if let Some(record) = stored` — fee-less ids simply don't exist.
- **Write paths are safe by construction**: `put_stream`, `push_to_index`,
  and `put_treasury`/`apply_fee` all `set` the entry before calling
  `extend_ttl` on the same key. Keep that order.
- Storage *reads* that don't extend (e.g. `get_stream`, `stream_fee`,
  `treasury_status`) have no such constraint — `get` on a missing key is
  the well-behaved `Option` case.

### 14.2 `#[contractimpl]` signatures are syntactic — plain types, no aliases

The `#[contractimpl]` macro generates the exported interface spec from the
type tokens *as written*; it does not resolve Rust type aliases. Defining
`type StreamIds = Vec<u64>` and using it as an entrypoint return type
compiles cleanly — `cargo check --all-targets` passes, and even
`stellar contract build` succeeds — but the generated spec references
`StreamIds` as an undefined type, and the CLI reports:

```text
⚠️  streampay-contract: type 'StreamIds' referenced by function
    'recipient_streams' output is not defined in the spec
```

Client generators and spec consumers then get a broken interface — the
build "worked", the ecosystem didn't. Rule: spell concrete SDK types
literally in every entrypoint signature (`Vec<u64>`, never an alias), as
`recipient_streams` / `sender_streams` and the mirrored test-client trait
in `test_client.rs` both do. The same applies to `#[contractclient]`
traits: the test client repeats the plain types for the same reason.

### 14.3 `soroban-sdk` 28 requires the Stellar CLI to build Wasm

Since the sdk 27 → 28 upgrade, the sdk's build script handshakes with
`stellar-cli` (spec-shaking v2). A plain

```bash
cargo build -p streampay-contract --target wasm32v1-none --release
```

fails with:

```text
error: soroban-sdk requires stellar-cli v25.2.0+ to build a contract
To fix, build with `stellar contract build` using stellar-cli v25.2.0+.
```

The supported build path is therefore `stellar contract build` (CI pins
stellar-cli v28.1.0) with the `wasm32v1-none` target installed
(`rustup target add wasm32v1-none`). Host-side work is unaffected:
`cargo check` and `cargo test -p streampay-contract` need no CLI. If your
Wasm build fails at a `build-script-build` step before compiling a single
line of contract code, you're hitting this — check `stellar --version`
first.

## 15. Batch stream creation & transaction budget bounds

The contract provides `create_streams_batch(entries: Vec<BatchEntry>)` to allow
payers (such as DAO treasuries, payroll systems, and subscription providers) to
open multiple streams across arbitrary recipients and tokens in a single
invocation.

### Semantics & isolation

- **All-or-nothing per entry, best-effort overall**: Each `BatchEntry` is
  validated and executes its own token pull independently. A validation failure
  (e.g. invalid time range, non-positive deposit, capacity overflow) or transfer
  rejection (e.g. insufficient balance or unapproved allowance) produces an
  `Err(StreamError)` in the returned vector for that entry.
- **No sibling rollback**: Failure of any individual entry does not revert or
  abort previously created or subsequent sibling streams in the batch.
- **Checks-effects-interactions**: Validation and token pull (`try_transfer_from`)
  are completed before any persistent stream storage or counter mutation occurs.
  If the pull fails, no stream state is written.
- **Multi-token support**: Entries within the same batch may specify different
  asset contracts.
- **Batch bounds**: The batch size is strictly bounded between `MIN_BATCH = 1`
  and `MAX_BATCH = 25`. Calls with 0 entries fail with `StreamError::BatchEmpty`,
  and calls exceeding 25 entries fail with `StreamError::BatchTooLarge`.

### Measured instruction & memory benchmarks

Measurements gathered via `soroban-env-host` invocation metering:

| Batch size | CPU instructions | Memory (bytes) | % of Soroban CPU budget (100M) |
|---|---|---|---|
| 1 | 514,652 | 201,628 | 0.51% |
| 5 | 2,357,938 | 594,733 | 2.36% |
| 10 | 5,301,290 | 1,240,177 | 5.30% |
| 20 | 12,551,145 | 2,968,621 | 12.55% |
| 25 (`MAX_BATCH`) | 19,000,404 | 4,767,985 | 19.00% |

### Why `MAX_BATCH = 25` is the hard bound

While Soroban's CPU instruction budget is 100,000,000 instructions (25 streams
consume only ~19% of this limit) and memory is well within the 40 MB ceiling,
the limiting protocol constraint is the **contract event byte limit of 16,384
bytes (16 KB) per transaction**.

Each stream creation emits:
1. An SAC token `transfer` event (~250–300 bytes)
2. A `StreamCreated` contract event (~300 bytes)

At 25 streams, total emitted event data reaches approximately 15.5 KB. Batches
with 26 or more streams exceed the 16,384-byte ceiling and trigger an immediate
host abort (`Error(Budget, ExceededLimit)`: `contract events size bytes > 16384`).
Thus, `MAX_BATCH = 25` represents the maximum safe on-chain batch size on Stellar.

## 16. Oracle Reference Clock & Staleness Bounds

StreamPay supports an optional external oracle reference clock (`create_stream_with_oracle(..., use_oracle: true)`), allowing payment streams to settle against high-precision off-chain time feeds or cross-ledger header clocks rather than Soroban ledger timestamps.

### Trust & Threat Model

- **Opt-In Per Stream**: Ledger time remains the default clock. Oracle resolution is strictly opt-in per stream (`use_oracle` flag on the persisted `Stream`), preventing unexpected feed dependency for standard streams. Streams written before the oracle clock existed carry no `use_oracle` key on the wire at all; the field is optional in Rust so those records keep decoding, and an absent flag reads as ledger time. The v1→v2 storage migration backfills the key to `false`.
- **Governor-Managed Publisher Registry**: The protocol governor configures authorized publishers and threshold requirements (`set_oracle_config`).
- **M-of-N Quorum Protection**: An M-of-N quorum scheme (e.g. 2-of-3) prevents any single compromised or rogue publisher from shifting reference time. Quorum aggregation uses the median of valid publisher reports, which eliminates outliers.
- **Staleness Bounds (`max_stale_seconds`)**: Each publisher submission records `(reported_time, ledger_time)`. A report is deemed valid if and only if `current_ledger_time <= report.ledger_time + max_stale_seconds`. Older reports are automatically discarded. Future timestamps exceeding `current_ledger_time + max_stale_seconds` are rejected on submission (`StreamError::OracleReportTooOld`).
- **Fail-Safe Fallback to Native Ledger Time**: If quorum cannot be reached (e.g. stale feed, insufficient reports, or unconfigured registry), the resolver safely falls back to native ledger timestamp `env.ledger().timestamp()` and emits an `OracleStaleFallback` event. Streams never freeze, locks never occur, and funds remain fully withdrawable.
- **Active Stream Invariance Under Config / Threshold Changes**: Modifying publisher sets or raising quorum threshold mid-stream cannot brick existing streams: any shortfall in quorum simply triggers the automatic fallback to ledger time.
- **Accrual Pure Function & CEI Invariance**: Time resolution is executed as an effect step strictly prior to state mutation. The accrual math (`streamed_at`, `available_amount_at`, `cancel_amounts_at`) remains a pure function parameterized by `now: u64`.

## 17. Two-step ownership transfer

Either party can hand their role to a new address. The handoff is always
propose → accept; a unilateral reassignment is impossible.

```text
propose(caller, id, new_owner)
        │  caller must be the current sender or recipient
        │  stores PendingOwnership { proposed_by, new_owner, role, expires_at }
        │  emits OwnershipProposed
        ▼
   pending proposal ──── cancel(proposer) ──▶ (removed)
        │
        │  now >= expires_at
        ├──────────────▶ accept reverts OwnershipProposalExpired
        │                (stale entry ignored; a new proposal replaces it)
        ▼
accept(new_owner, id)
        │  caller must equal pending.new_owner
        │  stream must still be Active
        │  moves only `sender` or `recipient`
        │  appends id to the new holder's index
        │  removes the pending key, emits OwnershipAccepted
        ▼
   new role holder
```

**Storage and TTL.** The proposal lives under `DataKey::PendingOwnership(id)`,
not inside `Stream`, so a proposal does not rewrite the stream entry and the
key gets its own TTL maintenance. Writes extend the key's TTL; reads check
existence *before* calling `extend_ttl` (extending a missing key fails). There
is at most one proposal per stream; an unexpired proposal blocks another
(`OwnershipProposalPending`), while an expired one is removed and replaced by
a successful `propose` call. A failed `accept` reverts its own storage writes,
so the stale key survives until a later successful proposal or cancel — stale
entries are harmless because acceptance checks `expires_at` before applying.

**Accounting invariance (proof sketch for mid-stream transfer).** Let a stream
have `(deposit, withdrawn, start_time, end_time, token, status, use_oracle)`
before an accepted transfer `T`, and let
`streamed(t) = floor(deposit · elapsed/duration)`. `T` writes only the role
address (`sender` or `recipient`) plus append-only index data; it moves no
tokens and does not read or modify any accounting field. Therefore after `T`,
every accounting field is definitionally unchanged, so for all `t`:
`streamed_T(t) = streamed_before(t)`, and
`available_T(t) = streamed_T(t) − withdrawn = available_before(t)`.

1. **Per-stream invariant.** `withdrawn` and `deposit` are unchanged, and
   `withdrawn ≤ streamed_before(t) ≤ deposit` held before `T`; substituting the
   equal `streamed_T(t)` gives `0 ≤ withdrawn ≤ streamed_T(t) ≤ deposit`.
2. **Conservation.** The contract's token balance covers
   `Σ(deposit − withdrawn)` over live streams plus the independent treasury
   ledger. `T` changes neither term for any stream and never touches the fee
   ledger, so global coverage is unchanged. Proposals and acceptances perform
   no token interaction at all, hence no reentrancy surface.
3. **Claims.** Recipient transfer redirects all *future* payouts of the same
   `available` balance: the new recipient can withdraw it once, and `withdrawn`
   advances exactly as if the old recipient had withdrawn. No double claim is
   possible because both recipients read and write the same `withdrawn`
   counter. Sender transfer redirects future top-up pulls and cancellation
   refunds; cancellation still splits `streamed − withdrawn` to the recipient
   and `deposit − streamed` to the refund target, which is the current sender
   unless §19 pinned it elsewhere.
4. **Terminal safety.** Transfer is limited to `Active` streams, so a
   cancelled/depleted stream can never acquire a new claimant or payer.

The test suite exercises each step: recipient transfer mid-accrual followed by
a withdrawal, sender transfer followed by top-up + cancel with exact balance
assertions, expiry at the exact TTL boundary, proposal cancellation, and index
contents for both old and new holders.

## 18. Two-step rate renegotiation

Either party can propose a new `amount_per_second` for the rest of a live
stream. Like §17, the change is always propose → accept, so neither side can
unilaterally re-price what is owed; unlike §17 it moves funds.

```text
propose(caller, id, amount_per_second)
        │  caller must be the current sender or recipient
        │  stream must be Active and its window not yet elapsed
        │  amount_per_second must be > 0 and inside the policy rate bounds
        │  stores PendingRateChange { stream_id, proposed_by, counterparty,
        │                             amount_per_second, expires_at }
        │  emits RateChangeProposed
        ▼
   pending offer ──── cancel(proposer) ──▶ (removed)
        │
        │  now >= expires_at
        ├──────────────▶ accept reverts RateProposalExpired
        │                (stale offer survives; a new proposal replaces it)
        ▼
accept(counterparty, id)
        │  caller must equal pending.counterparty (else NotAuthorized), and the
        │  recorded pair must still be the stream's parties in the same roles —
        │  a §17 transfer invalidates an offer negotiated with an ex-party
        │  boundary = resolve_stream_time(id).max(start_time); boundary < end_time
        │  owed     = accrual of the current schedule at the boundary
        │  reserved = amount_per_second · (end_time − boundary)      [exact]
        │  adjustment = reserved − (deposit − owed)
        │  increase: sender auth + transfer_from the shortfall  ← before effects
        │  effects: deposit = owed + reserved, install the clipped schedule,
        │           remove the offer, emit RateChangeAccepted
        │  decrease: transfer the freed escrow back to the sender ← after effects
        ▼
   same window, new rate from the boundary forward
```

**Storage and TTL.** The offer lives under `DataKey::PendingRateChange(id)` and
the accepted schedule under `DataKey::RateSegments(id)`, never inside `Stream`
(§2, [ADR-0012](adr/0012-piecewise-rate-schedule-storage.md)). A stream that
never renegotiated has neither key; a stream whose schedule reached
`MAX_RATE_SEGMENTS = 32` refuses further acceptances with
`TooManyRateSegments` and keeps the offer, so the ceiling is a bound on the
cost of pricing, not just on storage.

**Exactness (proof sketch).** Let `S = [w₁ … wₙ]` be the schedule before an
acceptance at boundary `β` with rate `r`, where each window `wᵢ` prices
`streamed_at(allocationᵢ, basis_secondsᵢ, ·)` over its own half-open slice, and
accrual is `A_S(t) = Σᵢ streamed_at(…)`. Acceptance writes
`S′ = [clip(wᵢ, β) for startᵢ < β] ++ [(β, end, r·(end−β), end−β)]`:

1. **The past is untouched.** `clip` shortens only `end_time`, so for every
   `t ≤ β` the elapsed term of each window is the same in `S` and `S′`:
   `A_{S′}(t) = A_S(t)`. `owed = A_S(β)` is therefore also `A_{S′}(β)`, and
   because `withdrawn` is not read or written, `available` at every `t ≤ β` is
   unchanged. The clipped head keeps the *original* `(deposit, duration)` pair,
   which is why a floor-division residue in the past is never re-based onto the
   new rate.
2. **The future has no residue.** For `t > β`, the tail window's basis equals
   its own length, so `streamed_at(r·(end−β), end−β, t−β) = r·(t−β)` — an
   integer product divided by the number it was multiplied by. Hence
   `A_{S′}(t) = owed + r·(t−β)` exactly.
3. **Escrow and schedule agree.** `deposit′ = owed + reserved = A_{S′}(end)`,
   and the signed `adjustment` is the only token interaction, so the contract's
   balance still covers `deposit′ − withdrawn`. `0 ≤ withdrawn ≤ A(t) ≤ deposit′`
   survives the change: `withdrawn` is untouched and `A_{S′}` is monotone in `t`
   because each window's accrual is and the windows are disjoint.
4. **Terminal safety.** Propose and accept both require `Active` with
   `boundary < end_time`, so a cancelled, depleted, or already-finished stream
   cannot acquire a schedule; a stream whose window closed while it stayed
   `Active` reverts `InvalidTimeRange` on both halves of the handshake.

**Failure atomicity.** The pull of a shortfall is the last check before any
effect, and the refund of a decrease is the last interaction after them: either
way a refusing token rolls the whole acceptance back, so a half-applied schedule
is unreachable. `rate_increase_without_funds_changes_nothing` pins the first
case (deposit, schedule, offer and contract balance all identical afterwards).

The test suite exercises each step: an increase that pulls exactly the
shortfall, an unfundable increase, a decrease that refunds exactly the freed
escrow, a decrease accepted mid-second on a deposit that does not divide by its
duration, withdrawals and the cancellation split against the same schedule,
top-up pro-rata onto the current window only, offer expiry/replacement/
cancellation, stale parties after an ownership transfer (§17), the frozen gate,
the segment cap, and the empty-schedule differential against the pre-#54
formula. §3.1 covers the math; the rounding analysis across random schedules is
§9.
## 19. Consented sender-role transfer

§17 moves a role to the address that will hold it, so that address consents. A
**sender-role transfer** is the other case: the payer changes, and the party
losing a counterparty is the recipient — so the *recipient* consents, and the
proposal is nonce-bound so a consent can only name one proposal.

```text
propose_sender_transfer(caller, id, new_sender, nonce, transfer_refund_rights)
    caller must be the current sender; stream must be Active
    new_sender must be neither the sender nor the recipient
    stores PendingSenderTransfer { stream_id, sender_from, new_sender, nonce,
                                   expires_at, transfer_refund_rights }
    emits SenderTransferProposed
        │
        ├─ accept_sender_transfer(recipient, id, nonce)
        │     caller must equal stream.recipient   → SenderTransferNotConsenter (93)
        │     nonce must equal the stored one       → SenderTransferNonceMismatch (91)
        │     window must still be open             → SenderTransferExpired (89)
        │     role moves: sender := new_sender
        │     both SenderStreams pages rewritten and TTL-extended
        │     RefundTarget := new_sender if transfer_refund_rights,
        │                      else the claim as it stood before the hop
        │     SenderHistory gains one immutable record
        │     pending key removed, emits SenderTransferred
        │
        └─ expire_sender_transfer(id)  — after the window, permissionless
              returns the reclaimed nonce, emits SenderTransferExpired
              refuses while the proposal is live → SenderTransferNotExpired (90)
```

**Why the claim is explicit.** `deposit` funds a stream, and the unaccrued
remainder is whoever paid's money. A role hop changes who may top up and who
may cancel; it does not change who funded it. So `transfer_refund_rights` is a
separate field on the proposal rather than a consequence of the hop, and
`DataKey::RefundTarget(id)` records the answer permanently: `refund_target()`
falls back to `stream.sender` when the key is absent, and `apply_sender_transfer`
pins the key on every hop — to the incoming sender only when the proposal asked
for it. A chain `A → B → C` with no flag set therefore still pays A, which is
the property the append-only log exists to make auditable.

**Index migration.** Both sides of the hop are rewritten with the same helpers
the creation path uses (`index_sender` appends through `push_to_index`,
`unindex_sender` prunes through `remove_from_index`), so a page cannot be
extended on one side and left to go cold on the other. The prune preserves the
order of the remaining ids. `RecipientStreams` is untouched: the recipient did
not change. Unlike §17's append-only index rule, the outgoing sender's page
stops listing the stream — the point of the feature is that nobody discovers a
stream under an address that no longer controls it.

**Storage and accounting.** Nothing about a hop moves a token: the effects are
`Stream`, `SenderStreams` (both pages), `RefundTarget` and `SenderHistory`
writes plus the removal of the proposal key, which is exactly the trace pinned
by `test_orderings/sender_transfer.txt`. `deposit`, `withdrawn`, `token`,
`start_time`, `end_time` and `status` are untouched, so §17's invariance proof
applies unchanged. Cost and growth are documented in
[`FOOTPRINT.md`](./FOOTPRINT.md) (Candidate 6).

## 20. Refund routing

§19 established that the refund of the unstreamed remainder is a *claim*, not a
consequence of a role. `DataKey::RefundTarget(id)` was written only as a
side-effect of a hop. **Refund routing** makes that claim directly addressable:
the sender-role holder can name the destination at creation, or amend it later,
without anyone's counterparty's consent — because routing money to an address
can only ever *give*, and the party who funded the deposit is the party entitled
to decide where it returns.

```text
create_stream_with_refund(…, refund_to)
      frozen                                  → ContractFrozen (36)
      refund_to == sender                     → RefundTargetUnchanged (95)
      then the ordinary create_stream_with_oracle checks and validation
      writes RefundTarget(id) = refund_to on top of the fresh record
      emits StreamCreated, then StreamRefundTargetChanged { at_creation: true }

set_refund_target(caller, id, refund_to)
      caller.require_auth()
      frozen                                  → ContractFrozen (36)
      stream must exist                       → StreamNotFound (1)
      status must be Active                   → StreamNotActive (5)
      caller must hold the sender role        → RefundTargetNotSender (94)
      target must differ from the claim       → RefundTargetUnchanged (95)
      overwrites RefundTarget(id); emits StreamRefundTargetChanged
```

The rejection order is deliberate and is what `error_surface_test.rs` probes:
authorization before existence-checking would leak which ids exist to a caller
the contract is about to refuse anyway, while `StreamNotActive` before
`RefundTargetNotSender` keeps a stranger from learning a finished stream's
state through an error that names them.

**What routing does not do.** It grants no authority — the routed address can
still neither cancel, top up, pause nor withdraw, and only the sender-role
holder can move the routing again (so after a hop the outgoing sender loses the
amendment right, which `a_routed_refund_pays_the_designated_address_and_nobody_else`
and `only_the_current_sender_can_re_route_the_refund` hold). It does
not touch the accrual math: `available`, `streamed`, and the split
`cancel_amounts` computes are functions of `deposit`, `withdrawn` and the time
window only, so a routed stream and an unrouted twin produce records that are
equal field-for-field with different destinations for the same remainder. That
is the property `routing_never_touches_the_accrual_math` asserts by *record
equality*, which is stronger than asserting equal numbers: it proves the routing
is not in the record at all.

**Composition with §19.** `apply_sender_transfer` pins `RefundTarget` on every
hop — to the incoming sender when the proposal set `transfer_refund_rights`,
otherwise to whatever the claim already was. A routing therefore survives a hop
that does not move rights, and is replaced by a hop that does; the last write
wins, which is the order the parties acted in. Both orders are exercised in
`routing_and_sender_transfers_compose_in_the_order_thappen` — see the four-cell
interaction matrix it builds. One trap follows from this and is documented on the
entrypoint rather than discovered in production: routing the claim to a fixed
address, then letting a *different* sender top the stream up, means the pinned
address drains the enlarged pot. The amendment is a destination, not a budget.

**Storage.** Routing writes one key per stream, overwritten by every amendment,
so growth is bounded by the number of streams that ever route rather than the
number of amendments (`docs/FOOTPRINT.md`, Candidate 6). A terminal stream has no
remainder to route: `set_refund_target` refuses with `StreamNotActive`, while the
`refund_target` view keeps answering — the destination of a paid-out refund is
audit information, not live state.

**Off-chain.** The indexer projects `stream_refund_target_changed` into
`streams.refund_target` (NULL = unrouted, i.e. the sender is paid) under the same
monotonic-projection rule as the rest of the row, and the routing never enters
`listAddress`: a routed address holds a claim, not a discoverable role. The
stream detail page reads the `refund_target` view and warns when the answer
differs from the sender, which is the only signal the contract gives — the view
resolves the fallback rather than reporting an absent key.
