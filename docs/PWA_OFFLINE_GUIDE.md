# Progressive Web App (PWA) Offline Mode and Pending Transaction Queue Guide

## 1. Overview

StreamPay's PWA mode makes the application installable on mobile devices and desktops while remaining functional in low-connectivity or offline field environments:
- **Offline Reads**: Cached stream and account state can be inspected anywhere in the field.
- **Pending Transaction Queue**: Pre-signed transactions (such as claims or withdrawals) are held safely until network connectivity is restored.

## 2. Service Worker Strategy (SWR)

The Service Worker (`public/sw.js`) employs a Stale-While-Revalidate (SWR) caching strategy:
- **Static Assets**: Shell HTML, bundled CSS/JS, and icons are precached in `streampay-static-v1`. Cache hits return instantaneously while background updates refresh the cache.
- **On-Chain Reads**: Queries to Horizon or Soroban RPC endpoints are cached in `streampay-data-v1`. In offline environments, the UI serves cached stream balances and status.
- **Versioned Invalidation**: When the Soroban contract ID or network changes, the cache version (`v1`) increments, automatically purging old entries to prevent showing state from different contracts.

## 3. Pending Transaction Queue Safety Model

Signed transaction envelopes (XDR) are network-bound, cryptographically signed, single-use artifacts tied to exact account sequence numbers and ledger/time bounds. Queuing transactions offline is inherently dangerous:

### Sequence Number Drift
If a user signs an offline claim with sequence number `N`, and then performs another transaction online (advancing the account sequence to `N` or higher), submitting the queued transaction will fail on-chain.
- **Rule**: `OfflinePendingTxQueue` verifies `BigInt(accountSeq) + 1n === BigInt(tx.seq)`. If the account sequence has drifted, the submission is rejected immediately with an informative message. The queue **never** performs silent resubmits.

### Expired Bounds
Transactions signed with timebounds (`minTime`, `maxTime`) or ledger bounds (`minLedger`, `maxLedger`) will fail if submitted after the window closes.
- **Rule**: Pre-submission checks compare the current ledger sequence and timestamp against the transaction's declared bounds. Expired transactions are marked as `rejected` with an explicit reason (`expired_bounds`), prompting the user to generate a fresh signature.

### Processing Pipeline
```
 [User Signs Offline] ---> [Enqueued in Local Storage]
                                      |
                           (Connectivity Restored)
                                      |
                                      v
                        [Pre-submission Validation]
                                      |
                     +----------------+----------------+
                     | Valid Sequence & Bounds        | Stale (Drift / Expired)
                     v                                v
            [Submit to Network]             [Reject Transaction]
                     |                                |
            [Mark Confirmed]                [Prompt User to Re-sign]
```

## 4. Mobile Installation and Wallet Quirks

- **iOS Safari**: iOS does not support the automated `beforeinstallprompt` banner. Users must be guided to tap the Share button and select "Add to Home Screen". Note that browser extensions (including Freighter) do not run inside iOS Home Screen PWAs. For mobile PWA claims, StreamPay supports Passkey signers (SEP-42) or WalletConnect bridges.
- **Android Chrome**: Android displays the native mini-infobar when PWA criteria are satisfied (`manifest.json` with valid icons and service worker registered). If Freighter mobile browser extension is installed in a Chromium-compatible mobile browser (e.g. Kiwi Browser), it integrates directly with the PWA.
