# ADR 0008: Extend-on-Write TTL Strategy for Persistent Storage

Status: Accepted (backfilled)
Date: 2026-09-13
Deciders: StreamPay Engineering Team

## Context and Problem Statement

Soroban's state storage model enforces storage rent via Time-To-Live (TTL) entry counters. In persistent storage, if an entry's TTL is not extended before reaching zero ledgers, it is archived to off-chain cold storage. Restoring an archived entry requires an explicit restoration transaction.

StreamPay contracts manage thousands of streams. If the contract attempted to prepay rent indefinitely at stream creation, the upfront deposit cost would be economically prohibitive for users. Conversely, if active streams were allowed to expire due to lack of rent maintenance, recipients would be unable to withdraw earned wages without complex restoration ceremonies.

Furthermore, certain critical entries — specifically `DataKey::NextStreamId`, the contract instance entry, and the contract Wasm code entry — are not automatically extended by Soroban on invocation and have a default lifespan of only 4,095 ledgers (~5.7 hours).

## Decision Drivers

- Guarantee that actively utilized streams never archive or expire unexpectedly.
- Ensure abandoned or inactive streams naturally archive off-chain, bounding contract state bloat.
- Avoid imposing upfront lifetime rent costs on stream senders.
- Establish a clear operational regime for entries that the contract cannot extend internally.

## Considered Options

- Option 1: Extend-on-write for streams + extend-on-read for indexes + external sentinel for instance/code TTL.
- Option 2: Prepay lifetime rent at stream creation.
- Option 3: Extend stream TTL on every read query.
- Option 4: Contract-side internal extension of instance and code entries on every user transaction.

## Decision Outcome

Chosen option: "Option 1: Extend-on-write for streams + extend-on-read for indexes + external sentinel", because:
1. **Extend-on-Write for Streams:**
   - Every mutating entrypoint that touches a stream (`create_stream`, `withdraw`, `withdraw_max`, `cancel_stream`, `top_up`) invokes:
     ```rust
     env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
     ```
     where `TTL_THRESHOLD_LEDGERS = 200_000` (~11.6 days) and `TTL_EXTEND_LEDGERS = 500_000` (~29 days).
   - An active stream being topped up or claimed regularly stays hot indefinitely.
2. **Natural State Archiving:**
   - Abandoned or completed streams that are never touched again receive no extensions and expire into Soroban archival storage, bounding on-chain state bloat without penalizing active users.
3. **Extend-on-Read for Discovery Indexes:**
   - Address indexes (`RecipientStreams` / `SenderStreams`) extend TTL during write *and* paginated reads (`recipient_streams` / `sender_streams`), keeping active users' discovery indices hot.
4. **External Operational Sentinel (`infra/ttl-sentinel`):**
   - Contract instance, Wasm code, and `NextStreamId` cannot safely extend themselves on every call without burning user gas. An off-chain sentinel service monitors these three critical entries and broadcasts extension transactions before the 4,095-ledger (~5.7h) cliff is reached.

### Consequences

- **Positive:**
  - Active users never experience archived streams or unexpected restoration delays.
  - Zero upfront lifetime rent penalties: streams pay only for the storage time they actively consume.
  - State bloat is bounded automatically by Soroban's protocol-level archival mechanics.
- **Negative / Trade-offs:**
  - Operators must run the external `infra/ttl-sentinel` daemon to maintain contract instance, Wasm code, and ID counter entries.
  - If a user completely abandons a stream for >29 days, an off-chain RPC restoration transaction is required before it can be mutated again.

## Alternatives Considered

### Option 2: Lifetime Prepay at Creation

- Good, because streams would never archive regardless of activity.
- Bad, because prepaying years of rent at creation requires locking substantial XLM balances upfront, making payroll streaming economically unviable.

### Option 3: Extend on Read Queries for All Streams

- Good, because inspecting a stream would keep it alive.
- Bad, because simulated read-only RPC calls (e.g. `simulateTransaction` on `get_stream`) cannot commit persistent state mutations without paying transaction submission fees.

### Option 4: In-Contract Extension of Instance/Code on Every Write

- Good, because it removes reliance on an external sentinel.
- Bad, because it consumes gas on every user transaction to extend contract-level keys and costs unnecessary rent when multiple transactions execute in the same ledger.

## Validation and Evidence

- Implementation in `contracts/streaming-payments/src/stream.rs` and `contracts/streaming-payments/src/lib.rs`.
- Comprehensive TTL rent model and operational runbook in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#12-ttl-and-rent-operations).
- Sentinel daemon test suite in `infra/ttl-sentinel/test/` asserting alert thresholds against ledger cliffs.
- Commits: `7f740cf` (Initial extend-on-write stream TTL), `7fad774` (Address index TTL extension), and `d47fc5d` ("feat(infra): add a TTL/rent sentinel for storage cliffs and rent projection").
