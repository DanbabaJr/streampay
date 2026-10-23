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
   - `cargo test -p streampay-contract`: All 195 unit and property tests pass.
   - `cargo test -p streampay-passkey`: All 14 tests pass.
2. **CEI Golden Ordering Traces**:
   - `cargo test -p streampay-contract --lib operation_order_matches_golden --locked`: All 9 golden traces match byte-for-byte.
3. **Footprint Regression Harness**:
   - `hot_path_footprint_harness` in `contracts/streaming-payments/src/test.rs` permanently asserts that hot paths execute within instruction budgets:
     - `create_stream` <= 560,000 CPU
     - `withdraw` <= 360,000 CPU
     - `cancel_stream` <= 560,000 CPU (raised from 540,000 for the dispute freeze lookup)
     - `withdraw_max` <= 350,000 CPU
     - `create_stream` <= 560,000 CPU (541,608 measured)
     - `withdraw` <= 370,000 CPU (365,133 measured)
     - `cancel_stream` <= 545,000 CPU (538,801 measured)
     - `withdraw_max` <= 375,000 CPU (368,142 measured)
     - `withdraw` on a renegotiated (two-window) stream <= 415,000 CPU (407,316 measured)
   - `full_schedule_pricing_is_bounded` asserts the worst case a schedule can
     produce — a stream at the 32-segment cap — at <= 850,000 CPU (820,911 measured).
