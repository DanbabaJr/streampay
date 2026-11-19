# Scheduled stream intents

Pre-authorized, keeper-executable stream creation: a sender locks the funds for
one or more future streams **now**, and a permissionless keeper materializes
each stream later, collecting the escrowed per-occurrence fee. This is the
on-chain "cron" layer for StreamPay — recurring payroll, delayed vesting
cliffs, or any stream that must start at a time the sender may not be online to
click.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first for the base stream model.

## 1. Why

A normal `create_stream` requires the sender's signature at creation time and an
up-front token approval. That is fine interactively, but a payroll contract may
want a stream to begin at 00:00 on the 1st, or a vesting cliff to unlock at a
fixed date, without a sender daemon holding a signing key online. Scheduled
intents invert the flow:

- **Authorize once, up front.** The sender signs a single scheduling
  transaction; the host verifies it and the contract escrows everything needed
  (`(deposit + fee) × occurrences`).
- **Execute later, permissionlessly.** Any address can call
  `execute_scheduled` once the occurrence is due; the caller (`keeper`)
  authorizes the call and is paid the escrowed fee. No sender key is needed at
  execution time.
- **No trust in the keeper is required.** The keeper cannot redirect the
  stream, change its parameters, execute an occurrence twice, or move funds it
  is not owed. Execution is gated by on-chain timing and a parameter
  commitment.

## 2. Lifecycle

```text
                        schedule_stream
                    (sender auth + escrow)
                              │
                              ▼
                          Pending ──────────────── execute_scheduled ─────┐
                              │                 (one occurrence at a time) │
                              │                                           ▼
                              │                          occurrences_remaining == 0
                              │                                           │
                              │                                           ▼
                              │                                     Executed (terminal)
                              │
              now < execute_after                 now >= expires_at
                              │                          │
                              ▼                          ▼
                       cancel_scheduled           reclaim_expired
                     (sender only, refund)     (permissionless, refund→sender)
                              │                          │
                              ▼                          ▼
                        Cancelled (terminal)      Expired (terminal)
```

- **Pending** — at least one occurrence remains; may be executed within its
  window, cancelled before the window opens, or reclaimed after expiry.
- **Executed** — every occurrence was materialized. Terminal.
- **Cancelled** — the sender cancelled before the execution window opened; the
  escrow for all outstanding occurrences was refunded. Terminal.
- **Expired** — `expires_at` passed with occurrences outstanding; escrow
  refunded to the sender. Terminal.

## 3. Timing model

All times are ledger timestamps (seconds).

| Parameter | Meaning | Constraint |
|---|---|---|
| `execute_after` | earliest time occurrence 0 may be executed | `now ≤ execute_after ≤ start_time` |
| `start_time` | start of occurrence 0's stream window | `start_time > now` (at scheduling) |
| `end_time` | end of occurrence 0's stream window | `end_time > start_time` |
| `interval` | seconds between occurrence starts | `0` for one-shot; `> 0` for recurring |
| `occurrences` | number of streams to create | `1 ≤ occurrences ≤ MAX_OCCURRENCES` (1000) |
| `expires_at` | hard deadline; no execution at/after this | `expires_at > execute_after` |

For occurrence `i` (0-based):

```text
due(i)    = execute_after + i * interval        // earliest execution time
window(i) = [ start_time + i*interval , end_time + i*interval )
```

Execution of occurrence `i` requires `due(i) ≤ now < expires_at`. Because
`execute_after ≤ start_time`, an occurrence is always due at or before its
stream window opens, so a keeper never has to wait for accrual to begin.
**Catch-up is allowed**: a keeper arriving late can execute several due
occurrences in successive calls. If it arrives *after* an occurrence's
`start_time`, the stream is created with a start in the past — the fixed window
means some value has already accrued and is immediately claimable by the
recipient. Late execution never shifts the window, so the schedule stays
deterministic.

One-shot intents use `occurrences = 1`, `interval = 0`.

## 4. Escrow and keeper economics

At scheduling time the contract pulls

```text
total_escrow = (deposit_amount + fee_budget) * occurrences
```

from the sender (via the existing token approval / `transfer_from` path) into
itself. Per occurrence:

- `deposit_amount` funds the created stream, and
- `fee_budget` is paid to whichever keeper executes that occurrence.

Because the funds are escrowed up front, `execute_scheduled` moves **no** tokens
in from the sender — it only does bookkeeping, creates the stream, and pays the
keeper from the contract's balance. A keeper therefore knows in advance that
the deposit exists and the fee is payable; there is no "execute a stream that
turns out to be unfunded" failure mode.

`fee_budget = 0` is legal (an altruistic or self-executed intent), and
`cancel_scheduled` / `reclaim_expired` refund `(deposit + fee) × remaining`.

## 5. Auth model

| Entrypoint | Who may call | Auth consumed | Notes |
|---|---|---|---|
| `schedule_stream` | anyone | `sender` | escrow pulled; params committed |
| `execute_scheduled` | anyone | `keeper` (the caller) | once per occurrence |
| `cancel_scheduled` | sender only | `sender` | only `now < execute_after` |
| `reclaim_expired` | anyone | none | refund always goes to `sender` |
| `get_intent` / `sender_intents` | anyone | none | read-only |

The keeper's `require_auth()` is what makes the fee **non-front-runnable**: a
copycat that watches the mempool and re-submits the same `execute_scheduled`
call under its own address cannot steal the fee, because the fee is paid to
`keeper` — the address that authorized the call — and the authorizing address
must actually sign. Whoever signs gets paid, so there is nothing to steal by
copying.

## 6. Contract API

| Function | Moves tokens | Emits |
|---|---|---|
| `schedule_stream(sender, recipient, token, deposit_amount, start_time, end_time, cancelable, interval, occurrences, fee_budget, execute_after, expires_at) → u64` | pulls `total_escrow` in | `StreamScheduled` |
| `execute_scheduled(intent_id, keeper) → u64` | pays keeper `fee_budget` | `StreamCreated`, `ScheduledStreamExecuted` |
| `cancel_scheduled(sender, intent_id)` | refunds `remaining_escrow` to sender | `ScheduledIntentCancelled` |
| `reclaim_expired(intent_id)` | refunds `remaining_escrow` to sender | `ScheduledIntentExpired` |
| `get_intent(intent_id) → ScheduledIntent` | — | — |
| `sender_intents(sender, offset, limit) → Vec<u64>` | — | — |

Scheduling reuses the base stream validation (`deposit > 0`, valid window, and
the `u128` capacity pre-check) plus the scheduling-specific constraints above.
New `StreamError` codes (append-only):

| Code | Variant | Raised when |
|---|---|---|
| 14 | `IntentNotFound` | no intent with this id |
| 15 | `IntentNotPending` | intent already executed / cancelled / expired |
| 16 | `IntentNotYetExecutable` | before the occurrence's `due(i)` |
| 17 | `IntentExpired` | `now ≥ expires_at` on execute/cancel |
| 18 | `IntentNotCancellable` | cancel after the window opened |
| 19 | `InvalidScheduleParameters` | bad interval/occurrences/`execute_after`/`expires_at` |
| 20 | `IntentParamsMismatch` | stored params no longer match `params_hash` |
| 21 | `IntentNotExpired` | `reclaim_expired` before `expires_at` |

## 7. Running a keeper

[`scripts/keeper.sh`](../scripts/keeper.sh) is a reference keeper. It either
watches explicit intent ids or enumerates a sender's intents, and for each one
**simulates `execute_scheduled` with `--send=no` first** (the source of truth
for executability), then sends the real transaction:

```bash
CONTRACT_ID=C... KEEPER=my-keeper ONCE=1 INTENTS="1 2 3" ./scripts/keeper.sh

# Auto-discover a sender's intents, gate on a minimum fee, and also reclaim
# intents that expired:
CONTRACT_ID=C... KEEPER=my-keeper SENDER=G... MIN_FEE=1000000 RECLAIM=1 \
  ./scripts/keeper.sh
```

Because `execute_scheduled` is once-per-occurrence, a keeper that races with
another simply sees its `send` revert (the simulation gate makes this rare) and
skips on. The script treats that as a normal, harmless outcome.

### Discovering work

The script's explicit-id / `sender_intents` modes are enough for a demo. A
production keeper should subscribe to `StreamScheduled` events so it never
misses an intent:

```bash
stellar contract events --id "$CONTRACT_ID" --network testnet \
  --start-ledger <L> --topic-1 stream_scheduled
```

Persist the last processed ledger and resume from there after a restart. Track
per-intent completion with `get_intent` (`status`, `occurrences_remaining`,
`occurrence_due`), and back off to polling `reclaim_expired` for intents whose
`expires_at` has passed (no reward, but it keeps you from watching dead work).

### Economics

A keeper should only execute when `fee_budget` exceeds its all-in cost — the
Stellar transaction fee plus the opportunity cost of the wall-clock wait. The
`--send=no` simulation also lets a keeper read the expected fee before bidding.
Set `MIN_FEE` accordingly, and remember the sender chose `fee_budget`: too low
and no rational keeper will run, too high and the sender overpays. For
self-service use, a sender can set `fee_budget = 0` and execute its own
intents, or run the keeper themselves.

## 8. Threat model

### Replay / double execution

- **One execution per occurrence.** `execute_scheduled` reads
  `occurrences_remaining`, decrements it, and marks the intent `Executed` when
  it hits zero *before* any token move (checks-effects-interactions). A replay
  of a completed occurrence reverts with `IntentNotPending`. For a recurring
  intent, a duplicate call for the same occurrence also reverts, because the
  next occurrence is not due until `execute_after + i*interval`.
- **Replay across time.** The scheduling parameters are committed in
  `params_hash` (SHA-256 over sender, recipient, token, deposit, window,
  cancelable, interval, occurrences, fee, `execute_after`, `expires_at`). Every
  execution recomputes the hash from storage and refuses to proceed on mismatch
  (`IntentParamsMismatch`). Mutable bookkeeping (`status`,
  `occurrences_remaining`, generated `id`) is deliberately excluded, so the
  commitment is invariant for the intent's lifetime.
- **Replay after expiry.** Once `now ≥ expires_at`, execution reverts
  (`IntentExpired`) — the authorization window is bounded, so a signed
  scheduling intent cannot be executed arbitrarily far in the future.

### Front-running the keeper

- Copying the executor's call and re-submitting it under a different address
  does **not** steal the fee: the fee is paid to the address that authorizes the
  call (`keeper.require_auth()`), and that address must sign. The copycat would
  have to authorize with its own key and would be paid *itself* — which is just
  being the keeper. There is no mempool-sniping payoff here.
- A sender cannot "cancel the fee out" from under a keeper: cancellation is only
  allowed strictly before `execute_after`. Once the window opens, the sender is
  committed; only execution or expiry can resolve the intent.

### Griefing by an under-funded keeper

- The common failure mode for keeper systems — a keeper executes a stream that
  turns out to be unfunded, wasting gas — **cannot occur here.** The full
  `(deposit + fee) × occurrences` escrow is pulled from the sender at
  scheduling time, *before* any keeper acts. `execute_scheduled` only pays out
  money the contract already holds, and its own consistency (`params_hash`)
  ensures the escrowed amounts match what it will pay and create.
- A keeper can always verify, via `get_intent` and a `--send=no` simulation,
  that an intent is Pending, due, unexpired, and matches its commitment before
  spending the network fee. A revert costs the keeper nothing on-chain.
- **Griefing the sender.** A sender can grief a keeper only by choosing a fee
  below the market cost of execution, in which case no rational keeper runs and
  the intent simply sits Pending until expiry — at which point anyone (including
  the sender) can `reclaim_expired`, and the funds are never locked: the escrow
  is always recoverable by the sender after `expires_at`. There is no state a
  sender can leave the intent in that permanently traps the keeper or the
  funds.

### Liveness and abandonment

- **No keeper runs.** Funds are not lost: after `expires_at`, `reclaim_expired`
  (permissionless, refund always to the sender) returns the outstanding escrow.
  The sender can always self-execute or self-reclaim.
- **Keeper abandons mid-schedule.** Each occurrence is independent; a later
  keeper can catch up on all due occurrences, or the remainder can be reclaimed
  once `expires_at` passes. Partial progress is never rolled back (already
  created streams live on, with their own lifecycle).

### Parameter integrity

- The sender's signature covers *the whole invocation*, so the sender
  authorizes the exact parameters the contract commits. `params_hash` is a
  second, storage-level check that the values the contract later reads are the
  ones that were authorized.
- Occurrence windows are fixed at scheduling time and never shifted by late
  execution, so a keeper cannot retroactively change when a stream starts or
  ends.

## 9. Testnet run log

The following is a testnet run procedure. It has **not yet been executed in
this checkout**; record the actual network output here before opening the PR.
Do not treat the illustrative id and status below as observed results:

```bash
# 1. schedule a one-shot intent due immediately, expiring in 5 minutes
stellar contract invoke --id $CONTRACT_ID --source sender --network testnet -- \
  schedule_stream \
    --sender $SENDER --recipient $RECIPIENT --token $TOKEN \
    --deposit_amount 1000000 --start_time $((NOW+60)) --end_time $((NOW+3660)) \
    --cancelable true --interval 0 --occurrences 1 --fee_budget 100000 \
    --execute_after $NOW --expires_at $((NOW+300))
# Expected shape only; record the actual returned id.

# 2. run the keeper
CONTRACT_ID=$CONTRACT_ID KEEPER=keeper ONCE=1 INTENTS="1" ./scripts/keeper.sh

# ...
# 3. verify
stellar contract invoke --id $CONTRACT_ID --network testnet -- \
  get_intent --intent_id 1
# Expected shape only; record the actual get_intent result.
```

> **Run log:** _paste the terminal output of the keeper run here (contract id,
> intent id, keeper address, the `ScheduledStreamExecuted` event / stream id,
> and the post-run `get_intent` status)._
