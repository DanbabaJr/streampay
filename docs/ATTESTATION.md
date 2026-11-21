# Release attestation chain

What ties a published contract Wasm to the sources that produced it, how to
check it before you deploy, and — the part that is usually hand-waved — exactly
what each check proves and what it silently does not.

- Signing scheme rationale: [`adr/0011-attestation-signing-scheme.md`](adr/0011-attestation-signing-scheme.md)
- Reproducible-build toolchain triad: [`REPRODUCING.md`](./REPRODUCING.md)
- Promotion gates that consume this: [`DEPLOY_PIPELINE.md`](./DEPLOY_PIPELINE.md)

## 1. The chain

Four links. Each is independently checkable; breaking any one is meant to
produce a named failure, not a silent pass.

```
   sources at commit C
          │  scripts/reproducible_build.sh
          │  (two independent builds, pinned hermetic toolchain,
          │   wasm + spec-json must be byte-identical)
          ▼
   Wasm bytes B, digest D(B)
          │  scripts/attest.sh   (Ed25519 sign with ATTESTATION_SIGNING_KEY)
          ▼
   attestation.json  +  attestation.json.sig
          │  attached to the GitHub release AND mirrored in attestations/<tag>/
          ▼
   scripts/verify_wasm.sh
        ├─ recompute D(B')  of the bytes you hold
        ├─ verify signature against attestations/signing-key.pub (your checkout)
        └─ assert D(B') == payload.wasm_sha256
```

## 2. Verify before deploying

You need `bash`, `openssl` and coreutils. No `stellar-cli`, no Docker, no Rust,
no network if you use the in-repo mirror.

```sh
# Verify your local build against the latest published release
scripts/verify_wasm.sh

# Verify a downloaded artifact against a specific tag
scripts/verify_wasm.sh /tmp/streampay_contract.wasm --tag v0.5.0

# Fully offline, from the in-repo mirror
scripts/verify_wasm.sh --tag v0.5.0 --offline

# Paranoid: pin the signing key out of band and demand the double build passed
scripts/verify_wasm.sh /tmp/streampay_contract.wasm --tag v0.5.0 \
  --require-repro --fingerprint sha256:<published-hex>
```

Exit status is non-zero unless every link held, and the report names the link
that broke. `scripts/deploy_testnet.sh` runs this gate and refuses to deploy on
failure.

## 3. Payload format

`attestations/<tag>/attestation.json`. The signature covers **these exact
bytes** — nothing is re-canonicalized at verify time, which is why jq is not a
verification dependency.

```json
{
  "schema": "streampay.attestation/v1",
  "commit": "952fa321868ad420ad2955fc4876b394e898b017",
  "tag": "v0.5.0",
  "timestamp": "2026-10-17T21:00:00Z",
  "wasm_sha256": "<digest of the contract Wasm>",
  "build": {
    "command": "stellar contract build",
    "working_directory": "contracts/streaming-payments",
    "target": "wasm32v1-none",
    "profile": "release",
    "artifact_path": "target/wasm32v1-none/release/streampay_contract.wasm"
  },
  "toolchain": {
    "rust_channel": "1.99.1",
    "rustc_version": "1.99.1",
    "stellar_cli_version": "28.1.0",
    "wasm_target": "wasm32v1-none"
  },
  "reproducibility": {
    "verified": true,
    "runs": 2,
    "wasm_identical": true,
    "spec_identical": true
  },
  "artifacts": [
    { "path": "target/.../streampay_contract.wasm", "sha256": "<digest>" },
    { "path": "SHA256SUMS", "sha256": "<digest>" }
  ],
  "builder": {
    "workflow": "release.yml",
    "run_id": "<Actions run id>",
    "run_url": "<link to the run>"
  },
  "signing_key_fingerprint": "sha256 of the DER public key"
}
```

`attestation.json.sig` is the detached Ed25519 signature over the payload, stored
as single-line base64 (never raw binary: `.gitattributes` text normalization
would corrupt it on some checkouts).

## 4. Threat model: what compromise of each component is caught

The honest question is not "is it signed" but "**if this component is owned,
what does the verifier still catch?**".

| Compromised component | What the attacker wants | Caught? | By what link | Residual risk |
|---|---|---|---|---|
| **GitHub release storage** (rewrite assets, keep repo clean) | Deploy a backdoored Wasm | **Yes** | Digest of the deployed bytes no longer matches the signed `wasm_sha256`. Rewriting the payload too breaks the signature against your pinned key. | Nothing. This is the primary threat the chain kills. |
| **CDN / mirror / MITM on download** | Same | **Yes** | Same digest + signature check. Verification needs no trust in the transport. | A malicious *verifier wrapper* that skips the check. |
| **Builder / CI runner** (post-build swap of `B`) | Ship different bytes than the workflow built | **Yes, if the swap changes `B` after the double build** | The reproducibility gate compares two independent builds; the signature binds the surviving digest. | **Not caught:** a builder that is compromised *before* both builds can deterministically emit a backdoor for commit C, sign it honestly, and pass every check. Reproducibility is not correctness. Only review/fuzzing/audit catches that. |
| **Repository source** (malicious change merged) | Ship a backdoor that *is* the reviewed build | **No** | Nothing in this chain reads source semantics. A signed, reproducible backdoor is still a backdoor. | This is the chain's central limit: it proves *which* bytes came from *which* source, never that the source is safe. |
| **`attestations/signing-key.pub` in the checkout** (swap key, re-sign) | Make forged attestations verify | **Not caught by default** | The pinned key is the trust anchor; a checkout that controls the key can also control what it trusts. | **Caught only if you pin the fingerprint out of band** (`--fingerprint`). CI surfaces any change to this path. Publish the fingerprint in release notes and pin it. |
| **Signing key secret `ATTESTATION_SIGNING_KEY`** (steal private key) | Sign arbitrary attestations | **No** | Cryptographically indistinguishable from a legitimate signing. | Caught only by external signals: an attestation whose `builder`/`commit` does not correspond to a real Actions run, or a key rotation. Rotate via `attestations/keys/`, publish the new fingerprint. |
| **`attestations/<tag>/` in-repo mirror** (diverge from the release asset) | Confuse offline verifiers | **Yes** | Nightly CI cross-checks the mirror against the release asset byte-for-byte; `--offline` still requires the signature to verify against the pinned key. | A mirror edited on a feature branch has no gate until merge review. |
| **Toolchain supply chain** (crates.io, stellar-cli binary, Docker base image) | Inject a compiler backdoor | **Partly** | `Cargo.lock` pins versions and cargo verifies crate checksums; the toolchain triad is pinned and the double build runs in the same hermetic image. | **Not caught:** a poisoned toolchain that is deterministic — both builds reproduce the poisoned output. Attestation records *which* toolchain, which makes post-hoc revocation possible. |
| **Deployer's machine** | Bypass verification | **No** | The gate is advisory at the last hop. | `SKIP_WASM_ATTESTATION=1` exists for unreleased local work and is recorded in the run summary, but a coerced operator can always skip. |

### What the chain proves

1. These bytes are the bytes a signed attestation describes.
2. That attestation was signed by the holder of the pinned key's private half.
3. It names a specific commit, toolchain and build command.
4. If `reproducibility.verified` is true: two independent builds of that commit,
   in the pinned hermetic image, produced byte-identical Wasm **and**
   byte-identical extracted spec/interface JSON.

### What the chain never proves

- The source at that commit is correct, safe or free of economic exploits.
- The build you are verifying was actually performed by the workflow named in
  `builder` — that claim is asserted by the signer, not independently derived.
  Cross-check the run URL (and SLSA provenance) if you need it externally
  attested.
- A compromised-before-both-builds builder is lying about determinism.
- That no *other* attestation was signed for a different artifact at the same
  commit — there is no transparency log. Two verifiers comparing notes would
  notice; one verifier alone would not.

## 5. Reproducing independently

```sh
# Two hermetic builds of the tag, byte-diffed; reports the drifting component
scripts/reproducible_build.sh --ref v0.5.0
```

If the builds drift, the report names the component (`wasm` or `spec-json`),
gives both digests, the first differing byte offset, and whether the artifact
length changed — which distinguishes "embedded path/timestamp" from "codegen or
link ordering" without eyeballing a hex dump.

## 6. Reporting a failure

A `DIGEST MISMATCH`, a failed signature, or a reproducibility drift on a
published release is a security event, not a build flake. Follow
[`../SECURITY.md`](../SECURITY.md) (private vulnerability report) with the
evidence bundle: both digests, the payload, the tag, your toolchain versions and
the verifier's full output.
