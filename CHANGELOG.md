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
  `MetadataTagTooLong` (14) and `MetadataLimitReached` (15), appended.
- `docs/VERIFYING_ATTESTATIONS.md` — the honest scope (attestation, not
  verification) with a worked invoice + hash-check recipe, and
  `scripts/verify_attestation.sh` to check a local document against an attested
  hash. Frontend: stream detail page lists a stream's attestations and lets a
  party attach one.
- Error-surface instrumentation and a generated test matrix
  (`error_surface_test.rs`): every `(entrypoint, condition)` rejection branch is
  registered in `src/surface.rs`, probed for its declared `StreamError`, and
  checked for coverage — CI fails on any error code with zero reachable
  branches or any branch without a code.
- Generated [`docs/ERRORS.md`](./docs/ERRORS.md) (entrypoint × branch → code
  table) with a CI step that regenerates it and diffs the committed artifact.

### Changed
- Retired `StreamError::NotStreamSender` (2) and `NotStreamRecipient` (3) as
  unreachable under the append-only policy: the numeric codes are kept and
  reserved, never reused or renumbered.
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
