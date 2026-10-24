# ADR 0004: Floor-Per-Second Accrual Math

Status: Accepted (backfilled)
Date: 2026-09-13
Deciders: StreamPay Engineering Team

## Context and Problem Statement

StreamPay provides continuous, linear streaming payments over a defined time window `[start_time, end_time)`. At any arbitrary ledger timestamp `now`, the contract must calculate the cumulative accrued amount `streamed_at` based on the stream's `deposit`, total `duration = end_time - start_time`, and `elapsed = min(now - start_time, duration)`.

Because Stellar token balances are represented as discrete 128-bit integers (`i128` stroops, where 1 XLM = 10,000,000 stroops), dividing integer deposits by integer durations inevitably yields fractional amounts. The protocol must choose an arithmetic rounding strategy that prevents under-collateralization, guarantees contract solvency, and respects fairness across partial withdrawals.

## Decision Drivers

- Solvency invariant: the contract must never release more tokens than have genuinely elapsed.
- Sender vs. recipient economic neutrality: rounding dust must not be exploitable to drain sender funds or deprive recipients of their full agreed deposit.
- Strict arithmetic determinism without floating-point emulation.

## Considered Options

- Option 1: Floored integer division (`deposit * elapsed / duration`, rounded down).
- Option 2: Ceiling integer division (`div_ceil`, rounded up).
- Option 3: Fractional sub-stroop accumulator stored in per-stream state.

## Decision Outcome

Chosen option: "Option 1: Floored integer division", because:
1. Calculating `(deposit * elapsed) / duration` using standard integer truncation ensures that a partial second is never counted as streamed. The recipient can only withdraw tokens that have fully matured.
2. Ceiling division would permit recipients to withdraw fractional stroops prematurely; in the worst case, a stream created for 10 seconds could release tokens before 1 second elapsed, violating linear vesting guarantees.
3. At the completion of the stream window (`elapsed >= duration`), `streamed_at` evaluates to `(deposit * duration) / duration = deposit` exactly. Any accumulated floor dust resolves entirely in favor of the recipient at or after `end_time`.
4. Widened arithmetic in `u128` prevents intermediate multiplication overflow:
   ```rust
   let product = (deposit as u128).checked_mul(elapsed as u128)?;
   let streamed = (product / (duration as u128)).min(deposit as u128) as i128;
   ```

### Consequences

- **Positive:**
  - Guaranteed solvency: the contract balance is mathematically proven to always be greater than or equal to unstreamed deposit obligations.
  - Rounding never benefits the sender at the recipient's expense: over the complete window, the recipient receives 100% of the deposit.
  - Zero storage overhead: calculation is stateless and requires no extra fields on `Stream`.
- **Negative / Trade-offs:**
  - In short-duration streams with very small deposits (e.g. 5 stroops over 10 seconds), zero stroops accrue during the first second. This is the desired conservative behavior for discrete token units.

## Alternatives Considered

### Option 2: Ceiling Integer Division (`div_ceil`)

- Good, because recipients see non-zero accrual immediately upon stream start.
- Bad, because it pays out unearned tokens before the elapsed time has transpired. If the sender cancels early, the recipient would receive more than earned, under-refunding the sender.

### Option 3: Sub-Stroop Fractional Accumulator in Storage

- Good, because it tracks sub-stroop fractions across multiple partial withdrawals.
- Bad, because Stellar tokens cannot be transferred in fractions of a stroop anyway; adding fractional storage fields increases serialized XDR entry bytes, read/write metering costs, and complexity for negligible economic precision.

## Validation and Evidence

- Core accrual logic defined in `contracts/streaming-payments/src/stream.rs` and documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#3-accrual-math).
- Property fuzz tests in `fuzz/fuzz_targets/streamed_at.rs` verify monotonicity and boundary exactness across millions of random input tuples.
- Differential vector suite (`scripts/generate-vectors.mjs` and `frontend/lib/oracle.test.ts`) verifies parity between contract Rust math and frontend TypeScript math.
- Commits: `7f740cf` (Initial implementation) and `5747c1e` ("test(fuzz): assert full-duration accrual and update architecture docs").
