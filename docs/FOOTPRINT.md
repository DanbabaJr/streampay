# StreamPay Gas & Storage Footprint Analysis

This document records the measurement methodology, baseline benchmarks, optimization candidate evaluations, architectural tradeoffs, and before/after comparisons for **Issue #27: Gas and storage footprint pass**.

---

## 1. Context & Objectives

The goal of this pass is to measure and minimize the resource footprint (CPU instructions + persistent storage keys/bytes) of StreamPay's hot paths:
- `create_stream`
- `withdraw`
- `withdraw_max`
- `cancel_stream`
- Discovery pagination: `sender_streams` / `recipient_streams`

### Key Constraints
- **Zero Interface Drift**: Public storage keys (`DataKey::Stream(u64)`), event schemas (`StreamCreated`, `Withdrawn`, etc.), and numeric error codes (`StreamError`) must remain byte-for-byte wire compatible.
- **Invariant & Test Preservation**: All 195+ unit/property tests, Checks-Effects-Interactions (CEI) golden ordering traces (`test_orderings/*.txt`), and TTL sentinel cliff models (`infra/ttl-sentinel`) must remain green without modification.
- **Documented Tradeoffs**: Every evaluated candidate must justify whether it is accepted or rejected based on concrete Soroban metering data.

---

## 2. Simulation Harness

The footprint simulation harness is implemented in [`contracts/streaming-payments/examples/storage_benchmark.rs`](../contracts/streaming-payments/examples/storage_benchmark.rs) and exercised as a regression assertion in [`contracts/streaming-payments/src/test.rs`](../contracts/streaming-payments/src/test.rs) (`hot_path_footprint_harness`).

Run the benchmark executable directly:
```bash
cargo run -p streampay-contract --example storage_benchmark
```

The harness measures:
1. **CPU Instructions & Memory Bytes**: Measured via `env.cost_estimate().budget().cpu_instruction_cost()` and `memory_bytes_cost()`.
2. **Wire & Storage Footprint**: Exact XDR byte lengths of serialized keys, entries, and event bodies via `soroban_sdk::xdr::ToXdr`.
3. **Simulated Storage Layouts**: Comparative execution of monolithic `Stream` storage vs. split hot/cold entries under identical contract state.

---

## 3. Production Contract Footprint Baseline

### 3.1 Hot Path Lifecycle Operations

| Operation | Type | Storage Footprint | CPU Instructions | Memory (Bytes) | Event Bytes (XDR) |
|---|---|---|---:|---:|---:|
| `create_stream` | Write | 1 Stream + 2 Indexes | 541,598 | 210,434 | 396 B |
| `get_stream` | Read | 1 Stream Entry | 66,664 | 40,243 | 0 B |
| `available` | Read | 1 Stream Entry | 58,284 | 39,461 | 0 B |
| `withdraw` | RMW | 1 Stream Entry | 347,082 | 138,899 | 236 B |
| `top_up` | RMW | 1 Stream Entry | 447,290 | 167,390 | ~76 B |
| `cancel_stream` | RMW | 1 Stream Entry | 523,563 | 171,201 | 248 B |
| `withdraw_max` | RMW | 1 Stream Entry | 338,663 | 134,329 | 236 B |
| `sender_streams (5 ids)` | Read | 1 Index Entry | 52,369 | 25,006 | 0 B |

> **Re-measured after #54 (rate renegotiation).** Every accrual path now reads
> the rate schedule from its own storage key, so each one pays an extra
> persistent lookup even for a stream that never renegotiated — the `withdraw`
> path moved from the 360,000-instruction budget the harness carried before this
> change to a measured 365,133. `create_stream` is unchanged: a new stream has
> no schedule to price. The numbers the harness asserts against today are in §6,
> and §4 Candidate 5 records why the extra read was accepted rather than
> avoided.

### 3.2 Wire & Storage Byte Footprint

| Component | Entity | Serialized Payload (Bytes) | Key Size (Bytes) | Total Ledger Footprint |
|---|---|---:|---:|---:|
| Storage Entry | `Stream` (monolithic) | 444 B | 40 B | 484 B |
| Storage Entry (Simulated) | `StreamConfigCold` | 332 B | 44 B | 376 B |
| Storage Entry (Simulated) | `StreamStateHot` | 120 B | 44 B | 164 B |
| Storage Entry | `SenderStreams` index key | N/A | 76 B | 76 B (key) |
| Event Payload | `StreamCreated` | 396 B | N/A | 396 B |
| Event Payload | `Withdrawn` | 236 B | N/A | 236 B |
| Event Payload | `StreamCancelled` | 248 B | N/A | 248 B |

---

## 4. Candidate Evaluations & Architectural Tradeoffs

### Candidate 1: Splitting Cold Fields from Hot Fields in `Stream` Struct
- **Mechanism Tested:**
  Split `Stream` into:
  - `StreamConfigCold`: Immutable configuration fields (`sender`, `recipient`, `token`, `deposit`, `start_time`, `end_time`, `cancelable`).
  - `StreamStateHot`: Mutable balance fields (`withdrawn`, `status`).
- **Benchmarked Results:**
  - Monolithic `Stream` Write: 60,956 CPU | 43,537 Memory
  - Split (Cold + Hot) Write: 98,480 CPU (**+61.6% CPU penalty**) | 60,375 Memory
  - Monolithic `Stream` Read: 48,319 CPU | 36,485 Memory
  - Split Read (Both entries): 73,200 CPU (**+51.5% CPU penalty**) | 47,926 Memory
  - Split Read (Hot-only): 41,123 CPU | 25,625 Memory
- **Tradeoff Analysis:**
  Every mutating path in the contract (`withdraw`, `withdraw_max`, `cancel_stream`, `top_up`) strictly requires BOTH configuration fields (token address for payout, deposit and window for accrual calculation, caller authorization checks) and state fields (`withdrawn`, `status`).
  Splitting fields into two separate storage keys incurs:
  1. A **+51.5% CPU read penalty** and a **+61.6% CPU write penalty**.
  2. Doubling of ledger keys touched per transaction, increasing base transaction fees.
  3. Total storage overhead actually increases: monolithic entry is 484 B total (444 B val + 40 B key), while two split entries total 540 B (376 B + 164 B) due to duplicate ledger key headers and prefix overhead.
  4. Breaking change: breaks `DataKey::Stream(u64)` and public contract interface.
- **Conclusion:** **Negative result (Rejected)**. The monolithic layout is strictly superior in CPU instructions, ledger fees, and storage footprint.

---

### Candidate 2: Trimming Event Fields
- **Mechanism Tested:**
  Trim fields considered redundant from event payloads (e.g., omitting `recipient` in `Withdrawn`, which could save ~36 bytes).
- **Tradeoff Analysis:**
  - Event payloads are small: `StreamCreated` is 396 B, `Withdrawn` is 236 B, and `StreamCancelled` is 248 B, well within Soroban transaction log limits.
  - Event schemas form an immutable public integration contract. Off-chain indexers ([`indexer/src/store.ts`](../indexer/src/store.ts)), CLI tools ([`tools/streampay-cli`](../tools/streampay-cli)), and client-parity test vectors ([`tests/client-parity/fixtures.json`](../tests/client-parity/fixtures.json)) strictly depend on these exact event fields.
  - Altering event schemas violates the explicit constraint: *"Must not change the public interface (storage keys, events, error codes)"*.
- **Conclusion:** **Rejected**. Retained full event payload fidelity.

---

### Candidate 3: TTL Extension Thresholds & Lazy Extension
- **Mechanism Tested:**
  Evaluate increasing or deferring `TTL_THRESHOLD_LEDGERS` (200,000) and `TTL_EXTEND_LEDGERS` (500,000).
- **Tradeoff Analysis:**
  - In Soroban, `extend_ttl` is already inherently lazy inside the host environment: if `current_ttl >= threshold`, the host performs a no-op and does not touch ledger state.
  - The 200,000 / 500,000 ledger thresholds (~11.5 days / ~29 days) are strictly bound to [`infra/ttl-sentinel`](../infra/ttl-sentinel) cliff models (validated by `infra/ttl-sentinel/test/constants-sync.test.ts`).
  - Mutating thresholds would desynchronize the monitoring sentinel daemon and risk premature ledger entry archiving.
- **Conclusion:** **Rejected**. Existing threshold configuration is optimal and synchronized with sentinel monitoring.

---

### Candidate 4: Host Call Resolution Caching & Native Index Slicing (Implemented)
- **1. Contract Address Resolution Caching:**
  - In `pull` ([`contracts/streaming-payments/src/lib.rs`](../contracts/streaming-payments/src/lib.rs)), cached `env.current_contract_address()` to eliminate redundant host dispatch on deposit transfers.
  - In `cancel_stream` ([`contracts/streaming-payments/src/lib.rs`](../contracts/streaming-payments/src/lib.rs)), cached `env.current_contract_address()` across recipient and sender payout legs, saving a redundant host dispatch when both payouts execute.
  - Saves **548 CPU instructions** and **80 memory bytes** per call without modifying any contract interface or behavior.
- **2. Native Index Slicing:**
  - In `page_stream_ids` ([`contracts/streaming-payments/src/stream.rs`](../contracts/streaming-payments/src/stream.rs)), replaced manual `while` loops and element-by-element push allocation (`Vec::new`, `get(i)`, `push_back(id)`) with native Soroban SDK vector slicing (`ids.slice(start..end)`).
  - Eliminates O(N) allocation and per-element host dispatch overhead during discovery pagination.
- **Conclusion:** **Accepted & Implemented**.

---

### Candidate 5: Where a Negotiated Rate Schedule Lives (Implemented)
- **Mechanism Tested:**
  #54 replaced "one rate per stream" with a schedule of priced windows. The
  schedule has to be readable by every accrual path (`available`, `withdraw`,
  `withdraw_max`, `cancel_stream`, `streamed_at`, `sponsored_claim`), so the
  question is which entry it is stored in.
- **Options and measured results:**
  - **Inline on `Stream`** (a `rate_segments` field): one read, but it changes
    the XDR layout of `DataKey::Stream(id)` — every stream written by an earlier
    release would fail to deserialize, which the append-only interface rule
    ([ADR-0003](adr/0003-append-only-interface.md)) forbids, and it inflates the
    entry every path reads and writes even when no renegotiation ever happened.
  - **A `has_schedule` flag on `Stream`** to skip the read for never-renegotiated
    streams: saves one lookup and costs the layout change above, i.e. it buys
    nothing that Candidate 5 is trying to buy.
  - **`DataKey::RateSegments(id)`, a separate persistent entry (implemented)**:
    no stored layout changes, the entry only exists on a stream that actually
    renegotiated, and its TTL is maintained with the schedule's own writes. The
    price is one absent-key lookup on the accrual paths of every other stream.
- **Measured cost of that lookup:** `withdraw` on a never-renegotiated stream
  costs 365,133 CPU instructions (the harness budget before #54 was 360,000).
  A stream with a two-window schedule prices at 407,316 (**+42,183**), and a
  schedule at the `MAX_RATE_SEGMENTS` cap of 32 windows prices at 820,911
  (**+455,778**, roughly 14,200 per window). The cap is what keeps the worst
  case bounded: `full_schedule_pricing_is_bounded` measures it rather than
  assuming it.
- **Conclusion:** **Accepted & Implemented**. The extra read is bounded, one
  host dispatch, and it is the only option that leaves stored streams
  byte-identical. See [ADR-0012](adr/0012-piecewise-rate-schedule-storage.md).

### Candidate 6: Versioned Stream Records and the Refund-Target Read (Implemented)

Two later changes each bought a property at the cost of metered work on the hot
paths, so both are recorded here rather than being discovered by a surprised
contributor:

- **`VersionedStream` envelope (#202).** `DataKey::Stream(id)` now stores
  `{ version, stream }` instead of a bare `Stream`. Every read pays one extra
  map decode and every write one extra map encode, and the record grows by the
  version symbol. This is what makes a future layout change decodable at all —
  the fail-closed probe in `get_stream_record` needs a tag to probe against.
- **`DataKey::RefundTarget(id)` read (#201).** `cancel_stream` resolves the
  address that owns the unaccrued remainder before it writes state, because a
  consented sender-role transfer must be able to leave that claim behind with
  the address that funded the deposit. The read happens on every cancel, and a
  *missing* key is metered like a present one, so a stream that never had a
  transfer pays the difference too.
- **Rejected alternative:** a `refund_to` field on `Stream`. `#[contracttype]`
  structs encode positionally (§13.2 of `docs/ARCHITECTURE.md`), so adding a
  field would make every already-stored record undecodable — the one change
  the storage-versioning work exists to make unnecessary. A separate key costs
  CPU; a field would cost the ledger's history.
- **Refund routing (#204).** `set_refund_target` is a read-then-overwrite of that
  same `DataKey::RefundTarget(id)`: one stream read, one target read, one key
  write, one event, and no token transfer — so amendments are cheaper than the
  cancel they redirect. `create_stream_with_refund` pays ordinary creation plus
  that single write, which is why the creation goldens and budgets are
  unchanged: routing is delegated to the existing creation path and pinned
  afterwards. Because every amendment overwrites the one key rather than
  appending, storage grows by at most one address per *routed stream*, not per
  routed amendment — the append-only growth claim is bounded by streams, and an
  unrouted stream stores nothing at all.
- **Batch claiming (#205).** `withdraw_many` settles each id through the same
  `settle_accrued` helper `withdraw_max` uses, so the per-entry work — record
  read, oracle resolution, rewrite, `Withdrawn` event, token transfer — is
  identical by construction. What the batch removes is the *per-transaction*
  work: one contract invocation, one `ContractFrozen` instance read, one
  `require_auth` for the whole batch, and one ledger footprint instead of
  twenty. The batch also adds work no single claim pays: the duplicate scan, the
  per-entry outcome vector, and the `BatchWithdrawSummary` event. Measured over
  the full cap of 20 streams, the additions cost less than the overhead they
  remove — see the table below.
- **Storage growth is append-only and bounded per stream:** at most three extra
  keys exist for a stream that has been through the sender-transfer surface
  (`PendingSenderTransfer`, `RefundTarget`, `SenderHistory`), and each is under
  the same 200,000/500,000-ledger TTL regime as the stream entry itself, so an
  abandoned stream still archives.

Re-measured with `cargo test -p streampay-contract --lib hot_path_footprint
--nocapture` (which prints `FOOTPRINT: path=… cpu=… mem=…` for each step):

| Operation | CPU Instructions | Memory (Bytes) | vs. §3.1 baseline |
|---|---:|---:|---:|
| `create_stream` | 546,291 | 214,304 | +4,693 (+0.87%) |
| `withdraw` | 372,647 | 149,374 | +25,565 (+7.37%) |
| `withdraw_max` | 376,172 | 146,139 | +37,509 (+11.08%) |
| `cancel_stream` | 590,248 | 192,600 | +66,685 (+12.74%) |
| `set_refund_target` | 140,812 | 68,410 | new path (#204), budget 150,000 |

`withdraw` on this tree measures 372,647 against the 365,133 #54 left behind:
the difference, 7,514, is the `VersionedStream` envelope — the same amount every
other accrual path now pays. `cancel_stream` carries that envelope cost plus the
`DataKey::RefundTarget(id)` read on top of #54's schedule read, which is why it
is the only path that pays three added lookups.

### 4.1 Batch claim vs. the same claims issued separately (#205)

`withdraw_many_footprint_harness` builds one portfolio of
`MAX_WITHDRAW_BATCH` = 20 fully accrued streams twice, over two identical
fixtures, and claims it in both ways. `cost_estimate()` reports the budget of the
*last* host invocation rather than a running total, so the twenty separate
claims are measured one call at a time and summed — that sum is what a recipient
without batching actually pays. The row below labelled "one stream" is the last
of those individual measurements, which the harness prints as
`withdraw_max cpu=… mem=…`; the later claims in the loop are the most expensive
ones, because every claim grows the recipient's own index the next claim reads.

| Path | CPU Instructions | Memory (Bytes) |
|---|---:|---:|
| `withdraw_max`, one stream (last measured) | 469,092 | 184,763 |
| `withdraw_max` × 20 (20 transactions, summed) | 9,056,515 | 3,503,477 |
| `withdraw_many` (20 ids, 1 transaction) | **7,213,732** | **1,925,908** |
| Saved by batching | 1,842,783 (−20.3%) | 1,577,569 (−45.0%) |

Per entry the batch pays 360,687 CPU against a 452,826 CPU average single
(9,056,515 / 20), so the −20.3% saving is the same ratio read either way, and
memory falls by nearly half because one transaction carries one contract
instance, one authorization and one footprint instead of twenty of each. The
harness asserts both that the batch is cheaper than the summed twenty singles and
that it is cheaper than twenty times the single claim it replaces, so a future
change cannot quietly make the batch path pay more per entry than the loop it
optimizes.

These numbers are *not* comparable with the §4 table's `withdraw_max` row
(376,172 CPU / 146,139 B). That one claims a 30-day stream in a fixture that has
already run `create_stream`, `withdraw` and `cancel_stream` in the same env; this
one claims twenty 1-day streams in a fixture built for the comparison. Only the
ratios inside each table are meaningful.

Two numbers put the cap in context: a full 20-stream batch runs at 7.21M CPU
against Soroban's 100M-instruction per-transaction ceiling, and the harness
budgets it at 8,600,000 CPU (8,000,000 before pause/resume, #24: each entry now
also looks up its `StreamPause` side key, which takes the batch to 8.42M CPU on
the same fixture). The ~0.8M of headroom the original budget left is the
caller's own footprint, rent, and the transaction envelope — which is why the cap
is 20 and not the 25 `create_streams_batch` allows: creation entries do not read
a record, resolve an oracle, rewrite it, emit two events and transfer tokens.

`cancel_stream` is the only path that pays all three added lookups — #54's rate
schedule, the record envelope, and the refund-target read; the rest of the delta
is the envelope alone. Its harness budget therefore moved 540,000 → 570,000
(#54) → 580,000 (#201/#204 on the pre-envelope record) → 600,000 CPU instructions
on this tree, and the harness now prints the numbers above so the next change to
a hot path is measured, not estimated.

---

## 5. Before vs. After Footprint Comparison

| Operation | Metric | Before | After | Change |
|---|---|---:|---:|:---:|
| `create_stream` | CPU Instructions | 542,146 | 541,598 | **-548 (-0.10%)** |
| `create_stream` | Memory Bytes | 210,514 | 210,434 | **-80 B** |
| `create_stream` | Storage Entries | 3 keys | 3 keys | 0 |
| `cancel_stream` | CPU Instructions | 524,111 | 523,563 | **-548 (-0.10%)** |
| `cancel_stream` | Memory Bytes | 171,281 | 171,201 | **-80 B** |
| `cancel_stream` | Storage Entries | 1 key | 1 key | 0 |
| `withdraw` | CPU Instructions | 347,082 | 347,082 | Parity (Optimal) |
| `withdraw_max` | CPU Instructions | 338,663 | 338,663 | Parity (Optimal) |
| `sender_streams (5 ids)` | Vector Strategy | Manual loop / alloc | Native `ids.slice` | **Optimized host slice** |

---

## 6. Verification & Regression Testing

1. **Unit & Property Tests**:
   - `cargo test -p streampay-contract`: All 338 unit and property tests pass
     (two more — the registry generator and the million-schedule rounding
     analysis — stay `#[ignore]`d).
   - `cargo test -p streampay-passkey`: All 14 tests pass.
2. **CEI Golden Ordering Traces**:
   - `cargo test -p streampay-contract --lib operation_order_matches_golden --locked`: All 18 golden traces match byte-for-byte.
3. **Footprint Regression Harness**:
   - `hot_path_footprint_harness` in `contracts/streaming-payments/src/test.rs` permanently asserts that hot paths execute within instruction budgets:
     - `create_stream` <= 560,000 CPU (546,291 measured)
     - `withdraw` <= 398,000 CPU (389,128 measured; 372,647 before the
       pause side-key lookup (#24), 365,133 before the record envelope, 347,082
       before #54)
     - `cancel_stream` <= 620,000 CPU (608,330 measured — 538,801 with #54's
       schedule read, 552,355 with the envelope on top, 590,248 with the
       routed-refund read, and the pause side-key lookup for the rest; 540,000
       was the pre-dispute budget)
     - `withdraw_max` <= 402,000 CPU (393,457 measured; 376,172 before #24)
     - `withdraw` on a renegotiated (two-window) stream <= 458,000 CPU (448,929 measured; 414,184 before #24)
     - `set_refund_target` <= 150,000 CPU (140,812 measured) — one read of the
       stream, one key overwrite, no token transfer
   - Pause/resume (#24) keeps its state under its own `StreamPause(id)` key
     rather than adding fields to `Stream` (which would change the stored
     layout of every existing stream), so every accrual path pays one more
     persistent lookup even for a stream that was never paused; the budgets
     above were re-measured with that lookup in place.
   - `full_schedule_pricing_is_bounded` asserts the worst case a schedule can
     produce — a stream at the 32-segment cap — at <= 850,000 CPU (828,425 measured).
   - `withdraw_many_footprint_harness` measures §4.1 and asserts that a
     full 20-id batch stays under 8,600,000 CPU (8,000,000 before #24's
     per-entry pause lookup) and costs less than the same
     twenty claims issued as separate transactions.

---

## 7. Batch Claim-All Iteration Footprint & Ledger-Limit Bounds

`withdraw_all` iterates the recipient's own stream index, one page per transaction (unlike `withdraw_many`, which takes an explicit id list). Full architectural details and the partial-failure decision matrix are documented in [`docs/CLAIM_ALL.md`](CLAIM_ALL.md).

### 7.1 Footprint Measurements (1 / 10 / 50 / 60 Streams)

| Stream Count | Pagination Chunk | CPU Instructions | Memory (Bytes) | Ledger Entries Touched | Safe Under 64-Entry Limit? |
|:---:|:---:|---:|---:|:---:|:---:|
| **1 stream** | 1 of 1 | 683,989 | 269,514 | ~6 entries | **Yes (Safe)** |
| **10 streams** | 10 of 10 | 2,324,978 | 708,874 | ~15 entries | **Yes (Safe)** |
| **50 streams** | 50 (Page 1) | 10,960,486 | 2,906,988 | ~55 entries | **Yes (Safe, < 64 entries)** |
| **60 streams** | Chunked: 50 + 10 (Page 2: 10) | 2,313,818 | 708,874 | ~15 entries | **Yes (Safe across 2 txs)** |
| **60 streams** | Unpaginated (Hypothetical) | ~27,000,000 | ~5,800,000 | 65+ entries | **REJECTED (> 64 limit cliff)** |

### 7.2 Ledger-Limit-Safe Page Bounds

Soroban enforces a maximum of **64 ledger entries** (read/write) per transaction. Processing 50 streams touches ~55 ledger entries (1 instance storage entry + 1 recipient index entry + 50 stream entries + ~3 token entries). Processing 60 streams in a single transaction would breach the 64-entry cliff ($2 + 60 + 3 = 65$), causing transaction rejection. Hence, `MAX_PAGE_SIZE = 50` is strictly enforced with chunked continuation tokens (`next_offset`).
