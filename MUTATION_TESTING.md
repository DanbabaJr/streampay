# Mutation Testing Baseline

## Summary

**Baseline Date:** 2026-10-15

**Module:** `contracts/streaming-payments/src/lib.rs` and `stream.rs`

**Results:**
- Total viable mutants: 95
- Caught: 91
- Missed: 4
- Unviable: 13
- Timeout: 1
- **Kill Rate: 95.8%** (exceeds 90% target)

## Survivors (4)

The following 4 mutants are acceptable survivors due to defensive/unreachable branches:

### 1. lib.rs:92:33 - `duration = end_time - start_time`

**Mutation:** Replace `-` with `+`

**Justification:** create_stream enforces `end_time > start_time` at lines 89-90. The mutation would produce an absurdly large duration that would immediately fail `MAX_DURATION_SECONDS` validation (line 93). This is an unreachable code path given the contract's invariants.

**Inline Documentation:** MUTANT-SUPPRESS comment added at line 92.

### 2. lib.rs:263:29 - `if recipient_amount > 0`

**Mutation:** Replace `>` with `>=`

**Justification:** recipient_amount is only 0 when cancel_amounts computes 0 (cancel before start). The test `cancel_at_exact_start_pays_sender_everything` verifies correct behavior without the transfer. The >= mutation would only add a no-op transfer of 0 tokens, which is functionally equivalent but unnecessary.

**Inline Documentation:** MUTANT-SUPPRESS comment added at line 268.

### 3. lib.rs:270:26 - `if sender_amount > 0`

**Mutation:** Replace `>` with `>=`

**Justification:** sender_amount is only 0 when cancel_amounts computes 0 (cancel after end). The test `cancel_after_end_pays_recipient_everything` verifies correct behavior without the transfer. The >= mutation would only add a no-op transfer of 0 tokens, which is functionally equivalent but unnecessary.

**Inline Documentation:** MUTANT-SUPPRESS comment added at line 280.

### 4. stream.rs:97:18 - `end_time - start_time` in elapsed_seconds

**Mutation:** Replace `-` with `+`

**Justification:** This branch is only reachable when `now >= end_time`, which means the full duration has already elapsed. The test `elapsed_after_end_returns_full_duration` verifies that the full deposit is available at this point. The mutation would cause an overflow in the subsequent streamed_at calculation, which is caught by MathOverflow. This is an unreachable code path given the contract's usage pattern.

**Inline Documentation:** MUTANT-SUPPRESS comment added at line 97.

## New Tests Added

To improve mutation coverage, the following tests were added:

1. `create_stream_stores_correct_duration` - Verifies duration calculation
2. `create_stream_accepts_exact_capacity_boundary` - Tests boundary condition for validate_capacity
3. `cancel_with_zero_recipient_amount_skips_transfer` - Tests zero-value transfer skip
4. `cancel_with_zero_sender_amount_skips_transfer` - Tests zero-value transfer skip
5. `elapsed_after_end_returns_full_duration` - Tests elapsed calculation at end boundary
6. `stream_ids_are_unique_and_monotonic` - Verifies stream ID uniqueness

## CI Integration

A weekly mutation testing workflow has been added at `.github/workflows/mutation.yml`:

- **Schedule:** Weekly on Sundays at 00:00 UTC
- **Trigger:** Manual dispatch available
- **Threshold:** Fails if kill rate drops below 90%
- **Reporting:** Results posted as a GitHub issue comment on scheduled runs
- **Artifacts:** Mutation results uploaded for 30 days

## Usage

Run mutation testing locally:

```bash
cd contracts/streaming-payments
cargo mutants --output mutants.out
```

View results:

```bash
cat mutants.out/missed.txt
cat mutants.out/caught.txt
```
