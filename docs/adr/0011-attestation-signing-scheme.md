# ADR 0011: Signing Scheme for Release Build Attestations

Status: Accepted
Date: 2026-10-17
Deciders: StreamPay Security & Infrastructure Team

## Context

`release.yml` already publishes the contract Wasm, a `SHA256SUMS` asset,
`release-metadata.json` and a SLSA build-provenance attestation
(`actions/attest-build-provenance@v2`). What it does not publish is anything an
**independent verifier** can use to prove, offline and with no trust in GitHub's
infrastructure, that *this* `.wasm` came from *these* sources at *this* commit
built by *this* toolchain.

Three gaps in the existing chain:

1. `SHA256SUMS` is unsigned. It is published next to the artifact it describes,
   so anyone who can write the release can write both. It proves nothing on its
   own.
2. SLSA provenance proves workflow origin — that the artifact came from a run of
   `release.yml` in this repository at this ref. It does **not** carry the
   toolchain versions, the build command, or whether the build was reproducible,
   and checking it requires reaching the GitHub Attestations API.
3. Nothing records the reproducibility result. `stellar contract build` is
   believed to be deterministic (see `docs/REPRODUCING.md` §6) but the release
   workflow never actually built twice, so the claim was asserted, not measured.

The requirement is that any deployer can prove a binary before deploying it, on
a hardened host, with as few installed dependencies as possible.

## Decision

Sign a JSON attestation payload with a **long-lived Ed25519 repository key**
using `openssl pkeyutl`, producing a detached signature. The public key is
committed at `attestations/signing-key.pub`; the private key lives only in the
`ATTESTATION_SIGNING_KEY` CI secret and an offline backup. SLSA provenance is
retained alongside it as a second chain with a different trust root.

## Alternatives Considered

### 1. cosign keyless signing with the workflow OIDC identity — rejected

All jobs in this repository run on GitHub-hosted `ubuntu-latest` runners, so
keyless signing *is* technically available. It is still the wrong tool here:

- **It duplicates a control we already have.** Keyless signing asserts "this
  artifact was produced by workflow X in repo Y at ref Z", authenticated by an
  ephemeral OIDC-federated certificate. That is precisely the claim
  `actions/attest-build-provenance@v2` already makes. Adding cosign would add a
  second copy of the same statement, not a new one.
- **It does not carry the fields we need.** The requirement is a payload with
  commit, artifact digest, Wasm digest, toolchain version, build command and
  timestamp. Keyless signing signs an arbitrary payload too, but the *value* of
  keyless is the identity binding, which we already get from SLSA. What we are
  missing is the reproducibility and toolchain claim.
- **Verification is network- and binary-dependent.** Checking a keyless
  signature needs `cosign` plus either the Rekor transparency log or a
  certificate bundle. Fulcio certificates are short-lived by design, so proving
  an old release depends on a third-party log staying reachable indefinitely. A
  deployer on an air-gapped or hardened host cannot verify at all.
- **It does not address the builder-compromise case.** A compromised workflow
  run obtains a perfectly valid OIDC identity. Keyless signing proves *which
  workflow* signed, not that the workflow did anything correct.

#### 2. minisign with a repository key — rejected on dependency cost only

The trust model is right and is essentially what we adopted: a long-lived
Ed25519 key, a tiny committed public key, offline verification, no transparency
log. minisign is rejected because verifying requires the `minisign` binary,
which is not preinstalled on `ubuntu-latest` or on a typical deploy host.
Installing it means a package manager or downloading a third-party binary —
which puts a supply-chain dependency *inside the verification step*. A verifier
you must download software to run is a weaker verifier.

#### 3. openssl Ed25519 with a repository key — adopted

- **Same trust model as minisign, same signature algorithm** (Ed25519). No
  cryptographic downgrade relative to option 2.
- **Zero marginal dependencies.** `openssl` is preinstalled on every CI runner
  and is already a hard requirement of `scripts/deploy_testnet.sh` (SAC salt
  generation). Verification needs `bash`, `openssl` and coreutils — all present
  on any host that can already run the deploy scripts.
- **Offline and permanent.** No certificate expiry, no log availability
  requirement. A release published today is still provable in five years from a
  checkout and the release assets.

### Payload and signature format

```
attestations/<tag>/attestation.json       the signed payload, exact bytes
attestations/<tag>/attestation.json.sig   detached Ed25519 signature, base64
attestations/signing-key.pub              pinned public key (trust anchor)
attestations/keys/*.pub                   rotated keys, still trusted
```

Two format decisions worth recording:

- **The signature covers the exact bytes of `attestation.json`.** Nothing is
  re-canonicalized at verify time. A `jq -S` round trip would make verification
  depend on jq's key ordering and formatting matching the signer's, and would
  make jq a verification dependency. Signing the bytes as written removes the
  whole class of problem.
- **The signature is stored as single-line base64, not raw binary.**
  `.gitattributes` normalizes text (`* text=auto`); a binary `.sig` committed on
  Linux and checked out on Windows risks CRLF corruption and a permanently
  unverifiable attestation. `attestations/**/*.json` and `*.sig` are pinned
  `-text` for the same reason.

## Consequences

### Positive

- A deployer can prove an artifact with `scripts/verify_wasm.sh` and nothing
  installed beyond `openssl`.
- The signed payload carries the toolchain, build command, commit and the
  measured reproducibility result — none of which SLSA provides.
- Reproducibility becomes a measured gate rather than an assumption: `release.yml`
  now builds twice in the pinned hermetic toolchain and refuses to sign if the
  two builds differ, in either the Wasm or the extracted spec JSON.
- Two independent chains with different trust roots (our key; GitHub's OIDC
  identity). Compromising one does not compromise the other.
- Tamper resistance is tested, not assumed: `tests/attestation_tamper_audit.sh`
  breaks every control and asserts it is caught, and runs in CI.

### Negative

- **A long-lived key is a larger blast radius than an ephemeral certificate.**
  If `ATTESTATION_SIGNING_KEY` leaks, an attacker can sign arbitrary
  attestations until the key is rotated. Mitigations: the private key is never
  in the repository (`attestation_keygen.sh` refuses to write it inside the
  checkout), it is only exposed to the release job, rotation is documented, and
  old keys stay trusted via `attestations/keys/` so rotation does not orphan
  existing releases.
- **The public key in the checkout is the trust anchor, so a repository
  compromise that swaps it and re-signs is not detectable from inside the
  checkout.** This is inherent to any pinned-key scheme, including minisign. The
  mitigation is out-of-band: each release publishes the key fingerprint, and
  `verify_wasm.sh --fingerprint sha256:<hex>` enforces it. Deployers who do not
  pin are relying on review of changes to `attestations/signing-key.pub`.
- **Manual bootstrap.** Someone must run `scripts/attestation_keygen.sh` and add
  the secret before the first release. Until then `release.yml` fails closed.
  This is deliberate: an unsigned release is not a weaker release, it is one no
  deployer can prove.
- **No transparency log.** Unlike Rekor, there is no public append-only record
  of which attestations were issued, so a *hidden* release (signed but never
  announced) would not be detectable. GitHub's release list and the SLSA chain
  partially cover this.

### Neutral

- The in-repo mirror is committed by the release workflow. Where branch
  protection refuses the push, the step warns and uploads the attestation as a
  workflow artifact instead of failing a release that has already been built,
  signed and published. The release assets remain the authoritative channel.

## Related

- [`docs/ATTESTATION.md`](../ATTESTATION.md) — payload reference, verifier guide
  and the full component-compromise threat model.
- [`docs/REPRODUCING.md`](../REPRODUCING.md) — the reproducible-build toolchain
  triad and known non-determinism risks.
- [`docs/adr/0010-payment-link-reference-format.md`](./0010-payment-link-reference-format.md)
