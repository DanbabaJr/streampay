# Persistent fuzz campaign

The per-PR and nightly fuzz jobs run each target for minutes. That finds shallow bugs. The persistent campaign runs for **hours**. It carries its corpora from one run to the next, so each run starts where the last one stopped. It also drives **stateful sequences**: many concurrent streams across several assets, against both the reference model and the shipped wasm. Every crash it finds becomes a minimised, runnable seed.

## What runs

| Target | Drives | Crash criterion |
|---|---|---|
| `campaign` | Stateful op sequences against the **natively compiled** contract and the reference model (#16) | Any divergence between them |
| `campaign_wasm` | The same sequences against the **release wasm** in the Soroban VM | Any divergence between them |
| `differential` | Pure accrual and fee math, contract vs model | Any divergence |
| `conservation` | Multi-token value conservation over random state transitions | Any broken invariant |
| `streamed_at` | The accrual function's properties | Any broken property |
| `rate_schedule` | Piecewise (renegotiated) accrual over random segment sequences (#54), contract vs two models | Any divergence from the floor-division model, any residue against the division-free `Σ rate × elapsed` model, any broken bound or monotonicity |

### The campaign harness (`fuzz/src/campaign.rs`)

Each input decodes to at most 256 operations. Every operation is applied to both the contract and `StreamPayModel`. After **every** operation the harness compares everything the two share:
- every user's balance in every asset;
- the contract's balance in every asset;
- every stream's fields, its `available` amount and its fee;
- every asset's treasury.

The first difference panics with `DIVERGENCE at step N after <op>: <what differed>`. That panic is the crash criterion.

What the campaign adds over the #16 harness:

- **Many concurrent streams.** Up to 64 per input. Operations name a stream by `pick`, which a round-robin cursor resolves, so a long sequence touches every live stream instead of piling onto stream 1. `Sweep` withdraws from the next *n* streams in turn, the traffic a payroll run produces. `pick = 255` names a stream that doesn't exist, which keeps the not-found paths covered.
- **Several assets.** Three Stellar Asset Contracts, each with its own treasury, so cross-asset accounting is checked on every step.
- **Boundary-biased amounts.** Zero, negatives, `i128::MAX` and raw `i128` are each one byte away. The #16 generator caps amounts at 10¹², and that cap is exactly what hid KD-1 (below).
- **The wasm.** `campaign_wasm` registers the release artifact, so the bytes that ship are the bytes under test. The VM gives libFuzzer no coverage feedback from inside the contract, so this target starts from the corpus `campaign` has grown, and the runner seeds it from there.

**What it cannot test:** authorisation. The harness runs under `mock_all_auths`, as #16's does, so every `require_auth` passes. Auth is covered by the contract's own unit tests. This is also why `top_up` is modelled with the stream's sender as caller. The #16 harness hands the model an arbitrary caller, which the model then rejects even though the contract (correctly, under mocked auth) accepts. That is an artifact of the harness, not a contract bug.

## Running it

```sh
# A self-hosted box: 8 hours, round-robin 30-minute slices, one worker per core.
scripts/fuzz/campaign.sh --hours 8

# Short local run.
scripts/fuzz/campaign.sh --hours 0.5 --targets campaign,differential --slice-min 5 --jobs 2

# Include the wasm target.
cargo build -p streampay-contract --target wasm32v1-none --release
STREAMPAY_WASM=$PWD/target/wasm32v1-none/release/streampay_contract.wasm \
  scripts/fuzz/campaign.sh --hours 8 --targets campaign,campaign_wasm,differential,conservation,rate_schedule,streamed_at
```

The runner does five things:
1. Builds every target once.
2. Rotates through the targets in time slices until the budget is spent, running N workers per slice on a shared corpus.
3. Appends each slice's libFuzzer statistics to `fuzz/campaign/<run>/runs.jsonl`.
4. Merges each corpus down to its minimal set.
5. Writes `REPORT.md`.

cargo-fuzz normally needs nightly. With only a stable toolchain, set `RUSTUP_TOOLCHAIN=stable RUSTC_BOOTSTRAP=1`. The runner uses `--sanitizer none` by default. These are safe-Rust targets checking a logical oracle, so ASan adds cost without adding findings.

**In CI:** `.github/workflows/fuzz-campaign.yml` runs every Saturday, with one 5-hour job per target in parallel (GitHub caps a job at 6 hours). A final job combines them into one report in the job summary. On the canonical repository it then pushes the merged corpora and the report to the `fuzz-corpus` branch. Each job first replays every seed in `fuzz/regressions/<target>/`, so a fixed bug stays fixed.

## Corpus and artifacts: the `fuzz-corpus` branch

Corpora live on an **orphan branch**, `fuzz-corpus`, which shares no history with `main`. Corpus churn therefore never reaches `main`'s history or clone size. `scripts/fuzz/corpus-sync.sh pull` and `push` move them.

```
corpus/<target>/        minimised corpus (libFuzzer -merge=1 output)
regressions/<target>/   triaged crashers, kept forever
reports/<date>.md       one report per campaign
```

**Size discipline.** `corpus-sync.sh push` enforces the first three rules and refuses to push otherwise.
- Only merged corpora are pushed. `campaign.sh` merges before it exits, and merging typically cuts a corpus by 80–95%.
- Each input is at most 4 KiB, the campaign's `-max_len`.
- Each target's corpus is at most **20 MiB**. Past that, the corpus has outgrown what a merge can fix. Find out why (usually a target admitting near-duplicate inputs) before raising the cap.
- If the branch's history grows past about 500 MiB, a maintainer replaces it with a fresh orphan branch holding only the current snapshot. Reports older than a year can go with it.

Locally, `fuzz/corpus/`, `fuzz/artifacts/`, `fuzz/campaign/` and `fuzz/triage/` stay ignored by git.

## Triage: from crasher to issue

```sh
scripts/fuzz/triage.sh            # all targets
scripts/fuzz/triage.sh campaign   # one target
```

Each new crasher becomes a bundle in `fuzz/triage/<target>-<signature>/`:

| File | Contents |
|---|---|
| `seed.bin`, `seed.b64` | The input after `-minimize_crash`, raw and base64 |
| `repro.sh` | One command that reproduces it from a clean checkout |
| `trace.txt` | The panic, plus the decoded operation sequence |
| `ISSUE.md` | A ready-to-file issue body with the seed inline |

The **signature** is the panic message with numbers stripped, so many inputs hitting one bug count as one entry. `fuzz/triage/INDEX.json` records each signature's status (`new`, `filed #N`, `fixed`, or `known KD-N`), and the campaign report shows it next to each crash.

**Rules:**
1. Every issue filed from a crasher carries its seed. Paste `ISSUE.md`, which already includes the seed in base64 and the command to run it.
2. When the fix lands, the same PR adds `seed.bin` to `fuzz/regressions/<target>/`. CI replays it before every campaign.
3. A divergence that is a model gap rather than a contract bug gets a `KD-N` entry below, with a suppression gated behind `STREAMPAY_FUZZ_STRICT`, so it can't swallow every later crash while it waits for a fix.

`STREAMPAY_FUZZ_TRACE=1` makes the campaign targets print an input's decoded operations before running it.

## Known divergences

### KD-1 — the model lets a sender's balance go negative

**Found by:** the first campaign execution of `campaign`.

**Behaviour:** `StreamPayModel::create_stream` (and `top_up`) debit the sender with `checked_sub`, which fails only on `i128` overflow. A deposit larger than the sender's balance or allowance succeeds in the model, while the contract correctly returns `DepositTransferFailed` (or `TopUpTransferFailed`). The #16 generator never draws an amount above 10¹² against balances of 10¹³, so its tests cannot reach this.

**Minimised seed:** `fuzz/known/KD-1/seed.bin`, 22 bytes, one operation:
```
0: Create { asset: 66, sender: 103, recipient: 119, deposit: Large(133092510986242), start_delay_secs: 65439, duration_secs: 255, cancelable: false }
DIVERGENCE at step 0: create_stream: contract=Err(DepositTransferFailed) model=Ok(1)
```

**Reproduce:**
```sh
cd fuzz && STREAMPAY_FUZZ_STRICT=1 STREAMPAY_FUZZ_TRACE=1 cargo fuzz run campaign known/KD-1/seed.bin
```

**Status:** to be filed. The fix belongs in the model: reject a pull exceeding the sender's balance (and model allowances). Until then the campaign skips any operation that would pull within 2% of the sender's balance or allowance (the 2% is fee headroom). Remove the suppression in `Campaign::exceeds_funds` once the model is fixed.

## Reading a report

| Column | Meaning |
|---|---|
| **Runs/sec** | Executions per second for that target, summed over its workers. One campaign execution is a whole sequence of up to 256 operations, each followed by a full state comparison, so expect hundreds per second, not the hundreds of thousands a pure-function target reaches. |
| **Edge coverage** | libFuzzer's covered edges over the instrumented edges in the binary. The binary links the Soroban host and SDK, so the percentage is small and best read as a trend. **Coverage gained** shows what this run added. |
| **Source coverage** | Line, function and region coverage of the contract's own source, from `scripts/fuzz/coverage.sh`. Needs `llvm-tools` and is filled in by the weekly CI job. |
| **Crashes** | Each signature found, with its triage status. |
