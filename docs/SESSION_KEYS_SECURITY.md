# Session Keys Security Model and Incident Response

> **Status: design record, not shipped surface.** The entrypoints described here
> (`authorize_agent`, `revoke_agent`, `withdraw_delegated`, `agent_status`) were
> merged in #660, duplicated by #677 and reverted in #697: together with the
> commit-reveal surface they pushed the contract Wasm to 140,693 B, past
> Soroban's 131,072 B code limit, so the build could not be deployed at all.
> Error codes 126–129 stay
> reserved and are listed in `surface.rs::RETIRED_CODES`; re-landing this design
> needs its own contract, per `docs/WASM_SIZE.md`.

## 1. Overview and Problem Statement

Automated stream withdrawals (e.g. daily sweeping into cold storage, recurring treasury distributions, automated portfolio rebalancing) traditionally require exposing the recipient's primary private key to continuous hot environment execution. If an automation server or cloud agent hosting the private key is breached, the attacker gains unbounded access to all active streams and wallet assets.

The session-key mechanism (Issue #56) resolves this by letting a recipient delegate scoped withdrawal authority to a secondary "agent" address on one stream, under constraints the contract enforces on every call:

- **Per-period cap (`max_per_period`):** hard ceiling on outflow inside one window.
- **Lifetime cap (`max_per_stream`):** hard ceiling on what that agent may ever withdraw from the stream.
- **Window length (`period_duration`):** seconds per window, e.g. 86400 for a daily sweep.
- **Session expiry (`expires_at`):** absolute timestamp after which every call reverts.
- **Instant revocability:** the recipient can delete the delegation in one transaction.

One delegation covers exactly one stream. The authorizer must be the stream's recipient, and payouts never leave the stream's recipient.

## 2. Security Architecture and Boundary

```
+-----------------------------------------------------------------------------------+
| Recipient Master Key (Cold Wallet / Hardware Signer)                              |
| - Grants a delegation with authorize_agent(stream_id, agent, ...)                 |
| - Removes it with revoke_agent(stream_id, agent, caller)                          |
| - Reads it back with agent_status(stream_id, agent)                               |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| On-Chain Policy Storage (StreamPay Contract, persistent)                          |
| - DataKey::AgentAuth(stream_id, agent) -> { max_per_period, max_per_stream,       |
|                                             period_duration, expires_at }         |
| - DataKey::AgentCap(stream_id, agent)   -> { current_period_start,               |
|                                             period_withdrawn, total_withdrawn }   |
| - Caps, window rollover and expiry are re-evaluated on every withdrawal           |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | Calls withdraw_delegated(stream_id, agent, amount)
+-----------------------------------------------------------------------------------+
| Automation Agent / Bot (Hot Wallet / Server)                                      |
| - Holds ONLY the agent keypair, and must sign each call                           |
| - Can NEVER withdraw to an arbitrary address (funds go directly to recipient)     |
| - Cannot exceed max_per_period in a window or max_per_stream overall              |
+-----------------------------------------------------------------------------------+
```

### 2.1 On-Chain Cap Enforcement vs Off-Chain Assumptions
Many Web3 delegation implementations rely on off-chain rate limiters or trust the bot server to only request authorized amounts. In StreamPay every constraint is validated inside the contract, and `withdraw_delegated` runs the same preamble as `withdraw` — maintenance freeze, hook reentrancy lock, oracle release gating and accrual — so a delegation can never move funds the recipient itself could not currently withdraw.

- **Destination Invariance:** `withdraw_delegated` pays through the same payout path as the recipient's own withdrawal, i.e. to `stream.recipient`. The agent cannot redirect payouts to its own address or a third party.
- **Authorization Required:** no `AgentAuth` record for `(stream_id, agent)` → `StreamError::AgentNotAuthorized`.
- **Window Progression:** when `now >= current_period_start + period_duration`, the contract re-anchors the window to the `period_duration` grid measured from `stream.start_time` and resets `period_withdrawn` to zero. Windows are deterministic, so a bot cannot shop for a fresher window.
- **Overflow-Protected Accumulation:** `period_withdrawn + amount` and `total_withdrawn + amount` are both computed with checked arithmetic before comparison against `max_per_period` and `max_per_stream`.
- **Expiry Check:** `now >= expires_at` → `StreamError::AgentExpired`. `authorize_agent` refuses a delegation whose `expires_at` is already in the past.
- **Accrual Bound:** the amount may not exceed what has actually streamed, so a large `max_per_period` cannot pull future accrual forward.

## 3. Threat Model and Blast Radius

| Attack Scenario | Blast Radius / Consequence | Mitigation in StreamPay |
|---|---|---|
| Complete Server / Hot Key Compromise | Attacker obtains the agent private key | Payouts still deliver ONLY to the recipient wallet, so the attacker cannot exfiltrate to their own address; the worst case within one window is `max_per_period`, and never more than `max_per_stream` for the life of the delegation. |
| Malicious / Errant Withdrawal Loop | Bot loops `withdraw_delegated` | The contract rejects once `period_withdrawn` would exceed `max_per_period` (`CapExceededPeriod`) or `total_withdrawn` would exceed `max_per_stream` (`CapExceededStream`). The stream cannot be drained ahead of the schedule. |
| Replay / Expired Key Use | Attacker uses a key past its validity | `expires_at` is enforced on-chain; expired calls revert with `AgentExpired` without any off-chain dependency. |
| Withdrawal After Revocation | Attacker races a revocation | `AgentAuth` is removed in the revoking transaction, so any later call finds no delegation and reverts with `AgentNotAuthorized`. |
| Frozen or Gated Stream | Attacker withdraws while the contract is paused or the stream's oracle condition is unmet | `require_not_frozen` and release gating reject the call (`ContractFrozen`, `ConditionNotMet`). |
| Hook Reentrancy During Delegation | A callback stream re-enters `withdraw_delegated` | The per-stream hook lock rejects reentrancy (`HookReentrancyBlocked`). |
| Master Key Compromise | Attacker gains the recipient key | The master key can withdraw the stream directly anyway (standard root-of-trust assumption). Session keys do not enlarge that blast radius. |

## 4. Revocation Latency and Guarantees

- **Zero-Latency Invalidation:** `revoke_agent(stream_id, agent, caller)` requires `caller`'s signature and rejects anyone but the stream recipient with `StreamError::NotAuthorized`. Once the transaction lands, every later `withdraw_delegated` from that agent on that stream reverts.
- **No Grace Period:** unlike staking or timelocked designs, there is no cooling-off window on revocation.
- **Event Trail:** the delegation and its removal are both observable on-chain — `AgentAuthorized` (topics `stream_id`, `agent`) and `AgentRevoked` (topics `stream_id`, `agent`, with `revoked_by` in the payload).
- **The Budget Is Not Reset:** revocation deletes the authorization record but leaves the cap ledger for `(stream_id, agent)` in place, so re-authorizing the *same* agent address continues to count against the previous `total_withdrawn`. This is deliberate — it is the stricter direction — but it means revoking and immediately re-granting a key does not hand that key a fresh lifetime allowance. Issue a new agent key to restart the budget.

## 5. Recipient Incident Response Runbook

In the event of suspected hot key compromise, bot host breach, or anomalous withdrawal behaviour:

### Step 1: Immediate Revocation (T+0 minutes)
From the recipient master wallet (cold wallet, Freighter, or CLI):
```bash
soroban contract invoke \
  --id <STREAMPAY_CONTRACT_ID> \
  --source <RECIPIENT_SECRET> \
  -- \
  revoke_agent \
  --stream_id <STREAM_ID> \
  --agent <COMPROMISED_AGENT_ADDRESS> \
  --caller <RECIPIENT_ADDRESS>
```

### Step 2: Verify Revocation On-Chain
Query `agent_status(stream_id, agent)`. A revoked delegation returns nothing, because the authorization record no longer exists. Any withdrawal the compromised key attempts afterwards reverts with `AgentNotAuthorized`.

### Step 3: Audit Withdrawal History
Read the `Withdrawn` events for the stream in the current period and confirm each payout arrived in the recipient's own account — the payout address is not an argument to `withdraw_delegated`, so a diverted payment is not possible under this design. `agent_status(stream_id, agent)` also reports `period_withdrawn` and `total_withdrawn` for the key up to the moment it was revoked.

### Step 4: Key Rotation and Re-provisioning
1. Terminate the compromised bot server/instance.
2. Generate a fresh agent keypair on a clean, isolated host.
3. Call `authorize_agent` from the recipient master wallet with the new agent address, sizing `max_per_period` to one window's need and `max_per_stream` to the whole remaining mandate:
```bash
soroban contract invoke \
  --id <STREAMPAY_CONTRACT_ID> \
  --source <RECIPIENT_SECRET> \
  -- \
  authorize_agent \
  --stream_id <STREAM_ID> \
  --agent <NEW_AGENT_ADDRESS> \
  --max_per_period <AMOUNT_PER_WINDOW> \
  --max_per_stream <LIFETIME_AMOUNT> \
  --period_duration <SECONDS> \
  --expires_at <UNIX_TIMESTAMP>
```
4. Update the bot's automation configuration with the new agent credentials.
