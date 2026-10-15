# ⚡ StreamPay

**Continuous, per-second payment streams for the Stellar network — Sablier-style money flow, native to Soroban.**

[![CI](https://github.com/Neziahtech/streampay/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![rustfmt + clippy](https://img.shields.io/badge/style-rustfmt%20%2B%20clippy-informational)](./.github/workflows/ci.yml)

> A payroll line that pays by the second. A vesting schedule your team can watch tick. A subscription that cancels itself the moment funding stops — with every unearned token refunded.

StreamPay is a Soroban smart contract that locks a deposit and releases it **linearly over time** to a recipient. The recipient withdraws accrued funds whenever they like; the sender can top up mid-stream or cancel, splitting the remaining funds fairly: earned tokens to the recipient, unearned tokens back to the sender. Similar in spirit to Sablier on Ethereum, designed from scratch for Stellar's ledger model.

## Why

- **Payroll**: pay contractors or DAO contributors by the second instead of by invoice — they can withdraw as they earn, with zero counterparty risk on accrued funds.
- **Vesting**: lock team/investor tokens in a transparent, immutable schedule.
- **Subscriptions & escrow**: fund a stream; when it runs dry, service stops. Cancelling returns what wasn't earned.

Everything is on-chain and trust-minimized: no admin key, no upgrade path, funds only ever move per the stream rules.

## How streams accrue

```text
 deposit ─────────────── locked in the contract ──────────────▶
 ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
             │ linear per-second release, floor division
 time ────── start_time ────────────────────── end_time ─────▶

 streamed(t) = deposit × elapsed / duration   (u128 checked, floored)
 available   = streamed − withdrawn           ; 0 before start_time
 on cancel : recipient ← available,  sender ← deposit − streamed
```

A stream is a half-open window `[start_time, end_time)`. At any ledger timestamp the contract computes `deposit × elapsed / duration` with checked math (products widened to `u128`, results floored to whole token units and capped at the deposit). **Every edge case you can think of — withdrawing before start, after end, cancelling a never-started stream, topping up after end — is covered by a unit test** (see `contracts/streaming-payments/src/test.rs`).

## Architecture overview

```text
/frontend (Next.js + Freighter)         /docs/ARCHITECTURE.md
        │  sign & submit txs                   │ design deep-dive
        ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  StreamingPayments (Soroban)                 │
│                                                              │
│  create_stream ─┐   withdraw ─┐   top_up ─┐   cancel_stream  │
│                 │             │            │        │        │
│            ┌────┴─────────────┴────────────┴────────┴────┐   │
│            │  Stream { sender, recipient, token,         │   │
│            │            deposit, withdrawn, start_time,  │   │
│            │            end_time, cancelable, status }   │   │
│            │  persistent storage + TTL extension         │   │
│            └──────────────────┬──────────────────────────┘   │
└───────────────────────────────┼──────────────────────────────┘
                                ▼
                     SAC / standard token interface
```

Deep dive (storage model, checked math, reentrancy, TTL strategy, design decisions): [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Contract API

| Function | Caller | Moves tokens | Emits |
|---|---|---|---|
| `create_stream(sender, recipient, token, deposit, start, end, cancelable) → u64` | anyone (sender auth required) | pulls deposit in | `StreamCreated` |
| `withdraw(stream_id, amount)` | recipient | pays out ≤ accrued | `Withdrawn` |
| `withdraw_max(stream_id) → i128` | recipient | pays out all accrued, atomically | `Withdrawn` |
| `cancel_stream(caller, stream_id)` | sender; recipient iff `cancelable` | pro-rata split, atomic | `StreamCancelled` |
| `top_up(stream_id, amount)` | sender | pulls added funds | `StreamToppedUp` |
| `get_stream(stream_id) → Stream` | — (read-only) | — | — |
| `available(stream_id) → i128` | — (read-only) | — | — |
| `recipient_streams(address, offset, limit) → Vec<u64>` | — (read-only) | — | — |
| `sender_streams(address, offset, limit) → Vec<u64>` | — (read-only) | — | — |
| `attach_metadata(attester, stream_id, content_hash, tag) → u32` | sender or recipient | — | `MetadataAttached` |
| `stream_attestations(stream_id, offset, limit) → Vec<Attestation>` | — (read-only) | — | — |
| `attestation_count(stream_id) → u32` | — (read-only) | — | — |
| `party_attestations(party, offset, limit) → Vec<AttestationRef>` | — (read-only) | — | — |

`attach_metadata` lets either party attach a **content hash** (32 bytes, e.g.
SHA-256) plus a short tag to a stream — an invoice, a payslip, a contract —
without storing the document on-chain. Attestations are append-only, indexed by
both parties, and size-bounded. This is *attestation*, not verification: the
contract records who claimed which hash when; a third party recomputes the hash
of the document they hold and compares. See
[`docs/VERIFYING_ATTESTATIONS.md`](./docs/VERIFYING_ATTESTATIONS.md) and
[`scripts/verify_attestation.sh`](./scripts/verify_attestation.sh).

`recipient_streams` / `sender_streams` are on-chain discovery indexes:
append-only, creation-ordered stream-id lists per address, paginated
(`limit` clamped to `MAX_PAGE_SIZE = 50`). Terminal streams keep their ids —
read each stream's `status` for lifecycle state.

Creating a stream requires a prior token approval: `token.approve(sender, <contract id>, deposit, exp)`. All failures return typed `StreamError` codes (no panics) — see `contracts/streaming-payments/src/errors.rs`.

## Getting started (clean machine)

Prerequisites:

1. **Rust** ≥ 1.85 (contract workspace uses edition 2021 with a conservative
   MSRV; soroban-sdk 27 sets the floor): <https://rustup.rs>
2. **Stellar CLI** (for deploy + Wasm build): `cargo install stellar-cli --locked`
3. **Node.js** ≥ 20 (frontend only): <https://nodejs.org>

Build and test the contract:

```bash
cargo test -p streampay-contract        # unit + property tests (see CI badge)
cargo fmt --all -- --check              # formatting gate
cargo clippy --all-targets -- -D warnings
stellar contract build                  # Wasm → target/wasm32v1-none/release/*.wasm
cargo deny check                        # supply chain (advisories, licenses, bans)
```

Fuzz the accrual math (nightly, optional):

```bash
cd fuzz && cargo +nightly fuzz run streamed_at -- -max_total_time=60
```

**Live testnet demo in one command:** [`./scripts/deploy_testnet.sh`](./scripts/deploy_testnet.sh)
deploys the contract, mints a demo token, and opens a 1-hour stream — full
walkthrough in [`docs/DEMO.md`](./docs/DEMO.md).

Run the frontend:

```bash
cd frontend
cp .env.example .env.local    # set NEXT_PUBLIC_STREAMING_CONTRACT_ID
npm install
npm run dev                   # http://localhost:3000
```

Deploy to testnet:

```bash
stellar keys generate deployer --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/streampay_contract.wasm \
  --source deployer --network testnet
```

## Repo layout

```text
contracts/streaming-payments/   the contract (lib.rs, stream.rs, errors.rs, events.rs, test.rs)
frontend/                       minimal Next.js UI (Freighter wallet)
fuzz/                           cargo-fuzz harness for the accrual math (own workspace)
scripts/                        deploy_testnet.sh + the release/promotion pipeline scripts
deployments/                    append-only promotion records + interface baselines
docs/ARCHITECTURE.md            design deep-dive
docs/DEPLOY_PIPELINE.md         sandbox → testnet → mainnet-canary promotion design
docs/CANARY_RUNBOOK.md          mainnet canary + rollback procedure
docs/DEMO.md                    verified testnet walkthrough
docs/GOOD_FIRST_ISSUES.md       ready-to-file contributor tickets
.github/workflows/ci.yml        test + fmt + clippy + coverage + wasm + lint/build/audit + supply chain
.github/workflows/release.yml   tag-driven Wasm release with SHA-256 digests
.github/workflows/fuzz.yml      scheduled fuzz sessions (non-blocking)
.github/workflows/promote.yml   gated promotions (sandbox → testnet → mainnet canary)
.github/workflows/rehearsal.yml secret-free dress rehearsal of the pipeline
CHANGELOG.md                    release history (Keep a Changelog)
```

## Roadmap

- **v0.1** — core contract: create / withdraw / cancel / top-up, tests, CI ✅
- **v0.2** — ✅ on-chain address indexes (`recipient_streams` /
  `sender_streams`), ✅ `withdraw_max`, ✅ frontend discovery + persistence,
  event indexer service, `pause_stream` (good first issue)
- **v0.3** — ✅ fuzzing in CI (`cargo-fuzz` on the rate math, scheduled),
  multi-token batch stream creation
- **v0.4** — full web UI polish (accrual charts), ✅ testnet demo script
- **v1.0** — external audit, mainnet deployment guide

Feature requests live in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/) — good first issues are tagged [`good first issue`](https://github.com/Neziahtech/streampay/labels/good%20first%20issue) and documented in [`docs/GOOD_FIRST_ISSUES.md`](./docs/GOOD_FIRST_ISSUES.md).

## Contributing

PRs welcome! Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) — it covers conventions, branch/PR process, and how to run the tests locally. Every PR runs the full test suite, fmt, clippy (`-D warnings`), and the frontend build in CI.

## Funding & sustainability

StreamPay is community-funded:

- **GrantFox** — bounties on good-first-issues and roadmap features. Install the GrantFox GitHub App on your fork to earn while contributing.
- **Drips** — list StreamPay as a dependency to split funding to upstream projects it builds on.

## License

[Apache-2.0](./LICENSE)
