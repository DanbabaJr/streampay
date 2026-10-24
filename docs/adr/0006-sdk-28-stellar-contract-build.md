# ADR 0006: Build Contract Wasm via `stellar contract build` in Soroban SDK 28+

Status: Accepted
Date: 2026-10-04
Deciders: StreamPay Engineering Team

## Context and Problem Statement

When upgrading StreamPay's smart contract dependencies from `soroban-sdk 27.0.6` to `28.0.0` (PR #14), standard contract compilation failed in CI. The command previously used:
```bash
cargo build --release --target wasm32v1-none -p streampay-contract
```
was explicitly rejected by `soroban-sdk 28`'s build script with an error requiring the `stellar-cli >= 25.2` spec-shaking v2 handshake.

The Stellar Development Foundation (SDF) introduced spec-shaking v2 in Soroban SDK 28 to strip unreferenced contract spec entries, embed contract environment metadata, and optimize Wasm binary sizes for mainnet deployment. Plain cargo commands bypass this pipeline and are therefore rejected by design.

## Decision Drivers

- Maintain compatibility with `soroban-sdk 28+` and Stellar Protocol 21/22.
- Produce verified, spec-shaken Wasm artifacts with reproducible SHA-256 digests across local and CI environments.
- Keep build instructions consistent across CI, GitHub release actions, local devcontainers, and shell deployment scripts.

## Considered Options

- Option 1: Standardize on `stellar contract build` using pinned `stellar-cli v28.1.0`.
- Option 2: Pin `soroban-sdk` to version 27.0.6 and defer SDK upgrades indefinitely.
- Option 3: Attempt to bypass the SDK build script check via undocumented environment flags.

## Decision Outcome

Chosen option: "Option 1: Standardize on `stellar contract build` with `stellar-cli v28.1.0`", because:
1. `stellar contract build` is the officially supported compilation path for Soroban SDK 28 and above.
2. The compilation output path remains identical: `target/wasm32v1-none/release/streampay_contract.wasm`.
3. In `.github/workflows/ci.yml` and `.github/workflows/release.yml`, CI installs the official prebuilt `stellar-cli v28.1.0` binary and executes:
   ```bash
   stellar contract build
   ```
   from the `contracts/streaming-payments/` directory.
4. Devcontainer definitions, [`scripts/deploy_testnet.sh`](../../scripts/deploy_testnet.sh), and developer documentation ([`docs/DEMO.md`](../DEMO.md)) were updated to match.

### Consequences

- **Positive:**
  - Contract successfully compiles under `soroban-sdk 28+` and subsequent releases (such as `29.0.1`).
  - Spec-shaking v2 reduces Wasm footprint and optimizes gas consumption on deployment.
  - Release digests are fully reproducible across development environments.
- **Negative / Trade-offs:**
  - Developers and CI environments must install `stellar-cli` alongside the standard Rust toolchain.
  - Compilation must be executed from within `contracts/streaming-payments/` or specify `--manifest-path`.

## Alternatives Considered

### Option 2: Retain `soroban-sdk 27.0.6`

- Good, because it requires no change to existing `cargo build` commands.
- Bad, because it blocks security patches, protocol upgrades, and modern ecosystem integrations.

### Option 3: Bypass SDK Build Script Checks

- Good, because it avoids installing `stellar-cli` in basic build pipelines.
- Bad, because it relies on private, unsupported internal SDK mechanics and produces non-spec-shaken Wasm binaries that risk rejection on Stellar testnet and mainnet networks.

## Validation and Evidence

- Integrated in `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- Documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) and [`scripts/deploy_testnet.sh`](../../scripts/deploy_testnet.sh).
- Commit: `350d7371ff238c99711ff08ef92dc3859ea4d871` ("fix(ci): build contract Wasm via stellar-cli (required by soroban-sdk 28)").
