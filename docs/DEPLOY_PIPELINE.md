# Deployment pipeline: sandbox → testnet → mainnet canary

How a contract change reaches Stellar mainnet, what has to be true before each
step is allowed to touch a network, and what "rollback" can actually mean on a
public chain.

Everything is **manually gated at first**: the design is the deliverable, and
the gates are real but conservative. Tightening comes later, once the gates have
a track record.

- Workflow: [`.github/workflows/promote.yml`](../.github/workflows/promote.yml)
- Rehearsal: [`.github/workflows/rehearsal.yml`](../.github/workflows/rehearsal.yml)
- Scripts: [`scripts/release_gates.sh`](../scripts/release_gates.sh),
  [`verify_release_digest.sh`](../scripts/verify_release_digest.sh),
  [`contract_interface_hash.sh`](../scripts/contract_interface_hash.sh),
  [`schema_diff.sh`](../scripts/schema_diff.sh),
  [`deploy_contract.sh`](../scripts/deploy_contract.sh),
  [`canary_check.sh`](../scripts/canary_check.sh),
  [`record_promotion.sh`](../scripts/record_promotion.sh),
  [`rollback_mainnet.sh`](../scripts/rollback_mainnet.sh)
- Canary procedure: [`CANARY_RUNBOOK.md`](./CANARY_RUNBOOK.md)
- Records: [`deployments/`](../deployments/README.md)

## 1. Environments

| Environment | What it is | Gate | Approval |
|---|---|---|---|
| **sandbox** | The CI gate job. No network, no funds. | tests, fuzz soak, reproducible digest, schema diff | none (CI) |
| **testnet** | Stellar testnet. | sandbox green + digest continuity | GitHub Environment `testnet` (required reviewers) |
| **mainnet canary** | Stellar mainnet, deployed as a canary. | testnet promoted + digest continuity | GitHub Environment `mainnet-canary` (required reviewers) |

Environments are GitHub Actions Environments with **required reviewers**, so a
run pauses at each boundary until a maintainer approves it in the Actions UI.
`mainnet-canary` additionally owns the `MAINNET_DEPLOYER_SECRET` secret, so the
mainnet signing key is never available to the sandbox or testnet jobs.

The pipeline is dispatched with `workflow_dispatch`:

| Input | Meaning |
|---|---|
| `release_tag` | The tag to promote. Must have a published Wasm + `SHA256SUMS` asset from `release.yml`. |
| `through` | `testnet` (default) or `mainnet-canary`. Mainnet always depends on a successful testnet job. |
| `schema_change_ack` | Acknowledge a contract-interface change (see §3). |
| `dry_run` | Dress rehearsal: run the gates for real, mock the deploys. |

## 2. Gates and the evidence each collects

`scripts/release_gates.sh` runs in the sandbox job and writes an evidence
bundle (uploaded as the `evidence-sandbox-<tag>` artifact):

| Gate | Script | Evidence | Fails when |
|---|---|---|---|
| Contract tests | `cargo test -p streampay-contract --locked` | `tests.log` | any test fails |
| Fuzz soak | `cargo +nightly fuzz run streamed_at` | `fuzz.log` | any crash, or the toolchain is missing (unless `ALLOW_FUZZ_SKIP=1` records the gap explicitly) |
| Reproducible digest | `stellar contract build` + SHA-256 | `SHA256SUMS`, `digest.txt` | the build produces no Wasm |
| Digest continuity | `verify_release_digest.sh` | `digest-continuity.txt` | the rebuilt Wasm's SHA-256 differs from the release's published digest |
| Contract interface | `contract_interface_hash.sh` | `interface.json`, `interface.sha256` | the interface cannot be extracted |
| Schema diff | `schema_diff.sh` | `schema-diff.txt` | the interface changed and was not acknowledged |
| Summary | — | `summary.md` | — |

The fuzz soak is a fixed wall-clock budget (default 60 s locally, 120 s in CI),
not a coverage target: it is a smoke test for the accrual math, and the
scheduled `fuzz.yml` session is the deep run. A skipped soak is recorded in the
evidence, never silently passed.

## 3. Digest continuity

The rule: **each promotion step verifies against the release workflow's
SHA-256, never a local build.**

- `release.yml` builds the Wasm on the tag, publishes `streampay_contract.wasm`
  and a `SHA256SUMS` asset, and prints the digest in the release body.
- The sandbox gate rebuilds from the tagged source and asserts the rebuild has
  the *same* digest (`digest-continuity.txt`). If the build is not reproducible,
  this gate fails before anything else happens.
- Each deploy job downloads the **published Wasm asset** (not the local build)
  and re-runs `verify_release_digest.sh` immediately before deploying, so the
  bytes that go on chain are provably the reviewed artifact.
- The rehearsal has no published release to compare against, so it publishes a
  synthetic `SHA256SUMS` from its own build and verifies the check end-to-end
  (`SYNTHETIC_RELEASE=1`, clearly marked in the evidence). Production never uses
  that path.

`stellar contract build` does not embed a timestamp, so two builders should
reproduce the same bytes; if they do not, that is a bug to fix, and this gate is
where it surfaces.

## 4. Contract interface (schema) diff

StreamPay's public interface — `create_stream` / `withdraw` / `withdraw_max` /
`cancel_stream` / `top_up` / `get_stream` / `available` /
`recipient_streams` / `sender_streams`, the `StreamError` codes, and the event
structs — is what clients bind to. `scripts/contract_interface_hash.sh` extracts
it from the Wasm with `stellar contract info interface --output json`,
canonicalizes it, and hashes it.

The baseline for each environment lives in
[`deployments/interface/<env>.sha256`](../deployments/interface) (with the full
JSON alongside it for a readable diff). `schema_diff.sh`:

- no baseline yet → "first promotion", pass;
- identical → pass silently;
- different → print a truncated interface diff and **fail unless**
  `SCHEMA_CHANGE_ACK=1` (the `schema_change_ack` input).

A schema change is a product decision — it can break integrators. The gate makes
that decision explicit and recorded rather than accidental.

## 5. Records

Every promotion writes (see [`deployments/README.md`](../deployments/README.md)):

1. an **append-only line** in `deployments/promotions.log`;
2. a per-run markdown record in `deployments/runs/<timestamp>-<env>.md` listing
   the event and the gate-evidence artifacts;
3. in CI, a **comment on the pinned promotion issue** (`PROMOTION_ISSUE`
   repository variable) and the evidence uploaded as a workflow artifact.

The issue thread is the durable log (GitHub issue comments are append-only),
the artifacts hold the evidence, and the repo files are the human-readable
mirror. Nothing is ever rewritten — a correction is a new line.

## 6. Rollback on a public chain

A Soroban contract **cannot be un-deployed**: the code is immutable at its
address, and existing stream state lives there. So a rollback is not a
reversal — it is a *forward recovery* and there are three honest options:

| Situation | What rollback is |
|---|---|
| The canary deploy is broken before any real funds move | Deploy the last known-good digest as a **new** contract id and re-point clients. Nothing was lost. |
| The deployed code is wrong but has live streams | Recover funds per-stream (recipients can always `withdraw_max`; senders can `cancel_stream`), then deploy the known-good digest and replay the migration that moves any remaining state into new streams. |
| The failure is client-side only | No contract action; fix the frontend and redeploy it. |

`scripts/rollback_mainnet.sh` automates the first option: it finds the last
`result=promoted` tag for the environment (explicit `ROLLBACK_TO_TAG` → the
promotion issue → the repo log), downloads that release's Wasm, verifies its
digest, deploys it, runs the canary checks against the restored instance, and
records the event with `result=rolled-back`. It refuses to proceed when the
rollback deploy *also* fails its canary, because at that point the "known good"
digest is no longer known good and a human has to decide.

The workflow triggers it automatically when the mainnet-canary job fails
(`rollback` job, `if: failure()`), still behind the `mainnet-canary`
environment's approval.

Migration replay: this repo has no on-chain migration machinery today
(streams are immutable once created and there is no upgrade path — see
`docs/ARCHITECTURE.md` §8). "Migration" for StreamPay means *client* data: the
frontend's stream-id cache and any pending intents move to the new contract id
by network-scoped key, and a client-side re-index from `StreamCreated` events
rebuilds discovery. The runbook states this explicitly so nobody expects an
on-chain data migration that does not exist.

## 7. Dress rehearsal

`scripts/promote_rehearsal.sh` runs the whole pipeline with the deploys and
canary checks mocked:

```
sandbox gates (real) → testnet deploy (mock) → testnet canary (mock)
                     → mainnet-canary deploy (mock) → canary (mock) → records
```

It needs the Rust/stellar toolchain but **no secrets and no funded key**, so it
runs on any contributor machine and in CI (`.github/workflows/rehearsal.yml`,
on pull requests that touch the pipeline). It produces the same evidence bundle
and promotion records the real pipeline does, so a pipeline change is verified
before it is trusted with a release.

Limitation to be honest about: mocked deploys exercise the *control flow and
every gate*, but not chain behaviour. The first real rehearsal against a funded
testnet key is still a manual step.

## 8. Limitations and future work

- **Manual approval everywhere.** Deliberate for now. Automating promotion after
  a clean canary window is the natural next step, and the gates already produce
  the evidence such automation would need.
- **No on-chain migration path.** By design (`docs/ARCHITECTURE.md` §8). A
  future upgradeable proxy or `migrate` entrypoint would change §6 materially.
- **Fuzz soak is time-bounded**, not coverage-guided over a large corpus; the
  scheduled workflow is the deeper run.
- **Single signer.** Mainnet deploys use one key. A multisig or KMS-backed
  signer is the obvious hardening step before this is used in anger.
- **Rehearsal mocks the chain.** See §7.
