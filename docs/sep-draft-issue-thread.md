# Community Discussion: SEP Draft — Streaming Payment Events and Discovery Indexes

*This document is the intended GitHub issue body and seed discussion thread for the SEP draft at `docs/sep-draft-stream-events.md`. Post it as a GitHub issue on the `stellar/stellar-protocol` repository before submitting the formal SEP PR.*

---

## Issue body

**Title:** `[SEP Draft] Standard events and discovery indexes for Soroban payment streams`

We are proposing a SEP that standardises the minimal on-chain interface needed for wallets and explorers to support **linear payment streams** generically, without bespoke per-contract integration.

The full draft is in this repository at [`docs/sep-draft-stream-events.md`](./sep-draft-stream-events.md). Here is a summary of the key decisions and the questions we'd like community input on before submitting upstream.

---

### What the SEP covers

Three required lifecycle events (`StreamCreated`, `Withdrawn`, `StreamCancelled`), two paginated discovery views (`sender_streams`, `recipient_streams`), and a `get_stream` state read. That's the entire normative surface.

Everything else — protocol fees, deposit top-ups, pause/resume, cliff vesting, milestones — is explicitly optional or out of scope.

### What it deliberately excludes

- **Pause / resume**: StreamPay doesn't implement pause. Including it in the required surface would either lock out simpler contracts or force them to implement a stub. Documented as an optional extension.
- **Milestones and cliff vesting**: These are non-linear accrual schedules. The event shape stays the same (same lifecycle transitions); only the formula changes. The SEP leaves the formula open so non-linear schedules are conformant.
- **Protocol fee governance**: The fee model is one deployment's policy choice, not a protocol primitive. The `FeeCharged` optional event schema is included as a courtesy for explorers, but nothing about fee governance is required.
- **`withdraw_max`**: This is a convenience entrypoint, not a protocol primitive. Conformance doesn't require it; its behaviour is fully derivable from `get_stream` + `withdraw`.

### Reference implementation

[`contracts/streaming-payments/`](../contracts/streaming-payments/) — Soroban SDK v28, Rust. Every normative requirement in the SEP maps directly to existing code; nothing in the reference implementation had to be changed to conform.

---

## Seed discussion points

The following are the decisions we are least certain about and most want community feedback on:

### 1. Event name casing

We used `PascalCase` for event names (`StreamCreated`, not `stream_created`) to match the Rust struct names and the `#[contractevent]` macro output. Is there a community convention emerging for Soroban event names? Should we standardise on `snake_case` symbols?

### 2. Topic layout

We put `stream_id` in topic[1] (topic[0] is the event name symbol). This means an event-streaming client can subscribe to all events of a given contract and filter by stream id. An alternative is to also put `sender` or `recipient` in a topic, enabling cross-contract subscriptions filtered by address. The tradeoff: Soroban events allow at most 4 topics total, and using them all for discovery reduces the data payload's flexibility. What indexing patterns do wallet and explorer teams actually use?

### 3. `i128` vs `u128` for amounts

We use `i128` throughout (matching the Soroban token contract interface). Strictly speaking, amounts are always non-negative; `u128` would be more semantically precise. The reason for `i128`: the Soroban SDK's `token::TokenClient::transfer` signature uses `i128`, and using a different type would require pervasive casts. Is there a preferred convention here?

### 4. Mandatory `total_streams` vs optional

We marked `total_streams()` as SHOULD rather than MUST because it's primarily useful for verification tools rather than wallets. Should it be MUST? Without it, a verifier cannot know when to stop paginating. An alternative is requiring that `sender_streams` / `recipient_streams` report whether the next page exists (a `has_more: bool`), which is a bigger interface change.

### 5. Accrual formula normative or informative?

The draft specifies the linear formula as normative for contracts that don't document a different schedule. An argument for making it informative: the SEP's value is the event shape and discovery interface, not the accrual math. The accrual formula is derivable from `deposit`, `start_time`, `end_time`, and ledger time — wallets can recalculate it locally. Counter-argument: if a conformant contract uses a different formula without documenting it, a wallet will display incorrect balances. Thoughts?

### 6. Error code registry

The SEP recommends a set of error codes but does not require them. Should there be a registered namespace (similar to SEP-0001's field registry) so that cross-contract tooling can display human-readable errors generically? Or is this too heavy for a first version?

### 7. Scope of `StreamCancelled` data

The `StreamCancelled` event includes both `recipient_amount` and `sender_amount`. An explorer can reconstruct these from state, but including them in the event makes the event self-contained. Are there privacy or data-minimisation concerns with publishing both amounts in the event? (On-chain data is public regardless, but event indexing is cheaper than state replay.)

---

## What we're asking for

1. **Does the minimal scope (three events + two views) feel right?** Too narrow to be useful? Too broad?
2. **Feedback on the seven open questions above.**
3. **Any conflicting or complementary work** we should align with. Are there other teams working on a payment-stream standard for Soroban?
4. **Interest in co-authorship.** If your wallet, explorer, or contract is solving the same problem, we'd like to co-author the formal SEP submission.

We'll incorporate feedback here for two to four weeks, then open a PR on `stellar/stellar-protocol` with the revised draft.
