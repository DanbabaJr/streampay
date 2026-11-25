# ADR 0002: CEI-First Payouts and Reentrancy Protection

Status: Accepted (backfilled)
Date: 2026-09-13
Deciders: StreamPay Engineering Team

## Context and Problem Statement

StreamPay's core operations (`withdraw`, `withdraw_max`, `cancel_stream`, and `withdraw_treasury`) release escrowed funds to recipients, senders, or the protocol treasury by invoking external token contracts via Soroban's token client (`soroban_sdk::token::Client`).

Although Soroban's execution model isolates contract invocations, arbitrary Stellar Asset Contract (SAC) implementations or custom SEP-41 token contracts can execute callbacks or reenter the calling contract during a transfer. If state changes (such as incrementing `withdrawn` or marking a stream `Cancelled` / `Depleted`) occur after the external token call, a reentrant call could repeatedly claim available balances before storage reflects previous payouts, draining contract reserves.

## Decision Drivers

- Absolute prevention of reentrancy drain exploits across all payout and cancellation entrypoints.
- Conservation of contract token balance: contract reserves must always strictly satisfy `balance >= Σ (deposit - withdrawn) + Σ (charged_total - withdrawn_total)`.
- Minimizing ledger entry operations, CPU instruction overhead, and storage footprint fees.

## Considered Options

- Option 1: Checks-Effects-Interactions (CEI) ordering for all mutations.
- Option 2: Reentrancy mutex / lock flag stored in contract instance storage.
- Option 3: Interactions-first (execute external token transfer before updating internal accounting).

## Decision Outcome

Chosen option: "Option 1: Checks-Effects-Interactions (CEI) ordering", because:
1. All state writes and event emissions occur strictly **before** calling `token.transfer` or `transfer_from`:
   - `withdraw`: increments `withdrawn += amount`, updates status to `Depleted` if fully drained, emits `Withdrawn`, and only then invokes `token.transfer`.
   - `cancel_stream`: updates status to `Cancelled`, records payout amounts as withdrawn, emits `StreamCancelled`, and only then transfers the split funds to recipient and sender.
   - `withdraw_treasury`: increments `withdrawn_total`, writes updated treasury storage, emits `FeeWithdrawn`, and only then calls `token.transfer`.
2. In `withdraw` and `cancel_stream`, `status` is checked after caller authorization: any reentrant attempt observes the post-write state where `available` has already reverted to zero or the remaining headroom.
3. If an external token transfer fails, Soroban's transactional host rolls back the entire invocation (including preceding state mutations and emitted events), returning a mapped payout failure (`StreamError::RecipientPayoutFailed` for recipient withdrawals/splits, `StreamError::SenderRefundFailed` for unaccrued sender refunds, or `StreamError::TreasuryPayoutFailed` for treasury fees) without state corruption. (The `*TransferFailed` family—`DepositTransferFailed` and `TopUpTransferFailed`—is reserved exclusively for inbound token pulls via `transfer_from`).

### Consequences

- **Positive:**
  - Robust mathematical protection against reentrancy attacks without relying on runtime mutexes.
  - Zero additional ledger keys or storage fees needed for lock state management.
  - Invariant preserved: the contract balance strictly reconciles with active stream deposits and treasury reserves at every ledger close.
- **Negative / Trade-offs:**
  - Developers must maintain strict discipline: any future payout entrypoint or refactor must verify that all state mutations and event emissions precede external token calls.

## Alternatives Considered

### Option 2: Reentrancy Mutex / Lock Flag in Instance Storage

- Good, because it provides an explicit runtime guard against concurrent reentry.
- Bad, because writing and clearing a lock flag requires additional ledger reads and writes per transaction, increasing CPU instructions and storage fees by an estimated 15-20% per withdrawal without offering safety advantages over correct CEI sequencing.

### Option 3: Interactions-First (Transfer then Record)

- Good, because failures in token transfers occur before internal state logic executes.
- Bad, because it leaves a critical reentrancy window where a malicious token contract callback can invoke `withdraw` again while internal storage still reports the pre-transfer unwithdrawn balance.

## Validation and Evidence

- Documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#5-reentrancy-checks-effects-interactions).
- Regression suite in `contracts/streaming-payments/src/test.rs` includes explicit reentrancy tests with a malicious mock token attempting reentry during withdrawal callbacks.
- Commits: `7f740cf` (Initial implementation) and `7fad774` (`withdraw_max` implementation sharing the CEI `pay_out` tail).
