# Asset Policy Governance

This document describes the governance model, failure modes, consequences, and mitigations for StreamPay's asset policy allowlist module (`src/policy.rs`).

---

## 1. Governance Model

The asset policy module provides optional, strict on-chain governance over which token assets may be used to create **new** payment streams, while enforcing the **anti-brick invariant**: existing streams of a removed asset remain fully withdrawable and refundable.

The module operates under three core governance pillars:

1. **Two-Step Admin Handoff**:
   - Rotating the policy admin requires two explicit transactions: the current admin proposes a new admin (`policy_propose_handoff`), and the proposed address must explicitly call `policy_accept_handoff` with its own authorization.
   - A pending handoff can be cancelled at any time by the current admin (`policy_cancel_handoff`).
   - This eliminates single-step transfer risks (such as mistyping a target address) that could permanently strand the admin role.

2. **Timelock on Policy Changes**:
   - Any allowlist mutation (`policy_propose_asset(asset, allowed)`) is recorded in persistent storage with the current ledger timestamp and an `executable_after` threshold.
   - The mutation cannot be executed until a configurable timelock delay (`policy_timelock_delay`) has elapsed.
   - The timelock delay is publicly readable on-chain by any user, explorer, or auditing tool.
   - This window guarantees that users, recipients, and indexers have advance notice of any upcoming asset delisting and sufficient time to settle or withdraw funds.

3. **Permissionless Execution**:
   - Once the timelock has elapsed, `policy_execute_asset(asset)` is callable by anyone (any user, keeper bot, or verifier).
   - *Why permissionless execution is intentional*: Once a policy change has been vetted by the admin and survived the mandatory timelock delay without cancellation, execution must not depend on the admin remaining available or online. If execution were restricted to the admin, a compromised or unresponsive admin could delay or withhold execution indefinitely. Permissionless execution ensures deterministic, reliable settlement of mature governance proposals.

4. **Opt-In & Anti-Brick Invariant**:
   - If the policy module is never initialized, all assets are permitted by default (zero regression against pre-policy deployments).
   - Even when active, any asset without an explicit allowlist entry is allowed by default.
   - Only explicitly removed assets (`allowed = false`) are rejected at `create_stream`.
   - `withdraw`, `withdraw_max`, and `cancel_stream` (refund) **never** check the allowlist. Tokens locked in existing streams can always be fully withdrawn or refunded pro-rata.

---

## 2. Governance Failure Modes and Mitigations

| Scenario | Consequence | Mitigation |
| :--- | :--- | :--- |
| **Admin key lost before handoff** | No new policy changes possible; existing streams unaffected | Use multisig or threshold signer (e.g. SEP-0030 / Soroban multi-auth) as policy admin. Because the module is opt-in and defaults to allowed, unmanaged assets remain functional and existing streams are unaffected. |
| **Malicious admin queues asset removal** | Queued; blocked until timelock elapses, giving users time to act | Timelock delay provides a public buffer (default 48 hours / 172,800 seconds). Indexers observe `PolicyAssetQueued` events; senders and recipients can withdraw accrued balances or cancel streams before delisting takes effect. |
| **Malicious admin completes handoff to attacker** | Attacker controls future policy; existing streams still withdrawable | Anti-brick invariant ensures token transfers for `withdraw`, `withdraw_max`, and `cancel_stream` bypass the policy allowlist. The attacker cannot brick, seize, or lock funds in running streams. |
| **Stale timelock (delay set to 0 or very low)** | Changes executable immediately, timelock provides no protection | Timelock duration is transparently readable on-chain via `policy_timelock_delay()`. Client frontends, wallets, and auditing sentinels should inspect this delay and warn users before depositing if the delay is below safe operational thresholds. |
| **Handoff proposed but never accepted** | Current admin retains control; cancel with `policy_cancel_handoff` | Current admin retains full operational authority while handoff is pending and can cancel the proposal at any time with `policy_cancel_handoff()`. No deadlocks occur. |
| **Typo in proposed asset address** | An unintended asset is queued for mutation | Current admin can overwrite the proposal by calling `policy_propose_asset` with the corrected parameters before the timelock expires, or propose a re-allow once identified. |
| **Front-running uninitialized policy** | Attacker calls `policy_init` before legitimate admin | Deployers should bundle `policy_init` in the deployment transaction sequence or contract initialization script. If uninitialized, the contract operates in open mode. |
| **Admin attempts double initialization** | Transaction panics and reverts | Contract strictly enforces one-time initialization; double-initialization panics with `"policy already initialized"`. |
| **Non-proposed party attempts to accept handoff** | Transaction panics with auth failure | `policy_accept_handoff` requires `proposed_admin.require_auth()`; only the explicitly nominated address can authorize acceptance. |
| **Storage TTL expiration of policy entries** | Policy entry archived if untouched for extended periods | Every policy read/mutation extends entry TTLs with `TTL_THRESHOLD_LEDGERS` (200,000 ledgers) and `TTL_EXTEND_LEDGERS` (500,000 ledgers). In addition, the off-chain `infra/ttl-sentinel` monitors live ledger cliff thresholds across all classes. |

---

## 3. Stream Policy Floors and Grandfathering Semantics

To prevent resource-exhaustion attacks, dust spam, and nonsensical configurations (e.g. 1-second streams with astronomical rates or dust deposits), StreamPay includes governance-managed policy floors and ceilings:

### Configuration Parameters
Stored in `StreamPolicy`:
- `min_deposit`: Minimum deposit required for a stream.
- `min_duration`: Minimum stream duration in seconds.
- `max_duration`: Maximum stream duration in seconds.
- `min_rate`: Minimum accrual rate (`deposit / duration`) in tokens/second.
- `max_rate`: Maximum accrual rate (`deposit / duration`) in tokens/second.

### Resolution Hierarchy
- **Token-Specific Policy**: Persisted under `PolicyDataKey::StreamPolicy(Address)`. Takes highest precedence.
- **Global Default Policy**: Persisted under `PolicyDataKey::GlobalStreamPolicy`. Used when no token-specific policy is configured.
- **Unset (Default)**: If neither exists, stream parameters are constrained only by fundamental contract limits (`deposit > 0`, `duration >= 1`, `duration <= MAX_DURATION_SECONDS`, `capacity`).

### Enforcement & Grandfathering Precedence
1. **Stream Creation (`create_stream`, `create_streams`)**:
   - Strictly enforces all floors and ceilings: `min_deposit`, `min_duration`, `max_duration`, `min_rate`, `max_rate`.
   - Violations return typed, append-only errors (`PolicyDepositBelowFloor`, `PolicyDurationBelowFloor`, `PolicyDurationAboveCeiling`, `PolicyRateBelowFloor`, `PolicyRateAboveCeiling`).
2. **Top-Up (`top_up`)**:
   - **Grandfathering Guarantee**: Stream duration is fixed at creation time and grandfathered. A subsequent increase in `min_duration` or decrease in `max_duration` does **not** block top-ups on already-running streams.
   - **Violation Rule**: The new total deposit (`deposit + top_up_amount`) and resulting accrual rate (`new_deposit / duration`) must respect `min_deposit`, `min_rate`, and `max_rate`.
3. **Cancellation (`cancel_stream`)**:
   - Under the **anti-brick invariant**, policy changes **never** obstruct or modify stream cancellations. Senders and recipients can always settle and withdraw accrued or unaccrued funds regardless of policy state.

### Governance Timelock Integration Hook
Currently, `set_stream_policy` is gated by the treasury governor (`treasury::require_governor`). When governance timelocks are fully deployed across administrative operations, `set_stream_policy` will hook into the timelocked proposal and execution queue (analogous to `propose_upgrade` and `execute_upgrade`), ensuring community review periods before parameter changes take effect.

