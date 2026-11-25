# Privacy Preserving Payment Claims Analysis

> **Status: design record, not shipped surface.** The commit-reveal entrypoints
> analysed here (`commit_claim`, `reveal_claim`, `expire_reveal`,
> `get_claim_commitment`) were merged in #677 and reverted in #697: they and the
> delegated-agent surface grew the contract Wasm to 140,693 B, past Soroban's
> 131,072 B code limit, so no build of it could be deployed. This analysis is
> kept as the design input for a separate privacy contract, which
> `docs/WASM_SIZE.md` names as the only remaining way to add this size of
> feature.

## 1. Overview and Problem Statement

In standard public streaming payments on Stellar Soroban, stream parameters (sender, recipient, token, total deposit, start time, end time) and every individual withdrawal transaction are recorded publicly on ledger. In many business contexts - such as contractor payroll, subscription payouts, or confidential vendor disbursements - public real-time visibility into the exact timing and granular amount of every intermediate withdrawal allows observers to infer cash-flow velocity, vendor burn rates, or sensitive compensation details.

The Commit-Reveal Claim mechanism (Issue #65) introduces cryptographic privacy for intermediate claim withdrawals on active payment streams.

## 2. Commit-Reveal Claim Protocol

The protocol divides a claim withdrawal into two decoupled on-chain phases:

```
[Recipient]                        [On-Chain Contract]                     [Public Ledger]
     |                                      |                                     |
     |--- 1. commit_claim(hash, deadline) ->|                                     |
     |       (hash = SHA256(stream, recv,   |-- Emits ClaimCommitted event ------>| (No claim amount visible)
     |        amount, salt))                |   (stores commitment, deadline)     |
     |                                      |                                     |
     |       ... Delay / Off-Chain ...      |                                     |
     |                                      |                                     |
     |--- 2. reveal_claim(amount, salt) --->|                                     |
     |                                      |-- Computes hash and matches record  |
     |                                      |-- Marks commitment as revealed      |
     |                                      |-- Executes withdrawal payout ------>| (Amount revealed at execution)
     |                                      |-- Emits ClaimRevealed event ------->|
```

### 2.1 Commit Phase
- Recipient generates a random 32-byte salt `salt`.
- Recipient computes `commitment_hash = SHA256(recipient || stream_id || amount || salt)`.
- Recipient invokes `commit_claim(stream_id, recipient, commitment_hash, deposit, reveal_deadline)`.
- The contract stores the commitment with an expiry timestamp `reveal_deadline` and emits `ClaimCommitted`.
- At this point, no external observer can determine the requested `amount`.

### 2.2 Reveal Phase
- Before `reveal_deadline`, the recipient submits `reveal_claim(stream_id, recipient, amount, salt)`.
- The contract recomputes `SHA256(recipient || stream_id || amount || salt)` on-chain.
- If the hash matches an unrevealed commitment and `now <= reveal_deadline`:
  1. The commitment is marked as revealed.
  2. The contract executes `Self::withdraw(env, stream_id, amount)`.
  3. Tokens are paid out to the recipient and `ClaimRevealed` is emitted.

### 2.3 Expiration and Safety Valve
If the recipient abandons the reveal or loses their salt, funds committed in safety deposits could potentially remain orphaned. The protocol implements an explicit safety valve:
- If `now > reveal_deadline` and the commitment remains unrevealed, `expire_reveal(stream_id, commitment_hash, sender)` can be invoked by the stream sender.
- The contract removes the commitment record and returns the refundable deposit to the stream sender, guaranteeing zero permanent capital lockup.

## 3. Privacy Guarantees and Boundary Analysis

### 3.1 What is Hidden
- **Granular Claim Amount During Transit:** Between the commit transaction and reveal transaction, passive observers, chain indexers, and mempool monitors cannot determine whether the recipient is claiming 1 token, 1,000 tokens, or their entire accrued balance.
- **Recipient Intent:** Observers cannot differentiate between different milestone payouts or invoice settlements until the recipient decides to reveal.

### 3.2 From Whom
- **Passive Observers and Indexers:** External blockchain scanners cannot inspect commitment hashes without knowing the 256-bit salt.
- **Competing Market Makers / Competitors:** Competitors tracking wallet activity cannot front-run or deduce proprietary disbursement timing.

### 3.3 For How Long
- The amount remains confidential from the time of `commit_claim` until `reveal_claim` is submitted. Once `reveal_claim` executes, the token transfer to recipient becomes visible on-chain.

### 3.4 Honest Assessment: What Still Leaks
It is crucial to acknowledge on-chain limitations in account-based smart contract systems:
1. **Stream Metadata:** The parent stream parameters (sender address, recipient address, total deposit, token address, and stream duration) remain public in the stream storage and event history.
2. **Accrual Bounds:** The maximum possible claim amount is bounded by the accrued balance of the stream at the moment of reveal.
3. **Settlement Transparency:** When `reveal_claim` executes, the payout token transfer moves tokens from the contract to the recipient wallet. Observers observing wallet balances after the reveal will see the net balance increase.
4. **Deposit & Gas Patterns:** Transaction fee payments and optional safety valve deposits are public.

## 4. Security and Threat Model

| Threat | Attack Vector | Mitigation in StreamPay |
|---|---|---|
| Brute-Force Hash Search | Observer iterates possible token amounts | 32-byte (256-bit) cryptographically secure pseudorandom salt provides 128-bit security against pre-image search. |
| Replay Attacks | Attacker resubmits a previously revealed claim | Commitments are keyed by hash and storage records flag `revealed: true`. Once revealed, reuse is rejected. |
| Griefing / Storage Bloat | Attacker floods contract with unrevealed commitments | `commit_claim` requires authentication of the stream recipient and supports an optional refundable safety deposit. |
| Stalled Payouts | Recipient loses salt, locking contract state | `expire_reveal` allows sender to purge expired commitments and recover deposits after deadline. |
| Front-Running Reveal | Front-runner intercepts reveal transaction | `recipient.require_auth()` guarantees only the authenticated recipient can execute `reveal_claim` and receive funds. |

## 5. Trade-offs and Recommendations

1. **Transaction Overhead:** Commit-reveal requires two transactions (commit + reveal) instead of a single withdrawal call, doubling gas costs.
2. **Recommended Use Case:** Recommended for high-value contractor payments, executive compensation tranches, and commercial supplier milestones where interim claim privacy justifies the extra invocation.
