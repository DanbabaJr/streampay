# StreamPay bug bounty

This is the operational half of [`SECURITY.md`](../SECURITY.md): the tiers,
scope, intake, triage SLA, and postmortem process that make a report land in a
tracked issue instead of an inbox. Everything runs on GitHub-native tooling —
issue forms, a labeler/triage workflow, and this document — so **no paid SaaS is
required to operate the program**.

- Intake form: [`.github/ISSUE_TEMPLATE/security-report.yml`](../.github/ISSUE_TEMPLATE/security-report.yml)
- Triage bot: [`.github/workflows/security-triage.yml`](../.github/workflows/security-triage.yml)
- Postmortem: [`.github/ISSUE_TEMPLATE/postmortem.yml`](../.github/ISSUE_TEMPLATE/postmortem.yml) and [`docs/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md)

> **Exploitable findings do not go through the public form.** If a bug can move
> funds, break a stream invariant, or bypass auth on a live deployment, report it
> privately first via [private vulnerability reporting](
> https://github.com/Neziahtech/streampay/security/advisories/new). The public
> issue form exists for findings that are already disclosed/fixed or that cannot
> be exploited (hardening gaps, defense-in-depth, informational). See
> [§1 Intake](#1-intake-canals).

---

## 1. Intake canals

| Canal | Use it for | Where |
|---|---|---|
| **Private report** (canonical) | Anything exploitable: fund loss, invariant break, auth bypass, live DoS | [security/advisories/new](https://github.com/Neziahtech/streampay/security/advisories/new) |
| **Public security issue** | Non-exploitable hardening, already-fixed/already-disclosed issues, informational | [`.github/ISSUE_TEMPLATE/security-report.yml`](../.github/ISSUE_TEMPLATE/security-report.yml) |
| **`security@` + PGP** | Not yet live; published before mainnet (v1.0) | — |

A public security issue **submitted through the form above** is automatically
classified, labeled, assigned, and acknowledged by the triage bot; its logic is
in [`.github/workflows/security-triage.yml`](../.github/workflows/security-triage.yml)
and is written to be reviewed alongside this document. An issue that merely
titles itself "[Security] …" without the form gets `security` + `needs-triage`
and nothing else — no acknowledgement, no self-assessed severity promoted to a
label, no assignee. Bulk, formless reports are closed as out-of-program.

No label in this repository is a promise of payment. `bounty` is applied by a
maintainer only after the reproduction has been run and the finding confirmed
(§4, §8). Do not paste wallet addresses into issues or PRs (§8); they are not a
payment instruction and, in practice, are the signature of program farming.

A **reproduction is mandatory**. GitHub marks the `Reproduction` field required
in the issue form, and the triage bot adds `repro-missing` if an edited report
drops it. Reports without a reproduction are not eligible for an award.

---

## 2. Scope

Scope is expressed over the assets enumerated in
[`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) §3.1 (`A-1`…`A-7`). A finding is
in scope when it violates one of the invariants in §3.2 and lands on an asset
below.

| In scope | Component / surface | Primary assets | Example classes |
|---|---|---|---|
| Yes | **Core contract** — `contracts/streaming-payments` (all entrypoints, accrual math, CEI ordering) | `A-1` escrowed funds, `A-2` stream state | Double-withdraw, accrual / rounding error, reentrancy, auth bypass, `top_up` accounting |
| Yes | **TTL / rent economics** — `infra/ttl-sentinel`, extension call sites | `A-5` bytecode & instance | Bricking a live deployment, unbounded rent, alert-timing failure |
| Yes | **Discovery indexes** — `A-4` `RecipientStreams` / `SenderStreams` | `A-4` indexes | Index corruption, pagination exhaustion, cross-stream clobbering |
| Yes | **CI / release pipeline** — `.github/workflows`, `scripts/`, `deny.toml` | Supply chain, `A-5` | Secret exfiltration, gate bypass, untrusted-input code execution |
| Yes | **Frontend** — `frontend/` (transaction building, auth, RPC handling) | `A-6` keys | Signature replay, network-passphrase confusion, fee-drain, stuck-funds flows |
| Partial | **Dependency / advisory findings** | — | Only where a `deny.toml` / `npm audit` gap is *demonstrably* reachable; raw CVE dumps are out of scope |
| No | **Out of scope** — see below | — | — |

### Out of scope

- **Non-standard tokens** (fee-on-transfer, rebasing): formally out of scope as
  an accepted v1 risk — the contract targets standard SAC / SEP-41 tokens where
  transfer amounts are conserved 1:1
  ([`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) §5, R-series).
- Testnet-only state, self-inflicted misconfiguration, and issues requiring a
  compromised user device or leaked private key.
- Stellar validator quorum, the Soroban host, and `env.ledger().timestamp()`
  (trusted boundary, [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) §2).
- Social engineering of maintainers, spam, and volumetric network-layer DoS.
- Known findings already tracked in an open issue (see [§6 duplicates](#6-duplicate-detection)).
- Best-practice / lint suggestions with no demonstrated impact.
- Findings in third-party services (DNS, registrar, GitHub itself) we do not
  control.

---

## 3. Loss model (the maximum-loss scenario, MLS)

Rewards are pegged to a fraction of the **maximum-loss scenario (MLS)** — the
worst realized damage the protocol can suffer from a single exploit at the time
of the report. MLS is *recomputed per report* from live on-chain state; the
reference calibration below is what makes it a number rather than a hand-wave.

### 3.1 Definition

$$
\text{MLS} = E + R
$$

- **E — escrowed value at risk.** The sum, over all live streams, of the
  unwithdrawn balance — i.e. exactly invariant 2 of
  [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) §3.2:

  $$E = \sum_{S \in \text{LiveStreams}} (S.\text{deposit} - S.\text{withdrawn})$$

  valued at the token's spot price. This is asset `A-1`, read from the
  contract's token balance (the contract balance covers the sum, by the
  solvency invariant).

- **R — remediation cost.** The one-off cost to detect, contain, and restore
  state after an availability-class failure (e.g. un-extended entries archived
  past the `4,095`-ledger cliff, bricking a deployment — asset `A-5`). `R` is
  priced directly from the **measured cost model** below.

### 3.2 Cost model (source of `R`)

`R` is derived from the gas/storage footprint work tracked in **issue #27,
"Gas and storage footprint pass"**, whose committed output lives in
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) §"TTL / rent economics"
([`ARCHITECTURE.md:450-455`](./ARCHITECTURE.md)):

> *"the same module projects rent from measured entry sizes (**504 B** per
> stream entry; index entries by id count) against the CAP-0066 fee curve. …
> **~0.021 XLM per live stream per month** at the floor fee, plus **~14.6 XLM
> per MiB of Wasm per month** — code rent is scale-invariant, so bytecode is the
> dominant cost centre below roughly **80 live streams**."*

Those measured constants are the only free parameters of `R`:

| Symbol | Meaning | Value | Source |
|---|---|---|---|
| `r_stream` | rent per live stream entry | `0.021 XLM / month` | issue #27 → `ARCHITECTURE.md:452` |
| `r_code` | rent per MiB of Wasm | `14.6 XLM / month` | issue #27 → `ARCHITECTURE.md:453` |
| `N_ref` | reference live-stream count | `80` | bytecode/entry cost crossover, `ARCHITECTURE.md:454` |
| `T_rec` | worst-case recovery window | `1 month` | time to restore + re-extend + verify |
| `P_XLM` | reference XLM price | `$0.10` | calibration constant (refresh from an oracle at report time) |

$$
R = (N_{\text{ref}} \cdot r_{\text{stream}} + r_{\text{code}}) \cdot T_{\text{rec}} \cdot P_{\text{XLM}}
$$

Because `r_code` dominates below the 80-stream crossover, the reference
deployment envelope is `N_ref = 80` live streams with a reference median deposit
`D_ref = 1,000 USDC` (calibration assumption — replaced by live state at report
time).

### 3.3 Worked reference example

```
E = N_ref × D_ref                  = 80 × 1,000            = $80,000.00
R = (80 × 0.021 + 14.6) × 1 × 0.10 = (1.68 + 14.6) × 0.10  = $1.628
MLS = E + R                                                = $80,001.63
```

So the calibration MLS is **≈ $80,002**. For a live report, substitute the
measured `E` (read the escrowed balance) and the current `P_XLM`; everything
else is fixed by issue #27's measurements.

### 3.4 Impact classes → share of MLS

The **share of MLS** a finding can realize drives severity, and severity drives
the tier:

| Impact class | What it means | Realizable share of MLS |
|---|---|---|
| **Funds drainable** | Attacker extracts `A-1` funds, or forges `A-2` state to over-withdraw | up to **100%** |
| **Invariant break** | Violates a [`THREAT_MODEL.md`](./THREAT_MODEL.md) §3.2 invariant without immediate extraction (e.g. solvency drift) | **10–50%** |
| **Denial of service** | Live streams/reads fail until restored (`A-5`, `A-3`, `A-4`) | up to **`R/MLS`** + stranded funds |
| **Griefing / spam** | Cost/UX degradation with no fund loss (`A-4`, `A-7`) | **< 1%** |
| **Informational** | No realistic impact; hardening only | **0%** |

---

## 4. Reward tiers

Tiers are **a percentage of MLS**, floored and capped so that small deployments
still pay a credible minimum and large ones do not outrun the treasury. Payout
is the tier percentage of MLS, clamped to `[floor, cap]`, rounded down to the
nearest whole dollar.

| Tier | Severity | % of MLS | Floor | Cap | Typical trigger |
|---|---|---|---|---|---|
| **P1** | Critical | **10 %** | $2,000 | $50,000 | Direct/drainable fund loss, auth bypass, mint/over-withdraw |
| **P2** | High | **5 %** | $1,000 | $25,000 | Partial fund loss or a solvency invariant break; DoS that strands funds |
| **P3** | Medium | **1 %** | $250 | $5,000 | Availability loss without fund loss; index corruption; griefing with measurable cost |
| **P4** | Low | **0.1 %** | $50 | $500 | Informational / defense-in-depth with a concrete failure mode |

Worked payouts against the §3.3 reference MLS (`$80,001.63`):

| Tier | `% × MLS` | Payout after clamp |
|---|---|---|
| P1 Critical | `0.10 × 80,001.63 = $8,000.16` | **$8,000** |
| P2 High | `0.05 × 80,001.63 = $4,000.08` | **$4,000** |
| P3 Medium | `0.01 × 80,001.63 = $800.02` | **$800** |
| P4 Low | `0.001 × 80,001.63 = $80.00` | **$80** |

Notes:

- **Mainnet vs testnet.** Until v1.0 the deployment is testnet-only and awards
  are made at the program's discretion (capped at the tier **floor**); mainnet
  awards use the full tier table.
- **Duplicate / first-report rule.** The first complete report of a given root
  cause is eligible; later duplicates are credited but not paid (see [§6](#6-duplicate-detection)).
- **Quality multiplier.** A working PoC and a minimal failing test can move a
  borderline report up one tier; no reproduction means no award.
- The tier is set by the **realized** share of MLS the triager confirms in the
  postmortem, not the reporter's self-assessment.

---

## 5. Triage SLA

Machine-enforced by [`.github/workflows/security-triage.yml`](../.github/workflows/security-triage.yml):

| Stage | Target | Who | How it is enforced |
|---|---|---|---|
| **Acknowledge** | **≤ 72 h** from issue creation | Triage bot (immediate) + maintainer | Bot posts the SLA deadline on intake; the scheduled sweep re-pings after 72 h |
| **Classify** | ≤ 72 h | Triage bot | Bot applies `severity:*` + `scope:*`, requests assignment from `.github/CODEOWNERS` |
| **Triage decision** | ≤ 7 days | Maintainer | `needs-triage` label cleared; tier assigned |
| **Fix / disclose** | coordinated | Maintainer + reporter | Per [`SECURITY.md`](../SECURITY.md) |

The bot is idempotent: it edits its own comment (marker
`<!-- security-triage-bot -->`) instead of re-posting on `edited`/`reopened`
events, and the SLA sweep uses `<!-- security-sla-breach -->`.

---

## 6. Duplicate detection

Duplicate detection is intentionally split between **guidance the reporter
follows** and **a deterministic heuristic the bot applies**, so the bot's logic
is reviewable in one place and never silently closes a report.

### 6.1 Reporter guidance (in the issue form)

Before filing, search existing reports:

1. `label:security` — all intake reports.
2. `label:severity:critical OR label:severity:high` — high-signal reports.
3. Your affected entrypoint / component name in the search box.
4. Link any related issue in the form's **Related issues** field.

The form's required checkbox attests that you searched and believe the report is
novel.

### 6.2 Bot heuristic (reviewable)

The triage workflow re-runs on every edit:

1. Tokenize the new issue's **title + Summary** into significant words
   (lowercased, `[a-z0-9_]{4,}`, stopwords removed — the full stopword set is in
   the workflow).
2. Compare against every **open issue already carrying `security`,
   `needs-triage`, or `possible-duplicate`** (PRs excluded).
3. If **≥ 2 significant tokens overlap**, add `possible-duplicate` and list the
   candidate issues in the bot comment.

The bot **never closes** anything: it flags for a human, who either links the
duplicate (`duplicate` label + close) or clears the label. Because the
tokenizer, the stopword list, and the threshold all live in the workflow file,
the heuristic can be reviewed and tuned in the same PR as the policy.

---

## 7. Postmortem

Every P1/P2 finding — and any rollback or incident — gets a blameless postmortem
opened from [`.github/ISSUE_TEMPLATE/postmortem.yml`](../.github/ISSUE_TEMPLATE/postmortem.yml),
written up with [`docs/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md). The
postmortem records the `E` and `MLS` actually observed, which is the feedback
loop that keeps the tier table honest.

---

## 8. Payment

- Awards are paid after the fix is merged and verified, normally within 30 days.
- Identity/KYC and tax handling are agreed privately per award.
- A wallet address pasted into a public issue or PR body is never a payment
  instruction and is never used. Payment details are exchanged only in the
  private thread opened once an award is approved.
- Reporters are credited in release notes unless they ask to stay anonymous.
