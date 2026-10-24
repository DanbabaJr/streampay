# Contributing to StreamPay

Thanks for helping build streaming payments for Stellar! This doc covers the
conventions, the branch/PR process, and how to run everything locally.

## Project layout

```text
contracts/streaming-payments/   the Soroban contract (Rust, no_std)
frontend/                       minimal Next.js + Freighter UI
indexer/                        TypeScript Soroban event indexer + SQLite REST API
fuzz/                           cargo-fuzz harness for the accrual math (own workspace)
docs/                           ARCHITECTURE.md, adr/ (decision records), DEMO.md
.github/workflows/              ci.yml, fuzz.yml, release.yml
```

## Quick-start (one-command local dev)

To go from a fresh clone to a running local demo (contract built, deployed to a local sandbox network, frontend configured and running):

```bash
# Linux / macOS
./scripts/dev.sh

# Windows (PowerShell)
.\scripts\dev.ps1
```

The bootstrap script verifies toolchain requirements (`stellar-cli >= 25.2.0`, Rust `wasm32v1-none`, Node.js), compiles the smart contract using `stellar contract build`, provisions/connects to a local Stellar sandbox, deploys the contract, writes `frontend/.env.local`, runs `npm ci`, and starts the frontend dev server. It is safe to re-run (idempotent).

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
npm test        # unit tests + recorded fee-series simulation (vitest)
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
  client-facing API). The next free code is counted from the code *main* has
  reached, not from your branch — if `npm run codes:check` says your branch is
  behind, bring main into it before you pick a number.
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
  indexes (`DataKey::RecipientStreams` / `SenderStreams`): they are written by
  `create_stream` and by an accepted ownership transfer (the new holder's list
  gains the id; the old holder keeps its historical entry), are advisory
  (never trust them for auth — the `Stream` entry is the source of truth), and
  reads paginate with `offset` / `limit` clamped to `MAX_PAGE_SIZE`. Do not add
  unbounded full-set scans.
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

- Update [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) when behavior
  changes — it's the source of truth for design decisions, including
  rejected alternatives, the append-only public-interface rules (§13), and
  the Soroban-specific traps to avoid rediscovering the hard way (§14).
- Error codes and events are documented in tables; keep the tables in sync —
  see **Generated files & CI gates** below for the exact commands.

## Generated files & CI gates

Several files in this repo are **generated**: CI regenerates them from their
sources and fails the build on any diff. They are never edited by hand — change
the source, then regenerate.

| Generated file | Generated from | Gate (CI job) |
|---|---|---|
| `docs/ERROR_SURFACE.md` | `contracts/streaming-payments/src/errors.rs` + `surface.rs`, via the `error_surface_doc` cargo example | "Error-surface table is up to date" (Contract) |
| `docs/errors.md`, `docs/errors/<code>.md`, `frontend/lib/errors.ts` | the same error surface, via `tooling/generate-error-catalog.mjs` | "Error catalog is up to date" (Perf budgets) |
| `tests/vectors/accrual_vectors.json` | the Rust reference model, via `scripts/generate-vectors.mjs` | "Differential vectors are up to date" (Frontend) |

All three gates call the same script —
[`scripts/check_generated.sh`](./scripts/check_generated.sh) — so you can run
every one of them locally, before pushing:

```bash
npm run generated:check        # all three areas
npm run generated:surface      # or one area: surface | catalog | vectors
```

The script regenerates in place and then fails on any diff, so a failing run has
already written the correct files for you; read what it printed, then:

```bash
git add <the paths it lists>
git commit
```

Three things to know:

- Run it **after** merging `main` into your branch, so you regenerate from the
  complete error surface. The catalog files carry a content-derived
  `schema_fingerprint` stamp (not a git SHA), so a clean regeneration on the
  same tree always matches CI.
- If you add a **new** error code, a new page appears under `docs/errors/`.
  `git diff` cannot see untracked files, so `git add docs/errors/` — otherwise
  the gate fails with "produced files that are not committed yet".
- `docs/ERROR_SURFACE.md` used to be `docs/ERRORS.md`. That name differed from
  `docs/errors.md` by case alone, which is invisible on macOS/Windows
  filesystems and made checkouts and renames ambiguous. The rule now: a
  generated artifact's filename must not collide with another's when the
  filesystem ignores case.

### Other mechanical gates, in one place

`cargo fmt` and the frontend toolchain account for most other first-push
failures, so the full pre-flight is:

```bash
npm run codes:check       # StreamError codes + registry wiring: E0081 and unwired codes
npm run lint:fix          # cargo fmt --all, then commit what it changed
npm run eol:check         # committed CRLF: the usual cause of a whole-file fmt diff
cargo clippy --all-targets -- -D warnings
npm run generated:check
npm run links:check       # every internal link and #anchor in the docs resolves
npm run json:check        # no key declared twice in any tracked JSON file
cd frontend && npm run lint && npx tsc --noEmit && npm test && npm run build
```

`npm run matrix` chains most of this from the repo root. If every command above
passes on your branch after merging `main`, CI passes too: the gates are the
same commands, not CI-only logic.

**Error codes and the registry.** `StreamError` is a wire contract: a code is never
renumbered, reused, or deleted, and an unreachable variant is *retired* in place
rather than removed. The two mistakes this causes are appending a code another
merged PR already took (`E0081: discriminant value assigned to multiple variants`)
and deleting a variant, which silently invalidates existing clients.
`npm run codes:check` reads your tree's enum *and* the base branch's, and prints
the next free code above whichever is higher — labelled with where the number
came from — so you never have to guess; CI runs it as the *first* step of the
Contract job, before the toolchain even installs, so a collision is a
file/line annotation within seconds instead of a compile error four minutes
later in two jobs at once. A branch that is behind main gets a warning instead
of advice, because "the highest code I can see plus one" is exactly how two PRs
pick the same number.

The same script then checks the registry in `contracts/streaming-payments/src/surface.rs`,
which maps every rejection branch to the code it returns: a code no branch
produces (and that is not in `RETIRED_CODES`) and a `Branch::…` name the mapping
uses without declaring it are the two ways a merge leaves the contract not
compiling — the red `Devcontainer — wasm build` check that says nothing about
what to add. Both are reported here with the file, the line and the exact fix
(`pub enum Branch` variant + an arm in `Branch::error()`). This mirrors the
contract's own matrix test (`every_error_code_is_produced_or_retired`), which
asserts the same property after a full build.

**Docs links.** `npm run links:check` fails on a relative link or `#heading`
anchor that does not resolve, and every failure is emitted as a CI annotation
with the file, the line, and the closest existing paths — because the usual
cause is a document that was renamed on `main`. (If your branch predates the
rename, `docs/ERRORS.md` is now `docs/ERROR_SURFACE.md`.)

**Duplicate JSON keys.** `npm run json:check` walks every tracked `.json` file and
fails when one object declares the same key twice. This needs a gate because the
file stays *valid*: `JSON.parse` and npm keep the last occurrence and drop the
earlier one without a word, so the first line is dead and nothing ever errors.
It is a merge shape, not a typo — two branches that append a key at the same spot
both keep their line when they merge. `frontend/package.json` carried `"test"`
that way, which is why 23 scheduler and fee-series specs stopped running in every
CI job while the step named after them stayed green. (The same event once left
duplicate *dependency* keys in the file, which npm rejects outright — at least
that failed loudly.) The scanner is annotated with both line numbers and the key
path, tolerates `tsconfig.json` comments and npm's trailing commas, and reports a
key repeated in two sibling objects as what it is: legitimate JSON.

`frontend` tests are collected by two runners that cannot see each other's files
— `node --test` discovers `*.test.ts`, while `vitest run` (scoped by
`frontend/vitest.config.mts`) discovers `lib/**/*.spec.ts` — so `npm test` chains
both, and CI additionally runs a dedicated `npm run test:scheduler` step. The
separate step exists because `scripts.test` is an ordinary string that any merge
can rewrite: the suite needs an owner whose check fails when a runner stops being
collected, rather than coverage that depends on one aggregate script staying
correct.

If `cargo fmt --all -- --check` fails with a diff covering **every line** of a
file, that file was committed with CRLF (Windows editors and `core.autocrlf=true`
do this; `.gitattributes` pins `.rs` to LF so it cannot recur). One command
normalizes the whole tree without losing your work:

```bash
git add --renormalize .
git commit -m "chore: normalize line endings to LF"
```

If you have no local Rust toolchain at all, the Contract job's Format check
still does: a failing run regenerates the formatting, uploads it as the
`fmt-fix-*` artifact, and the annotation says to `git apply fmt-fix.patch`.

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
   - [ ] `cd frontend && npm run lint && npm run typecheck && npm test && npm run build` (if frontend touched)
   - [ ] Tests for new behavior; ARCHITECTURE.md updated for design changes
   - [ ] CHANGELOG.md gets an entry under **Unreleased**
5. **Reviews**: one maintainer approval for docs/frontend, two for changes to
   `lib.rs`/`stream.rs` (money-touching code).
6. Squash-merge with a conventional subject; the squashed subject becomes the
   changelog entry.

## Architecture Decision Records (ADRs)

Significant architectural choices, invariants, or storage/tooling changes are documented as Architecture Decision Records in [`docs/adr/`](./docs/adr/README.md).

- When introducing or altering architectural invariants, create a new record using [`docs/adr/template.md`](./docs/adr/template.md) with the next sequential number.
- Records are immutable: if superseding a prior decision, mark the previous record as `Superseded by ADR-XXXX` (with a link to the replacement ADR) and link back from the new record.
- Verify numbering and link integrity locally before opening a PR:
  ```bash
  node scripts/check-adrs.mjs
  ```

## Good first issues

See [`docs/GOOD_FIRST_ISSUES.md`](./docs/GOOD_FIRST_ISSUES.md) — each ticket has
acceptance criteria and a difficulty label. Claim one by commenting "I'd like
to take this" and open a draft PR early so reviewers can steer. Bounties for
some issues are posted on GrantFox (install the GrantFox GitHub App on your
fork to be eligible).

## Security

Found a bug that moves funds incorrectly? Please **do not open a public
issue** — see SECURITY.md for the private disclosure process, or email the
maintainers listed in the repo settings.
