# Reproducible Builds & Verification Guide

This document is written for external auditors, security engineers, and third-party integrators verifying that the published StreamPay contract Wasm binary matches the tagged source code byte-for-byte.

StreamPay is committed to verifiable, trustless deployments. Public blockchain smart contracts cannot be undeployed; therefore, third-party verification that the deployed binary corresponds exactly to audited open-source code is a non-negotiable security requirement.

---

## 1. The Pinned Toolchain Triad

Deterministic Wasm compilation requires pinning the entire toolchain triad:

| Toolchain Component | Pinned Version | Definition Location | Purpose & Reproducibility Impact |
|---|---|---|---|
| **stellar-cli** | `28.1.0` | `.github/workflows/release.yml`, Dockerfile | Orchestrates `soroban-spec` v2 shaking, wasm contract optimization, and XDR spec ordering. Differing versions may shake or reorder spec entries differently. |
| **rustc** | `1.99.1` | `rust-toolchain.toml`, `release-metadata.json` | LLVM Wasm backend, MIR optimizations, and codegen. Different minor/patch releases of rustc can generate different opcode sequences or register allocations. |
| **rust-toolchain channel** | `1.99.1` | `rust-toolchain.toml` | Ensures identical Rust standard library (`wasm32v1-none`) intrinsics, compiler frontend, and lint behavior across all hosts. |

### Build Host Environment

The canonical release builds are compiled on `x86_64-unknown-linux-gnu` (Ubuntu Linux runner). To eliminate host-specific variance, the reproducible verification action defaults to a hermetic Docker container running this exact environment.

---

## 2. Release Metadata (`release-metadata.json`)

Every release workflow automatically generates and attaches a `release-metadata.json` file as a release asset alongside `streampay_contract.wasm` and `SHA256SUMS`.

### Schema

```json
{
  "stellar_cli_version": "28.1.0",
  "rustc_version": "1.99.1",
  "rust_toolchain": "1.99.1",
  "build_date": "2026-10-15T22:00:00Z",
  "wasm_sha256": "2804128a1c2e5c4bea9b61d9d55286ab6c74d66fc7924022bab59e64a9e79df1"
}
```

- `stellar_cli_version`: The exact stellar-cli CLI tool version used to run `stellar contract build`.
- `rustc_version`: The exact rustc compiler version output by `rustc --version`.
- `rust_toolchain`: Pinned toolchain channel recorded from `rust-toolchain.toml`.
- `build_date`: UTC ISO 8601 build timestamp.
- `wasm_sha256`: SHA-256 hash of the canonical release Wasm binary.

---

## 3. Step-by-Step Verification

### Option A: Using the Composite GitHub Action (Recommended for CI)

Add a verification step to any CI pipeline or external auditor repository:

```yaml
name: Verify StreamPay Wasm

on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Verify Reproducible Build
        uses: Neziahtech/streampay/.github/actions/verify-reproducible-build@v0.3.0
        with:
          tag: "v0.3.0"
          expected_digest: "2804128a1c2e5c4bea9b61d9d55286ab6c74d66fc7924022bab59e64a9e79df1"
```

The action:
1. Checks out the repository at the specified release tag.
2. Reads the pinned toolchain from `rust-toolchain.toml`.
3. Reads `release-metadata.json` (or downloads it from the release assets).
4. Rebuilds the Wasm using the pinned toolchain.
5. Computes the SHA-256 digest of the output Wasm.
6. Fails with exit code 1 if the digests do not match; exits 0 on exact match.
7. Sets step outputs:
   - `computed_digest`: The rebuilt Wasm SHA-256.
   - `match`: Boolean (`true` or `false`).

---

### Option B: Using the Standalone Script (Local / Auditor CLI)

Auditors can run verification directly on their local workstation:

```bash
# Clone the repository
git clone https://github.com/Neziahtech/streampay.git
cd streampay

# Verify against a published tag and expected digest
./scripts/verify_reproducible_build.sh v0.3.0 <expected_sha256_digest>

# Or verify the current working directory / commit:
./scripts/verify_reproducible_build.sh --current <expected_sha256_digest>
```

---

### Option C: Verify a Signed Attestation (no digest to carry around)

Options A and B require you to already possess a trusted digest, which is the
weak point: `SHA256SUMS` is published next to the artifact it describes, so
anyone who can rewrite the release can rewrite the sums too. The attestation
chain replaces "a number you brought with you" with a signature you check
against a key pinned in your own checkout.

```bash
# Requires only bash + openssl: no stellar-cli, no Docker, no Rust toolchain
./scripts/verify_wasm.sh /path/to/streampay_contract.wasm --tag v0.5.0 --require-repro
```

This recomputes the digest, fetches `attestation.json` and its detached Ed25519
signature, verifies the signature, and asserts the signed payload names the
bytes you hold. See [`ATTESTATION.md`](./ATTESTATION.md) for the payload format
and the component-by-component threat model, and
[`adr/0011`](adr/0011-attestation-signing-scheme.md) for why a repository key
rather than cosign keyless.

To prove reproducibility directly rather than trusting the attestation's claim:

```bash
# Two independent hermetic builds of the same commit, wasm AND spec JSON byte-diffed
./scripts/reproducible_build.sh --ref v0.5.0
```

If the builds drift, the report names the component that is non-deterministic,
gives both digests and the first differing byte offset, and distinguishes a
length change (embedded path or timestamp) from an equal-length change (codegen
or link ordering).

---

## 4. Two Build Paths

### 1. Hermetic (Docker) Path (Default & Recommended)

When Docker is available on the system, the action uses the hermetic Dockerfile at `.github/actions/verify-reproducible-build/Dockerfile`.

- **Isolation**: Mounts the checked-out source code into an isolated container.
- **Pinned Triad**: Uses `ARG RUST_VERSION=1.99.1` and `ARG STELLAR_CLI_VERSION=28.1.0`.
- **Zero Host Contamination**: Independent of the auditor's local Rust version, operating system, or environment variables.

To run the Docker build directly:
```bash
docker build \
  --build-arg RUST_VERSION=1.99.1 \
  --build-arg STELLAR_CLI_VERSION=28.1.0 \
  -t streampay-verifier:local \
  .github/actions/verify-reproducible-build

docker run --rm -v "$(pwd):/workspace" -w /workspace streampay-verifier:local \
  bash -c "cd contracts/streaming-payments && stellar contract build && sha256sum target/wasm32v1-none/release/streampay_contract.wasm"
```

### 2. Native Path

When Docker is unavailable (or when `use_docker: "false"` is configured), the verification action runs natively in the current shell environment.

- **Mismatch Detection**: The action verifies the host `rustc` and `stellar-cli` versions against the pinned release metadata.
- **Explicit Warning/Error**: If installed versions differ from the pinned triad, a clear error message is printed:
  ```
  ERROR: rustc version mismatch: installed 1.85.0 != pinned 1.99.1
  WARNING: Building with an unpinned rustc compiler may result in byte differences.
  ```
  This guarantees that toolchain discrepancies are never silently ignored as wrong contract code.
- **Stellar CLI Auto-Install**: On supported Linux runners, the action automatically downloads and installs the exact pinned `stellar-cli` version.

---

## 5. What the SHA-256 Digest Proves and What It Doesn't

### What the Digest Proves
- **Byte-for-Byte Reproducibility**: The rebuild independently produces the identical sequence of Wasm bytes from open-source code.
- **No Injected Backdoors**: Neither build runner tampering nor compiler-injected anomalies exist between the repository source code and the published Wasm binary.
- **Deterministic Compilation**: The build process is independent of ambient host state, timestamps, or file paths.

### What SLSA Provenance Proves vs What It Doesn't
StreamPay release workflows publish GitHub artifact attestations (`actions/attest-build-provenance`).
- **What SLSA Proves**: Cryptographically attests that the release asset was produced by the official GitHub Actions workflow in this repository from the specific tag.
- **What SLSA Does NOT Prove**: It does *not* prove that an external auditor will reproduce the exact same binary on a different machine. Bit-for-bit external reproducibility is proven exclusively by the independent rebuild and digest equality verification described in this guide.

### What the Digest Does Not Prove
- Does not guarantee that the contract source code is free of logical or economic bugs (which is covered by property testing, mutation testing, fuzzing, and formal audit).
- Does not verify that an on-chain contract instance matches this hash unless compared against the Soroban RPC contract code hash (`stellar contract inspect`).

---

## 6. Known Non-Reproducibility Risks & Mitigations

| Risk Factor | Mechanism of Non-Determinism | StreamPay Mitigation |
|---|---|---|
| **Local Path Leakage** | Host absolute paths embedded in Wasm debug info or symbols | `stellar contract build` automatically passes `CARGO_BUILD_RUSTFLAGS="--remap-path-prefix=<host>=/"`. |
| **Linker Ordering & Codegen Units** | Parallel code generation (`codegen-units > 1`) can yield non-deterministic function layout | `Cargo.toml` pins `codegen-units = 1` and `lto = true` for `[profile.release]`. |
| **Build Timestamps** | Macros like `env!("CARGO_PKG_VERSION")`, `__DATE__`, or timestamps | StreamPay code contains no time/date compiler macros. All time references use the Soroban ledger clock (`env.ledger().timestamp()`). |
| **Panic & Debug Bloat** | Host panic runtime formatting differences | `Cargo.toml` sets `panic = "abort"`, `debug = 0`, and `strip = "symbols"`. |
| **Dependency Floating** | Unpinned transitive crate versions | Workspace uses a strictly locked `Cargo.lock` checked into version control. |
| **Spec Shaking Non-Determinism** | Spec export hash ordering | Pinned `stellar-cli 28.1.0` enforces canonical XDR spec extraction order. |

---

## 7. Expected Digest Changes and Operator Notification

A legitimate source change (feature, refactor, or the size work in
[`WASM_SIZE.md`](WASM_SIZE.md), issue #58) produces a new Wasm digest by
design. The workflow for a digest change is:

1. The PR that changes the bytes states so explicitly and links the before/
   after size report; reviewers approve the digest move as part of the code
   change — a digest difference against the previous release is *expected*,
   not an incident.
2. Operators and integrators pinning `wasm_sha256` / `SHA256SUMS` /
   `UPGRADE_DIGESTS.txt` must repin to the new release asset **before** the
   upgrade is promoted. Tools watching deployed code hashes should expect a
   mismatch between the old pinned digest and the upgraded instance until
   they refresh.
3. The canonicalized interface hash (`scripts/contract_interface_hash.sh`)
   also moves; the promote run must set `schema_change_ack: true` (CLI gate:
   `SCHEMA_CHANGE_ACK=1`) so `deployments/interface/<env>.sha256` is
   re-baselined and `canary_check.sh`'s schema-continuity check compares
   against the new interface.
4. If a digest mismatch appears on a rebuild of an **existing, unchanged**
   tag, that is not this flow — follow section 8.

---

## 8. How to Report a Digest Mismatch

If you rebuild the contract from a published release tag and obtain a digest that does not match the published `SHA256SUMS` or `release-metadata.json`:

1. **Verify Toolchain Triad**:
   Confirm whether you ran the hermetic Docker path or native path. In native mode, check whether `rustc --version` and `stellar --version` match the values recorded in `release-metadata.json`.
2. **Collect Evidence Bundle**:
   - Rebuilt Wasm hash: `sha256sum target/wasm32v1-none/release/streampay_contract.wasm`
   - Git commit SHA: `git rev-parse HEAD`
   - Toolchain versions: `rustc -vV` and `stellar --version`
   - Full build log: output of `stellar contract build`
3. **Submit Report**:
   - If the mismatch appears to indicate a security issue or release discrepancy, report it immediately in accordance with [`SECURITY.md`](../SECURITY.md).
   - If you suspect an environmental or platform-specific variance, open an issue on GitHub with the evidence bundle.
