# Dust protection and sweep economics (#78)

This page justifies the three public constants added for #78 and states
plainly what the permissionless sweeper does and does not do. The code is in
[`dust.rs`](../contracts/streaming-payments/src/dust.rs); the tests are in
[`dust_test.rs`](../contracts/streaming-payments/src/dust_test.rs).

| Constant | Value | Meaning |
|---|---:|---|
| `MIN_STREAM_DEPOSIT` | `10_000_000` | Smallest deposit any creation path accepts (1 token at 7 decimals) |
| `MIN_CLAIM_AMOUNT` | `1_000_000` | Smallest single `withdraw` / `withdraw_max` while the stream still accrues (0.1 token) |
| `SWEEP_GRACE_SECONDS` | `2_592_000` | 30 days after `end_time` before a finished stream can be swept |

New error codes (appended after 129, never renumbered):

| Code | Variant | Raised by |
|---:|---|---|
| 130 | `DepositBelowMinimum` | `create_stream` (and every path that goes through it), `create_streams`, `create_streams_batch` (per entry), `schedule_stream` |
| 131 | `ClaimBelowMinimum` | `withdraw`, `withdraw_max` |
| 132 | `StreamNotSweepable` | `sweep_stream` |

See [`docs/ERROR_SURFACE.md`](ERROR_SURFACE.md) for the branch-level table.

All amounts are in the token's smallest unit. Every Stellar Asset Contract
token (XLM and every classic asset, including the major stablecoins) has 7
decimals, so the constants are expressed for 7-decimal tokens. The contract
cannot see prices, so every comparison below between a token amount and an
XLM fee is made **at parity** (1 token = 1 XLM). For a token worth more than
XLM (USDC, EURC) the floors are more conservative than shown; for a token worth
much less, they protect less.

## 1. Inputs and sources

Everything below is computed with the canonical fee function and the live
mainnet configuration. Values marked *estimate* are this page's assumptions
about transaction shape, not measurements of a mainnet transaction.

**Fee model.** A Soroban transaction pays `resource fee + inclusion fee`. The
resource fee charges, separately, CPU instructions, ledger-entry reads from
disk, ledger-entry writes, read and written bytes, transaction size (history
and bandwidth), event bytes, and rent for TTL extensions or entry growth
([Stellar docs: Fees, Resource Limits, and Metering](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering)).
The canonical computation is `compute_transaction_resource_fee` and
`compute_rent_fee` in
[`soroban-env-host/src/fees.rs`](https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/fees.rs).

**Network configuration.** Read from mainnet `CONFIG_SETTING` ledger entries
through `getLedgerEntries` on `https://mainnet.sorobanrpc.com` at ledger
65,671,380 (2026-11-25). Current values are also published on
[Stellar Lab's network limits page](https://lab.stellar.org/network-limits)
([where to find them](https://developers.stellar.org/docs/networks/resource-limits-fees)).
They change by validator vote, so treat the totals as a snapshot.

| Setting | Mainnet value |
|---|---:|
| `feeRatePerInstructionsIncrement` (per 10,000 instructions) | 3 stroops |
| `feeDiskReadLedgerEntry` | 781 stroops |
| `feeWriteLedgerEntry` | 1,250 stroops |
| `feeDiskRead1KB` | 223 stroops |
| `feeWrite1KB` | 437 stroops |
| `feeHistorical1KB` | 2,029 stroops |
| `feeContractEvents1KB` | 2,500 stroops |
| `feeTxSize1KB` | 203 stroops |
| `rentFee1KBSorobanStateSizeLow` / `High` | -17,000 / 10,000 |
| `sorobanStateTargetSizeBytes` | 3,000,000,000 |
| live Soroban state size (latest window sample) | 1,587,787,096 bytes |
| `persistentRentRateDenominator` | 1,215 |
| `minPersistentTTL` | 2,073,600 ledgers (~120 days) |
| `maxEntryTTL` | 3,110,400 ledgers |

The rent write fee per KB follows from the state size: `ceil(27,000 ×
1,587,787,096 / 3,000,000,000) − 17,000 = −2,710`, clamped to the protocol
minimum of **1,000 stroops per KB**. Rent for a persistent entry of `S` bytes
over `L` ledgers is then `ceil(S × 1,000 × L / (1,024 × 1,215))` stroops.

**Inclusion fee.** `getFeeStats` on the same RPC reported a Soroban inclusion
fee of 200 stroops at p50 and p99 (min 100) over the last 50 ledgers. The
estimates use 200.

**Contract-side inputs.**

| Input | Value | Source |
|---|---:|---|
| `withdraw` CPU | 372,647 instructions | measured, [`FOOTPRINT.md`](FOOTPRINT.md) |
| `create_stream` CPU | 546,291 instructions | measured, [`FOOTPRINT.md`](FOOTPRINT.md) |
| Stream record value | 496 bytes of XDR | measured by `per_stream_entry_sizes_stay_within_the_documented_estimate` |
| Fee record value | 104 bytes of XDR | same test |
| Stream ledger entry incl. key and envelope | ~600 bytes | *estimate* (value + ~100 bytes) |
| Contract TTL policy | extend to 500,000 ledgers when below 200,000 | `TTL_EXTEND_LEDGERS` / `TTL_THRESHOLD_LEDGERS` in `stream.rs` |

## 2. `MIN_CLAIM_AMOUNT`: what a claim costs

A `withdraw` reads and rewrites the stream record, moves tokens through the
token contract (rewriting the contract's balance entry and the recipient's
classic account or trustline, which is read from disk), and emits `Withdrawn`
plus the token's transfer event. Shape assumptions (*estimate*): 1 disk read
(~200 B), 3 written entries (~900 B), a ~1,000-byte transaction, ~400 bytes of
events.

| Component | Stroops |
|---|---:|
| CPU: `ceil(372,647 × 3 / 10,000)` | 112 |
| 1 disk read entry + ~200 B | 781 + 44 |
| 3 written entries + ~900 B | 3,750 + 385 |
| History: `(1,000 + 300) B × 2,029 / KB` | 2,576 |
| Bandwidth: `1,000 B × 203 / KB` | 199 |
| Events: `400 B × 2,500 / KB` | 977 |
| Inclusion fee | 200 |
| **Typical claim (*estimate*)** | **~9,000 (0.0009 XLM)** |

The stream record is created with the network's minimum persistent TTL
(~2.07M ledgers), far above the contract's 200,000-ledger renewal threshold,
so most claims pay no rent. A claim that does fall below the threshold extends
the record to 500,000 ledgers and pays at most `ceil(600 × 1,000 × 500,000 /
(1,024 × 1,215)) = 241,127` stroops of rent plus ~1,270 to write the TTL:
**~0.025 XLM worst case (*estimate*)**.

`MIN_CLAIM_AMOUNT = 1_000_000` (0.1 token) is therefore about **4× the
worst-case claim fee and ~110× the typical one at parity**. A claim below it
pays a fee that is a large fraction of what it delivers.

Why refusing is safe:

* It only applies while the stream is still accruing (`now < end_time` on the
  stream's own clock and not paused). Waiting costs the recipient nothing: the
  balance only grows.
* Once accrual stops (after `end_time`, or while paused) any positive amount
  can be claimed, so a tail smaller than the floor is never stranded. The
  floor also never touches `cancel_stream`, which pays out whatever accrued.
* `withdraw_many` and the batched claim paths are exempt on purpose: they
  amortize one transaction fee across up to 20 streams, so a per-stream floor
  would refuse claims that are cheap in aggregate. The floor targets the
  single-stream calls where one fee buys one payout.
* A zero or negative amount keeps its original error (`ZeroAmount`), and an
  empty balance keeps `NothingToWithdraw`; the floor is checked after both.

## 3. `MIN_STREAM_DEPOSIT`: what a stream costs to exist

Creating a stream writes a new stream record and, when a protocol fee is
charged, a new fee record; it appends the id to the sender's and recipient's
discovery indexes (new entries for a first stream, growing ones after that),
bumps the id counter, and pulls the deposit. New persistent entries are
created with the minimum persistent TTL, and their rent for those ~2.07M
ledgers is paid up front.

| Component | Stroops |
|---|---:|
| Stream record rent: `ceil(600 × 1,000 × 2,073,600 / (1,024 × 1,215))` | 1,000,000 |
| Two index entries: new (~120 B each) / grown (~12 B each) | 400,000 / 40,000 |
| Fee record rent (~190 B, only when a fee is charged) | 316,667 |
| Everything else: CPU, ~6 writes, bytes, history, events, inclusion | ~13,700 |
| **Create (*estimate*)** | **~1.05M to ~1.73M (0.105 to 0.173 XLM)** |

Add one typical claim and a stream costs roughly **0.106–0.174 XLM** to create
and drain. `MIN_STREAM_DEPOSIT = 10_000_000` (1 token, ten floor-sized claims)
keeps that overhead at about **11–17% of the stream's value at parity**. At a
tenth of the floor the overhead would already exceed the stream's entire
value. The floor is a minimum, not a recommendation.

The floor is checked right after the existing non-positive check, so `0` still
reports `ZeroAmount`, and before any governance stream policy, so a policy
`min_deposit` below the floor is simply never reached. `create_streams`
refuses the whole batch atomically; `create_streams_batch` reports the error
for the offending entry only; `schedule_stream` refuses an intent whose
per-occurrence deposit is below the floor, since every stream it would later
create would be dust.

## 4. `sweep_stream`: what it frees, and what it does not pay

### 4.1 Rent is not refunded

Soroban has no rent refund: deleting a persistent entry stops future rent and
removes it from live state, but the rent already prepaid for its TTL is gone.
The fee model has no refund path for deletions (`compute_rent_fee` only
charges for TTL extensions and size increases; the only refundable resource
fees are unused rent, event and return-value budget **within the same
transaction**). `sweep_stream` therefore **refunds no rent to anyone**.

It also moves **no tokens**. A stream qualifies only once it holds none:

* `Depleted` means `withdrawn == deposit`;
* `Cancelled` means `cancel_stream` already paid the recipient
  `streamed − withdrawn` and the refund target `deposit − streamed`, which
  together are exactly the escrow left.

So there is no residual balance to route. The issue's "designated party"
(the refund target, which falls back to the sender) is recorded in the
`StreamSwept` event as `refund_target`, so an indexer can attribute the
cleanup, but it is paid nothing.

### 4.2 What a sweep actually buys

* It removes the stream's entries from live Soroban state. Live state size is
  what drives the rent write fee every writer pays (§1), so sweeping finished
  streams pushes that fee down for everyone, a little.
* It prunes the id from the sender's and recipient's discovery indexes. Those
  are vectors rewritten in full on every new stream for that address, so
  their write bytes and size-growth rent shrink for every later
  `create_stream` by those parties, and paging them returns live streams.
* Finished streams stop showing up for indexers and UIs that walk the indexes.

A sweep costs the caller an estimated **~7,000 stroops (0.0007 XLM)**, with no
reward. It is a public good, which is why it is permissionless.

Deleted when present: the stream record, rate schedule, refund-target override,
sender history, a stale pause marker, the dispute round counter, and a met
release condition with its publishers' attestations. Kept on purpose: the
`StreamFee` record (treasury reconciliation scans it) and any template lineage
record (provenance). Stream ids are never reissued.

### 4.3 The sweep predicate

`sweep_stream` succeeds only when **all** of these hold (`dust::sweep_blocker`):

1. the status is `Depleted` or `Cancelled` (an exhaustive `match`, so a new
   status cannot silently qualify);
2. `ledger time >= end_time + SWEEP_GRACE_SECONDS` (saturating add);
3. nothing encumbers the stream (`dust::is_encumbered`): no held reentrancy
   lock, no open dispute (its bond is still escrowed), no pending ownership,
   rate-change or sender-transfer proposal, no advance with `repaid <
   total_owed`, no unmet release condition, and no registered hook of any
   class.

A live stream fails (1): every `Active` stream, including one past its
`end_time` that was never fully claimed and one that is paused, is refused
regardless of the clock. Each encumbrance has its own clean-up path (expire
the dispute, cancel or expire the proposal, unregister the hook), after which
the stream qualifies.

A pause marker is deliberately not an encumbrance: `resume_stream` refuses a
non-`Active` stream, so a stream cancelled or drained while paused could never
clear it, and it only freezes accrual, which a terminal status already ends.
The sweep deletes it instead.

The adversarial tests in `dust_test.rs` cover: an `Active` stream before
start, mid-window, at end, at end + grace and far past it; a paused `Active`
stream; the grace boundary to the second; an early cancel (grace still runs
from `end_time`); an open dispute; each pending proposal; an outstanding
advance; an unmet condition; a hook of each class; a held lock; a frozen
contract; an unknown id; and a double sweep. Each refused case also asserts
that the stream record, both indexes and the contract balance are unchanged.

### 4.4 Why 30 days of grace

The contract renews a touched entry to 500,000 ledgers (~29 days at 5 s), so
30 days lets recipients, senders, explorers and indexers read a finished
stream for about one renewal period after its window closes. The grace runs
from `end_time`, not from the cancel, so cancelling early does not shorten the
time a stream stays readable. `is_sweepable(stream_id)` lets a keeper check
before paying for a transaction.

## 5. Frontend

The stream page shows a "Not worth claiming yet" note when the accrued balance
is positive but below `MIN_CLAIM_AMOUNT` while the stream still accrues, with
an estimate of when enough will have accrued, and the withdraw form refuses a
sub-floor amount with the contract's reason (`frontend/lib/withdrawal.ts`). The
page does not read the pause flag, so on a paused stream it can show the note
although the contract would accept the claim; *Withdraw max* stays enabled and
the contract remains the authority.

## 6. If the network changes

Fee rates and `minPersistentTTL` are validator-voted. The constants are
append-only public interface, so they are not retuned in place: if the
inputs above move enough to matter, the remedy is a new constant and code
path, with this page updated from fresh `CONFIG_SETTING` reads.
