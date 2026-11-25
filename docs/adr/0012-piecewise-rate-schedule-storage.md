# ADR 0012: Piecewise Rate Schedules — Representation, Rounding, and Storage

Status: Accepted
Date: 2026-10-21
Deciders: StreamPay Contract Team (issue #54)

## Context and Problem Statement

A stream was priced once, at creation: `deposit` tokens over
`[start_time, end_time)`, accrued by `streamed_at(deposit, duration, elapsed)`.
Issue #54 asks for the two parties to be able to negotiate a new
`amount_per_second` mid-stream — with `propose`/`accept` and expiry, so neither
side can unilaterally change what is owed.

Once a stream can carry more than one rate, the single-window formula is no
longer a complete description of what is owed at a timestamp. Three constraints
shaped the answer:

1. **A rounding error here is a funds bug.** The accrual function decides how
   many tokens the recipient may claim. Any residue introduced by re-pricing the
   past, or by dividing where the original division did not land, is money that
   either leaves the contract early or never becomes claimable.
2. **The past is not negotiable.** A renegotiation must not change what had
   already accrued at the moment it was accepted. Clients, the indexer, and the
   recipient's already-claimable balance all read that number.
3. **The stored interface is append-only.** `DataKey::Stream(id)` entries
   written by deployed versions of this contract must keep deserializing
   ([ADR-0003](0003-append-only-interface.md)), and every accrual path is inside
   the CPU budget work of [docs/FOOTPRINT.md](../FOOTPRINT.md).

## Decision Drivers

- Exactness: no new division may appear on the renegotiated part of a schedule.
- Bit-identical backward compatibility: an empty schedule must price exactly what
  the pre-#54 code priced, error included.
- No change to the stored `Stream` layout, and no new permanent cost for streams
  that never renegotiate beyond one host dispatch.
- Bounded worst case: the cost of pricing a schedule must not grow with how often
  a stream renegotiates.
- Checks-Effects-Interactions, in the direction each branch's counterparty is
  protected ([ADR-0002](0002-cei-first-payouts.md)).

## Considered Options

- **Option 1: rewrite `deposit` and `end_time` on the `Stream` entry** and keep
  pricing with the single-window formula.
- **Option 2: store a per-window `rate` (tokens per second) with window
  boundaries, and accrue `rate * elapsed` per window.**
- **Option 3 (chosen): store a schedule of windows, each carrying an
  `(allocation, basis_seconds)` pair, priced by the unchanged `streamed_at`.**
- **Storage sub-option A: a `rate_segments` field on `Stream`.**
- **Storage sub-option B (chosen): `DataKey::RateSegments(id)`, a separate
  persistent entry, plus `DataKey::PendingRateChange(id)` for the open offer.**

## Decision Outcome

Chosen option: **Option 3 with storage sub-option B**, because it is the only
combination that prices a renegotiated window with *no division at all* while
leaving both the stored `Stream` layout and the single-window code path
untouched.

The mechanics, in [`stream.rs`](../../contracts/streaming-payments/src/stream.rs):

- `RateSegment { start_time, end_time, allocation, basis_seconds }`. A schedule
  is a list of these that partitions `[start_time, end_time)`.
- `streamed_amount_at_segments` sums `segment_accrual` over the schedule, and
  `segment_accrual` is `streamed_at(allocation, basis_seconds, elapsed_in_window)`
  — the *same* pure function the contract used before #54 ([ADR-0005](0005-pure-streamed-at.md)),
  evaluated over a slice of the stream. A one-window schedule covering the whole
  stream is therefore the pre-renegotiation behaviour by construction.
- A window written by `accept_rate_change` sets `allocation = rate * window` and
  `basis_seconds = window`. `streamed_at` then divides that product by the very
  number it was multiplied by: accrual is `rate * elapsed` exactly, an integer
  product with no residue, and it reaches `allocation` exactly at `end_time`.
- The head of a schedule is the pre-existing window, clipped at the boundary.
  `clip_segment` shortens `end_time` and carries `allocation`/`basis_seconds`
  over **untouched**, so the clipped head has accrued at the boundary exactly
  what it would have accrued had no change happened. Rounding lives where it
  already lived — in the original `deposit / duration` division — and nowhere
  else.
- `accept_rate_change` rebalances against that head: `owed` is the schedule's
  accrual at the boundary, `reserved = new_rate * remaining_seconds` is exact,
  and `deposit` becomes `owed + reserved`. The difference `reserved - (deposit -
  owed)` is pulled from the sender when positive and refunded when negative, so
  the schedule always sums to the escrow actually held.
- An empty `Vec` short-circuits to `streamed_amount_at`: never-renegotiated
  streams keep the old code path, the old rounding, and no segment loop.

### Consequences

- **Positive:** mid-stream renegotiation cannot re-price the past — asserted at
  hourly timestamps across the old window by
  `rate_change_never_reprices_the_past`, and against a second implementation by
  the differential tests and the `rate_schedule` fuzz target.
- **Positive:** the endpoint property is exact: a schedule settles at precisely
  the sum of its allocations, so `cancel_stream` at `end_time` pays the whole
  deposit and no token is stranded.
- **Positive:** no stored `Stream` changed, so existing streams need no migration
  and `migrate_storage` is not part of this feature.
- **Negative / trade-offs:** every accrual path pays one extra persistent-storage
  lookup even when no schedule exists (measured on `withdraw`: 365,133 CPU
  against the 360,000 budget the harness carried before #54 — see
  Candidate 5 in [docs/FOOTPRINT.md](../FOOTPRINT.md)). A schedule at the
  `MAX_RATE_SEGMENTS` cap prices at 820,911 CPU on the same path.
- **Negative / trade-offs:** `basis_seconds` is redundant information on a
  renegotiated window (it equals the window length); it is what lets a clipped
  head carry its original basis, which is the whole backwards-compatibility
  argument.
- **Neutral:** the cap of 32 windows means a stream can be renegotiated a bounded
  number of times; past that, acceptance reverts with `TooManyRateSegments`
  (67) and the offer stays open.
- **Neutral:** accrual is monotone in `now` because each window's accrual is,
  and the windows are disjoint.

## Pros and Cons of the Alternatives

### Option 1: rewrite `deposit` / `end_time` in place

- Good, because it needs no new storage key and no change to the accrual
  function.
- Bad, because the new `deposit / new_duration` quotient re-prices every second
  that already streamed: the recipient's claimable balance would silently change
  under a renegotiation, and a decrease could refund escrow that was already
  accrued. That is the funds bug #54 names.

### Option 2: store `rate` per window

- Good, because it is the most compact and exact for renegotiated windows.
- Bad, because there is no rate to store for the pre-existing part of a stream:
  a 3,000,000,000-token deposit over 7 seconds has no integer tokens-per-second,
  and forcing one would re-price the past. Windows therefore need an
  `(allocation, basis)` pair anyway, and a rate-only representation would be a
  second, lossy model of the same fact.

### Storage sub-option A: a field on `Stream`

- Good, because it saves the extra lookup.
- Bad, because it changes the XDR of every stored stream — an interface break for
  [ADR-0003](0003-append-only-interface.md) — and grows the entry that every
  path reads and writes, including the streams that never renegotiate.

## Validation and Evidence

- `empty_plan_matches_single_window_formula` (144 duration/deposit/offset
  combinations, each checked against the single-window formula, the pure
  `streamed_at`, and the cancel split).
- `rate_change_never_reprices_the_past`,
  `rate_decrease_mid_second_keeps_the_floor_where_it_belongs` (a deposit that
  does not divide by its duration), `rate_increase_pulls_the_exact_shortfall`,
  `rate_decrease_refunds_the_freed_escrow`.
- `piecewise_accrual_matches_the_reference_models` diffs 20,000 randomly shaped
  schedules against two models that share no code with the contract path — a
  `u128` long-division model with floor, and a division-free `Σ rate × elapsed`
  model — with zero divergence; the `--ignored` variant runs the same analysis
  over 1,000,000 schedules for the PR evidence.
- `fuzz/fuzz_targets/rate_schedule.rs` (CI fuzz matrix) asserts the same five
  oracles on coverage-guided inputs; `conservation.rs` renegotiates real streams
  and checks each stored schedule against the reference model.
- `accept_rate_increase_operation_order_matches_golden` and
  `accept_rate_decrease_operation_order_matches_golden` pin the CEI ordering:
  the shortfall `transfer_from` happens before any effect, the freed-escrow
  `transfer` happens after the schedule is installed.
