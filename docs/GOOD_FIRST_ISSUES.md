# Good first issues

Ready-to-file tickets for new contributors. Copy each into a GitHub issue,
apply the `good first issue` label plus the difficulty label, and (optionally)
attach a GrantFox bounty. Claim by commenting and opening an early draft PR.

> **Status (2026-10-04):** issues **#2** (withdrawal panel), **#4** (fuzz
> math), **#7** (fetch by id — superseded by on-chain discovery), and **#8**
> (testnet script + demo) have been implemented on `main`. They remain here
> as reference for the expected format of new tickets; do not claim them.

---

## 1. Add a `pause_stream` entrypoint

**Difficulty: medium** · Contract, Rust

Senders sometimes need to stop accrual temporarily without killing the stream
(a contractor on leave, an audit hold). Add `pause_stream(sender, stream_id)`
and `resume_stream(sender, stream_id)` that freeze accrual at the pause-time
`available` value and resume from the same point — total stream *duration*
stretches by exactly the paused interval.

**Description:** Introduce a `Paused` stream status. While paused,
`available_amount` must be frozen (accrual stops, withdrawals still allowed
against the frozen balance), `top_up` stays allowed, and the effective
`end_time` shifts by the paused duration on resume. Persist `paused_total`
seconds and `last_resumed_at` on the `Stream` so accrual math stays pure:
`elapsed = now − start_time − paused_total` (details in
`docs/ARCHITECTURE.md` §3).

**Acceptance criteria:**
- [ ] `pause_stream` / `resume_stream` return `Result<(), StreamError>`; only the sender may call them; non-Active streams revert with `StreamNotActive`.
- [ ] New error codes appended (never renumbered) for pause-specific failures.
- [ ] `PauseStream` / `ResumeStream` events emitted with `stream_id` topic.
- [ ] Unit tests: accrual frozen while paused, resumes exactly where it left off, withdraw-while-paused, pause→cancel, double-pause reverts.
- [ ] Property test updated: paused streams still satisfy `streamed ≤ deposit` and full-window completeness.
- [ ] `docs/ARCHITECTURE.md` lifecycle diagram updated.

---

## 2. Build the withdrawal panel in the frontend

**Difficulty: easy** · Frontend, TypeScript/React

The stream list exists but has no dedicated UX for the most common action:
withdrawing accrued funds.

**Description:** Add a stream detail view (`/stream/[id]`) showing deposit,
withdrawn, available (via the `available` read call), progress bar, and a
withdraw form that: fetches `available(stream_id)`, prefills the amount,
prevents submitting more than available client-side, and calls
`withdrawFromStream`. Show the contract's decoded error (e.g.
`AmountExceedsAvailable`) as a friendly message on failure.

**Acceptance criteria:**
- [ ] Route renders server-side-safe (no hydration mismatch) and typechecks.
- [ ] `available` is polled or refetchable; UI never allows an over-withdrawal attempt without warning.
- [ ] Freighter flow works end-to-end on testnet against a deployed contract.
- [ ] Error states surface `StreamError` codes readably.
- [ ] `frontend/README.md` documents the new route.

---

## 3. Event indexer service

**Difficulty: medium** · TypeScript, Node

UIs need stream history without scanning the chain. Build a small indexer
worker that polls Soroban RPC `getEvents` for the six StreamPay events
(`stream_id` is the first topic on all of them) and materializes them into a
queryable store.

**Description:** Create `indexer/` with a TypeScript worker: poll
`getEvents` with cursor persistence, filter by contract id, decode the typed
event payloads, upsert into SQLite (streams table + events append-log). Expose
a tiny HTTP API (`GET /streams?recipient=…`, `GET /streams/:id/history`) for
the frontend.

**Acceptance criteria:**
- [ ] Survives restarts: cursor is persisted, no events double-counted.
- [ ] Handles all six event types, including cancel payouts and ownership proposals/acceptances.
- [ ] Integration test: seed events via the contract test harness or fixture JSON, assert API output.
- [ ] `README` in `indexer/` with run instructions; CI job runs its tests.

---

## 4. Fuzz test the accrual math

**Difficulty: medium** · Rust, cargo-fuzz

`streamed_at` is a pure function (no `Env`) — perfect for coverage-guided
fuzzing. Wire up `cargo-fuzz` and let it hammer the invariants.

**Description:** Add `fuzz/` with a `streamed_at` target asserting: result ≤
deposit, result ≥ 0, monotonic in `elapsed`, `streamed_at(d, dur, dur) == d`
for admissible `(d, dur)` pairs, and no panics for arbitrary inputs (including
negative deposits and zero duration — the function must return `Ok(0)` or
`Err(MathOverflow)`, never crash).

**Acceptance criteria:**
- [ ] `cargo fuzz run streamed_at` completes 60s with no crashes locally (document the command).
- [ ] Optional CI job (non-blocking, scheduled or manual dispatch) runs a short fuzz session.
- [ ] Any panics found become regression unit tests with minimal reproducing inputs.
- [ ] `docs/ARCHITECTURE.md` §9 updated to reference the fuzz target.

---

## 5. Multi-token batch stream creation — implemented

`create_streams(sender, inputs: Vec<StreamInput>)` creates a complete batch
atomically. It uses the same per-stream validation and fee rules as
`create_stream`, groups token pulls and reserves ids in batches, and emits a
single `StreamsCreated` event with the ids. A failure in any row rolls back
the full transaction. The frontend payroll CSV form currently uses one token
for all rows.

---

## 6. Gas optimization pass on storage reads

**Difficulty: medium** · Contract, Rust

`cancel_stream` currently does read → modify → write of the whole `Stream`.
Profile where read bytes go and shave.

**Description:** Options to evaluate: splitting hot (`withdrawn`, `status`)
from cold (`sender`, `token`, times) fields into separate entries;
`extend_ttl` tuning; avoiding the double read in `withdraw` (validate →
auth → re-read). Produce before/after numbers using
`stellar contract invoke` cost output or `soroban-env-host` benchmarks on a
fixture workload.

**Acceptance criteria:**
- [ ] Benchmark harness committed (script + fixture), reproducible with documented commands.
- [ ] At least one implemented optimization with measured improvement, or a documented negative result proving current layout is optimal.
- [ ] No behavior change: all 40 existing tests still pass unmodified.
- [ ] ARCHITECTURE.md §2 updated with the storage-layout decision.

---

## 7. "Fetch stream by id" box in the UI

**Difficulty: easy** · Frontend, TypeScript/React

Today the stream list only shows streams created in the current session. Add a
search box: paste a stream id, call `readStream(id)`, and add it to the list.

**Acceptance criteria:**
- [ ] Invalid/nonexistent ids show a friendly error; valid ids render with status badge.
- [ ] Works with big ids (u64 range) via string→BigInt handling.
- [ ] Typecheck + build green.

---

## 8. Testnet deployment script + demo walkthrough

**Difficulty: easy** · Bash, docs

New contributors need a one-command path from clean machine to a live demo
stream.

**Description:** Write `scripts/deploy_testnet.sh` that: checks prerequisites
(`stellar`, funded key), builds the Wasm (`stellar contract build`), deploys,
fund-friends the test accounts, mints a demo token (deploy a SAC for a
custom asset), creates a demo stream, and prints a summary. Add
`docs/DEMO.md` walking through create → withdraw → cancel with expected
outputs.

**Acceptance criteria:**
- [ ] Script is idempotent-ish (safe to re-run; clear errors when prerequisites missing).
- [ ] `docs/DEMO.md` screenshots/expected outputs verified on a fresh testnet account.
- [ ] Linked from the root README's Getting Started section.
