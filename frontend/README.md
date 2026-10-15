# StreamPay frontend

Minimal Next.js (App Router, TypeScript) UI for the StreamPay contract:
connect Freighter, create streams, withdraw accrued funds (single amount or
atomic **withdraw max**), top up, cancel, attach hash-linked metadata
attestations — with on-chain discovery so the list survives reloads and shows
streams you didn't create in this session.

## Routes

| Route | What it does |
|---|---|
| `/` | Connect, create form, stream list with per-row actions and a **Discover on-chain** button (scans the contract's `recipient_streams` / `sender_streams` indexes for your address) |
| `/stream/[id]` | Stream detail: progress bar, live `available` poll (15 s), withdraw form with over-withdrawal guard, **Withdraw max** (`withdraw_max`), cancel, and a metadata attestation list plus an attach form for a connected party (`attach_metadata`). Read-only-safe without a wallet; contract errors decode to `StreamError` names |

## Setup

```bash
cd frontend
cp .env.example .env.local   # then fill in NEXT_PUBLIC_STREAMING_CONTRACT_ID
npm install
npm run dev                  # http://localhost:3000
```

Requires the [Freighter](https://www.freighter.app/) browser extension and a
funded account on the configured network (default: testnet — use the
[friendbot](https://developers.stellar.org/docs/dev-tools/tutorials/friendbot))
plus a deployed token contract id (any SAC, e.g. a custom USDC testnet asset).
For a one-command deployed contract + demo stream, see
[`../docs/DEMO.md`](../docs/DEMO.md).

## Notes

- `npm run lint` + `npm run typecheck` + `npm run build` + `npm audit` run in
  CI.
- Every mutating call follows: build → simulate → Freighter sign → send → poll.
- Read-only calls (`get_stream`, `available`, `stream_attestations`, the index
  views) simulate against the RPC without signing.
- Metadata attestations are append-only hash claims (e.g. a SHA-256 of an
  invoice); the contract never stores the document. Verify a local file against
  an attested hash with [`../scripts/verify_attestation.sh`](../scripts/verify_attestation.sh)
  — see [`../docs/VERIFYING_ATTESTATIONS.md`](../docs/VERIFYING_ATTESTATIONS.md).
- Amounts are **smallest token units** (stroops for classic assets).
- The stream list persists per-address cache in `localStorage` (scoped by
  network); on-chain indexes are the source for discovery, cache is only a
  convenience.
