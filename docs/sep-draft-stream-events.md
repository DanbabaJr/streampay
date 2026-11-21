# SEP-DRAFT: Streaming Payment Events and Discovery Indexes

**Status:** Draft — pre-submission community review  
**Type:** Standard  
**Layer:** Interface  
**Authors:** StreamPay contributors  
**Created:** 2026-10-15  
**Discussion:** See `docs/sep-draft-issue-thread.md`

---

## Abstract

This document proposes a Stellar Ecosystem Proposal (SEP) that standardises the on-chain event schema and address-keyed discovery indexes for **linear payment streams** on Soroban. A compliant contract emits a small, stable set of `contractevent` items and maintains two append-only paginated indexes (by sender, by recipient). Wallets, block explorers, and indexing services that implement this SEP can support streams from any compliant contract without bespoke integration.

The specification is deliberately minimal: it covers only the primitive operations every stream contract must support — create, withdraw, cancel — and the discovery queries needed to enumerate streams for an address. Extensions such as protocol fees, deposit top-ups, pausing, milestones, and cliffs are recognised as optional behaviours and documented as such. A reference implementation is available in this repository.

---

## Motivation

Payment streams — funds that flow continuously to a recipient over a time window — are a recurring pattern across Stellar use-cases: payroll, DAO contributor pay, subscriptions, and token vesting all share the same conceptual model. Multiple independent contracts have been or will be deployed on Soroban implementing variants of this pattern.

Without a common interface:

- Every wallet or explorer must integrate each streaming contract individually.
- Event-driven indexers (Horizon, custom pipelines) cannot generically decode stream lifecycle transitions.
- Cross-contract composability (e.g. a DAO voting weight that counts unstreamed deposits) requires contract-specific adapters.

A thin, stable ABI for the minimum viable stream operations solves all three problems. This SEP defines exactly that surface: the event topics and data fields emitted by lifecycle transitions, and the two paginated read-only views that let any application enumerate streams for a given address.

---

## Specification

### Terminology

- **Stream** — an on-chain record that releases funds from a *sender* to a *recipient* at a rate derived from a *deposit*, a *start time*, and an *end time*.
- **Deposit** — the total amount of a single Stellar asset locked into the stream at creation.
- **Accrued amount** — the portion of the deposit that has vested at the current time: `floor(deposit × elapsed / duration)`, where `elapsed = clamp(now − start_time, 0, duration)` and `duration = end_time − start_time`.
- **Available amount** — the accrued amount minus any prior withdrawals.
- **Compliant contract** — a Soroban contract whose on-chain behaviour satisfies §3 (Events) and §4 (Discovery Indexes).

The key words MUST, SHOULD, MAY, MUST NOT are used as defined in RFC 2119.

---

### 1. Stream Identifier

Each stream MUST be assigned a unique `u64` identifier (`stream_id`) that is monotonically increasing within the contract and starts at 1. Identifiers MUST NOT be reused after a stream reaches a terminal state (cancelled or fully withdrawn).

---

### 2. Asset Model

A stream is denominated in exactly one asset, identified by its Soroban `Address` (a SEP-11 / CAP-0046 contract address for classic Stellar assets wrapped via `stellar-asset-contract`, or any other fungible token). Amounts are expressed in the token's smallest indivisible unit as `i128`.

---

### 3. Events

All events MUST be emitted via `env.events().publish(...)` (or the `#[contractevent]` macro equivalent). Topic fields determine the subscription filter for event-streaming clients; data fields carry the payload.

This section defines the event name, topic list, and data fields for each lifecycle transition. The event name is the XDR symbol placed in topic[0] by `#[contractevent]`; it MUST match the name below exactly (case-sensitive).

> **Naming resolution (was open question 1).** `#[contractevent]` emits the **`PascalCase` struct name** as the topic[0] XDR symbol — `"StreamCreated"`, `"Withdrawn"`, `"StreamCancelled"`, `"StreamToppedUp"`, `"FeeCharged"`, `"StreamPaused"`, `"StreamResumed"`. The `snake_case` forms (`stream_created`, `withdrawn`, …) are **not** on-chain symbols: they are the registry's normalised `event_key` identifier, derived from the struct name by the generator that parses `contracts/streaming-payments/src/events.rs` (see `schemas/events/README.md` §"How it works") and used as the schema file name and the `EVENT_KEYS` decode index for the generated TypeScript consumers (`indexer/src/generated/events.ts`, `frontend/lib/generated/events.ts`). The SEP standardises the **`PascalCase` on-chain symbol**; the `snake_case` key is a tooling-side stable identifier and never appears on the wire. Rationale: matching the macro output keeps the on-chain symbol a pure function of the Rust struct name, so codegen consumers cannot drift from the contract. See the implementation-status table in §11.


#### 3.1 `StreamCreated`

Emitted when a new stream is opened and the deposit has been successfully transferred to the contract.

| Position | Field | Type | Description |
|---|---|---|---|
| topic[0] | *(event name)* | Symbol | `"StreamCreated"` |
| topic[1] | `stream_id` | `u64` | Unique stream identifier |
| data | `sender` | `Address` | Account that funded the stream |
| data | `recipient` | `Address` | Account that will receive the streamed funds |
| data | `token` | `Address` | Asset contract address |
| data | `deposit` | `i128` | Total amount locked (in smallest token units) |
| data | `start_time` | `u64` | Unix timestamp at which accrual begins |
| data | `end_time` | `u64` | Unix timestamp at which accrual ends (fully vested) |
| data | `cancelable` | `bool` | Whether the recipient is permitted to cancel this stream |

**Constraints:**  
- `deposit > 0`  
- `start_time >= current_ledger_timestamp` at the time of creation  
- `end_time > start_time`  
- `end_time − start_time` SHOULD be bounded to a reasonable maximum (implementors MAY choose their own cap; the reference implementation uses 100 years)

#### 3.2 `Withdrawn`

Emitted when the recipient withdraws accrued funds. One emission per successful withdrawal call.

| Position | Field | Type | Description |
|---|---|---|---|
| topic[0] | *(event name)* | Symbol | `"Withdrawn"` |
| topic[1] | `stream_id` | `u64` | Stream identifier |
| data | `recipient` | `Address` | Recipient of this withdrawal |
| data | `amount` | `i128` | Amount transferred in this call |
| data | `withdrawn_total` | `i128` | Cumulative amount withdrawn from this stream (including this call) |

**Constraints:**  
- `amount > 0`  
- `amount <= available_amount` at the time of the call  
- `withdrawn_total <= deposit`

#### 3.3 `StreamCancelled`

Emitted when a stream is cancelled. The recipient's accrued but unwithdrawn balance and the sender's unaccrued refund MUST both be transferred atomically in the same transaction as this event.

| Position | Field | Type | Description |
|---|---|---|---|
| topic[0] | *(event name)* | Symbol | `"StreamCancelled"` |
| topic[1] | `stream_id` | `u64` | Stream identifier |
| data | `cancelled_by` | `Address` | Address that initiated the cancellation |
| data | `recipient_amount` | `i128` | Accrued-but-unwithdrawn amount paid to the recipient |
| data | `sender_amount` | `i128` | Unaccrued amount refunded to the sender |

**Constraints:**  
- `recipient_amount + sender_amount == deposit − prior_withdrawn` at the moment of cancellation  
- `recipient_amount >= 0`, `sender_amount >= 0`  
- The stream MUST NOT emit any further `Withdrawn` or `StreamCancelled` events after this point

---

### 4. Discovery Indexes

A compliant contract MUST provide two read-only paginated views over an append-only, creation-ordered list of stream identifiers. These views MUST be callable without authentication.

#### 4.1 `sender_streams`

```
sender_streams(sender: Address, offset: u32, limit: u32) -> Vec<u64>
```

Returns stream identifiers, in creation order (oldest first), for all streams where `sender` is the funding party. `limit` SHOULD be capped at an implementation-defined `MAX_PAGE_SIZE` (the reference implementation uses 50). An unknown address MUST return an empty list rather than an error. The list is advisory: callers MUST read each stream's current state to determine lifecycle status.

#### 4.2 `recipient_streams`

```
recipient_streams(recipient: Address, offset: u32, limit: u32) -> Vec<u64>
```

Same semantics as `sender_streams`, but keyed by the recipient address.

#### 4.3 Stream count

A compliant contract SHOULD expose a `total_streams() -> u64` read that returns the number of streams ever created. This enables verification tools to know the full id space without paginating both indexes. The reference implementation exposes `total_streams` (`src/lib.rs`); it is verified on every differential-fuzz step against the model (`src/differential_harness.rs`), so it is present and tested but still normatively a SHOULD — see resolved decision 4 in §12.

---

### 5. Stream State View

A compliant contract MUST provide a `get_stream` read that returns the full state of a stream by id:

```
get_stream(stream_id: u64) -> Result<Stream, Error>
```

The returned structure MUST include at minimum:

| Field | Type | Description |
|---|---|---|
| `id` | `u64` | Stream identifier |
| `sender` | `Address` | Funding party |
| `recipient` | `Address` | Receiving party |
| `token` | `Address` | Asset contract address |
| `deposit` | `i128` | Total amount locked |
| `withdrawn` | `i128` | Total amount paid out to date |
| `start_time` | `u64` | Accrual window start (Unix seconds) |
| `end_time` | `u64` | Accrual window end (Unix seconds) |
| `cancelable` | `bool` | Whether the recipient can cancel |
| `status` | `StreamStatus` | `Active`, `Cancelled`, or `Depleted` |

**`StreamStatus` values:**

| Variant | Meaning |
|---|---|
| `Active` | Funds are still accruing; withdrawals and (permitted) cancellations are allowed |
| `Cancelled` | The stream was cancelled; payout was settled atomically |
| `Depleted` | All funds have been withdrawn; the stream is complete |

Both `Cancelled` and `Depleted` are terminal: no further state transitions are permitted.

---

### 6. Accrual Formula

The reference linear accrual formula is:

```
elapsed   = clamp(now − start_time, 0, duration)
duration  = end_time − start_time
streamed  = floor(deposit × elapsed / duration)
available = streamed − withdrawn          (where withdrawn is the cumulative amount)
```

All arithmetic MUST be performed with sufficient precision to avoid overflow; implementations SHOULD use 128-bit intermediates. A contract MAY define a non-linear accrual schedule (e.g. cliff or step vesting) as long as the event schema and discovery interface are preserved. Non-linear schedules SHOULD document their formula.

---

### 7. Cancellation Semantics

When a stream is cancelled:

- The recipient receives exactly `accrued_at_cancellation − prior_withdrawn`.
- The sender receives exactly `deposit − accrued_at_cancellation`.
- The sum of both amounts equals the funds still held by the contract for this stream.
- The `cancelable` flag on the stream governs whether the **recipient** may initiate a cancellation. The **sender** MUST always be permitted to cancel.
- Both transfers and the `StreamCancelled` event MUST occur in a single atomic transaction.

---

### 8. Optional Extensions

The following behaviours are recognised as common extensions. A compliant contract MAY implement any of them; none are required by this SEP.

#### 8.1 Deposit Top-Up

A contract MAY allow the sender to add funds to an active stream. If supported, a `StreamToppedUp` event SHOULD be emitted:

| Position | Field | Type |
|---|---|---|
| topic[0] | `"StreamToppedUp"` | Symbol |
| topic[1] | `stream_id` | `u64` |
| data | `sender` | `Address` |
| data | `amount` | `i128` |
| data | `new_deposit` | `i128` |

The updated `deposit` MUST be reflected in the next `get_stream` call.

#### 8.2 Protocol Fee

A contract MAY charge a non-refundable protocol fee at stream creation, deducted from the sender (on top of the deposit, not from it). If supported:

- The `deposit` field in `StreamCreated` MUST reflect the net amount that accrues to the recipient — not the gross amount pulled from the sender. This ensures the accrual formula is always `deposit`-based without ambiguity.
- A `FeeCharged` event SHOULD be emitted immediately after `StreamCreated`:

| Position | Field | Type |
|---|---|---|
| topic[0] | `"FeeCharged"` | Symbol |
| topic[1] | `stream_id` | `u64` |
| data | `token` | `Address` |
| data | `payer` | `Address` |
| data | `amount` | `i128` |
| data | `fee_bps` | `u32` |

#### 8.3 Pause / Resume

A contract MAY support pausing accrual. The reference implementation **does** implement this extension (it is no longer aspirational — the draft previously listed it as out of scope, which was incorrect). Two events are standardised here:

**`StreamPaused`** — emitted when the sender freezes accrual at the current time.

| Position | Field | Type |
|---|---|---|
| topic[0] | `"StreamPaused"` | Symbol |
| topic[1] | `stream_id` | `u64` |
| data | `paused_at` | `u64` |

**`StreamResumed`** — emitted when the sender resumes; the window shifts by the paused length so accrual continues from the frozen point.

| Position | Field | Type |
|---|---|---|
| topic[0] | `"StreamResumed"` | Symbol |
| topic[1] | `stream_id` | `u64` |
| data | `new_end_time` | `u64` |

**Resolved model (correction).** Pause is **not** represented by a `paused: bool` field or a `Paused` status variant — the `StreamStatus` enum has exactly `Active`, `Cancelled`, `Depleted` and a paused stream stays `Active`. Instead the reference implementation keeps a sidecar `paused_at: Option<u64>` keyed by `stream_id` (get/set in `src/stream.rs`) and, on resume, advances `end_time` by the frozen interval (`new_end_time`) rather than subtracting paused time inside the accrual formula. `available_amount` therefore needs no pause-aware branch: after a resume, `elapsed` is computed against the shifted window and accrual continues from where it stopped. Contracts MAY adopt any equivalent representation as long as the two events and the effective window shift are observable.

#### 8.4 Milestones and Cliff Vesting

A contract MAY implement cliff vesting (no accrual before a cliff time) or discrete milestone-based release. These are non-standard accrual schedules; their event interface is beyond the scope of this SEP.

---

### 9. Error Codes

A compliant contract MUST use stable, monotonically appended numeric error codes (never renumber or reuse). The following codes are RECOMMENDED for base operations:

| Code | Name | Condition |
|---|---|---|
| 1 | `StreamNotFound` | No stream exists with the given id |
| 4 | `StreamNotCancellable` | Recipient attempted to cancel a non-cancelable stream |
| 5 | `StreamNotActive` | Operation on a terminal stream |
| 6 | `StartTimeInPast` | `start_time` is before the current ledger timestamp |
| 7 | `InvalidTimeRange` | `end_time <= start_time` |
| 8 | `DurationTooLong` | Duration exceeds the implementation's maximum |
| 9 | `ZeroAmount` | A provided amount is zero or negative |
| 10 | `AmountExceedsAvailable` | Withdrawal amount exceeds accrued balance |
| 11 | `MathOverflow` | An intermediate computation would overflow (all math is checked) |
| 12 | `NotAuthorized` | Caller is not a permitted party for this operation |
| 13 | `NothingToWithdraw` | Atomic full-withdrawal call found nothing to pay out |

Codes 14–17 and above (`FeeRateTooHigh`, `NotGovernor`, `NoPendingGovernor`, `InsufficientTreasuryBalance`, and the dispute, sponsor, scheduled-intent, oracle, governance, policy, and upgrade families) belong to the optional-extension surfaces and are outside this SEP's base error registry; they follow the same append-only rule and are enumerated in `src/errors.rs` and [`docs/ERROR_SURFACE.md`](ERROR_SURFACE.md).

Implementors MUST NOT assign a meaning to a code that conflicts with the above. Codes 2 (`NotStreamSender`) and 3 (`NotStreamRecipient`) are retired in the reference implementation — the variants are kept in the enum but never produced — and SHOULD be treated as reserved across compliant implementations.

---

### 10. Checks-Effects-Interactions Ordering

All state-mutating entrypoints in a compliant contract MUST follow the CEI pattern: all state writes and event emissions MUST happen before any token transfers. This prevents reentrant token callbacks from observing stale state and double-spending.

---

### 11. Implementation Status

Every field and event named in this SEP maps to a live entry in the shipped event registry under `schemas/events/v1/events/`. The registry is generated from `contracts/streaming-payments/src/events.rs` and pinned in CI (the `event_registry::*` tests and the drift gate described in `schemas/events/README.md`), so this table describes what exists on `main`, not aspirations. `topic[0]` (the event-name symbol) is omitted from the registry's `topics` array because the generator derives it from the struct name; `stream_id` is the first registry-declared topic.

| Drafted surface | Live registry entry | On-chain symbol (topic[0]) | Data fields (registry → draft §) | Status |
|---|---|---|---|---|
| `StreamCreated` (§3.1) | `schemas/events/v1/events/stream_created.json` | `StreamCreated` | `sender, recipient, token, deposit, start_time, end_time, cancelable` | **Implemented** — exact match |
| `Withdrawn` (§3.2) | `schemas/events/v1/events/withdrawn.json` | `Withdrawn` | `recipient, amount, withdrawn_total` | **Implemented** — exact match |
| `StreamCancelled` (§3.3) | `schemas/events/v1/events/stream_cancelled.json` | `StreamCancelled` | `cancelled_by, recipient_amount, sender_amount` | **Implemented** — exact match |
| `sender_streams` (§4.1) | `src/lib.rs::sender_streams` | n/a (read) | — | **Implemented** — `MAX_PAGE_SIZE = 50` (ADR 0007) |
| `recipient_streams` (§4.2) | `src/lib.rs::recipient_streams` | n/a (read) | — | **Implemented** |
| `total_streams` (§4.3) | `src/lib.rs::total_streams` | n/a (read) | — | **Implemented** — verified in differential harness |
| `get_stream` (§5) | `src/lib.rs::get_stream` → `Stream` | n/a (read) | `id, sender, recipient, token, deposit, withdrawn, start_time, end_time, cancelable, status` | **Implemented** — `Stream` carries additional extension fields (oracle/piecewise-rate); the table's "at minimum" holds |
| `StreamStatus` (§5) | `src/stream.rs::StreamStatus` | — | `Active, Cancelled, Depleted` | **Implemented** — exact match; no `Paused` variant |
| `StreamToppedUp` (§8.1) | `schemas/events/v1/events/stream_topped_up.json` | `StreamToppedUp` | `sender, amount, new_deposit` | **Implemented** — exact match |
| `FeeCharged` (§8.2) | `schemas/events/v1/events/fee_charged.json` | `FeeCharged` | `token, payer, amount, fee_bps` | **Implemented** — exact match |
| `StreamPaused` (§8.3) | `schemas/events/v1/events/stream_paused.json` | `StreamPaused` | `paused_at` | **Implemented** — draft corrected (§8.3) |
| `StreamResumed` (§8.3) | `schemas/events/v1/events/stream_resumed.json` | `StreamResumed` | `new_end_time` | **Implemented** — draft corrected (§8.3) |
| Error codes 1,4–13 (§9) | `src/errors.rs::StreamError` | — | see §9 | **Implemented** — `MathOverflow` (11) added to §9; 2 and 3 retired |

Out-of-scope registry events (governance, dispute, sponsor, scheduled-intent, oracle, policy, upgrade, batch/streaming helpers such as `StreamsCreated` and `BatchWithdrawSummary`) exist in the registry but are not part of this SEP's normative surface; wallets may ignore them without breaking conformance.

---

### 12. Design Decisions (resolved)

Each item below resolves one of the community questions in the discussion thread, with the decision grounded in the shipped implementation. Where the pre-resolution draft disagreed with the registry, the registry won and the body was corrected (see the Changelog and §11).

**1. Event name casing — RESOLVED: `PascalCase` on-chain, `snake_case` registry key.** The on-chain topic[0] symbol is the `#[contractevent]` struct name (`StreamCreated`, …); the registry's `snake_case` `event_key` (`stream_created`) is a tooling identifier only, never on the wire. Rationale: keeping the symbol a pure function of the Rust struct name lets `schemas/events/README.md` codegen and the `event_registry::registry_matches_contract_event_structs` in-crate pin guarantee that consumer types cannot drift from the contract. See §3 naming resolution note.

**2. Topic layout — RESOLVED: `stream_id` in topic[1] only.** Every per-stream event declares exactly one registry topic, `stream_id: u64` (`"topics": [{"name": "stream_id", "type": "u64"}]` in §11's files). `sender`/`recipient` stay in the data payload, not topics. Rationale: Soroban allows at most 4 positional topics and treats them as part of the frozen ABI (`schemas/events/README.md`: re-ordering/removing a topic field is a breaking change). Because a client subscribes per contract and filters by `stream_id`, cross-contract address indexing is delegated to the append-only per-address discovery indexes (§4) rather than to event topics — the two `#[topic]`-by-address events that do exist (`StreamsCreated`, `BatchWithdrawSummary`) are batch helpers outside the base surface.

**3. `i128` vs `u128` — RESOLVED: `i128` for amounts, `u64` for timestamps.** The registry encodes `deposit`, `amount`, `withdrawn_total`, `recipient_amount`, `sender_amount`, `new_deposit` as `x-soroban-type: i128`, and `start_time`, `end_time`, `paused_at`, `new_end_time` as `u64`, `fee_bps` as `u32`. Rationale: the Soroban `token::TokenClient::transfer` signature is `i128`, so amounts must match to avoid pervasive casts at the CEI transfer boundary (§10); the `>= 0` constraints in §3 keep the semantics non-negative even though the wire type is signed.

**4. Mandatory `total_streams` vs optional — RESOLVED: keep SHOULD; it is implemented.** `src/lib.rs::total_streams` exists and is checked on every differential-fuzz step (`src/differential_harness.rs`), so verification tools can rely on it in this reference implementation. But it remains a SHOULD: a wallet that only paginates §4 indexes does not need it, and making it MUST would burden minimal contracts. `MAX_PAGE_SIZE = 50` (ADR 0007) lets a verifier stop paginating a per-address index when a page returns fewer than 50 ids without needing `total_streams`; `total_streams` is the cheaper global bound. The `has_more: bool` alternative was rejected — it changes the frozen `Vec<u64>` return of §4 and is a breaking registry change.

**5. Accrual formula normative or informative — RESOLVED: normative default, informative for documented variants.** §6 states the linear floor formula as the behaviour for contracts that document nothing else; §6 already permits non-linear schedules only if the event/discovery surface is preserved and the formula documented. Rationale: the formula is derivable from `deposit`, `start_time`, `end_time`, and ledger time, so a wallet that recalculates it locally stays correct for the default case; the residual risk (an undocumented non-linear schedule) is addressed by requiring documentation rather than by making the default formula informative. Grounded in ADR 0004 (floor-per-second accrual) and ADR 0005 (pure `streamed_at`).

**6. Error-code registry — RESOLVED: no separate namespace; reuse the append-only `StreamError` discriminants.** §9 lists base codes as RECOMMENDED, not required, and codes are the raw `#[contracterror]` discriminants in `src/errors.rs`. A registered human-readable namespace was rejected for v1 as heavier than the value it adds: `docs/ERROR_SURFACE.md` already generates a code→message table from the enum with doc comments, and `error_surface_test.rs` is a CI gate that keeps committed codes and emitted branches in lock-step (ADR 0003 append-only rule). Tooling can key off the numeric code plus the SEP-anchored name in §9 without a second registry.

**7. Scope of `StreamCancelled` data — RESOLVED: keep both `recipient_amount` and `sender_amount`.** The registry emits both (`stream_cancelled.json`). Rationale: making the event self-contained lets an explorer settle a cancellation from the event log alone, avoiding a state replay of the pre-cancellation accrual point; on-chain amounts are already public, so publishing them in the event adds no new disclosure beyond the token transfer records in the same transaction. The invariant in §3.3 (`recipient_amount + sender_amount == deposit − prior_withdrawn`) is checkable directly from the event, which is the audit benefit.

---

## Security Considerations

### Reentrancy

The CEI pattern (§10) is the primary reentrancy defence. Implementations that perform token transfers before updating state violate this SEP and MUST NOT be considered compliant.

### Overflow

The accrual formula multiplies `deposit × elapsed`, where `deposit` can be close to `i128::MAX` and `elapsed` can be large. Implementations MUST use 128-bit or wider intermediate arithmetic and MUST return an error rather than panic or wrap on overflow. The reference implementation validates `deposit × duration` fits in `u128` at creation time so that no subsequent multiplication can overflow.

### Start-time front-running

Requiring `start_time >= current_ledger_timestamp` prevents a sender from back-dating a stream to immediately grant the recipient an accrued balance that the sender never intended. Implementations MUST enforce this constraint.

### Index advisory nature

The discovery indexes (§4) are append-only and contain terminal streams. Callers MUST NOT treat the presence of a stream id in an index as evidence that the stream is currently active; they MUST read `get_stream` for authoritative state.

### `cancelable` flag immutability

The `cancelable` flag set at creation MUST NOT be mutable after the stream is stored. Allowing mutation would permit the sender to strip the recipient's cancellation right after the fact.

### Integer truncation in accrual

The floor division in the accrual formula means `streamed < deposit` even after the window ends if the deposit is not divisible by the duration. The remainder is only recoverable via explicit withdrawal at or after `end_time`; implementations SHOULD document this rounding behaviour.

### Protocol fee non-refundability (if fees are implemented)

If a protocol fee extension (§8.2) is implemented, the fee MUST be non-refundable on cancellation. Including the fee in the cancellable deposit would create an incentive for the contract operator to grief streams.

---

## Reference Implementation

**Repository:** <https://github.com/Neziahtech/streampay>  
**Contract path:** `contracts/streaming-payments/`  
**SDK:** Soroban SDK v28  
**Language:** Rust (compiled to Wasm for deployment)

The reference implementation satisfies all MUST requirements in this SEP:

| Requirement | Location |
|---|---|
| `StreamCreated` event | `src/events.rs` — `StreamCreated` struct |
| `Withdrawn` event | `src/events.rs` — `Withdrawn` struct |
| `StreamCancelled` event | `src/events.rs` — `StreamCancelled` struct |
| `sender_streams` / `recipient_streams` | `src/lib.rs` — `sender_streams`, `recipient_streams` |
| `get_stream` view | `src/lib.rs` — `get_stream` |
| `total_streams` | `src/lib.rs` — `total_streams` |
| Overflow-checked accrual | `src/stream.rs` — `streamed_at`, `validate_capacity` |
| CEI ordering | `src/lib.rs` — all mutating entrypoints |
| Stable error codes | `src/errors.rs` — `StreamError` |

Optional extensions implemented (non-normative from this SEP's perspective):

- **Deposit top-up** (`top_up`): `src/lib.rs`, `src/events.rs` (`StreamToppedUp`)
- **Protocol fee treasury**: `src/treasury.rs`, `src/events.rs` (`FeeCharged`, `FeeWithdrawn`)
- **Pause / resume** (`pause_stream`, `resume_stream`): `src/lib.rs`, `src/events.rs` (`StreamPaused`, `StreamResumed`), sidecar `paused_at` storage and window-shift in `src/stream.rs`

Optional extensions **not** implemented (out of scope for v1):

- Cliff vesting
- Milestone-based release
- Sender-initiated end-time extension (distinct from the pause-driven window shift above)

### Deployed contracts

| Network | Contract ID | Version |
|---|---|---|
| Testnet | *(see `deployments/testnet/`)* | v0.3+ |

---

## Backwards Compatibility

This SEP is a new standard; there are no prior SEPs to be compatible with. Contracts predating this SEP MAY be retrofitted by adding the required events and views without changing their core logic, provided they do not violate the semantic constraints in §3–§7.

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-15 | Initial draft for community review |
| 2026-11-20 | Resolved the seven open questions against the shipped event registry (§12); added the implementation-status table (§11). Corrections to the body: §3 clarified on-chain `PascalCase` symbol vs `snake_case` registry key; §4.3 noted `total_streams` is implemented; §8.3 rewritten to match the shipped `StreamPaused`/`StreamResumed` sidecar-window-shift model (paused stream stays `Active`, no `Paused` variant / `paused: bool`); §9 added the produced `MathOverflow` (11) code and clarified the extension-code range; Reference Implementation moved Pause/Resume from "not implemented" to "implemented". No schema files were changed. |
