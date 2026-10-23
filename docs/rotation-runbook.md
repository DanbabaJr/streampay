# Key Rotation Runbook

Procedures for rotating every privileged role StreamPay operates, with a
verification step **per surface** and explicit handling of live-stream
implications (in-flight amendments, scheduled refills, re-authorizing agent
sets). Pair with [`docs/ceremony.md`](./ceremony.md) (how replacement keys are
generated) and [`docs/OPERATIONS.md`](./OPERATIONS.md) §2 (secret inventory).

Two rules before any rotation:

1. **Routine vs. emergency.** This runbook is the *routine* path (planned
   rotation, old key presumed intact). A suspected compromise follows
   [`docs/KEY_COMPROMISE_TEMPLATE.md`](./KEY_COMPROMISE_TEMPLATE.md) first;
   its containment section then hands off to the rotation steps here with the
   freeze flag enabled (step 0 below).
2. **Two-step everywhere.** Both on-chain roles rotate by
   propose/nominate → accept. Never skip the accept step "to save a
   transaction": the nominee's `accept_*` call is the proof that the new key
   is usable and not a mistyped address that would strand the role.

---

## 0. Optional governor freeze (compromise path only)

For a *routine* rotation, do **not** freeze: streams keep running and the
runbook is invisible to users. For an emergency rotation, freeze first so a
mid-rotation attacker cannot create streams while control is in flux:

```bash
stellar contract invoke --id <CONTRACT_ID> --source <OLD_GOVERNOR> --network <net> \
  -- set_frozen --caller <OLD_GOVERNOR_ADDRESS> --frozen true
```

Verify: `is_frozen` reads `true`. Remember to unfreeze (§2 step 6) after the
new governor accepts. Freeze blocks `create_stream`, `withdraw`,
`withdraw_max`, `cancel_stream`, and `top_up`; reads and governance keep
working (`set_frozen` does not gate itself), which is why rotation can proceed
while frozen.

## 1. Treasury governor rotation

The governor gates: `set_fee_bps`, `nominate_governor`, `accept_governor`,
`withdraw_treasury`, `set_stream_policy`, `set_frozen`, `propose_upgrade`,
`cancel_upgrade`, `execute_upgrade`, `migrate_storage`
([`lib.rs`](../contracts/streaming-payments/src/lib.rs)). Bound at deploy time
by `__constructor`; rotated two-step.

> **If governance has been bootstrapped (issue #119), step 2 below is itself a
> proposal.** `nominate_governor` is one of the entry points the two-key timelock
> closes: after `governance_bootstrap`, calling it directly reverts with
> `GovernanceTimelockRequired` (code 79). Propose
> `GovernanceAction::NominateGovernor(<NEW_GOVERNOR_ADDRESS>)` instead, collect
> two distinct signer signatures, wait out the veto window, and execute — then
> the nominee still calls `accept_governor` directly, because that step proves
> the new key is usable and is performed by the *new* governor, not by
> governance. Note that this runbook rotates the governor address; the signer
> set that governs the timelock is a different role and rotates through
> `GovernanceAction::SetSigners` (§3a) — deliberately slower, at 4× the veto
> window, and executable on a single signature so that one honest keyholder can
> replace a lost or stolen key in the open. The full gated surface is listed in
> [`docs/UPGRADES.md`](./UPGRADES.md), §"Phases 2-6 After Governance Bootstrap".


1. **Prepare** the new governor address per the ceremony
   ([`docs/ceremony.md`](./ceremony.md) §3). If it is a multisig account, fund
   it with dust and confirm its threshold before nominating.
2. **Nominate** (old governor signs):
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <OLD_GOVERNOR> --network <net> \
     -- nominate_governor --caller <OLD_GOVERNOR_ADDRESS> --new_governor <NEW_GOVERNOR_ADDRESS>
   ```
3. **Accept** (new governor signs):
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <NEW_GOVERNOR> --network <net> \
     -- accept_governor --caller <NEW_GOVERNOR_ADDRESS>
   ```
4. **Verify the governance surface:**
   - `treasury_status <TOKEN>` returns `governor == <NEW_GOVERNOR_ADDRESS>` and
     `pending_governor == null` — this single read covers the role binding and
     confirms no stale nomination is left for a third party to accept.
   - Auth probe (testnet or a 1-stroop-valued real check): `set_fee_bps` with
     the **old** key must revert; with the **new** key it must succeed. The
     quarterly drill automates exactly this probe for the whole surface
     ([`scripts/key_rotation_drill.ts`](../scripts/key_rotation_drill.ts)).
   - **In-flight amendment check:** if an upgrade was mid-flight
     (`pending_upgrade` non-null), it survives rotation and remains
     executable by the new governor only — re-verify `pending_upgrade` still
     points at the intended wasm hash, and let `execute_upgrade` be the new
     governor's first act, or `cancel_upgrade` it.
   - **Treasury continuity:** `withdraw_treasury` of *zero* value reverts by
     design; verify continuity by reading `treasury_status` fee totals before
     and after — `charged_total`/`withdrawn_total` must be unchanged by the
     rotation (rotation never touches the fee ledger).
5. **Old key hygiene:** if the old governor is a departing maintainer's key,
   remove it from any multisig signer set it belonged to (§5) and re-split
   per the ceremony §6. A plain `nominate`→`accept` does **not**
   automatically retire signer keys embedded in a multisig account.

## 2. Policy admin rotation (per employee)

The policy admin gates `policy_propose_asset`, `policy_set_timelock_delay`,
`policy_propose_handoff`, `policy_cancel_handoff`
([`policy.rs`](../contracts/streaming-payments/src/policy.rs)). One rotation
per admin; every admin rotates on their own cadence and on offboarding.

1. **Check for in-flight amendments** (do this first):
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <anyone> --network <net> \
     -- policy_get_queued_asset --asset <ASSET>
   stellar contract invoke --id <CONTRACT_ID> --source <anyone> --network <net> \
     -- policy_pending_admin
   ```
   - A **queued allowlist change** is bound to the asset, not the admin: it
     survives rotation and becomes executable permissionlessly after its
     timelock (`policy_execute_asset` needs no admin). Decide explicitly:
     leave it (it will execute on schedule), or have the *old* admin re-queue
     the opposite change before handing off.
   - A **pending handoff** blocks a new one. The old admin either completes it
     (`policy_accept_handoff` by the nominee) or cancels it
     (`policy_cancel_handoff`) before proposing the real successor — do not
     "chain" handoffs.
2. **Propose** (old admin signs):
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <OLD_ADMIN> --network <net> \
     -- policy_propose_handoff --new_admin <NEW_ADMIN_ADDRESS>
   ```
3. **Accept** (new admin signs):
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <NEW_ADMIN> --network <net> \
     -- policy_accept_handoff
   ```
4. **Verify the policy surface:**
   - `policy_admin` returns the new address; `policy_pending_admin` is null.
   - Auth probe: `policy_set_timelock_delay` with the old key reverts; with
     the new key it succeeds (the drill asserts both).
   - **Anti-brick spot check:** if any asset was delisted mid-rotation, create
     a throwaway stream with the *listed* path and confirm `withdraw` still
     settles on a pre-existing stream of any delisted asset — rotation must
     never have touched allowlist state (`policy_is_asset_allowed` before/after
     for every queued asset).
5. **In-flight timelocks:** a rotation resets nothing about
   `policy_timelock_delay`; re-read it and confirm it matches the publicly
   advertised delay (`policy_timelock_delay` is user-visible notice, changing
   it silently during a rotation would shorten the safety window).
6. **Unfreeze** if step 0 ran:
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <NEW_GOVERNOR> --network <net> \
     -- set_frozen --caller <NEW_GOVERNOR_ADDRESS> --frozen false
   ```

## 3. Treasury signer rotation (inside the multisig set)

When the governor/admin is a multisig account, rotating a *member* of the
signer set is a Stellar account operation, not a contract call:

1. Add the replacement signer (`set_options`, signer weight 1) — new signer.
2. Verify: account response shows N+1 signers and `med_threshold = 2` still
   holds (thresholds never auto-adjust).
3. Remove the retired signer (`set_options` signer with weight 0) — old signer
   (or, if it is the compromised case, any remaining 2-of-3 does this).
4. Verify: exactly the intended signer list remains, and a 2-of-3 test
   signature succeeds while the retired key alone fails (the ceremony §4.6
   probe).
5. Record signer-set change in [`docs/SECURITY_LOG.md`](./SECURITY_LOG.md).

## 3a. Governance signer rotation (the contract's two-key set)

Distinct from §3: those are Soroban *account* signers; these are the addresses
held in the contract's own governance set, which is what closes the admin entry
points after bootstrap. Rotating them is the containment path for a lost or
stolen signer key, so the contract gives it a longer window and a lower quorum:
**4× the configured veto window, executable on a single signature.**

A deployment that has never called `governance_bootstrap` has no signer set; the
governor establishes one once, and it can never be re-set directly afterwards.

```bash
# 1. Propose the new set (a signer's key, not the governor's).
stellar contract invoke --id <CONTRACT_ID> --source <SIGNER_A> --network <net> \
  -- governance_propose --caller <SIGNER_A> \
  --action '{"set_signers":["<SIGNER_B_ADDRESS>","<SIGNER_C_ADDRESS>"]}'

# 2. The other keyholder signs — or vetoes, which one signer can do at any
#    time before the window closes.
stellar contract invoke --id <CONTRACT_ID> --source <SIGNER_B> --network <net> \
  -- governance_sign --caller <SIGNER_B> --proposal_id 1

# 3. After 4x the veto window, anyone may execute. It is permissionless on
#    purpose: an offline or compromised keyholder cannot suppress a rotation.
stellar contract invoke --id <CONTRACT_ID> --source <ANY_ACCOUNT> --network <net> \
  -- governance_execute --executor <ANY_ACCOUNT> --proposal_id 1
```

Rules the contract enforces, so a ceremony cannot quietly create a set that is
one key in two slots:

* Sets are validated **at propose time**: empty, duplicated or larger than
  `MAX_SIGNERS` (10) candidates revert.
* Execution re-checks every recorded signature against the **live** set, so
  rotating out a key invalidates the proposals that key had half-signed. Those
  proposals stay permanently unexecutable — re-propose them under the new set.
* A set of two distinct keys is the minimum; adding a third buys no additional
  safety, because the property is distinctness, not headcount.

**Verify:** `governance_signers` returns the intended set,
`governance_is_initialized` is `true`, `governance_veto_window` still matches the
advertised window, and a direct `set_fee_bps` from the *removed* key reverts with
`GovernanceTimelockRequired` (code 79). Log the rotation with the
`governance_signers_set` event ledger.

## 4. Live-stream implications (must-check list)

Rotation changes *who may govern*; it must change *nothing* about streams,
escrow, or settlement. These are the surfaces people forget:

| Surface | Risk during rotation | Verification step |
|---|---|---|
| **Active streams** | None by design — sender/recipient auth is independent of governor/admin. Confirm it stayed that way. | Post-rotation: `available` on a pre-rotation stream returns a sane accrual, and a recipient `withdraw_max` settles on testnet (drill: continuity row). |
| **Scheduled refills / recurring intents** | `execute_scheduled` is keeper-signed, not governor-signed — rotation must not strand queued intents. | Post-rotation: execute a pre-rotation one-shot intent with a fresh keeper key; assert `ScheduledStreamExecuted` fires and the keeper receives `fee_budget`. |
| **In-flight amendments** | Stale `pending_upgrade` or queued allowlist change executing under the *new* governor; orphaned `PendingGovernor`/`PendingAdmin`. | `pending_upgrade`, `policy_get_queued_asset`, `treasury_status.pending_governor`, `policy_pending_admin` all read back as intended (§1.4, §2.1, §2.4). |
| **Agent sets re-authorized** | Off-chain agents still trusting the old key or an old webhook secret. | Per agent below (§5). |
| **Fee ledger** | Rotation tx itself must not mint/charge fees. | `treasury_status` totals identical before/after (§1.4). |
| **User-visible delay** | Emergency freeze pauses withdrawals. | Track freeze window; unfreeze is step 2.6 and gets its own log entry. |

## 5. Operational agent re-authorization

On-chain rotation is half the job; the agent set must be re-pointed. Each
entry ends with its verification step. (Inventory and blast radii:
[`docs/OPERATIONS.md`](./OPERATIONS.md) §2.1.)

| Agent | Rotation action | Verification step |
|---|---|---|
| **Keeper fleet** (`scripts/keeper.sh` reference keeper) | Keeper keys are ephemeral per-run, but any *standing* keeper identity rotates like an operational key. No contract change: keeper auth is per-call. | Execute a due intent with the new keeper key (§4 row 2). Confirm the old standing keeper key, if any, still can execute (that is by design — it is permissionless) but is decommissioned in config. |
| **TTL sentinel extender** (`TTL_SENTINEL_EXTENDER_SECRET`) | Generate new keypair, fund ≤ 30-day XLM budget, update host env var, restart sentinel (`docs/OPERATIONS.md` §2.1 row 2). | Sentinel logs a successful `ExtendFootprintTTL` submission from the **new** key; old key balance drained to ≤ dust. Budget meter (`monthlyBudgetXlm`) unchanged. |
| **CI deployer** (`MAINNET_DEPLOYER_SECRET`, GitHub Environment `mainnet-canary`) | Generate new keypair, fund base XLM, update the Environment secret, drain old key (`docs/OPERATIONS.md` §2.1 row 1). | Dry-run `promote.yml` with `dry_run: true` resolves the new secret; a real `workflow_dispatch` deploy to testnet signs from the new key. Old address shows ~0 XLM on explorer. Deployer has zero post-deploy privileges ([`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) §4), so no contract surface needs re-authorization. |
| **Webhook receivers** (delivery + on-call URLs) | Rotate at the provider; StreamPay webhook delivery supports dual signatures across the overlap window ([`docs/WEBHOOKS.md`](./WEBHOOKS.md) §"Overlap window") — install the new secret, keep the old until traffic confirms, then drop the old. | Receiver verifies dual-signed traffic during overlap, then single-signed with the new secret after cutoff. Zero dropped events = pass. |
| **On-call ping** (`ONCALL_WEBHOOK_URL`) | Regenerate webhook, update repository secret (`docs/OPERATIONS.md` §2.1 row 4). | `.github/workflows/oncall-ping.yml` next scheduled run posts to the new URL. |
| **Netlify deploy account** | Re-authenticate GitHub OAuth / rotate team membership (`docs/OPERATIONS.md` §2.1). | A no-op deploy preview succeeds; old token revoked. |

## 6. Cadence and automation

- **Quarterly drill** (first of Jan/Apr/Jul/Oct, via
  [`.github/workflows/key-rotation-drill.yml`](../.github/workflows/key-rotation-drill.yml)):
  [`scripts/key_rotation_drill.ts`](../scripts/key_rotation_drill.ts) performs
  a full governor + policy-admin rotation against a **fresh testnet deploy**
  and asserts that no privileged operation survives an old key — every matrix
  row must be green. The pass/fail matrix artifact attaches to the run.
- **On offboarding**: rotate every row of §5 plus the departing member's
  signer share within 24 h (`docs/OPERATIONS.md` §2.2 rule 4).
- **On contract redeploy**: the constructor binds the governor at deploy time
  (`__constructor`), so a redeploy *is* a governor rotation — run §1.4
  verification against the new contract id and update every agent config that
  pins the old contract id.
- Every rotation (drill or manual) gets one line in
  [`docs/SECURITY_LOG.md`](./SECURITY_LOG.md): role, old/new address (public),
  block/ledger, who ran it, matrix artifact link.
