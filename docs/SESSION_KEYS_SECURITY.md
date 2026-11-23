# Session Keys Security Model and Incident Response

## 1. Overview and Problem Statement

Automated stream withdrawals (e.g. daily sweeping into cold storage, recurring treasury distributions, automated portfolio rebalancing) traditionally require exposing the recipient's primary private key to continuous hot environment execution. If an automation server or cloud agent hosting the private key is breached, the attacker gains unbounded access to all active streams and wallet assets.

The Session Keys mechanism (Issue #56) resolves this by enabling recipients to delegate scoped withdrawal authority to secondary "agent" addresses under strict, on-chain enforced constraints:
- **Maximum Spend Per Period:** Absolute upper limit on token outflow per time window.
- **Period Duration:** Rolling/fixed window duration in seconds (e.g. 86400 for daily sweeping).
- **Session Expiry:** Absolute timestamp after which the session automatically terminates.
- **Instant Revocability:** Master recipient can revoke the agent key immediately on-chain with zero latency.

## 2. Security Architecture and Boundary

```
+-----------------------------------------------------------------------------------+
| Recipient Master Key (Cold Wallet / Hardware Signer)                              |
| - Authorizes agent policy via authorize_agent()                                   |
| - Can revoke agent policy at any time via revoke_agent()                          |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| On-Chain Policy Storage (StreamPay Contract)                                     |
| - Policy: (agent, stream_id) -> { max_per_period, period_seconds, expires_at,     |
|                                    current_period_start, spent_current_period }   |
| - Enforces all rate limits, expirations, and revocation flags on-chain            |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | Calls withdraw_delegated()
+-----------------------------------------------------------------------------------+
| Automation Agent / Bot (Hot Wallet / Server)                                      |
| - Holds ONLY the agent keypair                                                    |
| - Can NEVER withdraw to an arbitrary address (funds go directly to recipient)     |
| - Cannot exceed max_per_period in any window                                      |
+-----------------------------------------------------------------------------------+
```

### 2.1 On-Chain Cap Enforcement vs Off-Chain Assumptions
Many Web3 delegation implementations rely on off-chain rate limiters or trust the bot server to only request authorized amounts. In StreamPay, every constraint is validated inside the smart contract:
- **Destination Invariance:** `withdraw_delegated` pays directly to the recipient address of the stream (`s.recipient`). The agent cannot redirect stream payouts to their own address or a third party.
- **Window Progression:** When `now >= current_period_start + period_seconds`, the contract resets `spent_current_period = 0` and updates `current_period_start = now`.
- **Overflow-Protected Accumulation:** Each withdrawal checks `spent_current_period + amount <= max_per_period` using checked arithmetic.
- **Expiry Check:** When `now >= expires_at`, calls revert immediately with `ClaimExpired`.

## 3. Threat Model and Blast Radius

| Attack Scenario | Blast Radius / Consequence | Mitigation in StreamPay |
|---|---|---|
| Complete Server / Hot Key Compromise | Attacker obtains agent private key | Payouts still deliver ONLY to recipient wallet. Attacker cannot steal funds to their own address. Max drain is limited to `max_per_period` within the active window. |
| Malicious / Errant Withdrawal Loop | Bot encounters an infinite loop calling withdraw | Contract rejects calls once `spent_current_period == max_per_period`. Stream balance cannot be drained prematurely. |
| Replay / Expired Key Use | Attacker attempts to use key past validity period | On-chain expiry timestamp `expires_at` is enforced. Rejection occurs without off-chain dependencies. |
| Master Key Compromise | Attacker gains cold key | Master key can drain stream directly (standard root trust assumption). Not aggravated by session key feature. |

## 4. Revocation Latency and Guarantees

- **Zero-Latency Invalidation:** Revocation executes via `revoke_agent(recipient, agent, stream_id)` requiring the recipient's signature. Once the transaction confirms in a block, all subsequent calls from `agent` revert immediately with `CancelStreamNotAuthorized`.
- **No Grace Period:** Unlike staking or timelock protocols, there is no delay or cooling-off period for revocation.
- **Storage Cleanup:** Revocation sets `revoked = true` in persistent contract storage, preventing subsequent reactivation under the same key without explicit re-authorization.

## 5. Recipient Incident Response Runbook

In the event of suspected hot key compromise, bot host breach, or anomalous withdrawal behavior:

### Step 1: Immediate Revocation (T+0 minutes)
From the recipient master wallet (cold wallet, Freighter, or CLI), immediately invoke:
```bash
soroban contract invoke \
  --id <STREAMPAY_CONTRACT_ID> \
  --source <RECIPIENT_SECRET> \
  -- \
  revoke_agent \
  --recipient <RECIPIENT_ADDRESS> \
  --agent <COMPROMISED_AGENT_ADDRESS> \
  --stream_id <STREAM_ID>
```

### Step 2: Verify Revocation On-Chain
Query the session policy using `get_session_policy(agent, stream_id)`. Confirm that `revoked` is `true`.

### Step 3: Audit Withdrawal History
Inspect contract events (`delegated_withdrawal`) for the current period. Because payouts deliver solely to the recipient's wallet, verify that all withdrawn tokens arrived safely in the recipient's account.

### Step 4: Key Rotation and Re-provisioning
1. Terminate the compromised bot server/instance.
2. Generate a fresh agent keypair on a clean, isolated host.
3. Call `authorize_agent` from the recipient master wallet with the new agent address.
4. Update the bot automation configuration with the new agent credentials.
