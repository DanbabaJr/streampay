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
  `MetadataTagTooLong` (18) and `MetadataLimitReached` (19), appended.
- `docs/VERIFYING_ATTESTATIONS.md` — the honest scope (attestation, not
  verification) with a worked invoice + hash-check recipe, and
  `scripts/verify_attestation.sh` to check a local document against an attested
  hash. Frontend: stream detail page lists a stream's attestations and lets a
  party attach one.
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
- Generated [`docs/ERRORS.md`](./docs/ERRORS.md) (entrypoint × branch → code
  table) with a CI step that regenerates it and diffs the committed artifact.
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
  `docs/ERRORS.md` documents them like every other branch.
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

### Changed
- **Deployment interface:** the contract now has a constructor. Deploy with
  the governor address as a constructor argument
  (`stellar contract deploy … -- --governor G…`); `scripts/deploy_testnet.sh`
  passes the deployer as governor. Existing v0.3 deployments are unaffected
  (no upgrade path; new deployments only).
- Retired `StreamError::NotStreamSender` (2) and `NotStreamRecipient` (3) as
  unreachable under the append-only policy: the numeric codes are kept and
  reserved, never reused or renumbered.

### Fixed
- Create-form failures decode to `StreamError` names like every other path
  (they were surfaced as raw error strings).

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
