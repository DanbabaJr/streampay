# Multi-Wallet Manual Test Plan

## Scope

End-to-end signing flows that cannot be automated (real browser extensions and
popups). Run before every release that touches `lib/wallet-adapter.ts`,
`lib/adapters/`, or `lib/wallet-context.tsx`.

---

## Environment setup

| Item | Required value |
|------|---------------|
| Network | Stellar Testnet |
| Freighter version | ≥ 5.x (with `getNetworkDetails` support) |
| Albedo | https://albedo.link (no install needed) |
| Testnet XLM | Fund via https://laboratory.stellar.org/#account-creator |

---

## TC-01 — Wallet picker shows both options

1. Open the app with no wallet extension installed.
2. Click **Connect wallet**.
3. **Expected**: Modal lists Freighter with an "Install ↗" link (greyed out) and
   Albedo with a clickable connect button (because Albedo is always available).

---

## TC-02 — Freighter happy path

1. Install Freighter, fund testnet account.
2. Set Freighter to **Testnet**.
3. Click **Connect wallet → Freighter**.
4. Approve in the Freighter popup.
5. **Expected**: `G…` address appears in WalletButton; modal closes.
6. Create a stream.
7. **Expected**: Freighter popup appears once for allowance (if first stream with
   that token) then once for the create transaction. Stream appears in the list.

---

## TC-03 — Freighter wrong-network rejection

1. Switch Freighter to Mainnet.
2. Click **Connect wallet → Freighter**.
3. **Expected**: Error toast "Freighter is on the wrong network. Switch to
   Stellar Testnet and try again." No address appears.

---

## TC-04 — Albedo happy path

1. No extension required. Click **Connect wallet → Albedo**.
2. The Albedo popup opens at `albedo.link`.
3. Approve public key sharing.
4. **Expected**: Address appears in WalletButton.
5. Create a stream.
6. **Expected**: Albedo popup appears for each signing step. Stream appears.

---

## TC-05 — Albedo network mismatch

1. Connect via Albedo on a page pointing at Mainnet
   (`NEXT_PUBLIC_NETWORK=PUBLIC`).
2. Sign a transaction.
3. **Expected**: Albedo adapter throws "Albedo signed on the wrong network:
   got 'testnet', expected 'public'." and no transaction is submitted.

---

## TC-06 — Disconnect clears state

1. Connect with either wallet.
2. Click **Disconnect**.
3. **Expected**: Address clears, WalletButton returns to "Connect wallet" state.
   Reconnect works without page reload.

---

## TC-07 — WalletButton spinner during connection

1. Click **Connect wallet**.
2. Before approving in the wallet extension, observe the button.
3. **Expected**: Button shows a spinner and is disabled.

---

## TC-08 — Install link for unavailable wallet

1. Uninstall (or use a browser without) Freighter.
2. Open the wallet picker.
3. **Expected**: Freighter entry is greyed out; clicking it opens
   `https://www.freighter.app/` in a new tab rather than starting a connect flow.
