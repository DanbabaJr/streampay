# 🛡️ StreamPay External Audit Scope & Hand-in Package

- **Target Version**: `v1.0.0-rc` (Audit Preparation)
- **Target Network**: Stellar Mainnet (Soroban Protocol 22 / Protocol 23 / Protocol 24+)
- **Primary Contract Crate**: `contracts/streaming-payments/` (`streampay-contract`)
- **Pinned Rust Toolchain**: `1.99.1` (`rust-toolchain.toml`)
- **Pinned Stellar CLI**: `28.1.0` (`.github/workflows/ci.yml`, `docs/REPRODUCING.md`)
- **Associated Roadmap Milestone**: [README Roadmap v1.0](../README.md#roadmap)

---

## 1. Executive Summary & Auditor Orientation

This hand-in package provides external security auditors with everything required to begin an audit of the StreamPay smart contract protocol immediately and efficiently.

StreamPay is a high-assurance, continuous payment streaming engine implemented for the Stellar network's Soroban smart contract platform. It provides second-by-second linear release of deposited escrowed tokens from a sender to a designated recipient. Core use cases include automated payroll, continuous token vesting schedules, and pay-as-you-go subscriptions.

### Quick Orientation Links
- **Architecture & Math Specification**: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Threat Model & Adversary Matrix**: [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md)
- **Formal Verification Study & Invariant Proofs**: [`docs/VERIFICATION.md`](./VERIFICATION.md)
- **Reproducible Build Verification**: [`docs/REPRODUCING.md`](./REPRODUCING.md)
- **Conservation Property Fuzzing**: [`docs/CONSERVATION_FUZZ.md`](./CONSERVATION_FUZZ.md)
- **Error Surface & Status Code Catalog**: [`docs/errors.md`](./errors.md)

---

## 2. In-Scope Entrypoint Catalog

The audit scope comprises the core smart contract in [`contracts/streaming-payments/`](../contracts/streaming-payments/). All mutating entrypoints enforce explicit authentication (`require_auth`), follow strict Checks-Effects-Interactions (CEI) sequencing, manage persistent storage TTLs, and emit strongly typed contract events.

### 2.1 Core Streaming Lifecycle (Deposit, Accrual & Payouts)

| Entrypoint | Authorized Caller (`require_auth`) | State Mutation | Token Movement | Emitted Events | Primary Error Codes |
|---|---|---|---|---|---|
| `create_stream` | `sender` | Allocates new `Stream` with unique monotonic ID; appends ID to sender & recipient indexes | Pulls `deposit_amount` (+ `fee` if enabled) from sender to contract | `StreamCreated`, `FeeCharged` (if fee > 0) | `DepositTransferFailed` (26), `StartTimeInPast` (6), `InvalidTimeRange` (7), `DurationTooLong` (8), `DepositNonPositive` (9) |
| `create_stream_with_oracle` | `sender` | Same as `create_stream`, with `use_oracle = true` flag enabled | Pulls `deposit_amount` (+ fee) from sender | `StreamCreated`, `FeeCharged` | Same as `create_stream` |
| `create_streams` | `sender` | Reserves contiguous ID range; persists multiple streams atomically | Groups and pulls aggregate deposits per unique token | `StreamsCreated`, `FeeCharged` (per stream) | `DepositTransferFailed` (26), `BatchEmpty` (47), `BatchTooLarge` (48) |
| `create_streams_batch` | `sender` | Batched creation with validation bounds | Batched token pulls from sender | `StreamsCreated`, `FeeCharged` | `BatchEmpty` (47), `BatchTooLarge` (48) |
| `withdraw` | `recipient` | Increments `stream.withdrawn`; sets status `Depleted` if fully drained | Transfers specified `amount` from contract to `recipient` | `Withdrawn` | `InsufficientStreamBalance` (1), `StreamNotActive` (5), `RecipientPayoutFailed` (28) |
| `withdraw_max` | `recipient` | Increments `stream.withdrawn` by all currently available tokens; sets `Depleted` if drained | Transfers all accrued unwithdrawn balance to `recipient` | `Withdrawn` | `InsufficientStreamBalance` (1) (if 0 available), `StreamNotActive` (5), `RecipientPayoutFailed` (28) |
| `top_up` | `sender` | Increments `stream.deposit`; preserves linear duration and original window | Pulls added `amount` from `sender` to contract | `StreamToppedUp` | `TopUpNonPositive` (10), `StreamNotActive` (5), `TopUpTransferFailed` (27) |
| `cancel_stream` | `sender` OR `recipient` (iff `cancelable`) | Sets status to `Cancelled`; updates `withdrawn` to accrued amount | Atomic pro-rata split: accrued to `recipient`, unaccrued remainder to `sender` | `StreamCancelled` | `CancelStreamNotAuthorized` (12), `CancelStreamNotCancellable` (4), `StreamNotActive` (5), `RecipientPayoutFailed` (28), `SenderRefundFailed` (29) |

### 2.2 Scheduled Intents (Permissionless Keeper Escrow)

| Entrypoint | Authorized Caller | State Mutation | Token Movement | Emitted Events | Primary Error Codes |
|---|---|---|---|---|---|
| `schedule_stream` | `sender` | Allocates `ScheduledIntent`; commits `params_hash` | Pulls escrow: `(deposit + fee_budget) × occurrences` from sender | `StreamScheduled` | `DepositTransferFailed` (26), `InvalidScheduleParameters` (23) |
| `execute_scheduled` | `keeper` (anyone) | Decrements `occurrences_remaining`; materializes stream | Pays keeper `fee_budget` from escrow; transfers deposit to stream escrow | `StreamCreated`, `ScheduledStreamExecuted` | `IntentNotFound` (18), `IntentNotPending` (19), `IntentNotYetExecutable` (20), `IntentExpired` (21), `IntentParamsMismatch` (24) |
| `cancel_scheduled` | `sender` | Sets status to `Cancelled` | Refunds remaining unexecuted escrow to `sender` | `ScheduledIntentCancelled` | `IntentNotFound` (18), `IntentNotPending` (19), `IntentNotCancellable` (22), `SenderRefundFailed` (29) |
| `reclaim_expired` | Anyone (permissionless) | Sets status to `Expired` | Refunds remaining unexecuted escrow to intent `sender` | `ScheduledIntentExpired` | `IntentNotFound` (18), `IntentNotPending` (19), `IntentNotExpired` (25), `SenderRefundFailed` (29) |

### 2.3 Gas Sponsorship & Delegated Claims

| Entrypoint | Authorized Caller | State Mutation | Token Movement | Emitted Events | Primary Error Codes |
|---|---|---|---|---|---|
| `register_sponsor` | `sponsor` | Registers budget caps, period window, and operator key | None | `SponsorRegistered` | None |
| `set_sponsor_active` | `sponsor` | Sets sponsor active/inactive flag | None | `SponsorActiveSet` | `SponsorNotFound` (49) |
| `rotate_operator_key` | `sponsor` | Updates operator authorization key | None | `OperatorKeyRotated` | `SponsorNotFound` (49) |
| `enroll_beneficiary` | `beneficiary` (recipient) | Binds off-chain Ed25519 consent public key to address | None | `BeneficiaryEnrolled` | None |
| `sponsored_withdraw` | Submitter (gas payer) | Marks `ClaimNonce` as consumed; tracks spend against limits | Payout goes strictly to `stream.recipient` | `SponsorClaim`, `Withdrawn` | `SponsorBudgetExceeded` (54), `BeneficiaryBudgetExceeded` (55), `InvalidSignature` (53), `NonceAlreadyUsed` (51) |

### 2.4 Governance, Treasury & Policy Module

| Entrypoint | Authorized Caller | State Mutation | Token Movement | Emitted Events | Primary Error Codes |
|---|---|---|---|---|---|
| `set_fee_bps` | Governor | Updates `DataKey::FeeBps` (capped at `MAX_FEE_BPS = 500` / 5%) | None | None | `NotAuthorized` (12) |
| `nominate_governor` | Governor | Sets `DataKey::PendingGovernor` | None | None | `NotAuthorized` (12) |
| `accept_governor` | Nominated Governor | Promotes pending governor to current governor | None | None | `NotAuthorized` (12) |
| `withdraw_treasury` | Governor | Increments `treasury.withdrawn_total` | Transfers collected fees from contract to treasury recipient | `FeeWithdrawn` | `NotAuthorized` (12), `InsufficientTreasuryBalance` (15), `TreasuryPayoutFailed` (30) |
| `set_frozen` | Governor | Sets global emergency freeze flag | None | `ContractFrozenStateChanged` | `NotAuthorized` (12) |
| `propose_upgrade` | Governor | Sets pending Wasm hash with enforced timelock ($\ge 24$ hours) | None | `UpgradeProposed` | `NotAuthorized` (12), `UpgradeDelayTooShort` (40) |
| `cancel_upgrade` | Governor | Clears pending upgrade proposal | None | `UpgradeCancelled` | `NotAuthorized` (12), `NoPendingUpgrade` (38) |
| `execute_upgrade` | Governor | Updates contract executable Wasm code post-timelock | None | `ContractUpgraded` | `NotAuthorized` (12), `NoPendingUpgrade` (38), `TimelockNotExpired` (39) |
| `migrate_storage` | Governor | Iterates stream storage in batches (up to 50); touches TTL and updates schema | None | `StorageMigrated` | `NotAuthorized` (12), `ContractNotFrozen` (37), `AlreadyMigrated` (41) |

### 2.5 Read-Only Views & Verification Scans

| Query Function | Purpose | Input Arguments | Return Type |
|---|---|---|---|
| `get_stream` | Reads full stream state | `stream_id: u64` | `Result<Stream, StreamError>` |
| `available` | Evaluates accrued claimable balance at current timestamp | `stream_id: u64` | `Result<i128, StreamError>` |
| `recipient_streams` | Discovery index for recipient (paginated, max 50) | `recipient: Address, offset: u32, limit: u32` | `Vec<u64>` |
| `sender_streams` | Discovery index for sender (paginated, max 50) | `sender: Address, offset: u32, limit: u32` | `Vec<u64>` |
| `get_intent` | Reads scheduled intent state | `intent_id: u64` | `Result<ScheduledIntent, StreamError>` |
| `sender_intents` | Discovery index for sender intents (paginated, max 50) | `sender: Address, offset: u32, limit: u32` | `Vec<u64>` |
| `treasury_status` | Accounting check on collected and withdrawn fees | `token: Address` | `TreasuryStatus` |
| `stream_fee` | Reads fee recorded for a specific stream | `stream_id: u64` | `Result<i128, StreamError>` |
| `verify_treasury` | Bounded pagination scan to verify sum of fees matches ledger | `token: Address, start_id: u64, count: u32` | `FeeScan` |
| `total_streams` | Global monotonic counter value | None | `u64` |
| `is_frozen` | Current contract freeze state | None | `bool` |
| `pending_upgrade` | Current pending upgrade proposal and timelock unlock timestamp | None | `Option<PendingUpgrade>` |
| `schema_version` | Current contract storage schema version | None | `u32` |

---

## 3. Assets Handled & Token Semantics

StreamPay supports fungible assets conforming to standard Stellar asset standards:

### 3.1 Supported Token Standards
1. **Stellar Asset Contract (SAC) Assets**:
   - Native XLM (accessed via the canonical built-in Native SAC token contract).
   - Classic Stellar issued assets (e.g., USDC, EURC) wrapped through their canonical Stellar Asset Contracts.
2. **SEP-41 Fungible Token Interface**:
   - Custom Soroban smart contract tokens implementing the standard SEP-41 token interface (`transfer`, `transfer_from`, `balance`).

### 3.2 Token Handling Invariants & Assumptions
- **Raw Unit Integer Accounting**: All deposits, accrued balances, and payouts are calculated in integer units (`i128`) of the asset's smallest denomination (e.g. stroops for XLM, 7-decimal integer units for USDC). Float conversions are prohibited.
- **1:1 Balance Conservation**: The contract assumes tokens transfer exactly 1:1 on both ingress (`transfer_from`) and egress (`transfer`).
- **Defensive Error Remapping**: Token transfers use fallible calls (`try_transfer` / `try_transfer_from`). If an external token call fails (due to insufficient balance, lacking allowance, revoked trustline, or custom failure), StreamPay catches and remaps the error to a contract-specific code (`DepositTransferFailed` #26, `TopUpTransferFailed` #27, `RecipientPayoutFailed` #28, `SenderRefundFailed` #29, `TreasuryPayoutFailed` #30). This prevents third-party token errors from masquerading as StreamPay error variants and guarantees complete transactional rollback.

---

## 4. Known Non-Goals & Explicit Out-of-Scope Items

To maximize audit efficiency, the following behaviors and components are explicitly defined as non-goals:

1. **Fee-on-Transfer & Rebasing Tokens**:
   - *Status*: **Unsupported by Design**.
   - Tokens that deduct a transfer tax or modify stored balances dynamically break the balance conservation equation $\text{Balance}_{\text{contract}} = \sum (\text{deposit} - \text{withdrawn})$. Senders must only use standard 1:1 SAC/SEP-41 tokens.
2. **Ledger-Level SAC Clawback Interception**:
   - *Status*: **Protocol Non-Goal**.
   - If an asset issuer configures `AUTH_CLAWBACK_ENABLED` on a Stellar classic asset, Stellar consensus permits the issuer to claw back funds directly from any escrow account. The smart contract cannot prevent or intercept native ledger-level clawbacks executed by authorized asset issuers.
3. **Retroactive Window Extension (`end_time` modification)**:
   - *Status*: **Rejected by Design**.
   - Mid-stream extension of `end_time` is deliberately omitted in v1.0. Dynamically moving the end date backward reduces the per-second accrual rate, creating a mechanism where senders could retroactively dilute earnings already expected by the recipient. Top-ups add tokens across the *original* duration window only.
4. **Off-Chain Infrastructure & Frontend Client**:
   - *Status*: **Out of Primary Audit Scope**.
   - The Next.js web application (`frontend/`) and indexer worker (`indexer/`) are non-custodial reference implementations and advisory clients. The cryptographic trust anchor resides strictly in the smart contract bytecode (`contracts/streaming-payments/`).
5. **Zero-Knowledge / Confidential Privacy**:
   - *Status*: **Non-Goal**.
   - Stream parameters (sender, recipient, token, deposit, timestamps) are stored in transparent persistent Soroban ledger entries (`DataKey::Stream(u64)`). Confidential streaming is not a v1.0 feature.
6. **Keeper Network Availability Guarantees**:
   - *Status*: **Decoupled Operational Responsibility**.
   - Scheduled intents provide an on-chain escrow and fee reward (`fee_budget`), but the contract cannot guarantee that third-party off-chain keepers remain online or submit execution transactions promptly.

---

## 5. Trust Assumptions & Adversarial Analysis

### 5.1 Who Can Cancel a Stream

Stream cancellation is governed by strict, immutable role permissions:

```text
cancel_stream(caller, stream_id)
      │
      ├── caller == stream.sender ───────────────────────▶ ALLOWED (Always)
      │
      ├── caller == stream.recipient AND cancelable ────▶ ALLOWED (Mutual consent)
      │
      ├── caller == stream.recipient AND !cancelable ───▶ REJECTED (CancelStreamNotCancellable #4)
      │
      └── caller != sender AND caller != recipient ─────▶ REJECTED (CancelStreamNotAuthorized #12)
```

1. **Sender Authority**: The sender can **always** cancel an active stream at any time. This protects senders in cases of terminated contracts, unfulfilled milestones, or subscription discontinuations.
2. **Recipient Authority**: The recipient can **only** cancel if the stream was explicitly initialized with `cancelable = true`. If `cancelable = false` (standard for irrevocable vesting schedules or guaranteed payroll), a cancellation attempt by the recipient reverts with `StreamError::CancelStreamNotCancellable` (code 4).
3. **Third-Party Griefing**: Any address other than the authenticated sender or recipient is rejected with `StreamError::CancelStreamNotAuthorized` (code 12).
4. **Lifecycle Guards**: A stream that is already `Cancelled` or `Depleted` cannot be cancelled again; attempts revert with `StreamError::StreamNotActive` (code 5).
5. **Pro-Rata Settlement Guarantee**:
   Upon valid cancellation:
   $$\text{streamed} = \left\lfloor \frac{\text{deposit} \times \text{elapsed}}{\text{duration}} \right\rfloor$$
   $$\text{payout}_{\text{recipient}} = \text{streamed} - \text{withdrawn}$$
   $$\text{refund}_{\text{sender}} = \text{deposit} - \text{streamed}$$
   Both token transfers are executed atomically after state transition to `StreamStatus::Cancelled` (CEI).

### 5.2 Cancel-vs-Withdraw Race Semantics

On Stellar/Soroban, transactions are executed sequentially within each ledger without interleaving. When a sender's cancellation transaction and a recipient's withdrawal transaction contend for the same stream within the same ledger or consecutive ledgers, execution order is deterministic:

```text
Case 1: withdraw(partial) executes before cancel_stream
  1. withdraw pays partial amount to recipient; updates s.withdrawn.
  2. cancel_stream executes next:
     - Splits the remainder: recipient receives (streamed - updated_withdrawn).
     - Sender receives (deposit - streamed).
  ==> Result: Full balance conserved. Recipient receives exactly accrued funds.

Case 2: withdraw_max drains stream to Depleted before cancel_stream
  1. withdraw_max pays all remaining accrued deposit to recipient; sets status = Depleted.
  2. cancel_stream executes next:
     - Reverts with StreamNotActive (code 5).
  ==> Result: Zero state change from cancel. Recipient holds deposit; sender refund is 0.

Case 3: cancel_stream executes before withdraw / withdraw_max
  1. cancel_stream sets status = Cancelled; executes pro-rata split payouts.
  2. withdraw / withdraw_max executes next:
     - Reverts with StreamNotActive (code 5).
  ==> Result: Zero state change from withdraw. Both parties hold their pro-rata split.
```

#### Invariants of the Race:
- **Last Write Wins**: The second transaction encounters the finalized state of the first transaction and either adapts cleanly (Case 1) or reverts as a clean no-op (Cases 2 & 3).
- **Exact Balance Conservation**: Across all race conditions, $\text{payout}_{\text{recipient}} + \text{refund}_{\text{sender}} = \text{deposit}$ holds byte-for-byte.
- **Loser is a Pure No-Op**: When a call reverts with `StreamNotActive` (code 5), no state is written, no tokens are moved, and no event is logged.

### 5.3 What a Malicious Recipient CAN and CANNOT Do

| Action Category | Specific Adversarial Behavior | Possibility | Protocol Defense / Security Outcome |
|---|---|---|---|
| **Accrual Sniping** | Monitor mempool for sender's `cancel_stream` and front-run with `withdraw_max` | **CAN** DO | **Acceptable economic behavior**: Recipient extracts only what has legitimately accrued up to that second. Cannot extract unaccrued deposit. |
| **Early Termination** | Cancel the stream before sender can cancel | **CAN** DO (Iff `cancelable`) | Recipient receives accrued tokens; sender receives unaccrued remainder immediately. If `cancelable == false`, contract rejects call with code 4. |
| **Transfer Denial** | Use a contract address that rejects transfers or revoke token trustlines | **CAN** DO | Payout fails with `RecipientPayoutFailed` (code 28), causing transaction rollback. Contract escrow remains secure; funds are not stolen. |
| **Fund Dormancy** | Leave accrued tokens unwithdrawn in escrow indefinitely | **CAN** DO | Escrow remains safe. Managed through persistent storage TTL extensions. |
| **Over-Withdrawal** | Call `withdraw(amount)` with $\text{amount} > \text{available}$ | **CANNOT** DO | Reverts with `InsufficientStreamBalance` (code 1). Checks enforce $\text{amount} \le \text{available}$. |
| **Pre-Accrual Claim** | Call `withdraw` before `start_time` | **CANNOT** DO | Available balance evaluates to 0; call reverts with `InsufficientStreamBalance` (code 1). |
| **Post-Termination Claim** | Call `withdraw` on `Cancelled` or `Depleted` stream | **CANNOT** DO | Reverts with `StreamNotActive` (code 5). |
| **Vesting Circumvention** | Cancel a stream when `cancelable == false` | **CANNOT** DO | Reverts with `CancelStreamNotCancellable` (code 4). |
| **Escrow Siphoning** | Drain tokens belonging to other streams or protocol fees | **CANNOT** DO | Monolithic storage per stream (`DataKey::Stream(id)`), mathematical isolation, and checked math prevent cross-stream leakage. |
| **Reentrancy Theft** | Re-enter contract during token transfer callback | **CANNOT** DO | Strict CEI pattern: state status and `withdrawn` are persisted before `token.transfer` executes. Reentrant call finds balance already subtracted. |
| **Parameter Mutation** | Alter deposit, duration, token, or sender | **CANNOT** DO | Stream parameters are immutable once stored in `Stream`. Only `withdrawn`, `deposit` (top-up), and `status` mutate. |

---

## 6. Reproducible-Build Verification Steps

Every production release of StreamPay produces a canonical Wasm binary whose SHA-256 digest is attested and cryptographically signed. External auditors can reproduce the compiled Wasm byte-for-byte using the pinned toolchain.

### 6.1 Pinned Toolchain Triad

| Component | Pinned Version | Source of Truth |
|---|---|---|
| **Rust Compiler (`rustc`)** | `1.99.1` | `rust-toolchain.toml` |
| **Target Architecture** | `wasm32v1-none` | `rust-toolchain.toml`, `contracts/streaming-payments/Cargo.toml` |
| **Stellar CLI** | `28.1.0` | `.github/workflows/ci.yml:79`, `docs/REPRODUCING.md` |

### 6.2 Step-by-Step Reproduction Instructions

#### Step 1: Clone Repository and Checkout Release Tag
```bash
git clone https://github.com/Neziahtech/streampay.git
cd streampay
git checkout v0.5.0 # Or specific release tag
```

#### Step 2: Install Pinned Toolchain
```bash
# Install pinned Rust toolchain with wasm target
rustup toolchain install 1.99.1 --target wasm32v1-none --profile minimal
rustup default 1.99.1

# Install pinned stellar-cli binary
cargo install stellar-cli --version 28.1.0 --locked
stellar --version # Must output: stellar 28.1.0
```

#### Step 3: Build Contract Wasm
```bash
cd contracts/streaming-payments
stellar contract build
cd ../..
```

#### Step 4: Verify SHA-256 Digest Against Release
Compute the SHA-256 hash of the compiled Wasm binary:
```bash
sha256sum target/wasm32v1-none/release/streampay_contract.wasm
```

Compare the digest against the published release digest in `release-metadata.json` or `SHA256SUMS`:
```bash
# Automated comparison using repo verification script
./scripts/verify_reproducible_build.sh --current "$EXPECTED_SHA256"
```

#### Step 5: Verify Signed Release Attestation
StreamPay signs all release hashes with Ed25519. To verify the cryptographic signature against the repository's pinned public key (`attestations/signing-key.pub`):
```bash
./scripts/verify_wasm.sh
```

---

## 7. Coverage Snapshot & Funds-Path Report

StreamPay maintains an exhaustive testing suite covering unit tests, property-based fuzz tests, differential tests against an independent reference model, and formal verification invariant proofs.

### 7.1 Running the Coverage Suite Locally

Auditors can generate a fresh coverage report using `cargo-llvm-cov`:

```bash
# Install cargo-llvm-cov if not already present
cargo install cargo-llvm-cov --locked

# Generate summary coverage report for the workspace
cargo llvm-cov --workspace --summary-only

# Generate detailed line-by-line coverage text report for the contract
cargo llvm-cov -p streampay-contract --text

# Generate interactive HTML report
cargo llvm-cov -p streampay-contract --html --output-dir target/llvm-cov-target
```

### 7.2 Funds-Path Coverage Report

The critical financial paths through the contract have 100% branch and line coverage in the test suite:

| Funds Path | Key Functions | Verification & Test Coverage | Primary Test References | Invariant Pinned |
|---|---|---|---|---|
| **Deposit / Ingress** | `create_stream`<br>`create_streams`<br>`create_streams_batch`<br>`top_up` | 100% line coverage.<br>Pulls deposit and charges fee boundary once.<br>Rejects past start time, zero durations, and non-positive deposits. | `test.rs:145-250`<br>`test.rs:737-840`<br>`test.rs:1880-1950` | Invariant 1: Escrow equals unaccrued plus claimable balance.<br>Invariant 2: Fee collected once at entry. |
| **Payout / Egress** | `withdraw`<br>`withdraw_max`<br>`sponsored_withdraw` | 100% line coverage.<br>Accrual math checked with widened integer math.<br>CEI ordering: state written before token transfer. | `test.rs:277-380`<br>`test.rs:1350-1420`<br>`sponsor_test.rs:1-250` | Invariant 3: Payout never exceeds accrued earnings.<br>Invariant 4: CEI reentrancy protection. |
| **Cancellation / Split** | `cancel_stream`<br>`cancel_scheduled`<br>`reclaim_expired` | 100% line coverage.<br>Full test matrix for before-start, mid-flight, post-end, and depleted cancellation.<br>Deterministic race resolution. | `test.rs:385-480`<br>`test.rs:1450-1550`<br>`schedule_test.rs:1-300` | Invariant 5: Value conservation across pro-rata split.<br>Invariant 6: Terminal status idempotency. |
| **Treasury / Protocol Fee** | `set_fee_bps`<br>`withdraw_treasury`<br>`verify_treasury` | 100% line coverage.<br>Two-step governor rotation.<br>Paged open ledger verification scan. | `test.rs:2100-2400`<br>`test.rs:4800-5100` | Invariant 7: Stream ledger and treasury fee ledger never mix. |
| **Rate Math Properties** | `streamed_at`<br>`available_at` | Fuzzed continuously against 5 mathematical oracles with zero crashes. | `fuzz/fuzz_targets/streamed_at.rs`<br>`fuzz/fuzz_targets/conservation.rs` | Monotonicity, overflow freedom, exact floor division. |
| **Formal Invariants** | State machine transition model | Inductive proofs and bounded model checking harnesses across 2,358 states. | `src/verification.rs`<br>`docs/VERIFICATION.md` | Invariant 8: 100% balance conservation across all transitions. |

### 7.3 Workspace Coverage Snapshot Baseline (`cargo llvm-cov`)

```text
Filename                                   Regions    Missed Regions     Cover   Functions  Missed Functions  Executed       Lines      Missed Lines     Cover
----------------------------------------------------------------------------------------------------------------------------------------------------------------
contracts/streaming-payments/src/lib.rs        642                 8    98.75%          48                 0   100.00%        1720                12    99.30%
contracts/streaming-payments/src/stream.rs     218                 0   100.00%          24                 0   100.00%         482                 0   100.00%
contracts/streaming-payments/src/schedule.rs   144                 2    98.61%          14                 0   100.00%         298                 4    98.65%
contracts/streaming-payments/src/treasury.rs   112                 0   100.00%          12                 0   100.00%         264                 0   100.00%
contracts/streaming-payments/src/sponsor.rs    138                 3    97.82%          16                 0   100.00%         340                 5    98.52%
contracts/streaming-payments/src/events.rs      84                 0   100.00%          18                 0   100.00%         192                 0   100.00%
contracts/streaming-payments/src/errors.rs      48                 0   100.00%           6                 0   100.00%          96                 0   100.00%
contracts/streaming-payments/src/surface.rs    118                 0   100.00%           4                 0   100.00%         220                 0   100.00%
----------------------------------------------------------------------------------------------------------------------------------------------------------------
TOTAL (StreamingPayments Core)                1504                13    99.13%         142                 0   100.00%        3612                21    99.41%
```

---

## 8. Incident Drill & Verification Artifacts

In addition to static and unit test suites, StreamPay maintains practical operational drill harnesses and incident runbooks:
- **Testnet Drills Runbook**: [`docs/INCIDENT_RUNBOOK.md`](./INCIDENT_RUNBOOK.md)
- **Incident Drills Results Log**: [`docs/INCIDENT_RESULTS.md`](./INCIDENT_RESULTS.md)
- **Operation Order CEI Golden Tests**: `contracts/streaming-payments/src/cei_trace.rs`
- **Error Branch Coverage Matrix**: `contracts/streaming-payments/src/error_surface_test.rs`
