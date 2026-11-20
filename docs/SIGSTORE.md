# Sigstore keyless release signing

Every release asset is signed with [Sigstore](https://www.sigstore.dev/) **keyless**:
`cosign` trades the GitHub Actions run's OIDC workload identity for a short-lived
Fulcio certificate scoped to this repository, this workflow and this tag, signs
the artifact, and records the signature in the public
[Rekor](https://docs.sigstore.dev/logging/overview/) transparency log. Nothing
in this chain holds, stores or rotates a private signing key — the key exists
only for the seconds the certificate is valid, so "rotation" is certificate
expiry.

This is the third link in the release-proof chain, and each link answers a
different question:

| Chain | Answers | Needs |
|---|---|---|
| `SHA256SUMS` | what digest was published | nothing |
| Ed25519 attestation + reproducible build ([`docs/ATTESTATION.md`](./ATTESTATION.md), [ADR 0011](./adr/0011-attestation-signing-scheme.md)) | *which commit, toolchain and build command* produced these bytes, and that the build repeats | `bash`, `openssl` |
| **Sigstore keyless (this document)** | *which CI run* signed, and *when* — publicly, in an append-only log | `cosign` (or any Sigstore verifier) |

Why both key schemes (see [ADR 0011](./adr/0011-attestation-signing-scheme.md)
for the original choice of a repository key): the Ed25519 chain is verifiable
offline forever with no third party reachable, which is what a deployer on a
hardened host needs. The keyless chain adds what a repository key cannot: a
public, append-only record of *when* a signature was created, and an identity
that cannot be forged by copying a key out of CI — there is no key to copy. A
compromised release workflow gets a valid identity either way; that is what the
reproducibility gate and the transparency log together let others notice.

## What is published

`sigstore-manifest.json` (schema `streampay.sigstore-manifest/v1`) travels with
the release assets:

```json
{
  "schema": "streampay.sigstore-manifest/v1",
  "tag": "v0.5.0",
  "repository": "Neziahtech/streampay",
  "workflow": "release-sign.yml",
  "ref": "refs/tags/v0.5.0",
  "identity": "https://github.com/Neziahtech/streampay/.github/workflows/release-sign.yml@refs/tags/v0.5.0",
  "issuer": "https://token.actions.githubusercontent.com",
  "rekor_url": "https://rekor.sigstore.dev",
  "attestation_path": "attestations/v0.5.0/attestation.json",
  "attestation_sha256": "<sha256 of the attestation>",
  "wasm_sha256": "<sha256 of the contract wasm>",
  "artifacts": [
    {"path":"streampay_contract.wasm","sha256":"<digest>","bundle":"streampay_contract.wasm.sigstore.json","certificate":"streampay_contract.wasm.pem","rekor":{"url":"https://rekor.sigstore.dev","logIndex":123456789,"integratedTime":1763600000}}
  ],
  "images": [
    {"ref":"registry/streampay-indexer@sha256:…","identity":"…"}
  ]
}
```

Per artifact: the signed digest, the cosign bundle (signature + Fulcio
certificate + Rekor entry with its inclusion proof and signed entry timestamp),
and the log index and integrated time of the transparency-log entry. The
manifest is written one artifact per line so a verifier without `jq` can read it
with `grep`/`sed`; it is ordinary JSON for everything else.

cosign v3 removed `sign-blob --output-certificate` (and `--rekor-url`): the
bundle is the only output. The `.pem` published next to it is therefore derived
from the bundle's `verificationMaterial.certificate.rawBytes`, and
`verify_sigstore.sh` rejects a release whose `.pem` and bundle disagree. The
manifest's `rekor_url` records the log the release claims; it is compared
against `--rekor-url` instead of being passed to cosign, which selects the log
from its signing config.

## Verify a release

Using this repository's verifier (the same code the release gate runs):

```sh
gh release download v0.5.0 --pattern 'streampay_contract.wasm' \
  --pattern 'SHA256SUMS' --pattern 'sigstore-manifest.json' \
  --pattern '*.sigstore.json' --pattern '*.pem' --pattern 'attestation.json' \
  --dir /tmp/rel

scripts/verify_sigstore.sh \
  --tag v0.5.0 \
  --repo Neziahtech/streampay \
  --manifest /tmp/rel/sigstore-manifest.json \
  --attestation /tmp/rel/attestation.json \
  --sha256sums /tmp/rel/SHA256SUMS \
  --artifact /tmp/rel/streampay_contract.wasm
```

`--print-identity` prints the identity the policy expects; useful for writing
your own `cosign` invocation.

Using only `cosign`, without trusting this repository's script:

```sh
cosign verify-blob \
  --bundle streampay_contract.wasm.sigstore.json \
  --certificate-identity \
    'https://github.com/Neziahtech/streampay/.github/workflows/release-sign.yml@refs/tags/v0.5.0' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  streampay_contract.wasm
```

The identity string is exact and includes the tag: a signature made by the same
workflow for another tag, or by another workflow in this repository, does not
verify. Do not relax it to a regexp that matches "any workflow" — that would
accept a signature from a job you did not review.

## Identity policy

| Field | Pinned value |
|---|---|
| certificate identity | `https://github.com/Neziahtech/streampay/.github/workflows/release-sign.yml@refs/tags/<tag>` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |
| transparency log | `https://rekor.sigstore.dev` |
| artifact digest | the digest in the signed manifest entry **and** the reproducible-build attestation's `wasm_sha256` |

`release-sign.yml` is the only workflow with `id-token: write` for signing, and
it is deliberately separate from `release.yml` so the build job cannot mint an
identity.

## What the gate rejects

`scripts/verify_sigstore.sh` fails closed on any of:

- an artifact whose digest is not in the signed manifest (bytes changed after signing, or never signed);
- a manifest produced for another tag, ref, workflow, repository or issuer;
- a certificate identity or OIDC issuer other than the pinned pair (the check `cosign` performs);
- a bundle with no Rekor `logIndex`/`integratedTime`, or a log entry whose index disagrees with the manifest;
- a contract Wasm whose digest disagrees with the reproducibility attestation, or no attestation at all;
- a digest that disagrees with the published `SHA256SUMS`.

`tests/sigstore_verify_test.sh` breaks each of those controls in turn and
requires the gate to reject it; it runs on every pull request that touches this
chain. It needs no `cosign` and no network: a stub stands in for `cosign` and
enforces what the real binary enforces, so what is tested is this repository's
policy.

## Operating notes

- **No secrets.** There is no signing key to bootstrap, back up or rotate. If the
  `sign` job cannot obtain an OIDC token it fails rather than falling back to a
  stored key.
- **A tag re-pointed after release** keeps its old signatures valid for the old
  bytes, which is exactly why the manifest records digests: verification of the
  *new* bytes fails because no signature covers them.
- **Rekor availability.** Verification reads the entry from the bundle, so a
  published release stays verifiable without querying the log. Recovery of a
  log entry's inclusion proof after the fact is a Rekor/`rekor-cli` operation and
  is out of scope for this gate.
