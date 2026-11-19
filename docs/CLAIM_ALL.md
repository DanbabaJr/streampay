# Batch Claim-All (`withdraw_all`) Architecture & Footprint Analysis

This document specifies the design, security invariants, error-isolation semantics, and storage footprint of the `withdraw_all` entrypoint in StreamPay.

---

## 1. Overview & Entrypoint Specification

The `withdraw_all` entrypoint allows a recipient to withdraw accrued funds from all their eligible streams in a single atomic transaction, aggregating payouts per asset.

It is the index-driven sibling of `withdraw_many`: `withdraw_many` claims an explicit list of up to `MAX_WITHDRAW_BATCH` ids and pays one transfer per stream, while `withdraw_all` walks a page of the recipient's own index and pays one transfer per asset. Both run every stream through the same checks and accrual math as `withdraw_max`.

```rust
pub fn withdraw_all(
    env: Env,
    recipient: Address,
    page_bounds: Option<PageBounds>,
) -> Result<WithdrawAllResult, StreamError>
```

### Data Structures

```rust
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageBounds {
    pub offset: u32,
    pub limit: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetTransfer {
    pub token: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimFailure {
    pub stream_id: u64,
    pub error_code: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawAllResult {
    pub transfers: Vec<AssetTransfer>,
    pub successful_stream_ids: Vec<u64>,
    pub failed_streams: Vec<ClaimFailure>,
    pub next_offset: Option<u32>,
}
```

---

## 2. Index Pagination & Continuation Token Design

To prevent transaction exhaustion, unbounded looping, and Soroban ledger entry footprint limit breaches, `withdraw_all` enforces pagination aligned with StreamPay's discovery index:

- **Maximum Page Size (`MAX_PAGE_SIZE = 50`)**:
  Callers may request a `limit` up to 50 streams. If `page_bounds` is omitted (`None`), defaults to `offset: 0, limit: 50`.
- **Continuation Token (`next_offset`)**:
  If the recipient has more streams than the processed window (`offset + processed < total`), `WithdrawAllResult.next_offset` returns `Some(next_offset)`.
  If all streams for the recipient have been read, `next_offset` returns `None`.
- **Non-Truncation Guarantee**:
  Streams are never silently dropped or truncated. Clients loop using `next_offset` until `next_offset == None`.
- **Index Stability**:
  Because `RecipientStreams` is strictly append-only (terminal/depleted streams maintain their index slot), numeric offsets remain completely stable across multiple sequential transactions.

---

## 3. Partial-Failure Decision Table

Per-stream conditions found *before* any tokens move never revert the whole batch. This ensures that a single unstarted, already-withdrawn, or depleted stream does not block claiming from other valid streams. A refused token transfer is the one exception (see §5).

| Scenario | Condition | State Mutation | Event Emitted | Return Value Entry | Batch Reverts? |
|---|---|---|---|---|:---:|
| **Unauthorized caller** | Caller does not satisfy `recipient.require_auth()` | None | None | Reverts with host auth error (`NotAuthorized`) | **Yes** (Atomic auth check) |
| **Contract frozen** | Contract maintenance flag is set (`ContractFrozen`) | None | None | Reverts with `StreamError::ContractFrozen` (code 36) | **Yes** (Safety circuit breaker) |
| **Stream not found** | `stream::get_stream(id)` fails | None | None | `ClaimFailure { stream_id, error_code: 1 }` | **No** (Isolated per stream) |
| **Wrong recipient** | `stream.recipient != recipient` | None | None | `ClaimFailure { stream_id, error_code: 12 }` | **No** (Isolated per stream) |
| **Non-active stream** | `stream.status == Cancelled` or `Depleted` | None | None | `ClaimFailure { stream_id, error_code: 5 }` | **No** (Isolated per stream) |
| **Nothing to withdraw** | Accrued balance `<= 0` (unstarted or fully withdrawn) | None | None | `ClaimFailure { stream_id, error_code: 13 }` | **No** (Isolated per stream) |
| **Math overflow** | Accrual arithmetic, `withdrawn + amount`, or the per-asset total would overflow | None | None | `ClaimFailure { stream_id, error_code: 11 }` | **No** (Isolated per stream) |
| **Token transfer failed** | Aggregated `try_transfer` for any asset rejects/fails | Discarded by the host | Discarded by the host | Reverts with `StreamError::RecipientPayoutFailed` (code 28) | **Yes** (see §5) |
| **Successful claim** | Stream active, `available > 0`, token transfer succeeds | `s.withdrawn += amount`, marks `Depleted` if drained | `Withdrawn` published per stream | Stream ID in `successful_stream_ids`; asset total in `transfers` | **No** (Succeeds) |

---

## 4. Resource Footprint & Ledger Entry Limit Analysis

In Soroban (Stellar Protocol 20+), transactions are bound by two hard resource constraints:
1. **CPU Instruction Budget**: 100,000,000 instructions per transaction.
2. **Ledger Entry Limit**: A transaction may touch at most **64 ledger entries** (read/write combined).

### 4.1 Storage Footprint Breakdown

Each `withdraw_all` transaction touches:
- **Instance Entry**: 1 entry (`ContractFrozen` check).
- **Recipient Index Entry**: 1 entry (`RecipientStreams(recipient)`).
- **Per-Stream Entries**: 1 persistent entry per stream (`Stream(id)`).
- **Token Contract Entries**: ~2–3 entries per unique asset (token instance, sender balance, recipient balance).

For $N$ streams and $T$ unique tokens:
$$\text{Ledger Entries} = 2 + N + 3T$$

When $T = 1$ asset:
- $N = 1$: $2 + 1 + 3 = 6$ entries (safe)
- $N = 10$: $2 + 10 + 3 = 15$ entries (safe)
- $N = 50$: $2 + 50 + 3 = 55$ entries (safe, $< 64$)
- $N = 60$ (unpaginated): $2 + 60 + 3 = 65$ entries (**exceeds 64 limit cliff!**)

### 4.2 Benchmark Measurements

Measured via [`contracts/streaming-payments/examples/storage_benchmark.rs`](../contracts/streaming-payments/examples/storage_benchmark.rs):

| Stream Count | Execution Strategy | CPU Instructions | Memory (Bytes) | Ledger Entries Touched | Safe Under 64-Entry Limit? |
|:---:|:---:|---:|---:|:---:|:---:|
| **1 stream** | 1 of 1 | 683,989 | 269,514 | ~6 entries | **Yes (Safe)** |
| **10 streams** | 10 of 10 | 2,324,978 | 708,874 | ~15 entries | **Yes (Safe)** |
| **50 streams** | 50 (Page 1) | 10,960,486 | 2,906,988 | ~55 entries | **Yes (Safe, < 64 entries)** |
| **60 streams** | Chunked: 50 + 10 (Page 2: 10) | 2,313,818 | 708,874 | ~15 entries | **Yes (Safe across 2 txs)** |
| **60 streams** | Unpaginated (Hypothetical) | ~27,000,000 | ~5,800,000 | 65+ entries | **REJECTED (> 64 limit cliff)** |

This demonstrates why `MAX_PAGE_SIZE = 50` is the mathematically and ledger-limit-safe bound.

---

## 5. Checks-Effects-Interactions (CEI) & Payout Failure

To uphold the protocol's strict CEI security model:
1. **Checks**: Each stream on the page is authorized for the caller and priced with the same accrual path `withdraw_max` uses. Streams that fail a check are recorded in `failed_streams` and left untouched.
2. **Effects**: For every stream that passes, `withdrawn` is incremented (status becomes `Depleted` if drained), the record is persisted, and `Withdrawn` is published — all *before* any token is called. Amounts are summed per asset.
3. **Interactions**: Only after every effect is written, one aggregated payout per asset is executed via `push` (`TokenClient::try_transfer`).
4. **Payout failure reverts the call**: If any asset's transfer fails, `withdraw_all` returns `StreamError::RecipientPayoutFailed` and the host discards every effect of the transaction. Restoring stream state *after* an external call — instead of reverting — would be exactly the reentrancy hazard CEI exists to prevent, and a published `Withdrawn` event cannot be un-published. This matches `withdraw_many`'s documented behaviour.

---

## 6. Frontend Integration

The dashboard provides a dedicated **⚡ Claim all** button in the "Your streams" card:
- Executes `withdrawAllFromStreams(address, signTransaction)`.
- Aggregates multi-asset balances and notifies the user with formatted token amounts and asset symbols.
- Displays continuation token notices if `nextOffset !== null`, prompting the user to claim subsequent pages.
- Automatically refreshes all updated streams in the UI.
