# Architecture Decision Records (ADRs)

This directory documents the significant architectural and design decisions made throughout StreamPay's evolution.

## What is an ADR?

An Architecture Decision Record (ADR) is a lightweight, immutable document that records a software design choice along with its context, considered options, decision drivers, and consequences.

### Immutability & Lifecycle

Once an ADR is marked **Accepted**, it is **immutable**. It serves as a historical record of why the decision was made under the constraints that existed at that time.

If an architectural decision changes later:
1. The original ADR is **NOT** rewritten.
2. A new ADR is created describing the new context and decision.
3. The original ADR's status is updated to `Superseded by ADR-XXXX` (linking to the replacement record).
4. The new ADR references the superseded ADR.

Allowed statuses:
- **Proposed:** Under active review by contributors.
- **Accepted:** Approved and implemented in the repository.
- **Accepted (backfilled)**: Approved and established in code, backfilled retroactively.
- **Rejected:** Considered and decided against.
- **Superseded by commit or ADR:** Replaced by a subsequent decision or commit (e.g. `Superseded by commit [8ac0d12](https://github.com/Neziahtech/streampay/commit/8ac0d12a4b77309fde0de1ac0fc347747d83efca)` or `Superseded by [ADR-0009](./0009-eslint-9-pinning.md)`).
- **Deprecated:** No longer relevant or active.

## Index of Architectural Decisions

| Number | Title | Status | Date | Decision Summary |
| :---: | :--- | :---: | :---: | :--- |
| [0001](./0001-record-architecture-decisions.md) | Record Architecture Decisions | Accepted | 2026-10-17 | Adopt numbered, immutable ADRs with automated CI link and structure checks. |
| [0002](./0002-cei-first-payouts.md) | CEI-First Payouts and Reentrancy Protection | Accepted (backfilled) | 2026-09-13 | Enforce Checks-Effects-Interactions before external token calls to prevent reentrancy drain. |
| [0003](./0003-append-only-interface.md) | Append-Only Interface for Error Codes and Indexes | Accepted (backfilled) | 2026-09-13 | Retain monotonic error codes and append-only address indexes for client ABI stability. |
| [0004](./0004-floor-per-second-accrual.md) | Floor-Per-Second Accrual Math | Accepted (backfilled) | 2026-09-13 | Use integer floor division for streaming math so unaccrued tokens are never released prematurely. |
| [0005](./0005-pure-streamed-at.md) | Pure `streamed_at` Rate Math Function | Accepted (backfilled) | 2026-09-13 | Implement accrual as a pure function without `Env` to enable high-speed cargo-fuzzing and native oracles. |
| [0006](./0006-sdk-28-stellar-contract-build.md) | Build Contract Wasm via `stellar contract build` in SDK 28+ | Accepted | 2026-10-04 | Standardize contract builds on `stellar-cli` to satisfy spec-shaking v2 requirements. |
| [0007](./0007-page-size-50-indexes.md) | Page-Size-50 Indexes for Address Discovery | Accepted (backfilled) | 2026-10-04 | Clamp query pagination to 50 items to bound transaction CPU instructions and memory limits. |
| [0008](./0008-extend-on-write-ttl-strategy.md) | Extend-on-Write TTL Strategy for Persistent Storage | Accepted (backfilled) | 2026-09-13 | Extend storage TTL on mutations only; let abandoned streams archive off-chain; sentinel monitors instance/code cliffs. |
| [0009](./0009-eslint-9-pinning.md) | ESLint 9 Pinning for Next.js 16 Flat Config | Superseded | 2026-10-04 | Pin `eslint` to `^9.39.5` (superseded by commit [8ac0d12](https://github.com/Neziahtech/streampay/commit/8ac0d12a4b77309fde0de1ac0fc347747d83efca) upgrading to `^10.12.0`). |
| [0010](./0010-payment-link-reference-format.md) | Shareable Payment Link Reference Format and Privacy Blinding | Accepted | 2026-10-17 | Adopt base64url payload with recipient blinding hash and CRC32 checksum for shareable payment links. |
| [0011](./0011-attestation-signing-scheme.md) | Signing Scheme for Release Build Attestations | Accepted | 2026-10-17 | Independent verifier Ed25519 signatures with in-repo trust anchor and POSIX verification script. |
| [0012](./0012-piecewise-rate-schedule-storage.md) | Piecewise Rate Schedules — Representation, Rounding, and Storage | Accepted | 2026-10-21 | Price renegotiated streams as `(allocation, basis_seconds)` windows under their own storage key, so the past is never re-priced and the new window accrues with no division. |

## How to Propose a New ADR

1. Copy [`template.md`](./template.md) to a new file in `docs/adr/` with the next zero-padded sequential number, e.g. `docs/adr/0012-your-decision-title.md`.
2. Fill out all sections honestly: state the context, concrete decision drivers, and alternatives considered.
3. Submit a pull request.
4. Verify that CI passes the ADR integrity check:
   ```bash
   node scripts/check-adrs.mjs
   ```
