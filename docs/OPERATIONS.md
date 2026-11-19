# StreamPay Operations Handbook: Running the Non-Code Half Cold

- **Handbook Version**: 1.0.0
- **Base Commit Hash**: `0846c879db1312d4a08bbf7099349822fc66ced4`
- **Date**: 2026-10-15
- **Status**: Live Operational Runbook & Cold-Start Guide
- **Repository**: [StreamPay](https://github.com/Neziahtech/streampay)

---

## 0. How to Read This Document

This document is written for a second maintainer or SRE stepping in to operate, release, debug, and maintain StreamPay without prior onboarding. Every operational claim, path, secret name, and command is strictly auditable against repository reality.

### Audit Tags Used Throughout
- `[VERIFIED]`: Directly cross-referenced and verified against active files, workflows, scripts, or commit history in this repository.
- `[UNVERIFIED]`: Operational state that lives outside git (e.g. cloud provider dashboards, external registrars, wallet custodians) and requires manual human confirmation.
- `[PROPOSED]`: Recommended operational improvements or configuration diffs that are **not** yet applied to the repository.

---

## 1. Scope and Audience

StreamPay is a non-custodial, linear streaming payment protocol on the Stellar network (Soroban). It consists of:
1. An immutable Soroban smart contract (`contracts/streaming-payments/`).
2. A Next.js web application (`frontend/`).
3. An operational TTL and rent monitoring service (`infra/ttl-sentinel/`).
4. Governed release and rehearsal automation (`scripts/`, `.github/workflows/`).

This handbook defines the non-code responsibilities required to keep StreamPay online, secure, and reproducible:
- Managing cryptographic keys, secrets, and environment variables.
- Responding to on-chain TTL archival cliffs and incident drills.
- Triaging and merging dependency updates without CI breakage.
- Executing multi-environment canary releases and rollbacks.
- Conducting bus-factor drills and running scheduled on-call rotations.

---

## 2. Key and Secret Inventory with Custody Rules

StreamPay follows an **ownerless smart contract model**: the deployed contract has **no admin key**, **no ownership role**, and **no upgrade authority** (`[VERIFIED: docs/INCIDENT_RUNBOOK.md:17-19]`). However, off-chain infrastructure, CI/CD pipelines, and rent sentinels require operational keys.

### 2.1 Inventory Table

| Secret / Key Name | Category | Purpose | Where It Lives | Current Custodian | Blast Radius if Compromised | Rotation Procedure | Last Rotated | Citation / Evidence |
|---|---|---|---|---|---|---|---|---|
| `MAINNET_DEPLOYER_SECRET` | Operational Key | Stellar secret key used to deploy Wasm bytecode to Stellar mainnet | GitHub Actions Environment Secret (`mainnet-canary`) | `[LEAD_MAINTAINER]` (`@Neziahtech`) | Attacker can deploy arbitrary contracts on mainnet using deployer funds. **Cannot** alter, pause, or drain existing deployed contracts. | 1. Generate new Stellar keypair.<br>2. Fund account with base XLM.<br>3. Update GitHub Environment secret.<br>4. Drain old key. | `[UNVERIFIED: Check GitHub Settings -> Environments -> mainnet-canary]` | `[VERIFIED: .github/workflows/promote.yml:217, 279]`, `[VERIFIED: docs/DEPLOY_PIPELINE.md:34]` |
| `TTL_SENTINEL_EXTENDER_SECRET` | Operational Key | Hot Stellar secret key funding `ExtendFootprintTTL` transactions to prevent state archival | Environment variable on monitoring host / container | `[OPS_ENGINEER]` | Attacker can steal the balance of the hot wallet. Limited to monthly budget cap (`monthlyBudgetXlm`, default 1–100 XLM). | 1. Generate new keypair.<br>2. Transfer small XLM budget.<br>3. Update host env var.<br>4. Restart sentinel. | `[UNVERIFIED: Host-dependent]` | `[VERIFIED: infra/ttl-sentinel/src/config.ts:99]`, `[VERIFIED: infra/ttl-sentinel/ttl-sentinel.config.example.json:50]` |
| `TTL_SENTINEL_WEBHOOK_URL` | Operational Webhook | Incoming webhook URL for sentinel alert delivery (console/JSONL/webhook) | Environment variable or `ttl-sentinel.config.json` | `[OPS_ENGINEER]` | Attacker can spam alert channels or discover contract IDs. No direct fund impact. | 1. Regenerate webhook in Slack/Discord.<br>2. Update host env var or config. | `[UNVERIFIED: Host-dependent]` | `[VERIFIED: infra/ttl-sentinel/ttl-sentinel.config.example.json:19]` |
| `ONCALL_WEBHOOK_URL` | Operational Webhook | Incoming webhook for weekly on-call rotation ping | GitHub Actions Repository Secret | `[LEAD_MAINTAINER]` (`@Neziahtech`) | Attacker can spam team notification channels. Zero access to code or funds. | 1. Regenerate webhook in chat platform.<br>2. Update GitHub secret `ONCALL_WEBHOOK_URL`. | `[UNVERIFIED: Set upon oncall tool deployment]` | `[VERIFIED: .github/workflows/oncall-ping.yml:34]`, `[VERIFIED: scripts/oncall/ping.mjs:93]` |
| `GITHUB_TOKEN` / `GH_TOKEN` | CI/CD Token | Automated release asset downloads, issue comments, draft generation | Ephemeral GitHub Actions token | GitHub Platform | Scoped to permissions declared in workflow jobs (`contents: write`, `issues: write`). | Handled automatically by GitHub Actions per job. | Ephemeral (Per-run) | `[VERIFIED: .github/workflows/promote.yml:47-50, 139]`, `[VERIFIED: .github/workflows/release.yml:12-15]` |
| Netlify Deploy Account | Web Hosting | Deploys Next.js frontend application | Netlify Dashboard / Git App Integration | `[LEAD_MAINTAINER]` (`@Neziahtech`) | Attacker can deploy phishing frontend with spoofed contract IDs. | 1. Revoke Netlify team access.<br>2. Re-authenticate GitHub OAuth application.<br>3. Trigger emergency shutdown (`netlify sites:stop`). | `[UNVERIFIED: Check Netlify Team Settings]` | `[VERIFIED: frontend/netlify.toml:1-7]`, `[VERIFIED: docs/INCIDENT_RUNBOOK.md:123-125]` |
| `streampay-ci` (Testnet) | Ephemeral Key | Deploys testnet contracts during CI runs if no key provided | Ephemeral / Testnet Friendbot | Automated in CI | Zero mainnet impact. Key balance funded via testnet friendbot. | Disposable; generated on demand via `stellar keys generate`. | Ephemeral | `[VERIFIED: scripts/deploy_contract.sh:41-45]` |

---

### 2.2 Custody Rules

1. **Dual Custodianship (Rule of Two)**:
   - All production secrets (`MAINNET_DEPLOYER_SECRET`, Netlify owner access) must be held by at least **two** active maintainers.
   - In GitHub, the `mainnet-canary` environment must require approval from a maintainer who is **not** the author of the commit being promoted (`[VERIFIED: docs/CANARY_RUNBOOK.md:31-33]`).
2. **Zero Plaintext Transmission**:
   - Secrets must **never** be transmitted via Slack, Discord, email, or chat.
   - Use password managers with end-to-end encryption (e.g. 1Password / Bitwarden team vaults) or hardware keys (YubiKey) for off-chain backups.
3. **Least Privilege & Budget Isolation**:
   - The TTL Extender key (`TTL_SENTINEL_EXTENDER_SECRET`) must never hold more than a 30-day operating buffer (10–50 XLM). The sentinel code enforces a hard budget meter (`monthlyBudgetXlm`) from `.spender.json` (`[VERIFIED: infra/ttl-sentinel/src/extender.ts:15-18]`).
4. **Offboarding Procedure**:
   - Upon maintainer offboarding:
     1. Rotate `MAINNET_DEPLOYER_SECRET` immediately.
     2. Remove user from GitHub organization and `CODEOWNERS` (`[VERIFIED: .github/CODEOWNERS:3-11]`).
     3. Revoke Netlify team membership.
     4. Rotate `ONCALL_WEBHOOK_URL` and `TTL_SENTINEL_WEBHOOK_URL`.
     5. Update `scripts/oncall/rotation.json`.
5. **Suspected Compromise Playbook**:
   - If `MAINNET_DEPLOYER_SECRET` is leaked:
     1. Drain remaining XLM from the deployer account using `stellar tx new payment`.
     2. Remove secret from GitHub Environment `mainnet-canary`.
     3. Generate a new key and record the address in `docs/INCIDENT_RESULTS.md`.
     4. Note: Existing deployed contracts are **immutable** and do **not** need to be drained or paused, as the deployer holds zero contract authority (`[VERIFIED: docs/INCIDENT_RUNBOOK.md:17-19]`).

---

## 3. Service Dependency Map

StreamPay interacts with public blockchain infrastructure, decentralized node providers, CI/CD runners, and client-side wallets.

### 3.1 Architecture Dependency Diagram

```mermaid
flowchart TD
    subgraph Client["Client Tier"]
        Browser["End-User Browser"]
        Freighter["Freighter Wallet (Client Extension)"]
    end

    subgraph Hosting["Frontend Hosting Tier"]
        Netlify["Netlify Hosting (CDN & SSR)"]
    end

    subgraph RPC["RPC & Network Tier"]
        TestnetRPC["Soroban Testnet RPC (soroban-testnet.stellar.org)"]
        PublicRPC["Soroban Publicnet RPC (soroban-rpc.stellar.org)"]
        StellarCore["Stellar Consensus Quorum (Validators / Ledgers)"]
    end

    subgraph Monitoring["Operational & Rent Tier"]
        TTLSentinel["TTL Sentinel (infra/ttl-sentinel)"]
        CronRunner["Node.js / Cron Host"]
    end

    subgraph SmartContract["On-Chain Tier"]
        Contract["StreamPay Contract (CB...)"]
        SAC["Stellar Asset Contract / SEP-41 Tokens"]
        Storage["Soroban Persistent Storage"]
    end

    Browser <--> Netlify
    Browser <--> Freighter
    Browser -->|simulate & send| PublicRPC
    Freighter -->|signs transactions| Browser

    TTLSentinel -->|getLedgerEntries| PublicRPC
    TTLSentinel -->|ExtendFootprintTTL| PublicRPC
    CronRunner --> TTLSentinel

    PublicRPC <--> StellarCore
    TestnetRPC <--> StellarCore
    StellarCore <--> Contract
    Contract <--> Storage
    Contract <--> SAC
```

---

### 3.2 Ordered Failure Table: "What Breaks What"

| Down / Compromised Component | What Breaks First | What Breaks Next | User-Visible Symptom | First Diagnostic Step | Primary Contact / Action | Fallback Procedure |
|---|---|---|---|---|---|---|
| **Public Soroban RPC (`soroban-rpc.stellar.org`)** | Transaction simulation in frontend (`[VERIFIED: frontend/lib/stellar.ts:140-144]`) | Stream discovery (`fetchStreamsFor`) and TTL Sentinel scans (`[VERIFIED: infra/ttl-sentinel/src/scanner.ts]`) | "Simulation failed", streams fail to load, balance shows 0 or loading spinner | Run `curl -X POST $RPC_URL -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'` | Stellar SDF Status (`status.stellar.org`) | Switch `NEXT_PUBLIC_SOROBAN_RPC_URL` in `frontend/.env.local` to alternate commercial RPC provider (e.g. Blockdaemon, NowNodes) |
| **Contract State Archival (~5.7 Hour Cliff)** | Monotonic ID generation (`DataKey::NextStreamId`), Contract Instance, Wasm Code entry | All mutating contract calls (`create_stream`, `withdraw`, `cancel_stream`) | Contract invocation reverts with host archival error code | Run `node dist/src/cli.js scan` in `infra/ttl-sentinel` to inspect `remainingLedgers` (`[VERIFIED: docs/ARCHITECTURE.md:276-296]`) | On-Call Maintainer | Submit manual `ExtendFootprintTTL` transaction or invoke `restore` via `stellar contract restore` paying state restore fee (`[VERIFIED: infra/ttl-sentinel/src/extender.ts]`) |
| **Netlify Web Hosting** | Frontend Web Application delivery (`frontend/`) | User stream interface | HTTP 500, 502, or DNS timeout loading the application UI | Run `curl -I https://<site>.netlify.app` and check `status.netlify.com` | Netlify Support / Infrastructure Lead | Users can interact directly via CLI (`stellar contract invoke`) using instructions in `docs/DEMO.md:85-115`; deploy static mirror to Vercel/Cloudflare Pages |
| **Freighter Wallet Extension / Horizon API** | Signature acquisition in frontend (`[VERIFIED: frontend/lib/stellar.ts:148-150]`) | Transaction submission | "Freighter not detected" or wallet popup fails to open | Verify extension version in browser; test basic keypair generation in CLI | Stellar Foundation / Freighter repo | Sign and submit transactions manually via Stellar Laboratory or Stellar CLI |
| **Testnet Friendbot (`friendbot.stellar.org`)** | Testnet deployment scripts (`[VERIFIED: scripts/deploy_testnet.sh:45-47]`) and canary smoke stream setup | CI rehearsal workflows (`rehearsal.yml`) and local testnet testing | Scripts fail with `502 Bad Gateway` or curl timeout | Run `curl -sf "https://friendbot.stellar.org?addr=<ADDR>"` | On-Call Maintainer / Stellar Status | Use existing pre-funded testnet accounts or wait for testnet reset; mock mode (`--mock`) in `scripts/canary_check.sh` allows offline verification |
| **GitHub Actions Service** | Promotion pipeline (`promote.yml`), CI gates (`ci.yml`), release drafts (`release.yml`) | Automated deployments, dependency audit gates, merge verification | PR checks hang; promotion workflow cannot run | Check `www.githubstatus.com` | GitHub Support / Maintainers | Execute release gates locally using `scripts/release_gates.sh` and deploy using CLI script `scripts/deploy_contract.sh` (`[VERIFIED: docs/DEPLOY_PIPELINE.md:13-20]`) |

---

## 4. On-Call Rotation Mechanics

StreamPay operates an active weekly on-call rotation to guarantee operational response for state archival cliffs, security disclosures, and canary promotions.

### 4.1 Rotation Structure
- **Rotation Length**: 7 Days (`[VERIFIED: scripts/oncall/rotation.json:2]`).
- **Handoff Time**: Every **Monday at 09:00 UTC** (`[VERIFIED: scripts/oncall/rotation.json:4-5]`).
- **Roster Location**: `scripts/oncall/rotation.json` (`[VERIFIED: scripts/oncall/rotation.json]`).
- **Notification Tool**: `scripts/oncall/ping.mjs` (`[VERIFIED: scripts/oncall/ping.mjs]`), triggered automatically via GitHub Actions `.github/workflows/oncall-ping.yml` (`[VERIFIED: .github/workflows/oncall-ping.yml]`).
- **Webhook Secret Name**: `ONCALL_WEBHOOK_URL` (`[VERIFIED: .github/workflows/oncall-ping.yml:34]`).

### 4.2 Escalation Hierarchy

```text
[Alert / Incident Fired]
         │
         ▼
 1. Primary On-Call (First responder: < 15 min response target)
         │
         ├─ Unresponsive after 30 minutes
         ▼
 2. Secondary On-Call (Backup responder: triage & containment)
         │
         ├─ Unresponsive or Critical Severity / Security Disclosure
         ▼
 3. Project Lead / CODEOWNER (@Neziahtech)
```

### 4.3 Severity Classification: Pageable vs. Next-Business-Day

| Severity Level | Response SLA | Examples | Immediate Actions |
|---|---|---|---|
| **P1 — Critical (Pageable Immediately)** | **< 15 minutes** | - Storage TTL entry nearing archival cliff (< 1,200 ledgers on counter/instance).<br>- Private security disclosure regarding contract insolvency.<br>- Mainnet canary failure on release promotion.<br>- DNS / Netlify hosting compromise. | 1. Acknowledge in incident channel.<br>2. Follow `docs/INCIDENT_RUNBOOK.md` matching scenario.<br>3. If contract threat, trigger emergency sender cancellation drill (`scripts/drill_draining_exploit.sh`). |
| **P2 — High (Pageable During Waking Hours)** | **< 2 hours** | - Soroban public RPC outage.<br>- Sentinel alerting warnings (stream < 150,000 ledgers remaining).<br>- Automated dependency audit gate failures on `main`. | 1. Check RPC health.<br>2. Re-run `npm run scan` in `infra/ttl-sentinel`.<br>3. Review failing CI logs. |
| **P3 — Low (Next Business Day)** | **Next Business Day** | - Routine Dependabot PRs.<br>- Testnet friendbot rate limits.<br>- Non-breaking documentation updates.<br>- Good-first-issue submissions. | Review during normal working hours. |

### 4.4 Webhook Setup and Dry-Run Procedure

1. **Create Webhook in Chat Platform**:
   - Create an incoming webhook in your team's Slack or Discord channel.
2. **Configure GitHub Repository Secret**:
   - Navigate to **Settings -> Secrets and variables -> Actions**.
   - Create a repository secret named **`ONCALL_WEBHOOK_URL`** and paste the webhook URL.
3. **Execute Manual Dry-Run in GitHub Actions**:
   - Go to **Actions -> On-Call Handoff Ping**.
   - Click **Run workflow**, ensure `dry_run` is set to `true`, and click **Run workflow**.
   - Verify workflow logs output: `[oncall-ping] DRY RUN MODE: Notification calculated successfully` without sending a live message (`[VERIFIED: scripts/oncall/ping.mjs:86-90]`).
4. **Execute Local Dry-Run**:
   ```bash
   node scripts/oncall/ping.mjs --dry-run
   ```

---

## 5. Dependency and Security Audit Policy

Dependency management in StreamPay is safety-critical: incorrect dependency updates can introduce subtle Wasm spec mismatches, break the Soroban Host environment, or disrupt lockfile audits.

### 5.1 The Dependabot Incident Post-Mortem

#### Incident Timeline and Root Cause
1. **The Merge (`PR #18`, Commit `f1f3f9a`)**:
   - A Dependabot PR bumping `next` to `16.3.8` in `frontend/` was merged without validating peer dependencies and build tooling.
2. **Immediate Breakage (`Commit 4c48978adbdfc5eea9788970075708cd1100e3c3`)**:
   - **Duplicate JSON Keys**: The automatic merge resolution left `frontend/package.json` with duplicate dependency keys, causing `npm ci` to fail immediately in CI.
   - **Peer Dependency Collision**: `next@16.3.8` was installed alongside `eslint-config-next@15`, triggering npm peer resolution failures.
   - **Breaking Tooling Removal**: Next.js 16 completely removed `next lint`. The existing CI script (`npm run lint`) failed because `next lint` no longer existed.
   - **ESLint Plugin Crash**: Upgrading ESLint to `10.x` crashed the plugin chain because `context.getFilename()` was removed in ESLint 10.
3. **The Resolution (`Commit 4c48978`, `Commit 2c03d76`, `Commit 642fbf8`)**:
   - Lead maintainer migrated frontend linting to ESLint flat config (`frontend/eslint.config.mjs`) running `eslint .` directly (`[VERIFIED: frontend/package.json:10]`, `[VERIFIED: CHANGELOG.md:62-65]`).
   - ESLint was pinned to the `9.x` line (`[VERIFIED: CHANGELOG.md:64-65]`).
   - Transitive high-severity vulnerabilities in `sharp` (librsvg CVE-2026-96889) and `source-map-js` (GHSA-68fv-2mgg-jv7q), plus `postcss` and `toml`, broke `npm audit --omit=dev --audit-level=high` in CI. Fixed by introducing explicit npm `overrides` in `frontend/package.json:28-33` (`[VERIFIED: CHANGELOG.md:76-79]`, `[VERIFIED: Commit 2c03d76]`).

---

### 5.2 Dependency Management Policy

#### Fast-Track (Auto-Merge Eligible)
A dependency update may **only** be merged automatically if **all** of the following criteria are met:
- [ ] Update is strictly a **patch** (`x.y.Z`) or **minor** (`x.Y.z`) bump within the same major version.
- [ ] Package is **not** in the High-Risk Lane (not Next.js, ESLint, React, `@stellar/stellar-sdk`, `@stellar/freighter-api`, or `soroban-sdk`).
- [ ] Entire GitHub Actions CI matrix is green (`ci.yml`, `rehearsal.yml`).
- [ ] `npm audit --omit=dev --audit-level=high` reports zero vulnerabilities.
- [ ] No npm `overrides` or `Cargo.lock` ban violations in `deny.toml`.

#### High-Risk Lane (Mandatory Manual Review & Rehearsal)
The following updates **always require manual maintainer testing and explicit approval**:
1. **Any major version bump** (`X.0.0`).
2. **Next.js & React Ecosystem**: `next`, `react`, `react-dom`, `eslint-config-next`, `eslint`.
3. **Stellar & Soroban SDKs**: `@stellar/stellar-sdk`, `@stellar/freighter-api`, `soroban-sdk`, `stellar-strkey`.
4. **Rust Build Tooling**: `stellar-cli`, `cargo-deny`, `cargo-mutants`, `cargo-llvm-cov`.
5. **Updates affecting npm overrides**: Any change touching `postcss`, `sharp`, `source-map-js`, or `toml`.

#### Rules Codified from Incident
1. **No Group Merges of Peer-Linked Packages**: Never merge `next` without verifying `eslint-config-next` in the same branch.
2. **Mandatory Clean Peer Tree**: Maintainers must verify `npm ls` runs without peer errors before approving frontend PRs.
3. **Rebase Before Merge**: Every PR must be rebased onto `main` and rerun through CI to prevent duplicate-key or lockfile merge skew.
4. **Immediate Revert Protocol**: If CI on `main` breaks following a dependency merge, maintainers must revert the PR commit within 30 minutes rather than debugging forward on `main`.

---

### 5.3 Dependabot Policy Gap and Proposed Configuration

#### Current Repository Reality
- `.github/dependabot.yml` currently has **no grouping rules**, schedules all updates weekly, and **omits `infra/ttl-sentinel` entirely** (`[VERIFIED: .github/dependabot.yml:1-35]`).
- As a result, Dependabot opens isolated PRs for linked dependencies (e.g. `next` without `eslint-config-next`), recreating the exact conditions of PR #18.

#### Proposed Change
```diff
--- a/.github/dependabot.yml
+++ b/.github/dependabot.yml
@@ -11,6 +11,15 @@ updates:
     commit-message:
       prefix: "cargo"
+    groups:
+      soroban:
+        patterns:
+          - "soroban-*"
+          - "stellar-*"
 
   - package-ecosystem: npm
     directory: "/frontend"
@@ -21,6 +30,28 @@ updates:
     commit-message:
       prefix: "npm"
+    groups:
+      next-ecosystem:
+        patterns:
+          - "next"
+          - "eslint-config-next"
+          - "react"
+          - "react-dom"
+      stellar-sdk:
+        patterns:
+          - "@stellar/*"
+
+  - package-ecosystem: npm
+    directory: "/infra/ttl-sentinel"
+    schedule:
+      interval: weekly
+    open-pull-requests-limit: 3
+    labels:
+      - dependencies
+      - infra
+    commit-message:
+      prefix: "sentinel"
 
   - package-ecosystem: github-actions
     directory: "/"
```

---

### 5.4 Funding and Sponsorship Management

- **Current Config**: Defined in `.github/FUNDING.yml` (`[VERIFIED: .github/FUNDING.yml:1-6]`).
- **Configured Accounts**:
  - GitHub Sponsors: `[VERIFIED: .github/FUNDING.yml:2: Neziahtech]`.
  - Custom Grants: `https://app.grantfox.io/` (bounties for tickets in `docs/GOOD_FIRST_ISSUES.md`).
  - Drips Network: `https://drips.network/` (dependency splits).
- **Maintainer Responsibility**: When adding new core maintainers, update `.github/FUNDING.yml` and project grant split percentages in Drips.

---

## 6. Release-Day Checklist

Execute this checklist for every production deployment. Every step corresponds to real tooling and scripts in the repository (`[VERIFIED: docs/DEPLOY_PIPELINE.md:1-187]`, `[VERIFIED: docs/CANARY_RUNBOOK.md:1-165]`).

### Phase 1: Pre-Flight Verification (Local Workstation)
- [ ] 1. Ensure working directory is clean:
  ```bash
  git status
  ```
- [ ] 2. Run the complete Rust test suite and clippy:
  ```bash
  cargo fmt --all -- --check
  cargo clippy --all-targets -- -D warnings
  cargo test -p streampay-contract --locked
  ```
- [ ] 3. Run frontend verification:
  ```bash
  cd frontend
  npm run lint
  npm run typecheck
  npm run build
  npm audit --omit=dev --audit-level=high
  cd ..
  ```
- [ ] 4. Run TTL sentinel test suite:
  ```bash
  cd infra/ttl-sentinel
  npm run typecheck
  npm test
  npm audit --omit=dev --audit-level=high
  cd ..
  ```
- [ ] 5. Execute full promotion dress rehearsal:
  ```bash
  scripts/promote_rehearsal.sh
  ```
  *Confirm output: `rehearsal: PASS`.*

---

### Phase 2: Release Creation (GitHub)
- [ ] 1. Bump version and update `CHANGELOG.md` following SemVer.
- [ ] 2. Create and push signed git tag:
  ```bash
  git tag -s vX.Y.Z -m "Release vX.Y.Z"
  git push origin vX.Y.Z
  ```
- [ ] 3. GitHub Actions `.github/workflows/release.yml` will automatically build the Wasm, compute SHA-256 digests, and create a draft release with `streampay_contract.wasm` and `SHA256SUMS` (`[VERIFIED: .github/workflows/release.yml:48-55]`).
- [ ] 4. Confirm published Wasm digest in the draft release body.

---

### Phase 3: Governed Promotion & Canary Execution
- [ ] 1. Navigate to **Actions -> Promote -> Run workflow** (`[VERIFIED: .github/workflows/promote.yml:21-46]`).
- [ ] 2. Set inputs:
  - `release_tag`: `vX.Y.Z`
  - `through`: `mainnet-canary`
  - `schema_change_ack`: `false` (unless interface intentionally changed)
  - `dry_run`: `false`
- [ ] 3. **Sandbox Gate**: Wait for sandbox job to pass. Open `evidence-sandbox-vX.Y.Z` artifact and verify:
  - `tests.log`: Green.
  - `digest-continuity.txt`: `digest-continuity: OK`.
  - `schema-diff.txt`: `unchanged`.
- [ ] 4. **Testnet Approval**: An active maintainer reviews testnet deploy and approves the `testnet` environment in GitHub Actions.
- [ ] 5. Confirm testnet canary passes (`canary: PASS`).
- [ ] 6. **Mainnet Canary Approval**: An independent maintainer (not the author) reviews testnet logs and approves the `mainnet-canary` environment (`[VERIFIED: docs/CANARY_RUNBOOK.md:31-33]`).
- [ ] 7. **Canary Observation Window**:
  - Observe mainnet canary smoke stream for at least **60 minutes** (`[VERIFIED: docs/CANARY_RUNBOOK.md:60-64]`).
  - Verify `available` is non-decreasing on the smoke stream (`scripts/canary_check.sh`).

---

### Phase 4: Rollback Procedure (If Canary Fails)
If any canary check fails, or contract behavior deviates from specification:
- [ ] 1. The `rollback` job in `.github/workflows/promote.yml` triggers automatically on failure (`[VERIFIED: .github/workflows/promote.yml:263-289]`).
- [ ] 2. If running manually:
  ```bash
  export MAINNET_DEPLOYER_SECRET="<SECRET>"
  scripts/rollback_mainnet.sh mainnet-canary
  ```
- [ ] 3. Confirm rollback record is appended to `deployments/promotions.log` with `result=rolled-back` (`[VERIFIED: scripts/rollback_mainnet.sh:59-61]`).
- [ ] 4. If UI was pointing at canary contract, immediately redeploy frontend with restored contract ID.

---

## 7. Bus-Factor Drill: Zero-Context Maintainer Release

This drill is designed to be executed by a maintainer who has never touched the release pipeline, verifying that the project can be operated if the lead maintainer is unavailable.

### 7.1 Day-Zero Access Checklist
Before attempting a release, verify you possess the following access permissions:
- [ ] Write permissions to repository `Neziahtech/streampay`.
- [ ] Reviewer access to GitHub Environments `testnet` and `mainnet-canary`.
- [ ] Access to the secure vault holding `MAINNET_DEPLOYER_SECRET` or authority to populate it.
- [ ] Member access to Netlify team dashboard controlling `streampay` frontend.
- [ ] Local workstation prerequisites: `rustup` with target `wasm32v1-none`, `stellar-cli >= 28.1.0`, `node >= 22`.

### 7.2 Access Verification Commands
Run these commands to confirm local tooling is ready:
```bash
stellar --version           # Must be >= 28.1.0 [VERIFIED: .github/workflows/ci.yml:69-71]
cargo --version             # Rust 2021 edition toolchain
node --version              # Must be v20 or v22
gh auth status              # Must have repo write scope
```

### 7.3 Step-by-Step Drill Walkthrough (Mocked / Safe)
1. Execute the full offline dress rehearsal:
   ```bash
   scripts/promote_rehearsal.sh
   ```
2. Inspect the generated evidence directory:
   ```bash
   ls -la evidence/rehearsal/
   cat evidence/rehearsal/summary.md
   ```
3. Test the on-call notification ping in dry-run mode:
   ```bash
   node scripts/oncall/ping.mjs --dry-run
   ```
4. Verify TTL sentinel cliff projection:
   ```bash
   cd infra/ttl-sentinel
   npm run scan -- --json
   cd ../..
   ```

### 7.4 "Stop and Escalate" Criteria
Halt the release and escalate immediately if:
- `verify_release_digest.sh` fails with a hash mismatch (indicates non-reproducible build or tampered Wasm).
- `schema_diff.sh` reports an unacknowledged interface modification (`[VERIFIED: scripts/schema_diff.sh]`).
- Contract tests report an arithmetic failure or error-surface coverage drop.
- Deployer account balance on Stellar mainnet has insufficient XLM for transaction fees.

### 7.5 Drill Log Table

| Date | Operator Handle | Drill Type | Result | Findings / Obstacles Encountered | Remediation Action |
|---|---|---|---|---|---|
| `2026-10-15` | `[LOCAL_AGENT]` | Full Rehearsal + On-Call Dry-Run | **PASS** | Rehearsal executed cleanly; verified on-call deterministic math. | Baseline established. |
| `[UNVERIFIED]` | `[MAINTAINER_2]` | Live Testnet Promotion Drill | Pending | Requires human maintainer execution. | Schedule in sprint planning. |

---

## 8. Verification Log

This section details how every section of this handbook was verified against the repository.

| Section | Verification Method | Commands Used | Result |
|---|---|---|---|
| **0. Header & Tags** | Read-verified against git HEAD | `git rev-parse HEAD` | Verified: `0846c879db1312d4a08bbf7099349822fc66ced4` |
| **2. Key & Secret Inventory** | Read-verified across repo files | `grep_search` across `.github/workflows/`, `scripts/`, `infra/ttl-sentinel/` | Verified: All secret names match exact workflow references |
| **3. Service Dependencies** | Read-verified from configs | Cross-referenced `frontend/lib/stellar.ts`, `netlify.toml`, `infra/ttl-sentinel/` | Verified: Dependency graph reflects real code paths |
| **4. On-Call Tooling** | **Dry-Run Executed** | `node scripts/oncall/ping.mjs --dry-run` and `node scripts/oncall/ping.mjs` | **PASS**: Deterministic shift calculation verified; safe no-op on missing webhook |
| **5. Dependabot Incident** | Read-verified from git history | `git log --grep="Next 16"`, `git show 4c48978`, `git show 2c03d76`, `git show 642fbf8` | Verified: PR #18 merge failure, ESLint flat config migration, and audit overrides confirmed |
| **6. Release Checklist** | Read-verified against scripts | Cross-referenced `scripts/promote_rehearsal.sh`, `scripts/release_gates.sh`, `docs/DEPLOY_PIPELINE.md` | Verified: Steps map 1:1 to executable scripts |
| **7. Bus-Factor Drill** | Read-verified | Cross-checked prerequisites in `scripts/deploy_testnet.sh` & `.github/workflows/ci.yml` | Verified: Required tooling versions match CI runners |

---

## 9. Known Gaps and Open Questions for Maintainers

1. **Single CODEOWNER Bottleneck (`[VERIFIED: .github/CODEOWNERS:3]`)**:
   - The entire repository currently maps to a single maintainer (`@Neziahtech`). A second maintainer must be granted administrative and code review authority to resolve the bus-factor risk.
2. **Missing Automated CI Tests for Frontend**:
   - `frontend/package.json` contains scripts for `lint`, `typecheck`, and `build`, but lacks an automated unit or integration test runner (`npm test` does not exist).
3. **No Automated Dependabot Coverage for `infra/ttl-sentinel`**:
   - `infra/ttl-sentinel/` has its own `package.json` and dependencies (`@stellar/stellar-sdk`), but is omitted from `.github/dependabot.yml` (`[VERIFIED: .github/dependabot.yml:1-35]`).
4. **On-Chain Auto-Extension Gap (`GAP-1`)**:
   - The smart contract does not auto-extend its instance, code, or counter entries on-chain, creating a ~5.7-hour cliff that requires continuous external sentinel operation (`[VERIFIED: docs/ARCHITECTURE.md:276-296]`).
5. **Absence of Dedicated Staging Environment**:
   - The frontend deploys to Netlify. There is currently no persistent staging environment mirroring mainnet RPC configurations.

---

## 10. Changelog

- **2026-10-15 (v1.0.0)**: Initial operations handbook compiled for second maintainers against commit `0846c879db1312d4a08bbf7099349822fc66ced4`. Integrated on-call ping tooling (`scripts/oncall/`, `.github/workflows/oncall-ping.yml`), Dependabot incident post-mortem, and bus-factor release checklists.
