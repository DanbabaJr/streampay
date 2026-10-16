# Contributing to StreamPay

Thanks for helping build streaming payments for Stellar! This doc covers the
conventions, the branch/PR process, and how to run everything locally.

## Project layout

```text
contracts/streaming-payments/   the Soroban contract (Rust, no_std)
frontend/                       minimal Next.js + Freighter UI
indexer/                        TypeScript Soroban event indexer + SQLite REST API
fuzz/                           cargo-fuzz harness for the accrual math (own workspace)
docs/                           ARCHITECTURE.md, GOOD_FIRST_ISSUES.md, DEMO.md
.github/workflows/              ci.yml, fuzz.yml, release.yml
```

## Setup (clean machine)

1. Install Rust ≥ 1.85 (<https://rustup.rs>) and add the wasm target:
   ```bash
   rustup target add wasm32v1-none
   ```
2. Install the Stellar CLI (contract Wasm builds, deploys):
   ```bash
   cargo install stellar-cli --locked
   ```
3. Node.js ≥ 20 for the frontend (<https://nodejs.org>).

## Running the tests locally

```bash
# Contract: the full gate CI runs
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test -p streampay-contract
cargo deny check                                # supply chain (advisories/licenses)

# Optional fuzz session (needs nightly + cargo-fuzz)
cd fuzz && cargo +nightly fuzz run streamed_at -- -max_total_time=60 && cd ..

# Frontend
cd frontend && npm install
npm run lint
npm run typecheck
npm run build
```

A PR is green when all CI jobs pass; locally, fmt/clippy/test (and
lint/typecheck/build when frontend files are touched) are the minimum gate.

## Coding conventions

### Rust / contract

- **No panics on expected failures.** Every public entrypoint returns
  `Result<_, StreamError>`; every arithmetic op on user amounts is checked
  (`checked_add`, `checked_sub`, capacity pre-checks). If a computation can
  overflow, return `StreamError::MathOverflow` — don't wrap, don't panic.
- **Errors are append-only.** Add new `StreamError` variants at the bottom with
  the next free code; never renumber or reuse codes (they are part of the
  client-facing API).
- **Checks-Effects-Interactions.** All storage writes and event emissions
  happen before any token transfer. New entrypoints must preserve this — add a
  test that proves it if you add a new payout path.
- **Pure math stays pure.** Rate/accrual functions take no `Env`, so they are
  unit-testable and fuzzable without a Soroban host.
- **Events are the public ledger.** Every state change emits an event with
  `stream_id` as a topic. If you add an event, filter tests by contract and
  compare typed XDR, not strings.
- Storage: per-stream state under `DataKey::Stream(id)` with TTL extension on
  mutation and read (see `stream.rs`). Discovery uses the append-only address
  indexes (`DataKey::RecipientStreams` / `SenderStreams`): they are written
  **only** by `create_stream`, are advisory (never trust them for auth — the
  `Stream` entry is the source of truth), and reads paginate with `offset` /
  `limit` clamped to `MAX_PAGE_SIZE`. Do not add unbounded full-set scans.
- `#![no_std]` — no allocations where an array or `soroban_sdk::Vec` works.
- Run `cargo fmt` before committing; CI enforces `--check`.

### TypeScript / frontend

- Strict TypeScript (`tsc --noEmit` must be clean); no `any` without a comment
  explaining why.
- Amounts from the contract are `bigint`/string in **smallest token units** —
  never `number` for math.
- All contract interaction lives in `frontend/lib/stellar.ts`; components stay
  presentational.
- Mutating flow is always: build → simulate → Freighter sign → send → poll →
  decode. Don't skip simulation; it's our error-message surface.

### TypeScript / indexer

- Keep event amounts and timestamps as decimal strings at the API boundary;
  they can exceed JavaScript's safe integer range.
- Keep event ingestion idempotent and update the event log, stream projection,
  and cursor transactionally where they share a page.
- The event definitions in `contracts/streaming-payments/src/events.rs` are
  the source of truth for field names and payloads.

### Docs

- Update `docs/ARCHITECTURE.md` when behavior changes — it's the source of
  truth for design decisions, including rejected alternatives.
- Error codes and events are documented in tables; keep the tables in sync.

## Branch & PR process

1. **Branch from `main`**, named `feat/<topic>`, `fix/<topic>`, or
   `docs/<topic>` (e.g. `feat/pause-stream`).
2. **Keep PRs small** — one feature or fix per PR. Contract changes should
   come with tests; behavior changes should update ARCHITECTURE.md.
3. **Commit style**: imperative subject line ≤ 72 chars
   (`withdraw: reject zero amounts early`), body explains *why*.
4. **PR checklist** (CI enforces, but save the round-trip):
   - [ ] `cargo fmt --all -- --check`
   - [ ] `cargo clippy --all-targets -- -D warnings`
   - [ ] `cargo test -p streampay-contract`
   - [ ] `cd frontend && npm run lint && npm run typecheck && npm run build` (if frontend touched)
   - [ ] Tests for new behavior; ARCHITECTURE.md updated for design changes
   - [ ] CHANGELOG.md gets an entry under **Unreleased**
5. **Reviews**: one maintainer approval for docs/frontend, two for changes to
   `lib.rs`/`stream.rs` (money-touching code).
6. Squash-merge with a conventional subject; the squashed subject becomes the
   changelog entry.

## Good first issues

See [`docs/GOOD_FIRST_ISSUES.md`](./GOOD_FIRST_ISSUES.md) — each ticket has
acceptance criteria and a difficulty label. Claim one by commenting "I'd like
to take this" and open a draft PR early so reviewers can steer. Bounties for
some issues are posted on GrantFox (install the GrantFox GitHub App on your
fork to be eligible).

## Security

Found a bug that moves funds incorrectly? Please **do not open a public
issue** — see SECURITY.md for the private disclosure process, or email the
maintainers listed in the repo settings.
