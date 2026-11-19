# ADR 0003: Append-Only Interface for Error Codes and Address Indexes

Status: Accepted (backfilled)
Date: 2026-09-13
Deciders: StreamPay Engineering Team

## Context and Problem Statement

Soroban smart contracts expose public interfaces to external callers, including hardware signers, client applications, TypeScript SDKs, and off-chain indexers. These interfaces evolve over time as new features are added (such as `withdraw_max`, treasury fees, scheduled intents, and batched streams).

Two specific interface vectors present severe backwards-compatibility risks if mutated carelessly:
1. **Error Codes:** Soroban `contracterror` values are mapped to integer discriminants. External clients decode contract errors by their raw numeric identifiers.
2. **Address Discovery Indexes:** Users discover their active and past streams via per-address index lists (`DataKey::RecipientStreams` and `DataKey::SenderStreams`), paginated via `offset` and `limit`.

If error codes are renumbered when older variants are removed, deployed clients and monitoring systems misinterpret operational failures. If stream indices are deleted or reordered upon stream completion, client pagination cursors shift and skip records.

## Decision Drivers

- Maintain strict, long-term ABI backwards compatibility for external consumers and automated indexers.
- Ensure stable, deterministic pagination for client account discovery.
- Avoid unnecessary O(N) storage rewrite costs on terminal lifecycle transitions (`cancel_stream`, `Depleted`).

## Considered Options

- Option 1: Strictly append-only error code enum and append-only per-address index vectors.
- Option 2: Dense error enum renumbering on variant retirement.
- Option 3: Dynamic in-place pruning of address index vectors upon stream completion.

## Decision Outcome

Chosen option: "Option 1: Strictly append-only error codes and address index vectors", because:
1. **Error Code Append-Only Policy:**
   - Every variant in `StreamError` has an explicit numeric discriminant (`#[contracterror]`).
   - New variants are appended at the bottom with the next sequential integer.
   - Retired error codes (specifically code 2 `NotStreamSender` and code 3 `NotStreamRecipient`) remain in the enum definition, marked as unreachable, and are never renumbered, deleted, or reassigned.
   - Automated error-surface tests (`error_surface_test.rs` and `docs/ERRORS.md`) enforce that committed codes match branch instrumentation.
2. **Address Index Append-Only Policy:**
   - When a stream is created, its `u64` identifier is appended to the recipient's and sender's index vectors.
   - When a stream is cancelled or depleted, the ID remains in the index vectors; the stream state itself (`Stream.status`) reflects its lifecycle status.
   - Paginating callers pass `offset` and `limit`, guaranteeing deterministic cursor progression without missed or duplicated items.

### Consequences

- **Positive:**
  - Deployed clients, transaction explorers, and indexers continue decoding errors accurately across contract upgrades.
  - Pagination over user stream history remains idempotent and deterministic.
  - Zero storage footprint overhead for lifecycle deletions: mutating a stream touches only the stream entry itself, never rewriting user index arrays.
- **Negative / Trade-offs:**
  - Address index vectors grow monotonically with user activity over time, necessitating bounded page limits (see [ADR 0007](./0007-page-size-50-indexes.md)).
  - Retired error codes occupy slot numbers in the enum definition permanently.

## Alternatives Considered

### Option 2: Dense Enum Renumbering on Variant Retirement

- Good, because the numeric range stays compact without unused gap numbers.
- Bad, because renumbering shifts all subsequent error codes (e.g. error code 5 becomes code 3), causing deployed frontends and mobile apps to misinterpret runtime reverts.

### Option 3: Pruning Address Vectors on Stream Completion

- Good, because index arrays only contain currently active streams.
- Bad, because removing elements from an on-chain vector requires an O(N) read-modify-write operation of the entire array, burning excessive storage write fees. Additionally, clients lose visibility into their stream history, and concurrent pagination cursors shift unexpectedly.

## Validation and Evidence

- Enforced in `contracts/streaming-payments/src/errors.rs` and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#7-error-surface).
- Automated CI gate: `cargo run -p streampay-contract --example error_surface_doc` verifies against `docs/ERRORS.md` in CI (`.github/workflows/ci.yml`).
- Commits: `7f740cf` (Initial error code definition and interface), `7fad774` ("feat(contract): on-chain address indexes and withdraw_max"), and `9f34b97` ("test: generated entrypoint-by-error matrix with docs artifact").
