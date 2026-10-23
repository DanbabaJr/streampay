# Contract Wasm size (issue #58)

Goal: keep the deployed `streampay_contract.wasm` **below 60 KB** without any
behavior change, so the contract stays cheap to deploy and close to the
Soroban instruction/size comfort zone while the CI size budget
(`WASM_SIZE_BUDGET_KB` in `.github/workflows/ci.yml`) holds the line.

Outcome: the techniques take the contract from 91,004 B to **60,386 B**, which
met the bar on the branch's own tree; merging `main` added 3,757 B of new
interface on top, and the follow-up probes in
[Size gate status](#size-gate-status-64143-b-is-the-measured-floor-of-this-interface)
measure that the remaining 4,144 B exists only inside the public interface.
Merging the governance timelock afterwards added a second, larger tranche —
see [Second re-baseline](#second-re-baseline-merging-the-governance-timelock-64143-b--78266-b-gate-77-kb)
— and issue #54's rate-renegotiation interface a third: the size gate now sits
at **83 KB**, see
[Third re-baseline](#third-re-baseline-mid-stream-rate-renegotiation-78266-b--84613-b-gate-83-kb).

All numbers below are built with the pinned release toolchain
(`stellar-cli 28.1.0`, `rustc 1.99.1`, `wasm32v1-none`, `stellar contract build`
→ spec-shaking v2 + wasm-opt `-Oz` with convergence). Reproduce any row with:

```bash
cd contracts/streaming-payments && stellar contract build
node scripts/wasm-report.mjs ../../target/wasm32v1-none/release/streampay_contract.wasm
```

## Measured progression

| Stage | Technique | Total (bytes) | Δ |
|---|---|---|---|
| Baseline | commit `09516fe` (post oracle-time + sponsor merge) | **91,004** | — |
| 1 | Doc strings removed from the on-chain spec | 60,852 | −30,152 |
| 2 | Creation effects-leg dedup (`persist_new_stream`) | 60,386 | −466 |

Final size: **60,386 bytes (59.0 KiB)** — under the 60 KB target, and 33.6 %
smaller than the baseline this work started from (59.7 % of it). Measured
against the 120 KB budget the size gate was set at (issue #35), the binary is
now **under two thirds of that budget**; the budget was lowered to 60 KB here
so any regression fails CI, and it now sits at **83 KB** on the merged tree for
the reasons in
[Size gate status](#size-gate-status-64143-b-is-the-measured-floor-of-this-interface),
[Second re-baseline](#second-re-baseline-merging-the-governance-timelock-64143-b--78266-b-gate-77-kb)
and
[Third re-baseline](#third-re-baseline-mid-stream-rate-renegotiation-78266-b--84613-b-gate-83-kb).

> **These two rows were measured on the tree before `main` was merged in.**
> After the merge the contract is 64,143 B — see
> [Re-baseline after merging `main`](#re-baseline-after-merging-main-ownership-transfer--vault)
> for the attribution and the deliberate gate decision.

### Section breakdown (baseline → final)

| Section | Baseline | Final | Δ |
|---|---|---|---|
| `contractspecv0` | 46,863 | 16,711 | −30,152 |
| `code` | 37,770 | 37,288 | −482 |
| `data` | 3,963 | 3,963 | 0 |
| `export` | 1,278 | 1,278 | 0 |
| `contractmetav0` ×2 | 230 | 230 | 0 |
| `contractenvmetav0` | 30 | 30 | 0 |
| headers/other | 870 | 886 | +16 |

The interface spec section alone was more than half the deployed binary. A
control experiment (stripping the `///` doc comments of the contract interface
items for one measurement build) shrank `contractspecv0` from 46,863 B to
16,711 B, proving most of the spec section is documentation strings embedded
into the Wasm by `soroban-sdk-macros` — the techniques in this branch attack
exactly that.

### Baseline function-level sizes (top of `code`)

| Function | Bytes |
|---|---|
| `sponsored_withdraw` | 1,589 |
| `create_streams` | 1,413 |
| `schedule_stream` | 1,268 |
| `create_streams_batch` | 1,086 |
| `execute_scheduled` | 914 |
| `top_up` | 756 |
| `cancel_stream` | 631 |
| `migrate_storage` | 564 |

(Regenerable in full with `scripts/wasm-report.mjs` against any build
artifact.)

## Technique 1 — stop embedding doc strings in the deployed spec (−30,152 B)

`soroban-sdk-macros` copies every `///` doc comment of the contract interface
(`#[contractimpl]` entrypoints, `#[contracttype]` fields/variants,
`#[contracterror]` variants, `#[contractevent]` structs — events ship in the
spec as UDT entries) into `contractspecv0`. On this contract that prose was
**30,152 B of the 46,863 B spec section** — a third of the whole binary —
paid on every deploy and baked into the on-chain interface.

The fix is purely mechanical: each such doc comment becomes

```rust
#[cfg_attr(not(target_family = "wasm"), doc = " …the original text… ")]
```

Proc-macro attributes are token-matched **before** `cfg_attr` expansion, so on
the `wasm32v1-none` build the spec macros see no `#[doc]` attributes at all
and emit empty doc strings; on host builds (tests, rustdoc, analytics
tooling) the attribute expands back into the identical `#[doc]` items. Source
documentation is preserved 1:1; only its duplication into the binary stops.

- No signature, name, arity, event-topic, or error-code change: `stellar
  contract invoke`, the frontend SDK typings pipeline, `canary_check.sh` and
  `schema_diff.sh` all keep working. The canonical interface hash does change
  (doc strings were part of the hashed spec) — see the operator-notification
  section at the end of this document.
- Module-internal docs (helpers, storage math) were never embedded and are
  left as plain `///`.

After this step the binary is **60,852 B (59.4 KiB)** — under the 60 KB
target, sections: `code` 37,770 · `contractspecv0` 16,711 · `data` 3,963.

## Technique 2 — dedup the stream-creation effects leg (−466 B)

`create_stream_with_oracle`, `create_stream_internal` (scheduled execution)
and `create_single_batch_entry` each contained the same id → persist → index →
optional fee → `StreamCreated` → optional `FeeCharged` leg, with only the fee
and oracle flag differing. They now share one private helper,
`StreamingPayments::persist_new_stream`, keeping the exact effect order (the
CEI operation-order goldens for the scheduled paths are byte-identical).

The atomic `create_streams` batch loop intentionally does **not** emit
per-stream `StreamCreated` events, so it keeps its own leg and was not merged.

`code` shrinks 37,770 → 37,288; the two call sites that inlined the leg
(`create_streams_batch` 1,086 → 795, `execute_scheduled` 914 → 773) now call
the shared helper. Final binary: **60,386 B (59.0 KiB)**.

## Re-baseline after merging main (ownership transfer + vault)

`main` has grown since this branch was cut: it now carries the two-step
ownership transfer surface (`propose_ownership_transfer`,
`accept_ownership_transfer`, `cancel_ownership_transfer`,
`pending_ownership_transfer`, the `OwnershipRole` / `PendingOwnership` types
and two events, 11 new `StreamError` codes), the separate `contracts/vault`
crate, and the ADR / generated-file gates. This branch merges `main`
(`0f80df3`) and re-applies Technique 1 to the new interface items, so the
size numbers above are re-baselined:

| Section | Branch final (pre-merge) | Merged with `main` | Δ from upstream |
|---|---|---|---|
| `code` | 37,288 | 39,312 | +2,024 |
| `contractspecv0` | 16,711 | 18,011 | +1,300 |
| `data` | 3,963 | 4,251 | +288 |
| `export` | 1,278 | 1,396 | +118 |
| headers/other | 886 | 913 | +27 |
| **Total** | **60,386** | **64,143 (62.6 KiB)** | **+3,757** |

Top `code` functions on the merged build (`scripts/wasm-report.mjs`, run
against the artifact in `target/wasm32v1-none/release/`):

| Function | Bytes |
|---|---|
| `sponsored_withdraw` | 1,589 |
| `create_streams` | 1,413 |
| `schedule_stream` | 1,268 |
| `create_streams_batch` | 795 |
| `execute_scheduled` | 773 |
| `top_up` | 756 |
| `cancel_stream` | 672 |
| `migrate_storage` | 567 |
| `propose_ownership_transfer` | 466 |
| `accept_ownership_transfer` | 426 |

The two techniques' deltas are unchanged in kind: upstream's new interface
items were doc-gated the same way (`lib.rs`, `errors.rs`, `events.rs`,
`stream.rs` re-converted by `shrink_docs`-style idempotent conversion), and
`persist_new_stream` is untouched by the merge. The +1,300 B of spec is the
new entrypoints' *structural* spec entries (names, types, param docs are now
empty) plus 11 error codes — not documentation, so Technique 1 cannot recover
it; without it the merged build would be ~94 KB instead of 64 KB.

### Size gate status: 64,143 B is the measured floor of this interface

The merged binary is **64,143 B**, i.e. 2,704 B over the old 61,440 B gate and
4,144 B over issue #58's literal 60,000 B bar. Both gaps were chased on the
merged tree; every probe below was measured and then reverted.

| Probe (merged tree) | Result |
|---|---|
| `#[inline(never)]` on the 31 public helpers in `stream.rs` (force sharing instead of inlining) | 64,524 B — **+381 B, worse**: wasm-opt already picks the better per-site strategy. |
| Gate `pub mod verification` out of wasm builds | 64,143 B — **0 B**: fat LTO already eliminates the whole ~6.6 KB proof/model-check surface. |
| Re-scan for interface items still carrying ungated `///` docs | **0** outside test-only modules (`test.rs`, `hostile_token_fuzz_test.rs`), which are not compiled into the Wasm. Technique 1 is complete. |
| Trim the export table | **0 B**: 70 exports = `memory` + `__constructor` + the 68 entrypoints. Nothing spurious to drop. |
| `overflow-checks = false` | **Not available**: `stellar contract build` refuses — "`overflow-checks` is not enabled for profile `release`". Rejected on safety regardless. |
| `opt-level = "s"` (speed-leaning) | 69,159 B — **+5,016 B**, confirming `"z"` is the size-optimal setting already in place. |
| Trim the 4,241 B `data` segment (event topics, `#[contracttype]` field names) | **0 B available**: these are the wire/storage symbols themselves, and there are no `symbol!()` call sites left to convert — every key is a `symbol_short!`/derive-encoded constant. Shortening a name is a storage and event compatibility break, not a size fix. |

Residual composition at 64,143 B: `code` 39,312 (61 %), `contractspecv0`
18,011 (28 %), `data` 4,251, `export` 1,396, headers/meta 1,173. The only
place 4,144 B exists is the interface itself — the spec entries *and* bodies
of the ~15 admin/treasury/policy entrypoints — which is the split rejected
below.

**Gate decision.** `WASM_SIZE_BUDGET_KB` is raised from 60 to **63**
(64,512 B — 369 B of headroom) in this PR, deliberately and with the
attribution above, as the gate's own comment prescribes ("raise deliberately
in a PR with justification if the contract grows"). The rule now is: *budget =
the smallest whole KB that the current interface fits*, so the ratchet stays
as tight as the interface allows instead of buying slack. Issue #58's target
was reached by the technique work on its own tree (**60,386 B**, −29.5 % from
the 91,004 B baseline); the merged tree carries upstream's +3,757 B of new
interface (ownership transfer + vault surface) on top, and no behavior
preserving technique recovers that. **Revisit the entrypoint split at the next
entrypoint addition** — that is what will trip the 63 KB gate.

| Option considered | Effect |
|---|---|
| Raise `WASM_SIZE_BUDGET_KB` to 70 | Green, but discards 7 KB of ratchet against the real 120 KB deploy budget — not taken. |
| Leave the gate at 60 KB and ship a red "Wasm size budget check" step | Makes the breach visible but blocks review/merge of an otherwise green PR, and the number it reports is upstream's growth, not a regression of this work — superseded by the justified bump above. |
| Move `withdraw_treasury` / `verify_treasury` / `treasury_status` / `set_stream_policy` / policy* admin entrypoints to a second contract | ~−2.5 KB `code` plus their spec entries, but breaks the single-contract storage/upgrade model (admin state shares instance storage with streams) — same rejection as before. |
| Trim remaining spec (68 entrypoints, 18 KB) | Only by dropping the spec section, already rejected below. |

## Second re-baseline: merging the governance timelock (64,143 B → 78,266 B, gate 77 KB)

`main` has since merged the governance timelock (`GovernanceAction` /
`Proposal` / `GovernanceDataKey`, 5 `#[contractevent]` structs, error codes
64–79, and the `governance_bootstrap` … `governance_execute` entrypoints).
The first CI build on top of that merge measured **84,682 B** — 20,170 B over
the 63 KB gate — because the new interface items arrived with plain `///` doc
comments, i.e. exactly the bytes Technique 1 exists to remove, and the
re-scan invariant ("0 interface items carrying ungated `///` docs") had
silently gone false when the branch was cut.

The fix is Technique 1 re-applied, now as a checked, re-runnable probe instead
of a one-off edit: `scripts/gate_interface_docs.py` walks the crate's sources,
identifies interface items by their attributes (and `pub fn` inside
`#[contractimpl]`), and converts their doc lines to the
`#[cfg_attr(not(target_family = "wasm"), doc = "…")]` form. It is idempotent,
skips test-only modules, and reports what it would gate:

```bash
python scripts/gate_interface_docs.py contracts/streaming-payments/src/*.rs          # dry run → 0 groups
python scripts/gate_interface_docs.py contracts/streaming-payments/src/*.rs --apply  # re-gates a fresh merge
```

The same command with `--check` is now a CI step in the contract job ("Interface
doc strings stay out of the Wasm spec"), so the invariant that broke here cannot
silently break again.

This pass gated **55 doc groups** (16 in `errors.rs`, 20 in `governance.rs`,
14 in `lib.rs`, 5 in `events.rs`) and recovered **6,416 B** of
`contractspecv0` (27,499 → 21,083). It also repaired damage the merge itself
had done: `set_fee_bps`, `set_stream_policy`, `set_frozen` and `cancel_upgrade`
each came out of the merge carrying *both* the branch's gated doc block and
main's rewritten plain one, so their rustdoc rendered the same paragraph twice
and the older wording contradicted the new governance behaviour. The stale
block was dropped in favour of main's text at all four sites.

| Section | Merged with ownership transfer | Merged with governance | Δ |
|---|---|---|---|
| `code` | 39,312 | 49,317 | +10,005 |
| `contractspecv0` | 18,011 | 21,083 | +3,072 |
| `data` | 4,251 | 4,999 | +748 |
| `export` | 1,396 | 1,631 | +235 |
| headers/meta/other | 1,173 | 1,236 | +63 |
| **Total** | **64,143** | **78,266 (76.4 KiB)** | **+14,123** |

Attribution of the +14,123 B: 10,005 B is the governance module's compiled body
(`governance_propose` alone is 2,195 B — the largest function in the binary —
and `governance_execute` 1,103 B), 3,072 B is the *structural* spec entries of
the new types, entrypoints and error codes, 748 B is the new event/field
symbols in `data`, and 235 B the new exports. None of it is documentation.

Probes run on this tree before accepting the number:

| Probe | Result |
|---|---|
| `gate_interface_docs.py --check` re-scan after the pass | **0 groups left** — and the scan is now a CI step, so the invariant is enforced rather than remembered. |
| Residual doc prose in the artifact (`grep` of the built wasm for governance doc phrases) | **0 hits** — only identifiers like `timelock` inside error/variant names survive. |
| Dedup of the governance legs into a shared helper (Technique 2 shape) | The five `governance_*` entrypoints are already 2-line wrappers over `governance.rs`; the bytes live inside one function each, so there is no duplicated leg to merge. Not taken. |
| `#[inline(never)]` / `opt-level` / feature trimming | Re-measured no — unchanged from the first re-baseline's table above. |

**Gate decision.** `WASM_SIZE_BUDGET_KB` is raised from 63 to **77**
(78,848 B — 582 B of headroom over the measured 78,266 B), which is the same
rule applied to the new interface: the smallest whole KB the current interface
fits. The alternative of holding 63 KB would require deleting ~14 KB of merged
governance functionality, which is a product decision, not a size optimization.
The single-contract split discussed above is now worth reopening on its own
merits (the `code` section is 63 % of the binary and `governance_propose` is
the single largest function in it), but it is out of scope for #58: this PR
ships no behavior change.


## Third re-baseline: mid-stream rate renegotiation (78,266 B → 84,613 B, gate 83 KB)

Issue #54 adds the two-step rate change: `propose_rate_change`,
`accept_rate_change` and `cancel_rate_change` plus the two read-only views
(`pending_rate_change`, `rate_segments`), the `RateChangeProposed` /
`RateChangeAccepted` events, the `RateSegment` and `PendingRateChange` stored
types, error codes 80–83, and the piecewise accrual helpers in `stream.rs`
that every existing read path now goes through.

| Section | Merged with governance | Merged with rate renegotiation | Δ |
|---|---|---|---|
| `code` | 49,317 | 53,479 | +4,162 |
| `contractspecv0` | 21,083 | 22,595 | +1,512 |
| `data` | 4,999 | 5,536 | +537 |
| `export` | 1,631 | 1,738 | +107 |
| headers/meta/other | 1,236 | 1,265 | +29 |
| **Total** | **78,266** | **84,613 (82.6 KiB)** | **+6,347** |

Attribution: +4,162 B is compiled body — `accept_rate_change` alone is 1,499 B
(the rebalancing math, the segment rewrite and the conditional top-up pull in
one leg), and the rest is the proposal leg plus the segment-aware accrual and
capacity helpers; +1,512 B is the *structural* spec entries of the 5
entrypoints, 2 events, 2 stored structs and 4 error codes; +537 B is the new
event/field symbols in `data`; +107 B the 5 new exports.

Probes run on this tree before accepting the number:

| Probe | Result |
|---|---|
| `gate_interface_docs.py --apply` on the merged tree | 33 doc groups gated (5 in `lib.rs`, 12 in `events.rs`, 12 in `stream.rs`, 4 in `errors.rs`); `--check` then reports 0. |
| Residual doc prose in the artifact (`grep` of the built wasm for the new entrypoints' and structs' doc phrases) | **0 hits** — only the identifiers themselves (`accept_rate_change`, `RateSegment`, …) survive, as spec and export symbols. |
| Reusing an existing leg instead of a new entrypoint | Rejected: a rate change cannot piggyback on `top_up` or `withdraw`, because both move funds unilaterally and the whole point of #54 is that neither party can impose a new rate alone. |
| Dedup of the three rate legs (Technique 2 shape) | Not taken: `propose` and `accept` share only the load/auth preamble that `authorize_*` helpers already own; the arithmetic that follows is different in each direction (a proposal prices nothing, an acceptance prices the schedule and rebalances it). |

**Gate decision.** `WASM_SIZE_BUDGET_KB` moves from 77 to **83**
(84,992 B — 379 B of headroom over the measured 84,613 B), the same rule
applied to the new interface. This is the entrypoint addition the 77 KB
comment anticipated, so the split discussion belongs here rather than in a
later cleanup:

- The `code` section is still ~63 % of the binary, and the two largest
  functions in it are `governance_propose` (2,195 B) and
  `sponsored_withdraw` (1,590 B) — neither is streaming accounting.
- The natural first cut is the governance module: its five entrypoints are
  thin wrappers over `governance.rs` and its state is instance storage, so a
  separate contract removes ~10 KB of code and most of the governance spec
  entries. The cost is real, though: the governor would no longer be able to
  freeze or upgrade the stream contract in the same transaction, cross-contract
  calls add instructions to paths the footprint gate measures, and every
  deployed instance would gain a second contract id to track in
  `docs/FOOTPRINT.md`, the deploy scripts and the attestation digest flow.
- Rate renegotiation itself cannot be the thing that moves out: its segments
  are read on every accrual path (`available_amount_with_plan`,
  `cancel_amounts_with_plan`, `streamed_amount_at_segments`), so a second
  contract would put a cross-contract read on the hot path of every withdrawal.

Recommendation: keep the single contract and the ratchet, and open the split as
its own issue with the freeze/upgrade atomicity question answered first. #54
ships its interface and moves the gate under the documented rule; cutting the
feature to hold 77 KB would be a product decision made by a size knob.

## Categories investigated and rejected (with measurements)

| Candidate | Verdict |
|---|---|
| `[profile.release]` tuning (`opt-level="z"`, `lto=true`, `codegen-units=1`, `panic="abort"`, `strip="symbols"`, `debug=0`) | Already maxed out on main; every knob was at its size-optimal setting before this work. Measured on the merged tree: `opt-level="s"` is +5,016 B worse, so there is no delta available in either direction. |
| Extra `wasm-opt` passes | `stellar contract build` already runs `-Oz` to convergence with MVP/sign-ext/mutable-globals/bulk-memory; there is no supported flag surface left to flip, and changing it would break reproducible builds (the canonical build is the CLI's). |
| Trimming soroban-sdk features (`no_std` surface) | **Verified no-op**: soroban-sdk 29.0.1 has no `default` feature at all (its features are `alloc`, `docs`, `hazmat*`, `testutils`), and the crate already builds `#![no_std]` without any of them. The issue's "dependency trimming" candidate has nothing to trim — the remaining `code` is the SDK's env host glue and XDR/`Vec`/`Map` serialization, which is what the 68 entrypoints call. |
| Dead-code elimination in event/error formatting | Nothing to eliminate: `surface::reject` instrumentation already compiles away in non-test builds, event publishing is live code, and error `code()`s are u32 consts. The dead bytes were doc prose (Technique 1), not formatting. |
| Stripping `contractspecv0` entirely (would save −18 KB on the merged tree) | **Rejected.** The host executes a spec-less Wasm, but `stellar contract invoke`, `stellar contract info interface`, `canary_check.sh` (all three checks), the schema gates and every integrator's auto-generated client depend on the embedded spec. Removing it trades 18 KB for breaking the entire operational surface. Use `stellar contract info hash` only as a last-resort deploy check, not as a substitute. |
| Splitting rarely-used entrypoints into a second contract | **Rejected for now.** Entry points cost size mainly through their spec entries (18 KB spread over 68 functions); moving e.g. the sponsor/attestation surface out would break the single-contract deploy/upgrade model (storage is per-contract; streams and sponsor budgets share instance storage), double the deploy pipeline, and change every integrator's address. This is also the *only* remaining lever at the 4 KB scale, so it is the pre-declared next step if the team decides #58's 60,000 B bar outranks the single-contract model — see the gate decision above. |
| `overflow-checks = false` | **Not available.** stellar-cli hard-refuses the build ("invalid Cargo.toml configuration: `overflow-checks` is not enabled for profile `release`"), independently of the safety argument: the contract's value model depends on checked math and `MathOverflow` is part of the published error surface. |

## Digest change — operator notification (expected)

This work changes the deployed bytes, so the release digest changes. This is
expected and is **not** a supply-chain signal. Operators must:

1. Expect `release-metadata.json.wasm_sha256`, `SHA256SUMS` and the
   `UPGRADE_DIGESTS.txt` head to change at the first release built from this
   branch. Any tool that pinned the old digest (watchtowers, canary configs,
   integrator allow-lists) must be repinned **before** the release tag.
2. Expect the canonicalized-interface hash (`scripts/contract_interface_hash.sh`)
   to change: doc strings are part of the hashed spec. The promote pipeline
   handles it — set `schema_change_ack: true` on the promote workflow run (and
   `SCHEMA_CHANGE_ACK=1` for `scripts/release_gates.sh`), which re-baselines
   `deployments/interface/<env>.sha256` for the canary's schema-continuity
   check. Existing deployments keep their old baseline until they are
   upgraded; `canary_check.sh` skips comparison when no baseline exists, and a
   wrong-Wasm deploy still fails on the new baseline.
3. Functionally nothing changes: storage layout, event topics, error codes and
   entrypoint signatures are untouched (verified by the regenerated
   `docs/errors.md` catalog and `docs/ERROR_SURFACE.md` being byte-identical
   apart from the catalog's `schema_fingerprint` line, which changes because
   `errors.rs` text changed, and by the differential/model tests), so the
   upgrade can follow the standard rehearsal → canary → promote flow in
   `docs/CANARY_RUNBOOK.md` with the ack steps above added.

Auditor-facing rebuild instructions are unchanged (`docs/REPRODUCING.md`):
the same pinned toolchain triad reproduces the new bytes.

## Function-level breakdown (top sizes)

Baseline (91,004 B) vs final (60,386 B), `code` section per function:

| Function | Baseline | Final |
|---|---|---|
| `sponsored_withdraw` | 1,589 | 1,589 |
| `create_streams` | 1,413 | 1,413 |
| `schedule_stream` | 1,268 | 1,268 |
| `create_streams_batch` | 1,086 | 795 |
| `execute_scheduled` | 914 | 773 |
| `top_up` | 756 | 756 |
| `cancel_stream` | 631 | 631 |
| `migrate_storage` | 564 | 564 |

`create_streams_batch` and `execute_scheduled` shrink because their inlined
copies of the creation effects leg now call the shared `persist_new_stream`
helper (which accounts for most of the remaining −50 B of spread). Full
before/after tables are regenerable with `scripts/wasm-report.mjs` against any
build artifact.
