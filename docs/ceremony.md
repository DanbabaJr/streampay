# Key Ceremony

How StreamPay generates, splits, backs up, and witnesses the keys that hold
privileged roles. Written for a small OSS team (2–4 active maintainers):
pragmatic, cheap to run, and explicit about what is deliberately **deferred
until v1.0** rather than hidden.

Scope: the on-chain treasury **governor**, the policy **admin** (one per
employee who holds it), the **treasury signer set** backing them, and the
operational agents inventoried in [`docs/OPERATIONS.md`](./OPERATIONS.md) §2.1
(`MAINNET_DEPLOYER_SECRET`, `TTL_SENTINEL_EXTENDER_SECRET`, webhook URLs).
User-facing sender/recipient keys are out of scope — they are ordinary Stellar
accounts under each user's own custody.

---

## 1. Decision: protocol-native multisig + offline Shamir backup

**Decision.** Every long-lived privileged Stellar key (governor, policy admin,
treasury signer) lives in an **M-of-N multisig account native to the Stellar
protocol** (thresholds + signer weights via `set_options`). The **seed phrase /
secret key backing each signer** is split with **Shamir's secret sharing
(SLIP-0039, 2-of-3)** and the shares are distributed across maintainers'
personal password managers. CI-only secrets (`MAINNET_DEPLOYER_SECRET`,
`TTL_SENTINEL_EXTENDER_SECRET`) are likewise Shamir-split, 2-of-3.

**Why multisig on-chain, not Shamir for day-to-day signing.**

- The contract's auth model is plain `Address::require_auth`
  ([`treasury.rs`](../contracts/streaming-payments/src/treasury.rs#L150),
  [`policy.rs`](../contracts/streaming-payments/src/policy.rs#L115)). A Stellar
  multisig account satisfies this natively: the two-step handoffs
  (`nominate_governor`/`accept_governor`, `policy_propose_handoff`/
  `policy_accept_handoff`) work unchanged, and the threshold is **publicly
  auditable on-chain** — anyone can verify the governor is a 2-of-3 before
  depositing into a stream.
- Shamir protects *storage*, not *signing*. Recombining a split secret on an
  online machine to sign a transaction recreates the single-point-of-failure
  every time you rotate. We split once, at generation, for **backup and
  recovery**; signing uses independent keys that never meet.
- The rejected alternative — a third-party co-signing service (SEP-0030) or a
  smart-wallet multisig contract — adds an external dependency and new code in
  the trust path. The vault/treasury proposals will revisit threshold signing
  if the signer set outgrows 4 people.

**Configuration (v1.0 target).**

| Role | Account type | Threshold | Signers |
|---|---|---|---|
| Treasury governor | Multisig account, `med_threshold = 2` | 2-of-3 | 3 maintainer signer keys, weight 1 each |
| Policy admin (per employee) | Multisig account, `med_threshold = 2` | 2-of-3 | same maintainer keys, or a per-team sub-quorum |
| Treasury signer (proposed vault) | Signer weight within the governor account | — | same 3 keys; the "treasury signer" is the multisig itself |
| CI deployer / TTL extender | Single-sig hot key (budget-capped) | — | 1 automated key, balance-limited per `docs/OPERATIONS.md` §2.2 rule 3 |

Until the multisig accounts are funded (pre-mainnet), the governor/admin may be
single-sig maintainer keys. The two-step handoff means upgrading to multisig is
itself just a rotation per [`docs/rotation-runbook.md`](./rotation-runbook.md).

## 2. What is deferred pre-v1.0 (explicit)

Recorded so nobody mistakes pragmatism for an oversight:

- **Hardware keys (Ledger/YubiKey) for signer keys.** Deferred: cost and
  UX for a 2–4 person OSS team; the Shamir offline backup plus multisig
  threshold already requires two independent compromises to move funds.
  Revisit at v1.0 when mainnet fees are live.
- **HSM/KMS custody of CI secrets.** Deferred: GitHub Environment secrets with
  required reviewers + a 30-day XLM budget cap on the sentinel key is the
  accepted residual risk (`docs/OPERATIONS.md` §2.1).
- **Third-party witness / notarization and geographically distributed
  safe-deposit boxes.** Deferred: shares live in 3 different maintainers'
  E2E-encrypted password managers in 3 different jurisdictions of trust domain
  (employers' vaults), which we judge sufficient pre-mainnet.
- **M-of-N with N > 3.** Deferred: signer set tracks active maintainers; the
  ceremony re-runs on maintainer join/leave (see §6).

## 3. Generation procedure

Performed on an **offline host** (§4). One role at a time; the witness
checklist (§5) is filled per role.

1. **Boot the offline host** (§4.1) and verify the tool checksums (§4.2).
2. **Generate the signer keypairs** with the Stellar CLI's own RNG:
   `stellar keys generate <role>-signer-<n> --network <target>` run once per
   signer, in the air gap. For a 2-of-3: three independent generations, three
   distinct maintainers each holding "their" key.
3. **Record public material only.** Write down each `stellar keys address`
   (G…) and, for multisig accounts, the intended threshold/weights. Never
   transcribe an S… seed by hand — hand-copies are the classic corruption
   point.
4. **Build the multisig account online** (the only online step): fund a fresh
   account from friendbot/testnet (or the treasury, for mainnet), add the three
   signers with `set_options` (weight 1) and set thresholds so
   `med_threshold = 2`, **before** any funds beyond dust sit on it. The
   public keys cross the air gap by QR or read-back comparison (§4.3).
5. **Shamir-split each S… seed** (SLIP-0039, 2-of-3, passphrase-less — see
   §4.4) and destroy the unsplit copy (§4.5). One share per maintainer
   password-manager item titled `streampay-<role>-share-<n>`; never two shares
   in the same vault.
6. **Verify before use** (§4.6): from an online machine, confirm the recorded
   G… addresses match the multisig account's signer list (Horizon/account
   response), and run one throwaway auth probe on testnet (the drill's matrix
   does exactly this — [`scripts/key_rotation_drill.ts`](../scripts/key_rotation_drill.ts)).
7. **Record the ceremony** in the security log
   ([`docs/SECURITY_LOG.md`](./SECURITY_LOG.md)): date, role, participants,
   threshold, and the *hashes* (SHA-256) of the share mnemonics — enough to
   prove later which shares belong to this ceremony without revealing them.

## 4. Air-gap procedure (small-team edition)

Full "air-gapped ceremony room" theater is out of proportion for this team.
The threat we actually defend against is **malware exfiltrating seeds at the
moment of generation**. A dedicated offline boot achieves that with gear the
team already owns.

### 4.1 Offline host

- A laptop booted from a **Ubuntu Live USB** (or Tails) with networking
  disabled in the live session: airplane-mode hardware switch where present,
  Wi-Fi/Bluetooth toggled off, Ethernet unplugged. "Offline" = no packets,
  verified with `ip link` showing only `lo`.
- Current, supported OS image; written to the USB with a checksum-verified
  image. The live session leaves no disk state, so the seeds exist only in RAM
  and on paper/encrypted shares.

### 4.2 Tool verification

- The Stellar CLI binary used in the gap is the **pinned release**
  (v28.1.0 — the version every workflow installs) fetched beforehand and
  carried in on a second USB; verify its SHA-256 against the GitHub release
  checksum file before first use. No `curl | sh` inside the gap.

### 4.3 Moving public material across the gap

- **Public keys only** (G… addresses, threshold plans). Preferred: display on
  the offline screen, read aloud / retype on the online machine, then compare
  character-by-character or via QR. Never move S… material across in either
  direction except as SLIP-0039 shares on paper (below).

### 4.4 Splitting

- Use an offline SLIP-0039 implementation (e.g. `trezor/python-shamir-mnemonic`
  carried into the gap same as the CLI). Parameters: **2-of-3**, iteration
  exponent 0, no passphrase (a forgotten passphrase is an availability loss
  with no security gain at N=3).
- Write the three shares on paper cards. No photos. No cloud notes. No
  "temporary" file on the online machine.

### 4.5 Destruction

- `shred`-equivalent on the live session is moot (RAM-only), but if any step
  wrote to the USB stick or local disk, that media is reformatted before reuse.
- Unsplit seed copies (the CLI's own `~/.stellar` on the offline session) die
  with the reboot; confirm by rebooting the live OS once before declaring the
  ceremony done.

### 4.6 Post-ceremony verification

- Online, confirm: multisig account exists, signer list matches the recorded
  G…s, thresholds are as planned, and a testnet auth probe signed by 2 of the
  3 signers succeeds while a 1-of-3 probe fails. The quarterly drill
  ([`.github/workflows/key-rotation-drill.yml`](../.github/workflows/key-rotation-drill.yml))
  automates the probe for the contract roles.

## 5. Witness checklist

Two maintainers participate in every ceremony; one is the **lead** (operates
the offline machine), one is the **witness** (watches and records). Print or
hand-copy this table and attach it to the security-log entry.

| # | Checkpoint | Lead initials | Witness initials |
|---|---|---|---|
| 1 | Offline boot confirmed: no network interfaces up (`ip link`) | | |
| 2 | CLI binary SHA-256 matches pinned release checksum | | |
| 3 | Each signer keypair generated fresh in the gap (count = planned N) | | |
| 4 | Public keys (G…) recorded and read-back-compared across the gap | | |
| 5 | Multisig funded only with dust until thresholds verified online | | |
| 6 | Thresholds/signer weights match the plan (Horizon response read out loud) | | |
| 7 | Each seed split 2-of-3; shares counted = 3; distributed to 3 distinct vaults | | |
| 8 | Unsplit copies destroyed; offline session rebooted; no residue on USB | | |
| 9 | Share mnemonic SHA-256 hashes recorded in the security log | | |
| 10 | Testnet auth probe: 2-of-3 succeeds, 1-of-3 fails, matrix rows green | | |

## 6. Re-running the ceremony

- **Quarterly**, as part of the scheduled key-rotation drill
  ([`docs/rotation-runbook.md`](./rotation-runbook.md) §6) — rotation exercises
  the *recovery* half of the backup without a full re-generation.
- **On any maintainer join/leave**: generate a replacement signer, rotate the
  role to the new signer set, and re-split the retired signer's seed before
  securely erasing it (`docs/OPERATIONS.md` §2.2 rule 4 covers offboarding).
- **On suspected compromise**: skip the ceremony entirely and follow
  [`docs/KEY_COMPROMISE_TEMPLATE.md`](./KEY_COMPROMISE_TEMPLATE.md).

## 7. Relationship to other documents

- Rotation procedures per role: [`docs/rotation-runbook.md`](./rotation-runbook.md)
- Secret inventory and custodians: [`docs/OPERATIONS.md`](./OPERATIONS.md) §2
- Drill automation: [`scripts/key_rotation_drill.ts`](../scripts/key_rotation_drill.ts),
  scheduled by [`.github/workflows/key-rotation-drill.yml`](../.github/workflows/key-rotation-drill.yml)
- Audit trail: [`docs/SECURITY_LOG.md`](./SECURITY_LOG.md)
