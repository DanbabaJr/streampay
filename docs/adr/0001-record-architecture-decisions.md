# ADR 0001: Record Architecture Decisions

Status: Accepted
Date: 2026-10-17
Deciders: StreamPay Engineering Team

## Context and Problem Statement

StreamPay encompasses a multi-component distributed architecture: a no-std Soroban smart contract, an off-chain TypeScript event indexer, a Next.js web application, TTL sentinel tooling, and an OpenTelemetry observability pipeline. Over time, fundamental technical decisions (such as storage models, arithmetic rounding rules, reentrancy protection, and compilation toolchains) were made and documented across pull request discussions, commit messages, and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

Without a structured, immutable log of architectural decisions:
1. Context on why specific trade-offs were made is easily lost or obscured over time.
2. New contributors risk re-evaluating or re-litigating settled trade-offs (e.g. attempting to split storage keys or renumber error codes).
3. Changes to foundational invariants lack explicit deprecation and supersession tracking.

## Decision Drivers

- Maintain an immutable, discoverable historical record of architectural decisions.
- Ensure backfill honesty: records document only the rationale and constraints that motivated the decision at the time.
- Enforce numbering continuity, format compliance, and link validity in CI automation.
- Support a clean lifecycle: decisions are accepted, and if changed later, superseded by a link to a replacement ADR.

## Considered Options

- Option 1: Architecture Decision Records (ADRs) stored as numbered Markdown documents in `docs/adr/`.
- Option 2: Rely exclusively on Git commit history and PR descriptions.
- Option 3: Maintain a single monolithic living architecture document (`docs/ARCHITECTURE.md`) without discrete decision milestones.

## Decision Outcome

Chosen option: "Option 1: Architecture Decision Records (ADRs) stored in `docs/adr/`", because:
1. ADRs provide lightweight, version-controlled, immutable records that live alongside the codebase.
2. Numbered files (`NNNN-title.md`) establish a clear chronology.
3. Once accepted, ADRs are immutable. If an architectural direction changes, a new ADR is proposed that explicitly supersedes the earlier record via a `Superseded by ADR-XXXX` reference and link to the new record.
4. CI tooling validates that ADR numbers are contiguous and all internal links remain valid.

### Consequences

- **Positive:**
  - Clear rationale is preserved for technical choices across contract, indexer, frontend, and infrastructure.
  - Onboarding contributors can quickly understand the architectural constraints and non-obvious negative results.
  - Automated CI validation prevents link rot and numbering gaps.
- **Negative / Trade-offs:**
  - Requires maintaining the ADR directory and creating new records whenever significant architectural changes occur.

## Alternatives Considered

### Option 2: Rely exclusively on Git commit history and PR descriptions

- Good, because it requires no separate directory or template.
- Bad, because PR discussions are scattered, hard to search holistically, and lack a consolidated index of core architectural invariants.

### Option 3: Monolithic `docs/ARCHITECTURE.md` only

- Good, because it provides a unified technical deep-dive of the current system state.
- Bad, because it documents the current state rather than the historical decisions, alternatives considered, and discarded options. ADRs complement `docs/ARCHITECTURE.md` by recording the decision timeline.

## Validation and Evidence

- ADR program established with automated CI validation in `scripts/check-adrs.mjs`.
- Core repository design decisions backfilled with original commit evidence and dated rationales.
