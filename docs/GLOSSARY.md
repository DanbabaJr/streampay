# StreamPay protocol glossary

One precise definition per protocol term, grounded in how the code actually
uses it. Every entry names its authoritative source: the doc or ADR that
defines the term, and the code that implements it. If a definition here and
the code disagree, the code wins — open an issue and fix this file.

Terms are alphabetized. Within an entry, a term in brackets (for example
[claim](#claim)) is itself defined in this glossary.

## How to read the sources

- [ARCHITECTURE.md](./ARCHITECTURE.md) is the design deep-dive (storage,
  accrual, auth, TTL, sponsorship).
- [SCHEDULED_INTENTS.md](./SCHEDULED_INTENTS.md) is the authority for
  scheduled intents and keepers.
- [adr/](./adr/README.md) records the decisions behind the math and the
  storage strategy; [WHITEPAPER.md](./WHITEPAPER.md) states the same
  properties formally.
- [FOOTPRINT.md](./FOOTPRINT.md) records measured resource costs.
- [errors.md](./errors.md) catalogues every `StreamError` code mentioned
  in passing below; the generated per-branch table is
  [ERROR_SURFACE.md](./ERROR_SURFACE.md).

### Accrual

The amount of a [stream](#stream) that has become payable to its recipient
by a given time. For a single-rate stream the contract computes it with one
pure function, `streamed_at` in `contracts/streaming-payments/src/stream.rs`:

```text
streamed_at(deposit, duration, elapsed) = deposit * elapsed / duration,
    floored to whole token units, capped at deposit
```

where `duration = end_time - start_time` and
`elapsed = min(now - start_time, duration)`. Nothing has accrued before
`start_time` (`elapsed == 0`), and the full deposit has accrued at or after
`end_time`. The window is half-open, `[start_time, end_time)`. The product
is computed in `u128` (with a capacity pre-check at creation so it can never
overflow later), and floor division means a partial second is never counted
as streamed: rounding dust accumulates to the recipient, who receives
exactly the full deposit by `end_time`. After a rate renegotiation, accrual
is the sum of one floored pro-rata term per rate segment, and the past is
never re-priced.

Source: [ADR 0004](./adr/0004-floor-per-second-accrual.md),
[ARCHITECTURE.md §3](./ARCHITECTURE.md#3-accrual-math) and
[§3.1](./ARCHITECTURE.md#31-piecewise-rates-a-stream-that-renegotiated-issue-54).

### Bond

The anti-griefing deposit a recipient posts to open a [dispute](#dispute).
`raise_dispute` pulls it from the recipient via `transfer_from` (so a prior
token approval is required) and the contract holds it for the life of the
dispute. The amount is `required_bond` in
`contracts/streaming-payments/src/dispute.rs`:

```text
bond = max(1 token unit, 5% of deposit * (prior_disputes + 1))
```

so each successive dispute on the same stream costs more. Outcomes: the
sender accepts the dispute and the bond is refunded (the stream unwinds
pro-rata); the sender rejects it as bad faith and the bond is slashed to the
sender; the 7-day timelock expires with no verdict and the bond is split
50/50, with the sender rounding up on an odd bond (`bond_shares`).

Source: [ARCHITECTURE.md §6](./ARCHITECTURE.md#disputed-an-overlay-not-a-status)
and [§8](./ARCHITECTURE.md#8-design-decisions-and-rejected-alternatives)
(griefing-threshold math).

### Claim

A recipient taking accrued funds out of a [stream](#stream). The contract
offers five shapes, all running the same [accrual](#accrual) math and the
same payout tail, and each emitting a `Withdrawn` event per stream paid:

- `withdraw(stream_id, amount)` — a partial claim, `amount ≤ available`.
- `withdraw_max(stream_id)` — claims all of `available` atomically.
- `withdraw_many(recipient, stream_ids, strict)` — up to 20 ids in one
  transaction; a stream that cannot pay is skipped with a numeric code
  instead of reverting the batch, unless `strict` is set.
- `withdraw_all(recipient, page_bounds)` — walks a page of the recipient's
  own stream index and aggregates payouts per asset.
- `sponsored_withdraw(...)` — the same claim relayed by a third party under
  a [sponsor](#sponsor)'s budget (see [sponsor](#sponsor)).

In every case `available = streamed - withdrawn`, so a claim can never pay
more than has accrued, and `0 ≤ withdrawn ≤ streamed ≤ deposit` holds after
every claim.

Source: [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-lifecycle-states),
[CLAIM_ALL.md](./CLAIM_ALL.md), [FOOTPRINT.md §4.1](./FOOTPRINT.md#41-batch-claim-vs-the-same-claims-issued-separately-205).

### Dispute

An overlay on an `Active` [stream](#stream), not a fourth stream status:
the existence of a `DisputeKey::Active(id)` entry in
`contracts/streaming-payments/src/dispute.rs`. While a dispute is open,
`cancel_stream` and `top_up` revert with `DisputeActive` (code 14), but
[accrual](#accrual) keeps running and the recipient keeps full access to
[claim](#claim) — a dispute freezes lifecycle mutations, never earnings.
Only the stream's recipient may raise one, and only by posting a
[bond](#bond). It resolves by `resolve_dispute` (sender accepts: bond back,
stream unwinds pro-rata; sender rejects: bond slashed to the sender, stream
resumes) or by `expire_dispute` after the 7-day timelock (bond split 50/50,
stream resumes). A stream can reach `Depleted` underneath an open dispute;
resolution then settles only the bond.

Source: [ARCHITECTURE.md §6](./ARCHITECTURE.md#disputed-an-overlay-not-a-status).

### Dual-read

The off-chain reconciliation pattern that compares the same stream state
read from two independent sources — Horizon (classic-bridge effects) and
Soroban RPC (contract storage) — and raises an alarm on divergence instead
of silently trusting either one. The reconciler
([`reconciler/`](../reconciler/README.md)) tolerates a consistency lag
window (default 30 s) for ordinary indexing delay: disagreement inside the
window is a warning, disagreement outside it is a divergence (error log +
webhook to the indexer dashboard). A stream missing from Horizon only is a
warning (likely indexing delay); missing from Soroban RPC only is critical
(potential index corruption). When divergence is detected above a ledger
`L`, the outbox retracts journal rows and intents above `L` so consumers
rebuild from the surviving cursor.

Source: [`reconciler/README.md`](../reconciler/README.md),
[OUTBOX.md](./OUTBOX.md#reorg-safety).

### Endowment

The property that a [stream](#stream) is fully funded up front: the deposit
`D` is escrowed at creation (and each top-up adds to it) *before* any of it
can accrue, so the endowment condition `deposit ≥ owed-rate × horizon`
holds with equality (`D = r · T`, where `r = D / T` is the owed rate). A
stream therefore never owes more than it was funded with, and the full
funding is owed by `end_time`. Contract-wide, the same idea is the solvency
invariant in [ARCHITECTURE.md §5](./ARCHITECTURE.md#5-reentrancy-checks-effects-interactions):
the contract's token balance is always at least the sum of
`deposit - withdrawn` over live streams, plus outstanding dispute
[bonds](#bond), plus collectible treasury fees.

Source: [WHITEPAPER.md §5](./WHITEPAPER.md#5-endowment-and-contract-solvency)
(§5.1 in particular),
[ARCHITECTURE.md §5](./ARCHITECTURE.md#5-reentrancy-checks-effects-interactions).

### Escrow

Funds held by the contract on behalf of a future action, releasable only
per the rules that created them. StreamPay has three escrows, and they never
mix: a stream's deposit (held until [claimed](#claim) by the recipient or
refunded on cancellation), a scheduled [intent](#intent)'s
`(deposit + fee_budget) × occurrences`, pulled from the sender at scheduling
time so a [keeper](#keeper) can never execute an unfunded intent, and a
dispute [bond](#bond), held for the life of the dispute. The fee a sender
paid at creation and a dispute bond are never part of any stream's deposit,
so no payout path can reach them.

Source: [SCHEDULED_INTENTS.md §4](./SCHEDULED_INTENTS.md#4-escrow-and-keeper-economics),
[ARCHITECTURE.md §5](./ARCHITECTURE.md#5-reentrancy-checks-effects-interactions)
(balance invariant).

### Footprint

The measured resource cost of an operation: CPU instructions, memory bytes,
ledger storage keys and bytes (XDR), and event bytes. The canonical numbers
are the baselines in [FOOTPRINT.md](./FOOTPRINT.md) — for example a
monolithic `Stream` entry is 444 bytes of payload + 40 bytes of key
(484 bytes total), `create_stream` costs ~542k CPU instructions, and a
`get_stream` read costs ~67k. "Footprint" is a measurement claim, not a
vibe: a change that claims to shrink it must cite the harness
(`contracts/streaming-payments/examples/storage_benchmark.rs`, asserted by
`hot_path_footprint_harness` in the contract tests). The layout decision
this produced — keep the stream in one monolithic entry, because splitting
hot/cold fields costs +51.5% CPU on reads and +61.6% on writes — is recorded
in [ARCHITECTURE.md §2](./ARCHITECTURE.md#2-storage-model).

Source: [FOOTPRINT.md §3](./FOOTPRINT.md#3-production-contract-footprint-baseline),
[ARCHITECTURE.md §2](./ARCHITECTURE.md#2-storage-model).

### Intent

Short for *scheduled intent*: a `ScheduledIntent` record
(`contracts/streaming-payments/src/schedule.rs`) created by
`schedule_stream` that pre-authorizes one or more future stream creations.
The sender authorizes once and escrows `(deposit + fee_budget) × occurrences`
up front; each occurrence is later materialized as an ordinary stream by a
[keeper](#keeper) calling `execute_scheduled`. An intent carries the full
stream parameters (sender, recipient, token, deposit, window, `cancelable`),
the recurrence (`interval`, `occurrences`, at most `MAX_OCCURRENCES = 1000`),
the execution window (`execute_after`, `expires_at`), and a SHA-256
`params_hash` commitment over every immutable parameter, recomputed on each
execution. Statuses are `Pending`, `Executed`, `Cancelled`, and `Expired`
(all but `Pending` terminal). Occurrence `i` is due at
`execute_after + i * interval` and its window is
`[start_time + i * interval, end_time + i * interval)`; late execution never
shifts the window, so a late-created stream may already have accrued value.
One-shot intents use `occurrences = 1`, `interval = 0`.

Source: [SCHEDULED_INTENTS.md](./SCHEDULED_INTENTS.md)
(§2 lifecycle, §3 timing model, §6 contract API).

### Keeper

Any address that executes a due scheduled [intent](#intent) by calling
`execute_scheduled(intent_id, keeper)`. The keeper authorizes only its own
call (`keeper.require_auth()`), needs no sender key, and is paid the
escrowed `fee_budget` for that occurrence from funds the sender already
locked up. The keeper cannot redirect the stream, change its parameters,
execute an occurrence twice, or move funds it is not owed: execution is
gated by on-chain timing and the intent's `params_hash`, and the fee is paid
to whoever authorized the call, so front-running the call cannot steal it.
The reference keeper is [`scripts/keeper.sh`](../scripts/keeper.sh); it
simulates with `--send=no` before sending, and should only execute when
`fee_budget` exceeds its all-in cost.

Source: [SCHEDULED_INTENTS.md §4](./SCHEDULED_INTENTS.md#4-escrow-and-keeper-economics),
[§5](./SCHEDULED_INTENTS.md#5-auth-model) and
[§7](./SCHEDULED_INTENTS.md#7-running-a-keeper).

### Ledger time vs wall clock

The contract's clock is **ledger time**: `env.ledger().timestamp()`, the
timestamp of the ledger the transaction lands in, in seconds. Streams are
expressed in seconds against that clock, so a stream behaves identically on
testnet, mainnet, and in tests — but its granularity is bounded by the
ledger cadence (~5 s on mainnet). **Wall clock** is the off-chain time a
user or frontend sees (`Date.now()`): it is only ever a rendering or
simulation input. A client that renders a balance from wall clock can lead
the landing ledger by a few seconds; the contract enforces the claim at
ledger time, so leading beyond the landing ledger reverts with
`AmountExceedsAvailable` rather than over-paying, and `withdraw_max` is
skew-proof by construction (the skew matrix is pinned in
`contracts/streaming-payments/src/clock_skew_test.rs`). The one exception
is opt-in per stream: an oracle reference clock (§16 of
[ARCHITECTURE.md](./ARCHITECTURE.md)) may supply time instead, with a
fail-safe fallback to ledger time if quorum or freshness fails.

Source: [ARCHITECTURE.md §8](./ARCHITECTURE.md#8-design-decisions-and-rejected-alternatives)
(wall-clock accrual) and
[§16](./ARCHITECTURE.md#16-oracle-reference-clock--staleness-bounds).

### ScVal

`ScVal` is Stellar's XDR value type: the single tagged-union encoding every
Soroban host value is serialized as — `U32`/`I32`/`U64`/`I64`/`U128`/`I128`,
`Bool`, `String`, `Symbol`, `Bytes`, `Vec`, `Map`, `Address`, `Timepoint`,
and so on. Contract types convert to and from it (`TryFromVal<Env, ScVal>`
in the SDK), which is why off-chain tooling that reads raw ledger entries
or builds signed payloads must speak it. Concretely in this repo: the
sponsored-[claim](#claim) message is assembled as a `Vec<Val>` whose fields
have fixed `ScVal` forms (`ScVal::String` for the domain tag and strkeys,
`ScVal::U64` for `stream_id`/`nonce`/`deadline`, `ScVal::I128` for `amount`),
and the storage-golden suite renders stored entries and events as `ScVal`
to diff layout changes.

Source: [ARCHITECTURE.md §13.2](./ARCHITECTURE.md#13-gas-sponsorship-relayed-claims-without-a-mempool-relayer),
[STORAGE_LAYOUT.md](./STORAGE_LAYOUT.md#layout).

### Sponsor

An account that funds other people's [claim](#claim) transaction fees — in
practice, the token budget behind "Claim for free". A sponsor registers with
`register_sponsor(sponsor, token, per_period_limit, per_beneficiary_limit,
window_seconds, operator_key)`, storing a `SponsorConfig` in
`contracts/streaming-payments/src/sponsor.rs`; beneficiaries enroll a
consent key once with `enroll_beneficiary`. A claim is then a fully
specified intent (contract, sponsor, beneficiary, token, stream, amount,
one-time nonce, short deadline) signed with **both** ed25519 keys — the
sponsor's operator (relayer) key and the beneficiary's consent key — and any
account may submit `sponsored_withdraw` and pay the network fee. The
contract verifies both signatures over the SHA-256 digest of the canonical
message before spending anything; caps are rolling windows, nonces are
one-shot and never freed, and rotating the operator key instantly invalidates
old operator signatures. The sponsor pays the budget in the funded token;
the operator pays the transaction fee; the beneficiary pays nothing except
the one-time enrollment.

Source: [ARCHITECTURE.md §13](./ARCHITECTURE.md#13-gas-sponsorship-relayed-claims-without-a-mempool-relayer),
[README.md](../README.md#gas-sponsorship-claim-for-free).

### Stream

The core object: one linear payment from a sender to a recipient in one
token. A `Stream` (`contracts/streaming-payments/src/stream.rs`) is
`{ sender, recipient, token, deposit, withdrawn, start_time, end_time,
cancelable, status }`, stored as a single persistent entry under
`DataKey::Stream(id)` with ids counted from 1 by `DataKey::NextStreamId`.
`sender` funds it (and may top it up or cancel it); `recipient` is the only
address that may [claim](#claim) from it; `deposit` is the total amount ever
payable, `withdrawn` what has already been paid out. `status` is `Active`,
`Cancelled`, or `Depleted` (fully withdrawn) — both terminal states are
terminal, and a dispute is an overlay on `Active`, not a status (see
[dispute](#dispute)). The window is half-open `[start_time, end_time)` and
[accrual](#accrual) is linear over it; cancelling splits pro-rata
(recipient ← accrued-but-unwithdrawn, sender ← unaccrued remainder).
Discovery is per-address, via append-only `RecipientStreams` /
`SenderStreams` indexes that are advisory only — auth and payouts always
read the `Stream` entry itself.

Source: [ARCHITECTURE.md §2](./ARCHITECTURE.md#2-storage-model) and
[§6](./ARCHITECTURE.md#6-lifecycle-states),
[README.md](../README.md#how-streams-accrue).

### TTL and rent

Soroban persistent-storage entries do not live forever: each carries a
**TTL** (time-to-live), counted in ledgers, and is archived to off-chain
cold storage when it reaches zero (restorable later, for a fee). StreamPay
extends TTL on write — every mutating entrypoint calls
`extend_ttl(TTL_THRESHOLD_LEDGERS = 200_000, TTL_EXTEND_LEDGERS = 500_000)`,
i.e. when under ~11.6 days of life remains, extend to ~29 days — so an
actively used stream never goes cold, while an abandoned one archives and
bounds state bloat. Address indexes get the same treatment on write *and*
on paginated read. Three entries are **never** extended on-chain and expire
after 4,095 ledgers (~5.7 h) unless an external process extends them:
`NextStreamId`, the contract instance entry, and the Wasm code entry — that
is what [`infra/ttl-sentinel`](../infra/ttl-sentinel/README.md) watches.
**Rent** is what that storage costs: the protocol charges per ledger per
byte of live entry, so a stream entry (~504 bytes) costs roughly 0.021 XLM
per live stream per month at the floor fee, and Wasm code rent dominates
below roughly 80 live streams.

Source: [ADR 0008](./adr/0008-extend-on-write-ttl-strategy.md),
[ARCHITECTURE.md §12](./ARCHITECTURE.md#12-ttl-and-rent-operations),
[WHITEPAPER.md §8.1](./WHITEPAPER.md#81-storage-rent-who-keeps-a-stream-alive-and-for-how-long).

## Writing docs: the "terms used in this doc" convention

New and revised docs must not make the reader infer a protocol term from
context. Follow this convention:

1. **Define it here first.** Before a new protocol term appears in any doc,
   add an alphabetized entry to this glossary with a definition grounded in
   the implementation and a link to its authoritative source. Do not invent
   a definition; if the code and the docs disagree, the code wins.
2. **Link the first use.** The first time a doc uses a glossary term, link
   it to its entry, e.g. `[accrual](./GLOSSARY.md#accrual)` from inside
   `docs/` (from the repo root, prefix the path with `docs/`). Later
   uses in the same doc need no link.
3. **Add a "terms used in this doc" note when a doc leans on the glossary.**
   Near the top of a doc that uses several protocol terms, add a short note
   naming them with links, for example:

   > Terms used in this doc: [stream](./GLOSSARY.md#stream),
   > [accrual](./GLOSSARY.md#accrual), [keeper](./GLOSSARY.md#keeper).
   > Definitions live in [GLOSSARY.md](./GLOSSARY.md).

   A doc that only uses one or two terms may skip the note and just link
   the first use (rule 2).
4. **Never redefine a term inline.** If a doc needs a nuance the glossary
   lacks, extend the glossary entry (with its source) instead of writing a
   second, drifting definition in the doc.
5. **Check the links.** Run `npm run links:check` from the repo root before
   opening the PR; it fails on any relative link or `#anchor` that does not
   resolve.
