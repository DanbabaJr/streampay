# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Contract storage keys, event shapes, and `StreamError` codes are public
interface: they are only ever appended to, never renumbered or reused.

## [Unreleased]

### Added
- Hash-linked metadata attestations: `attach_metadata(attester, stream_id,
  content_hash, tag)` records who claimed which 32-byte content hash, when, on
  a stream — append-only, indexed by both parties, size-bounded, with a
  `MetadataAttached` event. Read back with `stream_attestations`,
  `attestation_count`, and `party_attestations`. New codes
  `MetadataTagTooLong` (87) and `MetadataLimitReached` (88), appended.
- `docs/VERIFYING_ATTESTATIONS.md` — the honest scope (attestation, not
  verification) with a worked invoice + hash-check recipe, and
  `scripts/verify_attestation.sh` to check a local document against an attested
  hash. Frontend: stream detail page lists a stream's attestations and lets a
  party attach one.
- Two-step rate renegotiation (#54): `propose_rate_change`,
  `accept_rate_change`, `cancel_rate_change`, and the `pending_rate_change` and
  `rate_segments` read views. Either party can propose a new
  `amount_per_second` for the remainder of a live stream; only the named
  counterparty can accept, within a seven-day window. At acceptance the accrued
  balance is priced under the schedule that existed before the change (never
  re-priced), the rest of the window is reserved at the new rate, and the
  difference against the escrow still held is pulled from the sender (increase)
  or refunded to them (decrease) in the same transaction.
- Piecewise accrual: `Stream` streams are now priced as a schedule of
  `RateSegment { start_time, end_time, allocation, basis_seconds }` windows.
  `streamed_amount_at_segments` sums the unchanged pure `streamed_at` over them,
  so an empty schedule is the pre-#54 single-window formula bit-for-bit and a
  renegotiated window — `allocation = rate × window`, `basis_seconds = window` —
  accrues with no division residue at all. `available`, `withdraw`,
  `withdraw_max`, `cancel_stream`, `streamed_at` and `sponsored_withdraw` all
  price the same schedule.
- `PendingRateChange` and `RateSegments` storage keys
  (`DataKey::PendingRateChange(id)`, `DataKey::RateSegments(id)`, both
  appended), one offer per stream and at most `MAX_RATE_SEGMENTS = 32` accepted
  windows per stream, with dedicated TTL maintenance. No stored `Stream` layout
  changed, so no migration is required.
- Append-only `RateChangeProposed` / `RateChangeAccepted` events
  (`stream_id` topic); the acceptance payload carries
  `owed_at_change`, `reserved_at_new_rate`, `adjustment` and the new `deposit`
  as the audit trail of the rebalancing.
- New `StreamError` variants (appended): `NoPendingRateChange` (80),
  `RateProposalExpired` (81), `RateProposalPending` (82), and
  `TooManyRateSegments` (83).
- Reference-model schedule math (`model/src/math.rs`):
  `streamed_at_schedule` (the `u128` floor-division model) and
  `streamed_at_rate_schedule` (a division-free `Σ rate × elapsed` model), used
  as differential oracles rather than as a second reading of contract state.
- New `rate_schedule` fuzz target for segment sequences, and the `conservation`
  target now renegotiates streams inside its random operation sequence and
  re-prices every stored schedule against the reference model. Both are wired
  into `fuzz.yml`, `nightly-fuzz.yml`, `fuzz-campaign.yml` and the campaign /
  coverage scripts.
- `docs/adr/0012-piecewise-rate-schedule-storage.md`, and
  `docs/ARCHITECTURE.md` §3.1 (piecewise math) + §18 (the renegotiation flow,
  storage/TTL and the exactness argument).
- Two-step stream ownership transfer: `propose_ownership_transfer`,
  `accept_ownership_transfer`, `cancel_ownership_transfer`, and the
  `pending_ownership_transfer` read view. Either the sender (payer) or the
  recipient (claimant) can hand their role to a new address; the target must
  accept within a seven-day window. Accounting fields and token balances are
  untouched — only future claim/refund destinations move.
- `PendingOwnership` storage key (`DataKey::PendingOwnership(id)`, appended),
  one proposal per stream, with dedicated TTL maintenance.
- Append-only `OwnershipProposed` / `OwnershipAccepted` events
  (`stream_id` topic).
- New `StreamError` variants (appended): `NoPendingOwnership` (60),
  `OwnershipProposalExpired` (61), `InvalidTransferTarget` (62), and
  `OwnershipProposalPending` (63).
- Frontend (opt-in) **fee-aware claim scheduling**: a recipient can queue a
  signed `withdraw_max` intent and have the client submit it when the Soroban
  inclusion-fee percentile drops under a budget, with a deadline fallback so a
  deferred claim is never abandoned. New `frontend/lib/` modules
  (`fee-stats.ts`, `fee-observer.ts`, `claim-scheduler.ts`, `claim-runtime.ts`,
  `pending-queue.ts`, `use-claim-scheduler.ts`), a settings/queue panel on
  `/stream/[id]`, and `docs/FEE_AWARE_CLAIMS.md` (constraints + decisions
  tables). `pending-queue.ts` is the shared signed-intent queue that the PWA
  offline queue (#48) must reuse.
- Frontend unit + simulation tests (vitest): the claim-scheduler decision
  ladder and a replay of a recorded fee series, committed as snapshot decision
  tables; wired into the frontend CI job.
- `indexer/` TypeScript service that decodes StreamPay Soroban events into a
  cursor-backed SQLite projection and exposes stream-by-id and address stream
  REST endpoints, with local setup/API documentation.
- Scheduled stream intents: `schedule_stream` pre-authorizes one or more
  future stream creations (one-shot or recurring "cron") and escrows
  `(deposit + fee_budget) × occurrences` up front; `execute_scheduled`
  permissionlessly materializes each occurrence and pays the keeper the
  escrowed fee; `cancel_scheduled` (sender, before the window) and
  `reclaim_expired` (anyone, after `expires_at`) refund outstanding escrow;
  `get_intent` / `sender_intents` provide read access. Sender authorization is
  consumed at scheduling time (native Soroban auth) and the exact parameters
  are committed in a SHA-256 `params_hash` so execution cannot be replayed or
  parameter-swapped.
- New `StreamError` codes (append-only): `IntentNotFound` (18),
  `IntentNotPending` (19), `IntentNotYetExecutable` (20), `IntentExpired` (21),
  `IntentNotCancellable` (22), `InvalidScheduleParameters` (23),
  `IntentParamsMismatch` (24), `IntentNotExpired` (25).
- New events: `StreamScheduled`, `ScheduledStreamExecuted`,
  `ScheduledIntentCancelled`, `ScheduledIntentExpired`.
- New storage keys (append-only): `NextIntentId`, `Intent(id)`,
  `SenderIntents(addr)`.
- `scripts/keeper.sh` — reference keeper (explicit ids or sender discovery,
  `--send=no` simulation before sending, `MIN_FEE` gate, optional reclaim).
- `docs/SCHEDULED_INTENTS.md` — keeper guide plus replay / front-running /
  under-funded-keeper griefing threat model and a testnet run log.
- **Optional asset allowlist policy module** (`policy.rs`, issue #75): an
  opt-in, strictly-governed policy module restricting which assets may be used
  in new streams while guaranteeing existing streams of a removed asset remain
  fully withdrawable and refundable (the anti-brick invariant).
- Two-step admin handoff (`policy_propose_handoff` / `policy_accept_handoff` /
  `policy_cancel_handoff`), requiring proposed admin authorization before
  transferring control.
- Timelock on policy changes: allowlist mutations are queued with a timestamp
  (`policy_propose_asset`) and executable only after a configurable delay
  (`policy_timelock_delay`, default 48h), with permissionless execution
  (`policy_execute_asset`) preventing governance hostage situations.
- Append-only policy events: `PolicyInitialized`, `PolicyAssetQueued`,
  `PolicyAssetExecuted`, `PolicyHandoffProposed`, `PolicyHandoffAccepted`,
  `PolicyHandoffCancelled`.
- New `StreamError` variants (appended): `PolicyAssetNotAllowed` (31),
  `PolicyTimelockNotElapsed` (32), `PolicyNoQueuedChange` (33),
  `PolicyNotInitialized` (34), `PolicyNoPendingHandoff` (35).
- Governance failure table and model documentation in `docs/POLICY_GOVERNANCE.md`.
- **Optional protocol-fee treasury** (`treasury.rs`): a fee charged once at
  the deposit boundary of `create_stream` (`deposit × fee_bps / 10_000`,
  floored, sender pays `deposit + fee`). The stream's `deposit` and every
  accrual/payout/cancel computation are unchanged — at `fee_bps = 0` (the
  default) behavior is bit-for-bit identical to v0.3. Protocol cap:
  `MAX_FEE_BPS = 100` (1 %), a hard constant.
- Per-token treasury accounting (`Treasury { charged_total, withdrawn_total }`)
  plus a per-stream fee record (`StreamFee { token, amount }`), written only
  in lockstep with the new append-only events `FeeCharged` (stream_id topic)
  and `FeeWithdrawn` (token topic).
- Withdrawal governance: `__constructor(governor)` binds the treasury
  governor at deploy time (no front-runnable bootstrap); two-step rotation
  (`nominate_governor` / `accept_governor`); governor-gated `set_fee_bps`
  and `withdraw_treasury` (CEI-ordered, bounded by fees collected minus
  fees withdrawn).
- Open verification reads: `treasury_status(token)`, `stream_fee(stream_id)`,
  `total_streams()`, and the bounded paged scan `verify_treasury(token,
  start_id, count)` — proving `fee_total == Σ per-stream fees == Σ FeeCharged
  events` from public reads. `scripts/verify-fees.ts` is a key-less public
  audit script reconciling all three records against any Soroban RPC.
- New `StreamError` variants (appended): `FeeRateTooHigh` (14),
  `NotGovernor` (15), `NoPendingGovernor` (16),
  `InsufficientTreasuryBalance` (17).
- Treasury test suite incl. the decision-table test for fees ×
  cancel-refunds and a seeded property test asserting the verifier always
  agrees across random activity sequences.
- `infra/ttl-sentinel` — an operational sentinel for storage rent and TTLs,
  documented in [`infra/ttl-sentinel/README.md`](./infra/ttl-sentinel/README.md)
  and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §12. It scans every
  storage class (stream, address index, id counter, contract instance, Wasm
  code), reads `liveUntilLedgerSeq`, and alerts on `warn` / `crit` / `expired`
  transitions to console, JSONL and webhook sinks — read-only, no key.
  Extension is a separate, off-by-default component with its own funded key,
  dry-run default and monthly budget meter. The same module projects rent from
  measured entry sizes (504 B per stream) against the CAP-0066 fee curve, as
  input for the upcoming pricing/dust work.
- Recorded per-class worst-case cliffs derived from the contract's actual
  extension behavior: 200,000 ledgers for streams and index entries,
  **4,095 ledgers (~5.7 h) for the id counter, the contract instance and the
  Wasm code entry**, none of which the contract ever extends (invocations do
  not auto-extend instance/code entries). A schedule whose warning would land
  outside its class cliff now fails validation instead of shipping.
- Error-surface instrumentation and a generated test matrix
  (`error_surface_test.rs`): every `(entrypoint, condition)` rejection branch is
  registered in `src/surface.rs`, probed for its declared `StreamError`, and
  checked for coverage — CI fails on any error code with zero reachable
  branches or any branch without a code.
- Generated [`docs/ERROR_SURFACE.md`](./docs/ERROR_SURFACE.md) (entrypoint × branch → code
  table) with a CI step that regenerates it and diffs the committed artifact.
- Recipient-initiated dispute flow (#55): `raise_dispute` (bonded flag that
  freezes `cancel_stream`/`top_up` for a 7-day timelock), sender-only
  `resolve_dispute` (accept: bond refunded + pro-rata unwind; reject: bond
  slashed to the sender, stream resumes), permissionless `expire_dispute`
  (bond split 50/50, stream resumes), plus `get_dispute` /
  `required_dispute_bond` views. Anti-griefing bond = 5% of the deposit
  scaling linearly per dispute round on the stream; accrued withdrawals and
  accrual are never frozen. New events `DisputeRaised` / `DisputeResolved` /
  `DisputeExpired`; new `StreamError` codes `DisputeActive` (80),
  `DisputeNotFound` (81), `DisputeNotExpired` (82), each wired into the
  `surface.rs` branch registry with matrix probes. Covered by unit/property
  tests (incl. the locks-plus-outstanding-bonds balance invariant) and a new
  `dispute_bond` fuzz target. `docs/ARCHITECTURE.md` §8 documents the freeze
  policy and griefing-threshold math.
- **Gas sponsorship** (`sponsor.rs`, issue #57): sponsors pay transaction
  costs for recipients claiming accrued funds. Soroban has no mempool
  relayer, so authorization is carried *inside* the call: any account
  submits `sponsored_withdraw` and pays the network fee, while consent is
  two ed25519 signatures (sponsor operator key + enrolled beneficiary key)
  over the SHA-256 digest of a canonical XDR message (domain tag
  `StreamPay/sponsored-withdraw/v1`, contract, sponsor, beneficiary, token,
  stream id, amount, nonce, deadline). Per-sponsor period caps,
  per-beneficiary caps with rolling windows, one-shot nonces, sponsor
  pause/resume and instant operator-key rotation; an invalid signature
  traps before any nonce or budget state is consumed.
- Sponsor entrypoints: `register_sponsor`, `set_sponsor_active`,
  `rotate_operator_key`, `enroll_beneficiary`, `sponsored_withdraw`, plus
  open reads `get_sponsor`, `get_beneficiary_public_key`,
  `sponsor_period_spend`, `beneficiary_spend`. New `StreamError` variants
  (appended): `SponsorNotFound` (21), `SponsorInactive` (22),
  `BeneficiaryNotEnrolled` (23), `ClaimExpired` (24), `ClaimNonceReplay`
  (25), `SponsorBudgetExceeded` (26), `BeneficiaryBudgetExceeded` (27);
  the dispute-flow codes append at 80–82 after the governance block.
- Frontend "Claim for free" path (`frontend/lib/sponsor.ts` + stream detail
  page): builds and signs the exact intent the contract verifies, posts it
  to the sponsor relay, and discloses who pays and how much budget remains;
  falls back to a self-paid claim when no sponsor covers the stream's
  token. JS ↔ Rust wire parity is pinned by frozen vectors on both sides
  (`canonical_relay_message_has_a_frozen_wire_form` / `lib/sponsor.test.ts`).
- Sponsorship docs: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §13
  (mechanism, message layout, check order, relay contract, rejected
  alternatives) and [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) §12
  (budget-drain griefing, signature interception, replay).
- Distinct `StreamError` codes for token-transfer failures, appended after
  the scheduled-intent codes (18–25): `DepositTransferFailed` (26),
  `TopUpTransferFailed` (27), `RecipientPayoutFailed` (28),
  `SenderRefundFailed` (29), and — for the fee-treasury payout path added
  above — `TreasuryPayoutFailed` (30). Every token call now runs through the
  SDK's fallible (`try_`) client and any failure — missing allowance/balance,
  an asset that refuses transfers, a non-SEP-41 callee — is re-raised as its
  own StreamPay code, because contract error numbers share the
  `Error(Contract, #N)` namespace and a token's `#5` could otherwise
  masquerade as StreamPay's `StreamNotActive`. The mapped error is still
  returned as `Err`, so the whole invocation (effects + events) rolls back —
  CEI ordering and atomicity are unchanged.
  Each token-side rejection is registered as a `surface::reject` branch
  (`CreateDepositTransferFailed`, `TopUpTransferFailed`,
  `RecipientPayoutFailed`, `SenderRefundFailed`, `TreasuryPayoutFailed`), so
  the generated error-surface matrix probes every one of them and
  `docs/ERROR_SURFACE.md` documents them like every other branch.
- Non-native asset tests, end to end: full lifecycle
  (create → top-up → withdraw → withdraw_max → cancel) against a registered
  Stellar Asset Contract with supply conservation, allowance/balance pull
  failures on that SAC, and a token that refuses transfers per leg (its error
  code deliberately equals 13 to prove no leak), each asserting the distinct
  code plus state, balance, and event rollback. New error codes documented in
  `src/errors.rs` and `docs/ARCHITECTURE.md` §7.
- Frontend asset selector on the create form: **native XLM** or an entered
  token contract id. Native resolves to the network's Stellar Asset Contract
  (`stellar contract id asset --asset native`; overridable via
  `NEXT_PUBLIC_NATIVE_XLM_CONTRACT_ID`), contract ids are validated before a
  transaction is built, and streams on the native SAC are labelled "XLM" in
  the list and detail views. `stellar.ts` also maps the new error codes to
  names.
- Create/top-up now read the token's `allowance` first and ask Freighter to
  sign `token.approve` only when it is short — previously the form promised
  this but no approval was ever sent, so every first stream failed at
  simulation.
- Governed release pipeline (`sandbox → testnet → mainnet canary`):
  `.github/workflows/promote.yml` (manual dispatch, GitHub
  Environment-gated approvals, digest continuity at every step, automatic
  rollback job) and `.github/workflows/rehearsal.yml` (secret-free dress
  rehearsal, mocked deploys). New scripts under `scripts/`:
  `release_gates.sh`, `verify_release_digest.sh`,
  `contract_interface_hash.sh`, `schema_diff.sh`, `deploy_contract.sh`,
  `canary_check.sh`, `record_promotion.sh`, `rollback_mainnet.sh`,
  `promote_rehearsal.sh`, `lib.sh`.
- Append-only deployment records in `deployments/` (promotion log, per-run
  records, per-environment contract-interface baselines) and the design +
  operator docs `docs/DEPLOY_PIPELINE.md` and `docs/CANARY_RUNBOOK.md`.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §13–§14: the append-only
  public-interface rules (storage keys, event shapes, error codes — current
  tail 17) and the Soroban traps we've hit, each re-verified against the
  current toolchain: `extend_ttl` panics `Error(Storage, MissingValue)` on
  never-written keys (read paths existence-check first), `#[contractimpl]`
  signatures are syntactic (type aliases produce undefined spec types), and
  sdk-28 rejects plain `cargo build` for Wasm (requires `stellar contract
  build`). Linked from the README and CONTRIBUTING.

### Changed
- `hot_path_footprint_harness` instruction budgets were re-measured and raised
  (`create_stream` 560k / `withdraw` 370k / `cancel_stream` 545k /
  `withdraw_max` 375k, plus a new 415k budget for `withdraw` on a renegotiated
  stream): reading the rate schedule from its own key costs one extra persistent
  lookup on every accrual path even for a stream that never renegotiated. The
  trade-off, and why the alternative (a field on `Stream`) was rejected, is
  recorded in `docs/FOOTPRINT.md` Candidate 5 and ADR-0012.
- **Contract Wasm size (#58):** the deployed binary shrinks from 91,004 B to
  60,386 B (59.0 KiB, under the new 60 KB CI budget). Doc comments on
  interface items are no longer embedded into `contractspecv0` on-chain
  (kept 1:1 for host rustdoc via `cfg_attr`), and the duplicated
  stream-creation effects leg is consolidated into one helper. No storage,
  event, error-code or signature change; the deploy digest and the
  canonical interface hash do change — see `docs/WASM_SIZE.md` for the
  operator notification procedure. Merged with `main` (ownership transfer)
  the binary is 64,143 B: upstream's new interface adds 3,757 B on top of the
  60,386 B this work reached, and every remaining non-interface lever was
  measured at 0 B or negative. The CI budget is therefore raised deliberately
  to the smallest whole KB the current interface fits (63 KB, 369 B of
  headroom), with `docs/WASM_SIZE.md` recording why and naming the next
  entrypoint addition as the trigger to revisit the contract split. Merging
  the governance timelock then took the build to 84,682 B, because its new
  interface items arrived with plain `///` docs again; re-applying Technique 1
  with the new `scripts/gate_interface_docs.py` probe (55 doc groups, and four
  entrypoints whose doc blocks the merge had duplicated) recovers 6,416 B and
  lands the binary at **78,266 B**, 14,123 B of which is governance's code,
  spec entries, event symbols and exports. The scan now runs as a CI step
  ("Interface doc strings stay out of the Wasm spec") so the rule cannot regress
  again, and the budget moves 63 → **77 KB** (582 B of headroom) under the same
  rule.
- **Deployment interface:** the contract now has a constructor. Deploy with
  the governor address as a constructor argument
  (`stellar contract deploy … -- --governor G…`); `scripts/deploy_testnet.sh`
  passes the deployer as governor. Existing v0.3 deployments are unaffected
  (no upgrade path; new deployments only).
- Retired `StreamError::NotStreamSender` (2) and `NotStreamRecipient` (3) as
  unreachable under the append-only policy: the numeric codes are kept and
  reserved, never reused or renumbered.
- **Generated-artifact gates:** the three "committed output matches its source"
  CI checks now all call `scripts/check_generated.sh`, which regenerates and
  then fails on drift *including newly created untracked files*. The
  differential-vector step previously regenerated the corpus without diffing
  it, so a stale committed corpus passed. Locally: `npm run generated:check`.
- `docs/ERRORS.md` → `docs/ERROR_SURFACE.md`. It differed from the generated
  `docs/errors.md` by case alone, which is invisible on macOS/Windows
  filesystems and made renames and checkouts ambiguous. No on-chain surface
  changed; the error catalog regenerated accordingly (content-derived
  `schema_fingerprint` moved with the doc-comment references).
- `.gitattributes` pins `.rs/.md/.ts/.tsx/.mjs/.json` to LF so generated
  artifacts and their sources are byte-stable on a `core.autocrlf=true`
  checkout (CRLF in committed blobs has already broken the catalog's content
  hash once — `a3af379`), and `scripts/check_line_endings.sh` + a CI step fail
  on any blob committed with CRLF, naming the files and the fix.
- **Failure actionability.** The gates that fail most often now say what to do
  instead of just exiting 1:
  - `scripts/check_error_codes.sh` (Contract job, *first* step, no toolchain
    needed) reads the `StreamError` enum and reports duplicated codes, duplicate
    variant names, and gaps as `file`/`line` annotations, printing the highest
    code in use and the next free one. The collision two contributor PRs hit when
    both append "the next free code" is `E0081` four minutes into a build; here it
    is a one-line message in seconds — and on a PR event the merge ref already
    contains both sides. It then checks the `surface.rs` registry the same way the
    contract's matrix test does: a code no `Branch` maps to (and that is not in
    `RETIRED_CODES`) and a `Branch::…` name used without being declared — the two
    shapes of the otherwise-unexplained red `Devcontainer — wasm build` check.
  - `scripts/check_docs_links.mjs` emits each broken link/anchor as a workflow
    annotation that names the closest existing paths (`did you mean
    ./ERROR_SURFACE.md?`) and flags case-only matches, which resolve on
    macOS/Windows checkouts and fail on Linux CI.
  - The Contract job's Format check regenerates the formatting and uploads it as
    the `fmt-fix-*` artifact, so a contributor without a local Rust toolchain can
    `git apply fmt-fix.patch` instead of guessing at rustfmt's diff.
  - The devcontainer Wasm step explains that it runs no fmt, clippy or test steps, so
    its failure is the *compile* signal even when the Contract job stopped at a
    formatting complaint.
  - `cargo-deny` and the frontend `npm audit` steps each gained a follow-up step
    that fires only on their own outcome (`steps.<id>.outcome`) and says how to
    tell "a dependency you added" from "an advisory main already carries" —
    the second case has turned every open PR red before (`d282de1`) and invites a
    force-downgrade of a package the contributor never came to change.
- `npm run codes:check` and `npm run links:check` were added and are chained into
  `npm run matrix`, so the CI gate list and the local pre-flight are the same
  commands (CONTRIBUTING and the PR template name them).

### Fixed
- Error-catalog pages linked their "Regression / Coverage Probe" to test function
  names that do not exist (`error_surface_test.rs::stream_not_found` and ~50
  others), so auditors followed dead links and the docs lint warned on every CI
  run. Probes are now *derived* from `surface.rs::Branch::error()` — the registry
  the coverage test itself walks — with the reachability proof linked separately,
  and generation fails if any emitted symbol does not resolve, so a catalog
  cannot ship a dead link again.
- Create-form failures decode to `StreamError` names like every other path
  (they were surfaced as raw error strings).
- `follow-redirects` 1.16.0 → 1.16.1 in `frontend/package-lock.json`. Two
  high-severity advisories published 2026-10-20 (`GHSA-q3jh-wrc6-jgq8`,
  `GHSA-8r9p-f939-6h3c`) cover `>= 1.16.0, < 1.16.1`, which turned
  `npm audit --omit=dev --audit-level=high` red on every open pull request —
  including the ones that touched no dependency. The package is transitive
  (`@stellar/stellar-sdk` → `axios` → `follow-redirects`) and 1.16.1 already
  satisfies the `^1.16.0` range axios declares, so this is a re-resolve of the
  lockfile rather than an upgrade, and unlike the 0.3.0 `postcss`/`toml` case it
  needed no `overrides` pin.
- `rustls-webpki` 0.103.15 → 0.103.16 and `webpki-roots` 1.0.9 → 1.0.10 in
  `Cargo.lock`. `RUSTSEC-2026-0382` and `RUSTSEC-2026-0381` (both published
  2026-10-20) cover the emSign roots whose private keys are now public, and they
  reach the workspace transitively through `reqwest` from `streampay-state`, so
  the Security job's `cargo deny check` went red on every open pull request.
  Both patches are in-range, so `cargo update -p` for each is a four-line lock
  re-resolve — no crate added, no other crate moved, and no `deny.toml` ignore
  entry needed.

## [0.3.0] - 2026-10-04

### Changed
- `soroban-sdk` 27 → 28. Its build script now requires the stellar-cli
  toolchain, so contract Wasm is built with `stellar contract build`
  (stellar-cli ≥ 25.2) in CI, the release workflow, and the deploy script
  instead of plain `cargo build --target wasm32v1-none`. Artifact name and
  location are unchanged.
- Frontend upgraded to Next.js 16 and `eslint-config-next` 16; linting
  moved to ESLint flat config (`eslint.config.mjs`) since Next 16 removes
  `next lint`. ESLint stays on the 9.x line (10 is incompatible with the
  current plugin chain).
- `@stellar/stellar-sdk` 14 → 17 and `@stellar/freighter-api` 4 → 6 —
  verified against the app's RPC and signing call sites.
- CI actions bumped (checkout v7, setup-node v7, action-gh-release v3).

### Fixed
- `deny.toml` rewritten against the cargo-deny 0.20 schema (the previous
  file failed to parse, so the gate never actually ran); the `paste`
  "unmaintained" advisory is ignored with written justification and the
  redundant cargo-audit step removed in favor of cargo-deny as the single
  advisory gate.
- Dependency audit CI now covers production dependencies
  (`npm audit --omit=dev --audit-level=high`); `postcss` and `toml` are
  pinned to patched versions via npm `overrides` to clear the two high
  advisories reachable through `next` and `@stellar/stellar-sdk`.

## [0.2.0] - 2026-10-04

### Added
- On-chain address discovery indexes: `recipient_streams` and
  `sender_streams` paginated views (append-only id lists per address,
  creation-ordered, `MAX_PAGE_SIZE = 50`).
- `withdraw_max(stream_id) -> i128` — atomically claim the full accrued
  balance in one call (no read-then-withdraw race).
- New `StreamError::NothingToWithdraw` (code 13, appended).
- `fuzz/` cargo-fuzz harness for the pure accrual math (`streamed_at`),
  with scheduled CI runs (non-blocking).
- Supply-chain CI: `cargo deny` + `cargo audit`, `npm audit`, coverage
  summary, Dependabot (cargo, npm, actions).
- Frontend ESLint gate in CI; stream persistence across sessions;
  `withdraw max` action; on-chain stream discovery via the new indexes.
- Governance: CODEOWNERS, FUNDING.yml, code of conduct, release workflow
  publishing a reproducible Wasm build with SHA-256 digests.
- `scripts/deploy_testnet.sh` one-command testnet demo + `docs/DEMO.md`.

### Changed
- `withdraw` internals refactored into shared CEI-ordered payout path
  (`authorize_withdrawal` + `pay_out`); behavior is unchanged — all
  pre-existing tests pass unmodified.
- Contract crate now also builds as `rlib` (for the fuzz harness); Wasm
  output is unaffected.

## [0.1.0] - 2026-09-13

The initial contract + frontend release, published before git tagging was
adopted (no `v0.1.0` tag exists; tagging begins with `v0.2.0`).

### Added
- Core contract: `create_stream`, `withdraw`, `cancel_stream`, `top_up`,
  `get_stream`, `available` — linear per-second streams with checked
  `u128` math, typed errors (no panics), CEI ordering, TTL maintenance.
- 40 unit + property tests with committed snapshots.
- Minimal Next.js + Freighter frontend (create, list, withdraw, top up,
  cancel).
- CI: test / fmt / clippy(-D warnings) / Wasm build; frontend
  typecheck / build.
- Docs: README, ARCHITECTURE.md, GOOD_FIRST_ISSUES.md, CONTRIBUTING.md,
  SECURITY.md. Apache-2.0.

[Unreleased]: https://github.com/Neziahtech/streampay/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Neziahtech/streampay/releases/tag/v0.3.0
[0.2.0]: https://github.com/Neziahtech/streampay/releases/tag/v0.2.0
[0.1.0]: https://github.com/Neziahtech/streampay/releases
