# Mainnet canary runbook

Operator procedure for promoting a StreamPay release through
testnet into a mainnet canary, deciding whether to keep it, and rolling it back
if it misbehaves. Read [`DEPLOY_PIPELINE.md`](./DEPLOY_PIPELINE.md) first.

> **Principle:** a public chain cannot be un-deployed. Every step here is
> forward-only; "rollback" is a new deploy of the last known-good digest, and
> the runbook says so plainly instead of implying a reversal.

## 0. Preconditions

Before dispatching a promotion:

- [ ] The release tag exists and its `release.yml` run published
      `streampay_contract.wasm` **and** `SHA256SUMS`.
- [ ] The tag is cut from a commit that includes `.github/workflows/promote.yml`
      and `scripts/` (otherwise the pipeline cannot run).
- [ ] The GitHub Environments `testnet` and `mainnet-canary` exist and have the
      required reviewers configured.
- [ ] The `mainnet-canary` environment has `MAINNET_DEPLOYER_SECRET` set to a
      funded Stellar mainnet secret key.
- [ ] Repository variable `PROMOTION_ISSUE` points at the pinned log issue.
- [ ] You have read the diff since the last promoted tag and know whether the
      contract interface changed (§2, step 2).

## 1. Who approves what

| Boundary | Approver |
|---|---|
| sandbox → testnet | any maintainer (testnet is disposable) |
| testnet → mainnet canary | a maintainer who is **not** the author of the contract change, and who has read the testnet canary output |

The mainnet-canary approval is the last human checkpoint before real funds are
exposed. Treat it as a sign-off, not a rubber stamp.

## 2. Promotion procedure

1. **Dispatch** `Promote` (`workflow_dispatch`) with `release_tag`, `through`,
   and `schema_change_ack` as appropriate. Use `dry_run = true` for a first
   sanity pass if anything about the pipeline changed.
2. **Sandbox gates.** When the `sandbox` job finishes, open the
   `evidence-sandbox-<tag>` artifact and confirm:
   - `tests.log` — all green;
   - `fuzz.log` — completed the budget with no crash (or the skip is recorded
     and justified);
   - `digest-continuity.txt` — `digest-continuity: OK`, i.e. the rebuild matches
     the published digest;
   - `schema-diff.txt` — `unchanged`, or `change acknowledged` with a diff you
     have actually read.
   If the schema changed and you did not mean to change the interface, **stop**
   and treat it as a bug.
3. **Approve the `testnet` environment.** The testnet job then downloads the
   published Wasm, re-verifies its digest, deploys, runs the canary checks, and
   records the promotion. Confirm the canary output (`canary: PASS`) and the
   recorded line before continuing.
4. **Approve the `mainnet-canary` environment** (only if `through =
   mainnet-canary`). The job deploys the published Wasm to mainnet and runs the
   canary checks.
5. **Watch the canary.** The canary window is the period between the deploy and
   the decision to keep it. Minimum: one full ledger cycle plus the smoke stream
   check. Recommended: 60 minutes, watching `available` on the smoke stream
   ticking up and the contract's account not running out of XLM.
6. **Keep or roll back.** If every check passes and no alert fires, the canary
   is accepted — the promotion record already reflects it (`result=promoted`).
   Otherwise go to §4.

## 3. Canary checks and pass/fail criteria

`scripts/canary_check.sh <env> <contract-id>` runs three checks; **any failure
is a rollback trigger**.

| # | Check | Passes when | Why it matters |
|---|---|---|---|
| 1 | Schema continuity | The on-chain interface hash equals `deployments/interface/<env>.sha256` | Catches a wrong Wasm or a stale deploy pointer |
| 2 | Liveness | A read call returns — either data or the typed `StreamNotFound` (#1) error | Proves the contract answers; a transport error is a failure |
| 3 | Economics | The smoke stream's `available` is ≥ 0 and non-decreasing across two reads | Catches broken accrual or wrong token wiring |

Additional watch items during the window (not automated):

- the deployer/contract account has enough XLM for TTL extensions;
- no unexpected `StreamError` codes in client logs;
- the smoke stream's `available` growth matches `deposit / duration`.

## 4. Rollback criteria

Roll back **immediately** if any of these is true:

- any canary check in §3 fails;
- the deployed Wasm digest does not match the promoted digest (detected by
  check 1);
- funds move incorrectly, or a security invariant from `SECURITY.md` is
  violated (this is also a private security report — see `SECURITY.md`);
- the contract is unresponsive for more than ~5 minutes.

Do **not** roll back for:

- a fee spike (it changes cost, not correctness);
- frontend-only issues (fix and redeploy the frontend; the contract is fine);
- expected test transactions from the smoke stream.

## 5. Rollback procedure

### 5.1 Automatic

If the `mainnet-canary` job fails, the `rollback` job runs (still behind the
`mainnet-canary` environment approval) and executes
`scripts/rollback_mainnet.sh`, which:

1. resolves the last `result=promoted` tag for the environment
   (`ROLLBACK_TO_TAG` override → the promotion issue → the repo log);
2. downloads that release's Wasm and verifies its digest against the release's
   `SHA256SUMS`;
3. deploys it as a **new** contract id;
4. runs the canary checks against the restored instance;
5. records the event with `result=rolled-back`.

If the rollback's own canary fails, the script aborts and says so — the last
known-good digest is no longer known good, and a human must decide.

### 5.2 Manual

```bash
ROLLBACK_TO_TAG=v0.3.0 \
STELLAR_SOURCE_KEY=mainnet-deployer \
scripts/rollback_mainnet.sh mainnet-canary
```

Then, in one go:

1. **Re-point clients.** Update the frontend's
   `NEXT_PUBLIC_STREAMING_CONTRACT_ID` and redeploy it. The stream-id cache is
   network-scoped, so old ids silently stop resolving; re-index from
   `StreamCreated` events rather than trusting the cache.
2. **Recover in-flight funds per stream.** Recipients can always
   `withdraw_max`; senders can `cancel_stream` a stream they funded. There is no
   on-chain migration to run and no admin key to freeze anything — this is the
   recovery path.
3. **Replay client state.** Any queued signed intents (the fee-aware claim queue
   and the PWA offline queue, which share `pending-queue.ts`) carry the old
   account sequence and the old contract id; discard and re-sign them.
4. **Announce.** Post the incident and the rollback record link in the promotion
   issue and any public channel in use.

## 6. After a rollback

- [ ] Confirm the restored contract id passes all three canary checks (§3).
- [ ] Confirm the rollback line is in `deployments/promotions.log` /
      `deployments/runs/` and the promotion issue.
- [ ] Open a post-mortem issue: what failed, which gate should have caught it,
      and what evidence was missing.
- [ ] If a gate was missing, add it to `scripts/release_gates.sh` **and** to the
      rehearsal so the dress rehearsal covers it.
- [ ] Do not re-attempt the failed release until the cause is fixed and the
      sandbox gates pass again on a new tag.

## 7. Escalation

- Funds at risk or a security invariant violated → follow `SECURITY.md`
  (private report), and page the maintainers in `.github/CODEOWNERS`.
- Pipeline broken (a gate cannot run) → fix the gate, run
  `scripts/promote_rehearsal.sh`, and land the fix before promoting anything.
- Ambiguous canary result → **default to rollback**. A false rollback costs a
  deploy; a missed one can cost funds.
