# Release attestations

Signed statements binding a published contract Wasm to the exact commit,
toolchain and build command that produced it. This directory is the in-repo
mirror; the same two files are attached to each GitHub release.

```
attestations/
  signing-key.pub          the pinned Ed25519 verification key (trust anchor)
  keys/                    rotated keys, kept so old attestations still verify
  <tag>/
    attestation.json       the signed payload — these exact bytes are signed
    attestation.json.sig   detached Ed25519 signature, single-line base64
```

Verify an artifact you are about to deploy:

```sh
scripts/verify_wasm.sh                                   # local build, latest release
scripts/verify_wasm.sh path/to/streampay_contract.wasm --tag v0.5.0
scripts/verify_wasm.sh --offline --tag v0.5.0            # no network
```

The only dependencies are `bash`, `openssl` and coreutils — deliberately, so a
deployer can prove a binary on a hardened host with nothing installed. See
[`docs/ATTESTATION.md`](../docs/ATTESTATION.md) for the payload format and the
threat model, and [`docs/adr/0011`](../docs/adr/0011-attestation-signing-scheme.md)
for why this scheme rather than cosign keyless or minisign.

## Trust anchor

`signing-key.pub` in **your own checkout** is the root of trust. The verifier
never accepts a public key that arrives alongside the artifact, because whoever
can rewrite a release could otherwise ship their own key.

That makes this file the single most security-sensitive path in the repo:
replacing it *and* re-signing is undetectable from inside the checkout. So its
fingerprint is published out of band in each release's notes, and deployers who
care should pin it:

```sh
scripts/verify_wasm.sh --fingerprint sha256:<hex> --require-repro
```

Check the pinned key against the published fingerprint at any time:

```sh
openssl pkey -pubin -in attestations/signing-key.pub -outform DER | sha256sum
```

## Bootstrap and rotation

No key is committed by this README's authors on your behalf — a public key
whose private half nobody holds would silently break every future release.
Generate the pair once, per repo:

```sh
scripts/attestation_keygen.sh          # writes the public half here, the private half to ~/.streampay/
gh secret set ATTESTATION_SIGNING_KEY < ~/.streampay/attestation-signing.key
git add attestations/signing-key.pub && git commit
```

The private key must never enter the repository; `attestation_keygen.sh`
refuses to write it inside the checkout. Until the secret exists, `release.yml`
fails closed rather than publishing an unverifiable release.

To rotate: move the current `signing-key.pub` into `keys/<fingerprint>.pub`,
generate a new pair, publish the new fingerprint, and add the new private key as
the secret. The verifier tries every pinned key, so attestations signed before
the rotation keep verifying.

## Regenerating locally

Attestations are produced by CI, not by hand — a locally generated one proves
only that you could run the signing key. For completeness:

```sh
ATTESTATION_SIGNING_KEY=~/.streampay/attestation-signing.key \
  scripts/attest.sh --tag v0.5.0 \
    --wasm target/wasm32v1-none/release/streampay_contract.wasm \
    --repro-report evidence/repro/repro-result.env
```
