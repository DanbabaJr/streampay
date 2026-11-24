# End-to-End Sandbox Network Testing and Signer Bypass Specification

## 1. Overview and Architecture

The StreamPay E2E test suite executes against a disposable local `stellar sandbox` (standalone network) in CI without human interaction. This guarantees that contract execution, transaction fee absorption, and wallet adapters are tested against actual Soroban ledger logic.

### CI Environment Setup
- **Service Container**: CI runs the official `stellar/quickstart` standalone container with Soroban RPC enabled on port `8000`.
- **In-Place Deployment**: On container start, the contract is built (`soroban contract build`) and deployed in-place. The resulting contract ID is passed to the frontend via `NEXT_PUBLIC_CONTRACT_ID`.

## 2. Deterministic Signing Bypass

Testing against web wallets in headless CI is prone to flakiness due to browser extension popups and asynchronous user prompts.

### Signer Design (`e2e/deterministic-signer.ts`)
- Generates reproducible ed25519 keypairs for `sender` and `recipient` roles using deterministic seed hashing.
- Derives valid Stellar public addresses (`G...`) with RFC 4648 Base32 encoding and CRC16 checksums.
- Injects a `window.freighterApi` adapter mock directly into the browser context via Playwright `page.addInitScript()`.
- Signs transaction envelopes deterministically, returning valid signed envelopes for submission.

## 3. Full User Journey Workflow (`e2e/sandbox-journey.spec.ts`)

1. **Connect Wallet**: Injected Freighter API automatically approves connection for the deterministic sender address.
2. **Create Stream**: Sender enters recipient address, deposit (e.g. 100 XLM), and duration, submitting the on-chain creation transaction.
3. **Accrual Observation**: Live accrual math updates the recipient available balance.
4. **Withdraw Accrued**: Recipient triggers claim/withdraw, verifying that the available balance decreases and account balance increments.
5. **Cancel Stream**: Sender closes the stream, verifying that the remaining unaccrued deposit is refunded.

## 4. Flakiness Budget and Ledger Timing Mitigation

Ledger progression in standalone sandboxes can introduce test flakiness if tests assume instantaneous finality:
- **Ledger Closing Jitter**: In standalone mode, ledgers close every 1 to 5 seconds depending on transaction volume. Tests poll transaction status with exponential backoff rather than arbitrary sleeps.
- **Artifact Capture**: On failure, Playwright is configured to retain:
  - Video recording of the browser session.
  - Full trace archives (`trace.zip`).
  - Network request logs and console logs.
- **20-Run Stability Target**: The suite is verified across 20 consecutive headless runs to guarantee zero flaky failures before merging.
