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
│              cancel_stream / top_up / pause_stream / resume_stream /│
│              get_stream / available / recipient_streams /           │
│              sender_streams                                         │
│  stream.rs   Stream type, storage, checked accrual math            │
│  errors.rs   StreamError — stable numeric codes, append-only       │
│  events.rs   StreamCreated / Withdrawn / StreamCancelled /         │
│              StreamToppedUp / PauseStream / ResumeStream           │
│              (stream_id as topic)                                   │
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

The `Stream` entry also carries the pause bookkeeping (`paused_total`,
`paused_at`) — see §3. Streams live in **persistent** storage. Every mutating
entrypoint that touches a stream extends its TTL (`TTL_THRESHOLD_LEDGERS = 200_000`, extend to
`500_000` ≈ 29 days), so a stream that is being used never goes cold, while
abandoned streams naturally archive to off-chain recovery — the Soroban-native
way to bound state bloat without penalizing active users. Index entries get
the same TTL treatment on write *and* on read, so an actively-queried address
stays hot.

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

## 3. Accrual math

Everything reduces to one pure function (`stream.rs`):

```rust
streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError>
```

- `elapsed == 0` (before `start_time`) → `0`
- `elapsed >= duration` (at/after `end_time`) → `deposit`
- otherwise → `deposit * elapsed / duration`, floored

The per-stream `elapsed` fed into the pure function is pause-aware:

```text
elapsed = min(duration, effective_now − start_time − paused_total)
effective_now = paused_at  (while Paused — accrual is frozen)
              = now        (while Active)
```

So a pause does two things and nothing else: it freezes the accrual clock at
the pause timestamp (withdrawals still work against the frozen balance), and
on resume it folds the paused interval into `paused_total`, shifting the
effective end of the window out by exactly that amount. The pure rate
function itself is unchanged — pause handling lives entirely in the elapsed
calculation (`elapsed_seconds` in `stream.rs`).

Bookkeeping is two appended `Stream` fields: `paused_total` (cumulative
paused seconds, folded in at each resume) and `paused_at` (the timestamp the
current pause began, `0` while running). The *freeze* timestamp is what makes
the frozen-balance read work without a separate status-only query — the
good-first-issue sketch suggested `last_resumed_at`, but that cannot express
"how much has accrued so far" while a pause is in flight. A stream therefore
accrues over its window against `duration + paused_total` of wall-clock time,
with `end_time` itself left untouched.

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
| `pause_stream` | sender only | sender |
| `resume_stream` | sender only | sender |

`pause_stream` additionally rejects non-`Active` streams with
`StreamNotActive` (a double pause is a non-Active stream), and
`resume_stream` rejects non-`Paused` streams with `StreamNotPaused`.

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
           Active ──────────── cancel_stream ────────────▶ Cancelled (terminal)
             │  │  │                                         pro-rata split at the
             │  │  │                                         current — possibly
             │  │  │                                         frozen — accrual point
             │  │  │
             │  │  └─ withdrawn == deposit ───────────────▶ Depleted (terminal)
             │  │
             │  └─ top_up allowed (even after end_time: the added funds
             │     are fully accrued → recipient withdraws)
             │
             │ pause_stream (sender only)
             ▼
           Paused ─┬─ withdraw allowed against the frozen balance
             │     ├─ top_up allowed (accrual stays frozen)
             │     └─ cancel_stream allowed (split at the frozen point)
             │
             └─ resume_stream ──────▶ Active   (folds the paused interval
                                                into `paused_total`; the
                                                window stretches by exactly
                                                that much)
```

- Cancelling a `Depleted` stream reverts (`StreamNotActive`) — there is
  nothing left to split.
- Cancelling a not-yet-started stream is a 100 % refund to the sender.
- `top_up` on a cancelled/depleted stream reverts.
- `pause_stream` on a cancelled/depleted stream (or a double pause) reverts
  (`StreamNotActive`); `resume_stream` on a non-paused stream (including a
  double resume) reverts (`StreamNotPaused`).
- Terminal states are terminal: there is no path out of `Cancelled` or
  `Depleted`, and a cancelled stream's remaining bookkeeping (including
  `paused_at`) is zeroed at cancellation.

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
| 14 | `StreamNotPaused` | `resume_stream` on a stream that is not paused |

Codes are **append-only**: never renumber or reuse a variant.

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

## 9. Testing strategy- **Unit tests** (`test.rs`) cover every spec edge case: withdraw before
  start / at / after end, sequential partial withdrawals, cancel before
  start / fully-withdrawn / not-cancelable, top-up after end, zero-duration
  and zero-amount rejection, `i128::MAX`-scale checked math, event emission
  (typed, per-contract-filtered), a malicious-token reentrancy attempt, and
  the pause lifecycle (frozen accrual, resumed-exactly-where-it-froze,
  withdraw/top-up/cancel while paused, stretched full-window completeness,
  double-pause/double-resume rejection, auth).
- **Property test**: random `(deposit, duration)` — for random sample points
  `t ≤ duration`, the sum of payouts up to `t` never exceeds
  `streamed_at(deposit, duration, t)`, and `streamed_at(..., duration) ==
  deposit` exactly. A second property test repeats the bounds, monotonicity,
  and full-window-completeness checks over the pause-aware elapsed model
  (`wall-clock − paused_total`, clamped) for arbitrary pause totals.
- **Rate math is pure** (`streamed_at` takes no `Env`), so the `cargo-fuzz`
  target in [`fuzz/`](../fuzz/fuzz_targets/streamed_at.rs) hammers it without
  a Soroban host: bounds, exact floor-ratio reference comparison,
  monotonicity, and "errors are only ever genuine `MathOverflow`". CI runs a
  scheduled session (`fuzz.yml`, non-blocking); any crash becomes a regression
  unit test.
- **`withdraw_max`** shares the `withdraw` payout tail (`pay_out`) so both
  paths inherit the same CEI ordering and reentrancy proof; index pagination
  and TTL behavior have dedicated tests in `test.rs`.

## 10. Open problems / roadmap hooks

- Multi-token batch creation — one tx, N streams; watch the instruction
  budget, likely `try_create_batch` with per-item results.
- Gas optimization pass on storage reads — `cancel_stream` does one
  read-modify-write; a `Stream` split into hot/cold fields could shave bytes.
- Event indexer service — TypeScript worker polling `getEvents` per topic
  `stream_id`, materializing stream history for the UI.
