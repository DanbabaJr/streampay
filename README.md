# ⚡ StreamPay

**Continuous, per-second payment streams for the Stellar network — Sablier-style money flow, native to Soroban.**

[![CI](https://github.com/Neziahtech/streampay/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![rustfmt + clippy](https://img.shields.io/badge/style-rustfmt%20%2B%20clippy-informational)](./.github/workflows/ci.yml)

> A payroll line that pays by the second. A vesting schedule your team can watch tick. A subscription that cancels itself the moment funding stops — with every unearned token refunded.

StreamPay is a Soroban smart contract that locks a deposit and releases it **linearly over time** to a recipient. The recipient withdraws accrued funds whenever they like; the sender can top up mid-stream or cancel, splitting the remaining funds fairly: earned tokens to the recipient, unearned tokens back to the sender. Similar in spirit to Sablier on Ethereum, designed from scratch for Stellar's ledger model.

## Why

- **Payroll**: pay contractors or DAO contributors by the second instead of by invoice — they can withdraw as they earn, with zero counterparty risk on accrued funds.
- **Vesting**: lock team/investor tokens in a transparent, immutable schedule.
- **Subscriptions & escrow**: fund a stream; when it runs dry, service stops. Cancelling returns what wasn't earned.

Everything is on-chain and trust-minimized: no admin key, no upgrade path, funds only ever move per the stream rules.

## How streams accrue

```text
 deposit ─────────────── locked in the contract ──────────────▶
 ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
             │ linear per-second release, floor division
 time ────── start_time ────────────────────── end_time ─────▶

 streamed(t) = deposit × elapsed / duration   (u128 checked, floored)
 available   = streamed − withdrawn           ; 0 before start_time
 on cancel : recipient ← available,  sender ← deposit − streamed
```

A stream is a half-open window `[start_time, end_time)`. At any ledger timestamp the contract computes `deposit × elapsed / duration` with checked math (products widened to `u128`, results floored to whole token units and capped at the deposit). **Every edge case you can think of — withdrawing before start, after end, cancelling a never-started stream, topping up after end — is covered by a unit test** (see `contracts/streaming-payments/src/test.rs`).

How it works in depth, including the design invariants and the Soroban-specific traps contributors keep rediscovering (`extend_ttl` on missing keys, `#[contractimpl]` signature rules, the sdk-28 build path): [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). New to the protocol vocabulary? [`docs/GLOSSARY.md`](./docs/GLOSSARY.md) defines every protocol term — stream, accrual, endowment, claim, keeper, intent, sponsor, bond, TTL/rent, footprint, dual-read, ScVal, ledger time — with a link to its authoritative source.

## Architecture overview

```text
/frontend (Next.js + Freighter)         /docs/ARCHITECTURE.md
        │  sign & submit txs                   │ design deep-dive
        ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  StreamingPayments (Soroban)                 │
│                                                              │
│  create_stream(s)┐  withdraw ─┐   top_up ─┐   cancel_stream  │
│                 │             │            │        │        │
│            ┌────┴─────────────┴────────────┴────────┴────┐   │
│            │  Stream { sender, recipient, token,         │   │
│            │            deposit, withdrawn, start_time,  │   │
│            │            end_time, cancelable, status }   │   │
│            │  persistent storage + TTL extension         │   │
│            └──────────────────┬──────────────────────────┘   │
└───────────────────────────────┼──────────────────────────────┘
                                ▼
                     SAC / standard token interface
```

Deep dive (storage model, checked math, reentrancy, TTL strategy, design decisions): [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Historical architecture decision records (ADRs) and trade-off rationales: [`docs/adr/`](./docs/adr/README.md).

Incident response drills and procedures: [`docs/INCIDENT_RUNBOOK.md`](./docs/INCIDENT_RUNBOOK.md).

Metrics, alerting stack, and operational diagnosis: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) and [`infra/observability`](./infra/observability/README.md).

## Contract API

| Function | Caller | Moves tokens | Emits |
|---|---|---|---|
| `create_stream(sender, recipient, token, deposit, start, end, cancelable) → u64` | anyone (sender auth required) | pulls deposit in | `StreamCreated` |
| `create_streams(sender, inputs: Vec<StreamInput>) → Vec<u64>` | anyone (sender auth required) | one pull per token | `StreamsCreated`; `FeeCharged` per charged stream |
| `withdraw(stream_id, amount)` | recipient | pays out ≤ accrued | `Withdrawn` |
| `withdraw_max(stream_id) → i128` | recipient | pays out all accrued, atomically | `Withdrawn` |
| `withdraw_many(recipient, stream_ids: Vec<u64>, strict) → Vec<WithdrawEntry>` | recipient of every listed stream | pays out each settled stream's accrued balance, in one transaction | `Withdrawn` per settled stream; `BatchWithdrawSummary` |
| `withdraw_all(recipient, page_bounds) → WithdrawAllResult` | recipient | batch-withdraws accrued funds, aggregated per asset | `Withdrawn` per stream |
| `cancel_stream(caller, stream_id)` | sender; recipient iff `cancelable` | pro-rata split, atomic | `StreamCancelled` |
| `top_up(stream_id, amount)` | sender | pulls added funds | `StreamToppedUp` |
| `raise_dispute(stream_id)` | recipient | pulls escalating anti-griefing bond in | `DisputeRaised` |
| `resolve_dispute(caller, stream_id, accept)` | sender | accept: bond back + pro-rata unwind; reject: bond slashed to sender | `DisputeResolved` (+ `StreamCancelled` on accept) |
| `expire_dispute(stream_id)` | anyone after 7 d | bond split 50/50 (sender rounds up), stream resumes | `DisputeExpired` |
| `propose_ownership_transfer(caller, stream_id, new_owner)` | sender or recipient | — (records a pending target) | `OwnershipProposed` |
| `accept_ownership_transfer(caller, stream_id)` | named `new_owner` only | — (moves the role) | `OwnershipAccepted` |
| `cancel_ownership_transfer(caller, stream_id)` | proposer only | — (clears the pending target) | — |
| `propose_rate_change(caller, stream_id, amount_per_second)` | sender or recipient | — (records a pending offer) | `RateChangeProposed` |
| `accept_rate_change(caller, stream_id)` | named counterparty only (an increase also consumes sender auth) | pulls the shortfall or refunds the freed escrow, atomically | `RateChangeAccepted` |
| `cancel_rate_change(caller, stream_id)` | proposer only | — (clears the pending offer) | — |
| `propose_sender_transfer(caller, stream_id, new_sender, nonce, transfer_refund_rights)` | current sender | — (records a pending proposal) | `SenderTransferProposed` |
| `accept_sender_transfer(caller, stream_id, nonce)` | recipient only | — (moves the payer role) | `SenderTransferred` |
| `expire_sender_transfer(stream_id) → u64` | anyone, after the window | — (clears a dead proposal) | `SenderTransferExpired` |
| `create_stream_with_refund(sender, recipient, token, deposit, start, end, cancelable, refund_to) → u64` | anyone (sender auth required) | pulls deposit in | `StreamCreated`; `StreamRefundTargetChanged` |
| `set_refund_target(caller, stream_id, refund_to)` | sender-role holder, active streams | — (moves the refund destination) | `StreamRefundTargetChanged` |
| `get_stream(stream_id) → Stream` | — (read-only) | — | — |
| `get_dispute(stream_id) → Dispute` | — (read-only) | — | — |
| `required_dispute_bond(stream_id) → i128` | — (read-only) | — | — |
| `available(stream_id) → i128` | — (read-only) | — | — |
| `pending_ownership_transfer(stream_id) → Option<PendingOwnership>` | — (read-only) | — | — |
| `pending_rate_change(stream_id) → Option<PendingRateChange>` | — (read-only) | — | — |
| `rate_segments(stream_id) → Vec<RateSegment>` | — (read-only) | — | — |
| `pending_sender_transfer(stream_id) → Option<PendingSenderTransfer>` | — (read-only) | — | — |
| `sender_history(stream_id) → SenderHistory` | — (read-only) | — | — |
| `refund_target(stream_id) → Address` | — (read-only) | — | — |
| `recipient_streams(address, offset, limit) → Vec<u64>` | — (read-only) | — | — |
| `sender_streams(address, offset, limit) → Vec<u64>` | — (read-only) | — | — |
| `schedule_stream(sender, recipient, token, deposit, start, end, cancelable, interval, occurrences, fee_budget, execute_after, expires_at) → u64` | anyone (sender auth required) | pulls `(deposit+fee)×occurrences` in | `StreamScheduled` |
| `execute_scheduled(intent_id, keeper) → u64` | anyone (keeper auth required) | pays keeper the fee | `StreamCreated`, `ScheduledStreamExecuted` |
| `cancel_scheduled(sender, intent_id)` | intent sender, before the window | refunds outstanding escrow | `ScheduledIntentCancelled` |
| `reclaim_expired(intent_id)` | anyone, after `expires_at` | refunds outstanding escrow to sender | `ScheduledIntentExpired` |
| `get_intent(intent_id) → ScheduledIntent` | — (read-only) | — | — |
| `sender_intents(address, offset, limit) → Vec<u64>` | — (read-only) | — | — |
| `set_fee_bps(caller, new_fee_bps)` | treasury governor | — | — |
| `nominate_governor(caller, new_governor)` | treasury governor | — | — |
| `accept_governor(caller)` | nominated governor | — | — |
| `withdraw_treasury(caller, token, recipient, amount)` | treasury governor | pays out collected fees | `FeeWithdrawn` |
| `treasury_status(token) → TreasuryStatus` | — (read-only) | — | — |
| `stream_fee(stream_id) → i128` | — (read-only) | — | — |
| `verify_treasury(token, start_id, count) → FeeScan` | — (read-only) | — | — |
| `total_streams() → u64` | — (read-only) | — | — |
| `register_sponsor(sponsor, token, per_period_limit, per_beneficiary_limit, window_seconds, operator_key)` | sponsor | — | `SponsorRegistered` |
| `set_sponsor_active(sponsor, active)` | sponsor | — | `SponsorActiveSet` |
| `rotate_operator_key(sponsor, new_operator_key)` | sponsor | — | `OperatorKeyRotated` |
| `enroll_beneficiary(beneficiary, public_key)` | beneficiary | — | `BeneficiaryEnrolled` |
| `sponsored_withdraw(sponsor, beneficiary, stream_id, amount, nonce, deadline, operator_sig, beneficiary_sig)` | anyone (gas paid by submitter; consent via two ed25519 sigs) | pays out ≤ accrued | `SponsorClaim` |
| `get_sponsor(sponsor) → Option<SponsorConfig>` | — (read-only) | — | — |
| `get_beneficiary_public_key(beneficiary) → Option<BytesN<32>>` | — (read-only) | — | — |
| `sponsor_period_spend(sponsor) → PeriodSpend` | — (read-only) | — | — |
| `beneficiary_spend(sponsor, beneficiary) → PeriodSpend` | — (read-only) | — | — |

`create_stream` emits `FeeCharged` when a protocol fee applies. `create_streams`
validates and creates the full batch atomically: if one input fails, none of
the streams or token transfers are committed. Empty batches are no-ops. Each
batch reserves contiguous ids in one write and groups the deposit pulls by
token. It emits one `StreamsCreated` event containing the new ids instead of
individual `StreamCreated` events; fee-enabled batches still emit one
`FeeCharged` event per charged stream to preserve treasury auditability — see
[Protocol fees](#protocol-fees-optional) below. Soroban transaction resource
limits bound the practical maximum batch size.

`withdraw_many(recipient, stream_ids, strict)` (#205) settles up to
`MAX_WITHDRAW_BATCH = 20` streams in one transaction and answers with one entry
per requested id, in request order: `{ stream_id, amount, code: 0 }` for a stream
that paid, `{ stream_id, amount: 0, code }` for one it skipped. The code is the
numeric `StreamError` discriminant rather than an error *value* on purpose —
`scValToNative` cannot convert a ScVal carrying an `ScError`, so a `Result` in
that vector would make a batch with one skipped stream undecodable off-chain.
Every entry runs the same code path as `withdraw_max` — the same accrual math,
TTL extension and `Withdrawn` event — so partial success is the default and one
exhausted stream no longer blocks the other nineteen. `strict` promotes any
per-entry rejection into a revert of the whole call. Three bounds are checked
before any state is read: an empty list (`WithdrawBatchEmpty`, 96), a list over
the cap (`WithdrawBatchTooLarge`, 97) and a repeated id
(`WithdrawDuplicateStreamIds`, 98) each revert the call outright, because a
second entry for an id would claim against state its first entry had already
rewritten. A per-entry `code` is one of the pre-payout rejections the
single-stream path returns — the stream is unknown, not yours, not active, or has
nothing accrued — and that entry pays nothing. A refused *payout* is the one
failure that aborts the batch instead of skipping an entry: its `withdrawn`
update and `Withdrawn` event were written before the token was called, as CEI
requires, and neither can be un-written for a single entry, so the transaction
reverts whole. Batching is cheaper as well as shorter: 20 claims in one call
measured 6.27M CPU against 7.99M for the same 20 claims as 20 transactions
([`docs/FOOTPRINT.md`](./docs/FOOTPRINT.md) §4.1).

`recipient_streams` / `sender_streams` are on-chain discovery indexes:
append-only, creation-ordered stream-id lists per address, paginated
(`limit` clamped to `MAX_PAGE_SIZE = 50`). Terminal streams keep their ids —
read each stream's `status` for lifecycle state. Ownership transfers follow
the same append-only rule: the new holder's index gains the id on acceptance
and the previous holder keeps its historical entry, so readers must check the
current `sender` / `recipient` fields on `get_stream` before acting on an
indexed id. A consented **sender-role transfer** (#201) is the exception: it
re-points the payer index on both sides, so the outgoing sender's page stops
listing the stream and the incoming sender's starts listing it.

### Two-step ownership transfer

Either party can hand their role to a new address without moving funds:

1. The current sender (payer) or recipient (claimant) calls
   `propose_ownership_transfer`, which records the target and a 7-day
   acceptance window. The stream is unchanged.
2. The named target calls `accept_ownership_transfer`; only then does the role
   move. The proposer can cancel a pending proposal at any time.

Deposit, withdrawn amount, and the time window are untouched, so accrual and
the `0 ≤ withdrawn ≤ streamed ≤ deposit` invariant are identical before and
after a transfer — only the destination of future claims (recipient) or future
top-ups/cancellation refunds (sender) changes. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §17 for the full invariant
proof sketch.

### Two-step rate renegotiation

The two parties can agree on a new `amount_per_second` for the rest of a live
stream. Neither can impose it:

1. The current sender or recipient calls `propose_rate_change`, which records
   the new rate and a 7-day acceptance window. The stream is unchanged.
2. Only the counterparty named in that offer can call `accept_rate_change`, and
   only before it expires. The proposer can cancel a pending offer at any time;
   an expired offer is unacceptible but replaceable.

At acceptance the contract prices the change: what the recipient has already
earned at the old rate stays exactly as it accrued, the remaining window is
reserved at the new rate, and the difference against the escrow still held is
settled in the same transaction — pulled from the sender on an increase,
refunded to them on a decrease. An increase the sender cannot fund reverts
before anything changes, so a failed negotiation leaves the stream, its
schedule and the open offer untouched. The accepted schedule is readable with
`rate_segments`, and every accrual path (`available`, `withdraw`,
`withdraw_max`, cancellation) prices it, so the client-side numbers and the
on-chain money cannot disagree. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §3.1 and §18 for the piecewise
math and the exactness argument, and
[`docs/adr/0012-piecewise-rate-schedule-storage.md`](./docs/adr/0012-piecewise-rate-schedule-storage.md)
for why the schedule lives under its own storage key.
### Consented sender-role transfer

`propose_ownership_transfer` hands a role to the address that will hold it, so
the target consents. A **sender-role transfer** is the other case: the payer
changes, and the party who loses their counterparty is the recipient, so the
*recipient* consents.

1. The current sender calls `propose_sender_transfer(stream_id, new_sender,
   nonce, transfer_refund_rights)`, which stores a proposal with the same
   7-day window. The stream is unchanged; a second proposal is refused while
   one is live (`SenderTransferPending`, code 92).
2. The stream's recipient — and only the recipient — calls
   `accept_sender_transfer(stream_id, nonce)` with that nonce. Any other
   caller gets `SenderTransferNotConsenter` (93); a nonce that is not the
   stored one gets `SenderTransferNonceMismatch` (91), so a replaced proposal
   can never be executed with a stale consent.
3. If the window lapses, the proposal cannot execute (`SenderTransferExpired`,
   82) and anyone may reclaim the storage with
   `expire_sender_transfer(stream_id)` (83 while it is still live), which
   returns the nonce it removed.

Only `sender` moves: deposit, `withdrawn`, token and window are untouched, so
accrual is identical before and after a hop. Every executed hop is appended to
the stream's immutable `SenderHistory` log, whose `sender_at_creation` keeps
answering "who funded this deposit?" however many roles pass by. The refund
claim of the original deposit is **not** implied by the role change: it stays
with whoever held it unless the proposal sets `transfer_refund_rights`, and
`refund_target(stream_id)` always reports where the cancellation remainder
would go. Both discovery index pages are rewritten and TTL-extended by the
same shared index writers the creation path uses.

### Refund routing

The destination that paragraph defers to is directly addressable. A stream can
be created with its refund already routed — `create_stream_with_refund(...,
refund_to)` — and re-pointed later by whoever currently holds the sender role
with `set_refund_target(stream_id, refund_to)`, which refuses a finished stream
(`StreamNotActive`, 5), a caller outside the payer role (`RefundTargetNotSender`,
94), and a routing to the address that already holds the claim
(`RefundTargetUnchanged`, 95).

Routing moves *where cancellation money goes* and nothing else: it grants no
authority (the routed address still cannot cancel, top up or withdraw), and it
never enters the accrual math, so a routed stream and an unrouted twin have
identical records and identical remainders — only the destination differs. It
composes with a sender-role hop in the order the two happen: a hop that does not
move refund rights preserves the routing, a hop that does replaces it. Note the
trap that follows: a pinned destination drains whatever the pot holds, so routing
the claim before a later sender tops the stream up sends that larger remainder
to the pinned address. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §19.

Any SEP-41-compatible asset can fund a stream: an issued asset via its
Stellar Asset Contract id (e.g. USDC on testnet) or **native XLM** via its
own SAC — the frontend's asset selector resolves the choice for you.

Creating a stream requires a prior token approval: `token.approve(sender, <contract id>, deposit, exp)` — the UI checks the allowance and signs the approval only when it is short. All failures return typed `StreamError` codes (no panics) — see `contracts/streaming-payments/src/errors.rs`. Token-transfer failures carry their own codes (`DepositTransferFailed` 26, `TopUpTransferFailed` 27, `RecipientPayoutFailed` 28, `SenderRefundFailed` 29, `TreasuryPayoutFailed` 30): a token's own error numbers live in the same `Error(Contract, #N)` namespace and are never allowed to masquerade as StreamPay's.

### Scheduled intents (keeper-executable cron)

`sender` can pre-authorize one or many future stream creations and escrow the
up-front cost; a permissionless keeper then materializes each occurrence and
collects the escrowed `fee_budget`. This gives payroll/vesting an on-chain cron
without a sender signing key online. Funds are escrowed for **all** occurrences
at scheduling time, so a keeper can never run an unfunded intent. New `StreamError`
codes 18–25 cover the intent lifecycle.

**Keeper in one command:** [`./scripts/keeper.sh`](./scripts/keeper.sh)

```bash
CONTRACT_ID=C... KEEPER=my-keeper ONCE=1 INTENTS="1 2 3" ./scripts/keeper.sh
CONTRACT_ID=C... KEEPER=my-keeper SENDER=G... MIN_FEE=1000000 RECLAIM=1 \
  ./scripts/keeper.sh
```

The full threat model (replay, keeper front-running, under-funded-keeper
griefing, liveness) and the testnet run log live in
[`docs/SCHEDULED_INTENTS.md`](./docs/SCHEDULED_INTENTS.md).

## Protocol fees (optional)

An off-by-default treasury layer (`fee_bps = 0` at deploy) charges a
protocol fee **once, at the deposit boundary**: the sender approves and pays
`deposit + fee`, where `fee = deposit × fee_bps / 10_000` (hard-capped at
100 bps = 1 % by protocol constant). The stream's `deposit` — and therefore
every per-second accrual, withdrawal and cancel-refund computation — is
untouched. At `fee_bps = 0` behavior is bit-for-bit identical to v0.3.

Fees accumulate in a per-token treasury, withdrawable only by the
treasury governor (bound at deploy time by the constructor; two-step
rotation). Anyone can prove the fee ledger is consistent —
`fee_total == Σ FeeCharged events == Σ per-stream stored fees` — from
public reads alone:

```bash
cd scripts && npm install
npm run verify-fees -- --contract <C…> --token <C…> --start-ledger <deploy ledger>
```

Design details, the cancel-refund decision table, and rejected
alternatives: [`docs/ARCHITECTURE.md` §11](./docs/ARCHITECTURE.md).

**Disputes.** A recipient who was paid to the wrong address — or coerced into
being a stream's recipient — can `raise_dispute` for a bond (5 % of the
deposit, scaling linearly with every dispute round on that stream) and freeze
the stream's cancel/top-up controls for one week while the sender decides:
accept (bond back, stream unwound pro-rata) or reject as bad faith (bond
slashed to the sender, stream resumes). If the sender never acts, the
timelock expires and the bond is split 50/50. Accrued funds stay withdrawable
throughout — a dispute never confiscates earnings. The bond makes serial
griefing escalate: blocking the stream costs the recipient ~2.5 % of the
deposit per week, growing every round (`docs/ARCHITECTURE.md` has the full
threshold math). Raising a dispute needs a prior `token.approve(recipient,
<contract id>, bond, exp)`.
## Gas sponsorship (claim for free)

Recipients can withdraw accrued funds without holding XLM for the
transaction fee: a **sponsor** (a sender, the dApp operator, or any funded
account) registers a budget — token, per-period cap, per-beneficiary cap,
window, and an ed25519 operator (relayer) key — and beneficiaries enroll
their own ed25519 consent key once. A claim is then a fully-specified
intent (contract, sponsor, beneficiary, token, stream, amount, one-time
nonce, short deadline) signed by **both** keys; any account may submit
`sponsored_withdraw` and pays the network fee, while the contract verifies
both signatures over the SHA-256 digest of the canonical message before
spending anything. Soroban has no mempool relayer, so this dual-signature
inner-authorization pattern replaces one — the exact mechanism, message
layout and check order are documented in
[`docs/ARCHITECTURE.md` §13](./docs/ARCHITECTURE.md), and the JS ↔ Rust
wire parity is pinned by frozen test vectors on both sides.

Budgets are hard caps: the period spend and per-beneficiary spend roll
forward with the window, nonces are one-shot, and an invalid-signature
attempt traps before any nonce or budget state is consumed — a failed relay
leaves no trace to wear down.
Sponsor key rotation is instant — `rotate_operator_key` makes old operator
signatures stop validating with the next ledger. The frontend exposes the
whole path as **"Claim for free"** with explicit disclosure of who pays and
what remains in the budget.

Threat model for this surface (budget-drain griefing, signature
interception, replay, clock manipulation):
[`docs/THREAT_MODEL.md` §12](./docs/THREAT_MODEL.md).

## Getting started (clean machine)

Prerequisites:

1. **Rust** ≥ 1.85 (contract workspace uses edition 2021 with a conservative
   MSRV; soroban-sdk 27 sets the floor): <https://rustup.rs>
2. **Stellar CLI** (for deploy + Wasm build): `cargo install stellar-cli --locked`
3. **Node.js** ≥ 20 (frontend only): <https://nodejs.org>

Build and test the contract:

```bash
cargo test -p streampay-contract        # unit + property tests (see CI badge)
cargo fmt --all -- --check              # formatting gate
cargo clippy --all-targets -- -D warnings
stellar contract build                  # Wasm → target/wasm32v1-none/release/*.wasm
cargo deny check                        # supply chain (advisories, licenses, bans)
```

Fuzz the accrual math (nightly, optional):

```bash
cd fuzz && cargo +nightly fuzz run streamed_at -- -max_total_time=60
```

**Testnet Demo & Walkthrough:**
- **One-command deploy & demo stream:** [`./scripts/deploy_testnet.sh`](./scripts/deploy_testnet.sh) deploys the contract, mints demo SAC tokens, and opens an active 1-hour stream.
- **Full lifecycle walkthrough:** See [`docs/DEMO.md`](./docs/DEMO.md) for step-by-step CLI commands (`create_stream` → `withdraw` / `withdraw_max` → `cancel_stream`), expected outputs, and troubleshooting.

Run the frontend:

```bash
cd frontend
cp .env.example .env.local    # set NEXT_PUBLIC_STREAMING_CONTRACT_ID
npm install
npm run dev                   # http://localhost:3000
```

Deploy to testnet:

```bash
stellar keys generate deployer --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/streampay_contract.wasm \
  --source deployer --network testnet \
  -- --governor "$(stellar keys address deployer)"
```

## Headless CLI

The TypeScript CLI supports stream creation, withdrawals, cancellation,
top-ups, and recipient `claim-all`, with environment, encrypted-file, and
hardware-wallet handoff signers, plus read-only `status`/`get` snapshots with
a `--watch` JSON-lines mode. Dry-runs use Soroban RPC transaction
simulation and report its footprint and event-derived token deltas. It
requires Node.js ≥ 22.6; setup, JSON schema v1, and exit codes are documented
in [`tools/streampay-cli`](./tools/streampay-cli/README.md).

## TTL & rent operations

Streams and address indexes extend their TTL on every write (a ~29-day
`extend_to`), so active state stays hot and abandoned streams archive the
Soroban-native way. Three entries are **never** extended on-chain, though: the
id counter, the contract instance, and the Wasm code entry. Their TTL is fixed
at 4,095 ledgers — **~5.7 hours** — so a deployment needs external TTL
maintenance before stream creation and *all* reads start failing on archived
entries. [`infra/ttl-sentinel`](./infra/ttl-sentinel/README.md) covers that: it
scans every storage class, projects expiry against sampled ledger cadence, and
alerts (console / JSONL / webhook) — read-only and key-less by default, with an
off-by-default funded extender as a separate component. It also projects rent
from measured entry sizes, feeding the pricing/dust work. Full rationale and
the per-class cost table: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §12
and the [sentinel README](./infra/ttl-sentinel/README.md).

```bash
cd infra/ttl-sentinel && npm ci
STREAMPAY_CONTRACT_ID=C... npm run scan    # one pass; --watch to loop
npm run rent -- --streams 1000             # rent + cost projection
```

## Repo layout

```text
contracts/streaming-payments/   the contract (lib.rs, stream.rs, schedule.rs, treasury.rs, errors.rs, events.rs, test.rs, schedule_test.rs)
frontend/                       minimal Next.js UI (Freighter wallet)
tools/streampay-cli/            headless CLI: transactions, key encrypt, status/get --watch
indexer/                        Soroban event indexer (TypeScript + SQLite + REST API)
fuzz/                           cargo-fuzz harness for the accrual math (own workspace)
scripts/deploy_testnet.sh       one-command testnet demo
scripts/keeper.sh               reference keeper for scheduled intents
scripts/verify-fees.ts          public fee-ledger audit (anyone can run, no keys)
deployments/                    append-only promotion records + interface baselines
infra/ttl-sentinel/             storage TTL + rent sentinel (scan, alerts, optional funded extender)
infra/observability/            Prometheus + Grafana dashboards + Alertmanager compose/kustomize bundle
infra/indexer/                  event indexer service with Prometheus metrics & fault injection
infra/reconciler/               continuous state reconciler and truth verification daemon
docs/RUNBOOK.md                 operational diagnosis runbook for all alert rules
docs/ARCHITECTURE.md            design deep-dive
docs/GLOSSARY.md               protocol glossary: sourced definitions of every protocol term
docs/FEE_AWARE_CLAIMS.md        opt-in fee-aware claim scheduling (constraints + decisions)
docs/SCHEDULED_INTENTS.md       scheduled intents: keeper guide + threat model
docs/DEPLOY_PIPELINE.md         sandbox → testnet → mainnet-canary promotion design
docs/CANARY_RUNBOOK.md          mainnet canary + rollback procedure
docs/DEMO.md                    verified testnet walkthrough
docs/EVENTS.md                  generated catalogue of every contract event
schemas/events/README.md        event schema registry: generator, compatibility gate, consumer workflow
indexer/README.md               event indexer setup, configuration, and API
docs/GOOD_FIRST_ISSUES.md       ready-to-file contributor tickets
.github/workflows/ci.yml        test + fmt + clippy + coverage + wasm + lint/build/audit + supply chain
.github/workflows/release.yml   tag-driven Wasm release with SHA-256 digests
.github/workflows/fuzz.yml      scheduled fuzz sessions (non-blocking)
.github/workflows/promote.yml   gated promotions (sandbox → testnet → mainnet canary)
.github/workflows/rehearsal.yml secret-free dress rehearsal of the pipeline
CHANGELOG.md                    release history (Keep a Changelog)
```

## Roadmap

- **v0.1** — core contract: create / withdraw / cancel / top-up, tests, CI ✅
- **v0.2** — ✅ on-chain address indexes (`recipient_streams` /
  `sender_streams`), ✅ `withdraw_max`, ✅ frontend discovery + persistence,
  event indexer service, `pause_stream` (good first issue)
- **v0.3** — ✅ fuzzing in CI (`cargo-fuzz` on the rate math, scheduled),
  multi-token batch stream creation
- **v0.4** — full web UI polish (accrual charts), ✅ testnet demo script,
  ✅ keeper-executable scheduled intents (`schedule_stream` /
  `execute_scheduled`, `scripts/keeper.sh`)
- **v0.5** — ✅ optional protocol-fee treasury: boundary-charged fees,
  governor-gated withdrawals, open verification
  (`verify_treasury` + `scripts/verify-fees.ts`), ✅ incident response drills
  and runbook (testnet simulation)
- **v1.0** — external audit ([`docs/AUDIT_SCOPE.md`](./docs/AUDIT_SCOPE.md)), mainnet deployment guide

Feature requests live in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/) — good first issues are tagged [`good first issue`](https://github.com/Neziahtech/streampay/labels/good%20first%20issue) and documented in [`docs/GOOD_FIRST_ISSUES.md`](./docs/GOOD_FIRST_ISSUES.md).

Incident drill tooling and results are documented in [`docs/INCIDENT_RUNBOOK.md`](./docs/INCIDENT_RUNBOOK.md) and [`docs/INCIDENT_RESULTS.md`](./docs/INCIDENT_RESULTS.md). Run the drills with [`scripts/run_all_drills.sh`](./scripts/run_all_drills.sh); individual scenarios are available under `scripts/drill_*.sh`.

## Contributing

PRs welcome! Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) — it covers conventions, branch/PR process, and how to run the tests locally. Every PR runs the full test suite, fmt, clippy (`-D warnings`), and the frontend build in CI. Arriving through the Drips Wave program? [`docs/WAVE_CONTRIBUTORS.md`](./docs/WAVE_CONTRIBUTORS.md) walks through claiming an issue, the PR conventions, the CI gates and what "resolved" means.

## Funding & sustainability

StreamPay is community-funded:

- **GrantFox** — bounties on good-first-issues and roadmap features. Install the GrantFox GitHub App on your fork to earn while contributing.
- **Drips** — list StreamPay as a dependency to split funding to upstream projects it builds on.

## License

[Apache-2.0](./LICENSE)
