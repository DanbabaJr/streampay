# ADR 0007: Page-Size-50 Indexes for Address Discovery

Status: Accepted (backfilled)
Date: 2026-10-04
Deciders: StreamPay Engineering Team

## Context and Problem Statement

Users need to discover streams where they are the designated sender or recipient. A naive design would maintain a global list of all streams or allow unpaginated queries of per-address stream lists.

However, Soroban enforces strict resource limits per transaction:
- **CPU Instructions:** 100,000,000 instructions maximum per transaction.
- **Memory Footprint:** 40 MB memory limit.
- **Return Value Size:** Bounded by network bandwidth and RPC serialization limits.

If an active sender (such as a DAO or enterprise payroll administrator) creates hundreds or thousands of streams, returning all stream IDs in a single vector would quickly exceed Soroban's CPU instruction and memory limits, causing read transactions to fail permanently for active users.

## Decision Drivers

- Prevent denial-of-service via resource exhaustion for active users with large stream histories.
- Keep per-read gas and CPU instruction consumption predictable and well within Soroban transaction limits.
- Provide responsive, bounded pagination for frontend interfaces and indexing workers.

## Considered Options

- Option 1: Per-address index vectors with page limit clamped to `MAX_PAGE_SIZE = 50`.
- Option 2: Unbounded per-address vector queries (`offset` without enforced maximum `limit`).
- Option 3: Contract-wide global stream registry (`Vec<u64>`).
- Option 4: Very small page limit (e.g., `MAX_PAGE_SIZE = 10`).

## Decision Outcome

Chosen option: "Option 1: Per-address index vectors with page limit clamped to `MAX_PAGE_SIZE = 50`", because:
1. Stream discovery is partitioned per address: `DataKey::RecipientStreams(Address)` and `DataKey::SenderStreams(Address)`.
2. Public discovery entrypoints (`recipient_streams` and `sender_streams`) accept `offset: u32` and `limit: u32` with `limit` clamped via `limit.min(MAX_PAGE_SIZE)`. Similarly, administrative audit scans (`verify_treasury(token, start_id, count)`) clamp requested batch counts via `count.min(MAX_PAGE_SIZE)`:
   ```rust
   let page_limit = limit.min(MAX_PAGE_SIZE); // MAX_PAGE_SIZE = 50
   ```
3. Returning up to 50 `u64` IDs consumes ~400 bytes of XDR payload and ~60,000 CPU instructions, using less than 0.1% of Soroban's per-transaction CPU allowance.
4. Clients page through their history deterministically by advancing `offset += 50` until fewer than 50 items are returned.

### Consequences

- **Positive:**
  - Queries are guaranteed to succeed regardless of how many streams an address has created or received over its lifetime.
  - Resource consumption per query is bounded by a tight mathematical constant.
  - The client UI can cleanly map 50 items per view page.
- **Negative / Trade-offs:**
  - Callers with more than 50 streams must make multiple RPC round trips to retrieve their full historical list.
  - `DataKey::RecipientStreams` entries grow as vectors in persistent storage, requiring occasional TTL refresh on read.

## Alternatives Considered

### Option 2: Unbounded Vector Queries

- Good, because small accounts could fetch everything in a single call.
- Bad, because accounts that exceed a few hundred streams would revert with `HostError: ResourceLimitExceeded`, rendering their stream history permanently unreadable on-chain.

### Option 3: Global Contract-Wide Stream Registry

- Good, because anyone could scan all streams from a single storage key.
- Bad, because `create_stream` would be forced to read, resize, and rewrite an ever-growing global vector on every single creation, making creation cost scale linearly with global platform adoption.

### Option 4: Very Small Page Limit (`MAX_PAGE_SIZE = 10`)

- Good, because payload size is minimal.
- Bad, because it introduces excessive RPC latency and round trips for typical users who manage 20-30 streams.

## Validation and Evidence

- Defined in `contracts/streaming-payments/src/stream.rs:34` (`pub const MAX_PAGE_SIZE: u32 = 50;`) and exposed via discovery and treasury entrypoints in `contracts/streaming-payments/src/lib.rs`.
- Documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#2-storage-model).
- Unit tests in `contracts/streaming-payments/src/test.rs` verify boundary clamping (requesting 100 items returns exactly 50).
- Commit: `7fad774` ("feat(contract): on-chain address indexes and withdraw_max").
