# Community Discussion: SEP Draft — Streaming Payment Events and Discovery Indexes

*This document is the intended GitHub issue body and seed discussion thread for the SEP draft at `docs/sep-draft-stream-events.md`. Post it as a GitHub issue on the `stellar/stellar-protocol` repository before submitting the formal SEP PR.*

---

## Issue body

**Title:** `[SEP Draft] Standard events and discovery indexes for Soroban payment streams`

We are proposing a SEP that standardises the minimal on-chain interface needed for wallets and explorers to support **linear payment streams** generically, without bespoke per-contract integration.

The full draft is in this repository at [`docs/sep-draft-stream-events.md`](./sep-draft-stream-events.md). Here is a summary of the key decisions. The seven questions we opened the thread with are now **resolved** against the shipped implementation — the decisions and their rationale are recorded in §12 of the draft and echoed below — and we'd like any remaining objections before submitting upstream.

---

### What the SEP covers

Three required lifecycle events (`StreamCreated`, `Withdrawn`, `StreamCancelled`), two paginated discovery views (`sender_streams`, `recipient_streams`), and a `get_stream` state read. That's the entire normative surface.

Everything else — protocol fees, deposit top-ups, pause/resume, cliff vesting, milestones — is explicitly optional or out of scope.

### What it deliberately excludes

- **Pause / resume as a *required* surface**: StreamPay **does** implement pause (`pause_stream` / `resume_stream`, emitting `StreamPaused` / `StreamResumed`), but it is documented as an **optional extension** (§8.3), not part of the required surface. Including it in MUST would lock out simpler contracts or force them to implement a stub. The earlier draft wrongly claimed StreamPay did not implement pause and guessed at a `Paused` status variant; the resolved text now matches the registry — a paused stream stays `Active` and the implementation freezes accrual at `paused_at` and shifts `end_time` on resume.
- **Milestones and cliff vesting**: These are non-linear accrual schedules. The event shape stays the same (same lifecycle transitions); only the formula changes. The SEP leaves the formula open so non-linear schedules are conformant.
- **Protocol fee governance**: The fee model is one deployment's policy choice, not a protocol primitive. The `FeeCharged` optional event schema is included as a courtesy for explorers, but nothing about fee governance is required.
- **`withdraw_max`**: This is a convenience entrypoint, not a protocol primitive. Conformance doesn't require it; its behaviour is fully derivable from `get_stream` + `withdraw`.

### Reference implementation

[`contracts/streaming-payments/`](../contracts/streaming-payments/) — Soroban SDK v28, Rust. Every normative requirement in the SEP maps directly to existing code; nothing in the reference implementation had to be changed to conform.

---

## Resolved discussion points

The seven questions we opened the thread with are now resolved against the shipped implementation. Each decision is grounded in a registry entry, a contract entrypoint, or an ADR — the full write-up lives in §11 (implementation-status table) and §12 (decisions) of [`docs/sep-draft-stream-events.md`](./sep-draft-stream-events.md). Community objections to these specific resolutions are still welcome, but the draft no longer carries them as open.

### 1. Event name casing — RESOLVED: `PascalCase` on-chain, `snake_case` registry key

`#[contractevent]` emits the `PascalCase` struct name (`StreamCreated`) as the topic[0] symbol; that is what we standardise. The `snake_case` `stream_created` you see in `schemas/events/v1/events/` is the registry's normalised `event_key` — a file/tooling identifier derived by the generator and used for the TypeScript `EVENT_KEYS` decode index — never on the wire. Keeping the on-chain symbol a pure function of the Rust struct name is what lets the in-crate pin test (`event_registry::registry_matches_contract_event_structs`) guarantee codegen never drifts from the contract.

### 2. Topic layout — RESOLVED: `stream_id` in topic[1] only

Every per-stream event declares exactly one topic, `stream_id: u64`; `sender`/`recipient` remain data fields. Soroban caps topics at 4 and freezes them in the ABI (topic re-order/removal is a breaking registry change), and cross-contract discovery is already served by the append-only per-address indexes (`sender_streams`/`recipient_streams`) rather than event topics. Address-keyed topics would spend frozen ABI surface for something the indexes already do better.

### 3. `i128` vs `u128` — RESOLVED: `i128` amounts, `u64` timestamps

The registry encodes all amounts as `i128`, timestamps as `u64`, and `fee_bps` as `u32`. This matches `token::TokenClient::transfer`'s `i128` signature at the CEI transfer boundary; the `>= 0` field constraints keep semantics non-negative despite the signed wire type.

### 4. Mandatory `total_streams` vs optional — RESOLVED: keep SHOULD (it is implemented)

`total_streams` exists and is verified in the differential harness, so tools can rely on it here. We keep it a SHOULD because wallets that page the §4 indexes don't need it — `MAX_PAGE_SIZE = 50` (ADR 0007) already lets a verifier stop when a page returns < 50. The `has_more: bool` alternative is rejected: it changes the frozen `Vec<u64>` return and is a breaking registry change.

### 5. Accrual formula normative or informative — RESOLVED: normative default, informative for documented variants

The linear floor formula (ADR 0004/0005) is the documented default for contracts that specify nothing else; §6 still allows non-linear schedules if they are documented and preserve the event/discovery surface. A wallet recalculating locally stays correct for the default case; the residual risk is closed by the documentation requirement, not by demoting the formula to informative.

### 6. Error code registry — RESOLVED: reuse the append-only `StreamError` discriminants, no separate namespace

Codes 1 and 4–13 are RECOMMENDED for the base surface (code 11 `MathOverflow` was restored to the table — it is produced, contrary to the earlier draft). A separate human-readable namespace was judged too heavy for v1: `docs/ERROR_SURFACE.md` already generates code→message from the enum's doc comments and `error_surface_test.rs` is the CI gate that keeps them in lock-step under the append-only rule (ADR 0003).

### 7. Scope of `StreamCancelled` data — RESOLVED: keep both amounts

`recipient_amount` and `sender_amount` stay in the event so explorers can settle a cancellation from the event log without a state replay, and the §3.3 sum invariant is checkable directly. The amounts are already public in the transaction's token transfer records, so this adds no new disclosure.

---

## What we're asking for

1. **Confirm the minimal scope (three events + two views) still feels right** now that the seven questions are resolved above and in §11–§12 of the draft.
2. **Any objection to a resolved position above** — particularly the topic-layout (2) and error-registry (6) decisions, which trade ABI flexibility for tooling determinism.
3. **Any conflicting or complementary work** we should align with. Are there other teams working on a payment-stream standard for Soroban?
4. **Interest in co-authorship.** If your wallet, explorer, or contract is solving the same problem, we'd like to co-author the formal SEP submission.

We'll incorporate remaining feedback here briefly, then open a PR on `stellar/stellar-protocol` with the revised draft.
