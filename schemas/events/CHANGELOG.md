# Event schema changelog

Append-only record of event-schema evolution. The CI compatibility gate
(`scripts/event_compat_check.mjs`) requires **every added event or field** to
be mentioned here — by event struct name and field name — before the PR can
merge. Breaking changes are rejected outright; they need a governed
v1 → v2 migration (see [README.md](README.md#versioning-v1--v2-coexistence)).

## v1.0.7 — 2026-11-26 (dust economics and the stale-stream sweeper, #78)

One additive event; no existing event changed shape (entry count 62 → 63).

- `StreamSwept`: added event (topic `stream_id:u64`, data `refund_target`, `depleted`, `entries_removed`) — emitted by the permissionless `sweep_stream` when it deletes a finished (`Depleted` or `Cancelled`), unencumbered stream's storage at least `SWEEP_GRACE_SECONDS` after its `end_time`. No tokens move: `refund_target` names the party the stream's remainder already went to, `depleted` is false for a cancelled stream, and `entries_removed` counts the per-stream persistent entries deleted. See [docs/DUST_ECONOMICS.md](../../docs/DUST_ECONOMICS.md).

## v1.0.6 — 2026-11-24 (`main` repair #697: session-key, commit-reveal and insurance surfaces withdrawn)

Eight registry entries disappear (entry count 70 → 62): `AgentAuthorized` and
`AgentRevoked` (added in v1.0.5 by #660), plus `PolicyViolation`, `PowerAccrued`,
`PremiumAccrued`, `SenderPolicyRevoked`, `SenderPolicySet` and `VoteCast` (added
by #626, whose registry regeneration landed without a changelog entry — recorded
here so the count is auditable).

A third surface is withdrawn without any registry change: #677's commit-reveal
claims emitted `ClaimCommitted`, `ClaimRevealed` and `ClaimExpired`, but `main`'s
registry never carried those entries, so deleting `commit_claim`, `reveal_claim`,
`expire_reveal` and `get_claim_commitment` removes shapes that were never
published.

All three withdrawals share one reason: the tree they produced measured 140,693
bytes of contract code, past Soroban's 131,072-byte limit, so no build of `main`
containing them could be deployed and nothing shipped ever emitted these events.
#626 additionally drained the insurance pool on an unauthenticated path. Each
removal carries a grant in [removals.json](removals.json); `v0.2.0`/`v0.3.0` hold
none of these shapes, so no v1 → v2 coexistence is needed. Re-landing any of
these designs needs its own contract — see
[docs/WASM_SIZE.md](../../docs/WASM_SIZE.md).

## v1.0.5 — 2026-11-21 (session-key delegation, #660)

> Superseded by v1.0.6: these two events were withdrawn with the delegated-agent
> entrypoints that emitted them.

Two additive events; no existing event changed shape (entry count 62 → 64).
Both carry the positional topics `stream_id:u64` and `agent:Address`:

- `AgentAuthorized`: added event (data `max_per_period`, `max_per_stream`, `period_duration`, `expires_at`) — emitted by `authorize_agent` when a recipient delegates withdrawal rights to a session key under explicit caps and an expiry.
- `AgentRevoked`: added event (data `revoked_by`) — emitted by `revoke_agent` when the recipient withdraws that delegation.

## v1.0.4 — 2026-11-20 (receivables advances, release conditions, stream templates and callback hooks, #620)

Eleven additive events; no existing event changed shape (entry count 51 → 62).

- `AdvanceDrawn`: added event (topic `stream_id:u64`, data `recipient`, `lender`, `amount`, `fee`, `repayment_bps`) — emitted when `draw_advance` lends against a recipient's unaccrued stream value.
- `AdvanceRepaid`: added event (topic `stream_id:u64`, data `recipient`, `lender`, `amount`, `remaining_owed`) — emitted when `repay_advance` settles part or all of an outstanding advance.
- `AdvanceLiquidated`: added event (topic `stream_id:u64`, data `recipient`, `lender`, `amount`, `remaining_unpaid`) — emitted when a cancellation intercepts the refund to settle an advance that outlived its stream.
- `ConditionRegistered`: added event (topic `stream_id:u64`, data `condition_id`) — emitted when `register_condition` attaches an oracle-attested release predicate to a stream.
- `ConditionMet`: added event (topic `stream_id:u64`, data `condition_id`) — emitted when quorum attestations satisfy a registered condition and the release gate opens.
- `ConditionExpired`: added event (topic `stream_id:u64`, data `condition_id`) — emitted when a condition passes its horizon unmet and stops gating withdrawals.
- `TemplateApproved`: added event (topic `template_id:u32`, data `version`, `token`, `duration`) — emitted when an admin approves a template revision for instantiation.
- `TemplateInstantiated`: added event (topic `template_id:u32`, data `version`, `stream_id`, `sender`, `recipient`, `deposit`) — emitted when `instantiate_template` opens a stream from an approved template, recording the lineage edge.
- `HookRegistered`: added event (topic `stream_id:u64`, data `event_class`, `callback_contract`, `selector`) — emitted when a stream attaches a post-action callback to an event class.
- `HookInvoked`: added event (topic `stream_id:u64`, data `event_class`, `callback_contract`) — emitted after the hook-bearing action's state is committed and the callback ran successfully.
- `HookFailed`: added event (topic `stream_id:u64`, data `event_class`, `callback_contract`, `error_code`) — emitted when a callback traps; the guarded action's fate follows the hook's failure policy.

## v1.0.3 — 2026-10-25 (stream pause / resume, issue #24)

Two additive events; no existing event changed shape (entry count 49 → 51).
Both carry the positional topic `stream_id:u64`:

- `StreamPaused`: added event (key `stream_paused`, data `paused_at`) — emitted
  by `pause_stream` with the stream-clock time accrual froze at.
- `StreamResumed`: added event (key `stream_resumed`, data `new_end_time`) —
  emitted by `resume_stream` with the window's `end_time` after it shifted by
  the paused length.

## v1.0.2 — 2026-10-24 (six events for schema versioning, sender transfer, refund routing and batch claiming)

Six events are newly published by `contracts/streaming-payments/src/events.rs`;
the registry was regenerated from this tree, so the entry count goes 43 → 49 and
**no existing event changed shape**. Each is additive: consumers that ignore
unknown event types and unknown keys keep decoding everything they knew before.

- `StreamRecordMigrated`: added event (topic `stream_id`, data `from_version`,
  `to_version`) — emitted when `migrate_stream_version` re-encodes one stream's
  record under a new layout version (#202).
- `SenderTransferProposed`: added event (topic `stream_id`, data `sender_from`,
  `new_sender`, `nonce`, `expires_at`, `transfer_refund_rights`) — emitted when
  the sender offers the payer role to a new address (#201).
- `SenderTransferred`: added event (topic `stream_id`, data `sender_from`,
  `sender_to`, `nonce`, `refund_rights_transferred`) — emitted when the
  recipient's consent completes the hop (#201).
- `SenderTransferExpired`: added event (topic `stream_id`, data `sender_from`,
  `new_sender`, `nonce`) — emitted when anyone reclaims a proposal whose consent
  window lapsed (#201).
- `StreamRefundTargetChanged`: added event (topic `stream_id`, data
  `previous_target`, `new_target`, `at_creation`) — emitted when a stream's
  cancellation remainder is routed to a designated address, at creation or by
  amendment (#204).
- `BatchWithdrawSummary`: added event (topic `recipient`, data `settled`,
  `total`, `requested`, `skipped`) — emitted once after a `withdraw_many` batch
  settles, alongside the unchanged per-stream `Withdrawn` events (#205).

`BatchWithdrawSummary.settled` is the first event field whose type is a
`Vec` of a contract struct; that struct, `WithdrawOutcome { stream_id, amount }`,
is added to the registry as a definition alongside `StreamPolicy` and
`OwnershipRole`. The catalogue in [`docs/EVENTS.md`](../../docs/EVENTS.md) and
the generated `indexer/src/generated/events.ts` /
`frontend/lib/generated/events.ts` now cover all 49 events.

## v1.0.1 — 2026-10-24 (registry regenerated from main `44b2049`)

Five events that `contracts/streaming-payments/src/events.rs` already declares
and publishes were absent from the committed registry: it was generated before the
dispute-bond and rate-schedule work landed on main, so `registry.json` carried 38
entries against 43 `#[contractevent]` structs — which is why the in-crate
`registry_matches_contract_event_structs` pin test and
`bash scripts/check_generated.sh events` were both red. Regenerating adds them;
**no existing event changed shape**, so every v1 fingerprint from the baseline is
still byte-for-byte what consumers decode. The five, each with the positional
topic `stream_id:u64`:

- `DisputeRaised`: added event (key `dispute_raised`, data `recipient`, `bond`,
  `expires_at`) — emitted by `raise_dispute`.
- `DisputeResolved`: added event (key `dispute_resolved`, data `sender`, `accept`,
  `bond`) — emitted by `resolve_dispute`.
- `DisputeExpired`: added event (key `dispute_expired`, data `recipient`, `bond`,
  `sender_share`, `recipient_share`) — emitted when an unresolved dispute matures.
- `RateChangeProposed`: added event (key `rate_change_proposed`, data
  `proposed_by`, `counterparty`, `amount_per_second`, `expires_at`) — emitted by
  the rate-change proposal path.
- `RateChangeAccepted`: added event (key `rate_change_accepted`, data
  `accepted_by`, `new_amount_per_second`, `effective_from`, `owed_at_change`,
  `reserved_at_new_rate`, `adjustment`, `deposit`) — emitted when a proposed rate
  takes effect.

Indexer and frontend decode these from the regenerated
`indexer/src/generated/events.ts` / `frontend/lib/generated/events.ts`; the
catalogue in [`docs/EVENTS.md`](../../docs/EVENTS.md) now lists all 43. (Note for
the record: the `## v1.0.0` entry below says "all 33 events"; the registry
generated at that commit already held 38, and holds 43 after this refresh.)

## v1.0.0 — 2026-10-20

Initial registry (issue #213): all 33 events emitted by
`contracts/streaming-payments` are catalogued with topic layout, data fields,
JSON Schemas (`v1/events/`) and a flat fingerprint table
(`registry.json`). Two contract types are referenced by event fields and so are
versioned here: the `StreamPolicy` struct (`StreamPolicySet`) and the
`OwnershipRole` enum, which the ownership-handoff events encode as a variant
symbol. No shape change was made by the registry work itself — every
fingerprint is the event the contract already emits.

<!--
Add new entries here, newest first (immediately above `## v1.0.0`). Format
(what the gate greps for):

- `StreamCreated`: added field `memo` (`Address`) — consumers should ignore
  unknown keys; see <PR link>.
-->
