# Fee-aware claim scheduling (opt-in)

StreamPay lets a **recipient** choose to defer a claim: instead of paying
whatever the network charges at the moment they click *Withdraw max*, the
client builds one `withdraw_max` transaction, has Freighter sign it once, holds
the signed envelope in client storage, and submits it when the Soroban
inclusion-fee percentile is at or under a budget the user set. If fees never
get cheap, the claim is **still submitted** before a deadline derived from the
stream's economics.

This document is deliberately blunt about what the mechanism can and cannot
promise. Read §1 before trusting any of the rest.

- Decision core: `frontend/lib/claim-scheduler.ts` (pure, no I/O)
- Fee parsing: `frontend/lib/fee-stats.ts`
- RPC observer: `frontend/lib/fee-observer.ts`
- Queue + submit runtime: `frontend/lib/claim-runtime.ts`
- Storage: `frontend/lib/pending-queue.ts`
- Wallet glue + UI: `frontend/lib/use-claim-scheduler.ts`,
  `frontend/components/ClaimSchedulerSettings.tsx`
- Simulation: `frontend/lib/claim-scheduler.spec.ts` (recorded series in
  `frontend/lib/__fixtures__/fee-series.json`)

---

## 1. Honest constraints

### 1.1 What fee data is actually observable

The only fee signal Soroban RPC exposes is
[`getFeeStats`](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getFeeStats).
It returns two distributions:

| Field | Meaning |
|---|---|
| `sorobanInclusionFee` | Inclusion fees paid by Soroban (smart-contract) transactions, **per transaction**, in stroops |
| `inclusionFee` | Inclusion fees paid by classic transactions, **normalized per operation** |
| `latestLedger` | Ledger the RPC had seen at the time of the response |

Each distribution reports `min`, `mode`, `max`, the nearest-rank percentiles
`p10…p99`, plus `transactionCount` and `ledgerCount` (how many consecutive
ledgers the window covers — 50 on the public network). The scheduler reads only
`min`, `mode`, `max` and the percentiles; `transactionCount`/`ledgerCount` are
informational.

**Not observable**, and therefore not relied on:

- The exact inclusion fee a *future* transaction will pay. `getFeeStats` is a
  backward-looking summary of already-included transactions, so it can only
  tell you what has been cheap, never what will be cheap.
- The Soroban **resource fee** (execution + state rent), which is computed
  per-transaction by simulation and dominates the total cost of a Soroban
  transaction. The inclusion-fee stat is the part this feature optimizes; the
  resource fee is unaffected by waiting.
- Fee surge or any mempool/pending-transaction view.

### 1.2 Refresh cadence

Stellar closes a ledger roughly every 5 s, and `getFeeStats` summarizes the
last `ledgerCount` ledgers. The observer therefore polls every
`DEFAULT_POLL_MS = 6000 ms` (`frontend/lib/fee-observer.ts`): faster than that
just re-reads the same distribution, and slower than ~15 s starts to lag real
fee moves. Overlapping polls are coalesced, so a slow RPC never queues
requests.

### 1.3 Why a claim is never "missed" — and what is *not* guaranteed

The guarantee is **against stream end/refund events, not against cheap fees.**
Concretely, these contract properties (`docs/ARCHITECTURE.md` §3, §6) mean a
deferred claim can never lose value:

1. **Funds persist.** A stream's deposit stays in the contract until it is
   withdrawn. At `end_time` the stream is fully matured (`streamed == deposit`)
   but nothing is forfeited — the recipient can withdraw the full amount at any
   later time. There is no expiry on the claimable balance.
2. **Cancellation pays the recipient.** If the sender cancels (or a cancelable
   stream is cancelled by the recipient), the accrued balance is transferred to
   the recipient **in the same transaction** that refunds the sender. A pending
   claim is not a race against cancellation; the split is pro-rata by
   construction.
3. **No admin, no upgrade, no sweep.** There is no key that can move the funds
   outside the stream rules, so a late claim is worth exactly the same as an
   early one.

What is **not** guaranteed, and must be stated plainly:

- **Savings are not guaranteed.** The scheduler can only take an opportunity
  that the recorded fee series actually offers. On a congested network the
  deadline fallback submits at the current fee, which may be higher than the
  fee at the moment the claim was queued.
- **No background execution in v1.** The observer and scheduler run in the
  browser tab (or installed PWA window) that owns the queue. Close it and
  nothing is submitted until it is open again. This is why the deadline is a
  *fallback*, not a fire-and-forget automation.
- **A held signature is not permanent.** The queued intent is a signed
  transaction with a `maxTime`. Past it the envelope is dead and a new
  signature is required — which needs the user (see §3).

---

## 2. Queue design: one signed intent, one queue

A **signed intent** is an assembled, simulated `withdraw_max` transaction that
Freighter has signed but that has not been submitted. It is the only thing the
scheduler holds.

### 2.1 One shared queue

`frontend/lib/pending-queue.ts` is the **single** client-side queue of signed
intents. It is intentionally generic — intents are tagged with a `kind`
(`"claim"` for this feature) and scoped by `"<network>:<address>"` — because the
PWA offline pending queue (issue #48) needs the exact same primitive: an
already-signed action held in client storage until it is worth submitting.

Building a second queue would double-count intents on reconnect, diverge on
crash recovery, and — most importantly — **fight over the wallet's account
sequence number**, since two intents signed from the same account are only
individually valid in the order they are submitted. #48 must reuse this module,
not add a parallel one.

### 2.2 What is stored

For each pending claim (`QueuedClaim` in `claim-scheduler.ts`):

| Field | Why |
|---|---|
| `id` | intent id (`crypto.randomUUID()`) |
| `streamId`, `recipient` | what to claim, and who signs |
| `signedXdr` | base64 signed envelope, or `null` while awaiting a signature |
| `signedValidUntil` | the envelope's `maxTime` (unix seconds) |
| `streamStartTime`, `streamEndTime` | the deadline math (§4) |
| `createdAt`, `attempts`, `lastError`, `txHash` | diagnostics |

Persistence is `localStorage`, keyed by scope so testnet ids never leak into
publicnet. Writes are whole-list replacements — the queue is a handful of
intents, so read-modify-write keeps crash recovery trivial. Only `pending`
claims are persisted; terminal ones are dropped.

**Sequence-number caveat.** A signed envelope carries the account's sequence
number at signing time. If the same account submits any other transaction
first, the held intent becomes invalid (`tx_bad_seq`) and must be re-signed.
The same applies if the intent exceeds its `maxTime`. Both cases surface as a
`resign` — the scheduler never silently retries a stale envelope.

---

## 3. Deadline enforcement and fallback rules

The decision ladder (`evaluateClaim` in `claim-scheduler.ts`) is evaluated top
to bottom; first match wins:

| # | Condition | Action | Reason |
|---|---|---|---|
| 1 | claim is terminal | `done` | `already-terminal` |
| 2 | scheduling disabled | `wait` | `disabled` |
| 3 | `now ≤ streamStartTime` | `wait` | `too-early` |
| 4 | no signature held | `resign` | `awaiting-signature` |
| 5 | `now ≥ signedValidUntil` | `resign` | `signature-expired` |
| 6 | `now ≥ streamEndTime − deadlineLeadSeconds` | `submit` | `deadline-fallback` |
| 7 | `now ≥ signedValidUntil − submitLeadSeconds` | `submit` | `intent-expiring` |
| 8 | selected percentile ≤ `maxFeeStroops` | `submit` | `fee-below-threshold` |
| 9 | otherwise | `wait` | `fee-above-threshold` |

Step 3 prevents a guaranteed revert: `withdraw_max` on a stream with nothing
accrued fails with `NothingToWithdraw` (error #13).

Step 5 precedes 6 and 7 because a dead envelope cannot be submitted — it must
be replaced first. Steps 6 and 7 are mutually consistent because 5 has already
removed the lapsed case.

### 3.1 Deadline math from the stream's economics (issue #34)

Two clocks come out of the stream, and they are different things:

- **Stream horizon.** `streamEndTime` is when accrual reaches the full deposit.
  After it, there is nothing left to optimize *for* — the amount is fixed — so
  the scheduler stops deferring `deadlineLeadSeconds` before it and submits at
  the next tick regardless of fee. This is the "submit anyway at the deadline"
  fallback. It is *not* a loss event: the funds would still be claimable later
  (§1.3). It is the point past which waiting buys nothing.
- **Signature horizon.** `signedValidUntil` bounds how long the held envelope
  can be submitted. It is the hard wall, and the only thing that can make a
  claim *unusable* (not lost, just in need of a re-sign).

Because the signature horizon can be shorter than the stream horizon, a policy
whose `intentValiditySeconds` is small is **forced to submit early** by step 7 —
the scheduler will not risk watching a live signature lapse. The settings UI
exposes the window precisely so the user can widen it and actually wait.

### 3.2 Fallback rules, restated

- Threshold met → submit (`fee-below-threshold`).
- Threshold never met, signature still valid → submit at the deadline
  (`deadline-fallback`).
- Signature about to lapse → submit now rather than lose the envelope
  (`intent-expiring`).
- Signature already lapsed (tab was closed, address changed, RPC outage) →
  re-sign; the user is prompted once, and a `resignCooldownSeconds` gate stops
  a failing signature from re-prompting on every tick.

---

## 4. Settings UI

Rendered on `/stream/[id]` for the recipient of an active stream
(`ClaimSchedulerSettings.tsx`):

| Control | Policy field | Default |
|---|---|---|
| Enable scheduled claims | `enabled` | off (opt-in) |
| Fee percentile | `percentile` | `p50` |
| Max fee (stroops) | `maxFeeStroops` | 150 (base inclusion fee is 100) |
| Deadline lead (minutes) | `deadlineLeadSeconds` | 15 |
| Signature window (minutes) | `intentValiditySeconds` | 60 |

The panel shows the live observed percentile, the budget, the last decision
reason, and the queued claims with **Re-sign**, **Submit now** and **Cancel**.
`policy` is persisted per wallet in `localStorage`; the queue is persisted by
the shared pending queue.

---

## 5. Simulation

`frontend/lib/claim-scheduler.spec.ts` replays a **recorded fee series**
(`frontend/lib/__fixtures__/fee-series.json`) through `replaySeries` and asserts
the decisions. The rendered tables are committed as vitest snapshots
(`frontend/lib/__snapshots__/claim-scheduler.spec.ts.snap`), so any change to
the decision math fails the test until the table is deliberately updated.

Fixture: a 1-hour stream (`streamStart = t0`, `streamEnd = t0 + 3600`), default
policy (percentile `p50`, budget 150 stroops, deadline lead 900 s, submit lead
120 s), recorded at 30 s cadence.

### 5.1 `lull` — the fee drops under budget

| # | t (unix) | since end | since sig | fee stroops | budget | action | reason |
|---|----------|-----------|-----------|-------------|--------|--------|--------|
| 1 | 1790000000 | 3600s | 1800s | 200 | 150 | wait | too-early |
| 2 | 1790000030 | 3570s | 1770s | 190 | 150 | wait | fee-above-threshold |
| 3 | 1790000060 | 3540s | 1740s | 180 | 150 | wait | fee-above-threshold |
| 4 | 1790000090 | 3510s | 1710s | 210 | 150 | wait | fee-above-threshold |
| 5 | 1790000120 | 3480s | 1680s | 175 | 150 | wait | fee-above-threshold |
| 6 | 1790000150 | 3450s | 1650s | 160 | 150 | wait | fee-above-threshold |
| 7 | 1790000180 | 3420s | 1620s | 155 | 150 | wait | fee-above-threshold |
| 8 | 1790000210 | 3390s | 1590s | 165 | 150 | wait | fee-above-threshold |
| 9 | 1790000240 | 3360s | 1560s | 148 | 150 | **submit** | fee-below-threshold |

### 5.2 `spike` — fees never drop (91 samples, abridged)

| # | t (unix) | since end | since sig | fee stroops | budget | action | reason |
|---|----------|-----------|-----------|-------------|--------|--------|--------|
| 1 | 1790000000 | 3600s | 5400s | 900 | 150 | wait | too-early |
| 2 | 1790000030 | 3570s | 5370s | 820 | 150 | wait | fee-above-threshold |
| … | … | … | … | … | … | wait | fee-above-threshold |
| 91 | 1790002700 | 900s | 2700s | 340 | 150 | **submit** | deadline-fallback |

### 5.3 `spike` with a short (30 min) signature window

The envelope lapses before the stream's deadline, so the scheduler is forced to
submit at `t = 1680 s` — 900 s *before* the deadline fallback would fire:

| # | t (unix) | since end | since sig | fee stroops | budget | action | reason |
|---|----------|-----------|-----------|-------------|--------|--------|--------|
| 1 | 1790000000 | 3600s | 1800s | 900 | 150 | wait | too-early |
| 2 | 1790000030 | 3570s | 1770s | 820 | 150 | wait | fee-above-threshold |
| … | … | … | … | … | … | wait | fee-above-threshold |
| 57 | 1790001680 | 1920s | 120s | 260 | 150 | **submit** | intent-expiring |

### 5.4 `spike` with a client that was offline past the signature's `maxTime`

First decision is a re-sign (the envelope is dead), then the scheduler resumes
and falls back at the deadline:

| # | t (unix) | since end | since sig | fee stroops | budget | action | reason |
|---|----------|-----------|-----------|-------------|--------|--------|--------|
| 1 | 1790002010 | 1590s | −210s | 420 | 150 | **resign** | signature-expired |
| 2 | 1790002040 | 1560s | 1770s | 400 | 150 | wait | fee-above-threshold |
| … | … | … | … | … | … | wait | fee-above-threshold |
| 24 | 1790002700 | 900s | 1110s | 340 | 150 | **submit** | deadline-fallback |

### 5.5 What the simulation proves

- Every scenario eventually reaches a `submit` — a queued claim is never
  abandoned (asserted for all fixture series).
- The deadline fallback fires inside the deadline window
  (`secondsToStreamEnd ≤ deadlineLeadSeconds`).
- A short signature window forces an early submit rather than risking a lapse.
- A lapsed envelope produces exactly one `resign`, not a submit of a dead
  transaction.

---

## 6. Limitations and follow-ups

- **Foreground only.** No service worker / background submission in v1. A PWA
  wake-up path would be the natural follow-up and should reuse
  `pending-queue.ts`.
- **One intent per stream.** The scheduler queues at most one claim per stream;
  re-claiming after a successful submit requires queueing again.
- **Client clock reliance.** Deadlines are computed against the client wall
  clock (the observer stamps `observedAt` from `Date.now()`). A skewed clock
  moves the fallback; the contract's own `timestamp` remains authoritative for
  accrual.
- **Sequence contention.** Any other transaction from the same wallet invalidates
  a held intent (re-signed on the next tick). Batching claims so they share one
  signature would be a strict improvement.
