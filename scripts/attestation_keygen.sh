#!/usr/bin/env bash
# Bootstrap the release-attestation signing key (see docs/adr/0003).
#
# Generates an Ed25519 keypair. The PUBLIC half is written into the repo
# (attestations/signing-key.pub) and committed, so any deployer can verify an
# attestation with nothing but `openssl` and a checkout. The PRIVATE half is
# written OUTSIDE the repository and must be loaded into CI as the
# ATTESTATION_SIGNING_KEY secret. It is never committed and never printed.
#
# Usage:
#   scripts/attestation_keygen.sh                     # write both halves
#   scripts/attestation_keygen.sh --private-out PATH  # choose the private path
#   scripts/attestation_keygen.sh --print-public      # re-print the public PEM
#
# Key rotation: generate a new pair, commit the new public key alongside the
# old one under attestations/keys/, and bump attestations/signing-key.pub. The
# verifier accepts any key listed in attestations/keys/, so old attestations
# stay verifiable after rotation.
. "$(dirname "$0")/lib.sh"

PUB_REL="attestations/signing-key.pub"
private_out="${ATTESTATION_PRIVATE_KEY:-$HOME/.streampay/attestation-signing.key}"
print_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    --private-out) private_out="${2:?--private-out requires a path}"; shift 2 ;;
    --print-public) print_only=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require openssl

if [ "$print_only" = "1" ]; then
  [ -f "$REPO_ROOT/$PUB_REL" ] || die "no pinned public key at $PUB_REL — run this script without --print-public first"
  cat "$REPO_ROOT/$PUB_REL"
  exit 0
fi

[ -f "$REPO_ROOT/$PUB_REL" ] && die \
  "$PUB_REL already exists. Refusing to overwrite the pinned verification key:
  every attestation already published against it would stop verifying.
  To rotate, see the header of this script; to start over, delete it deliberately."

case "$(cd "$(dirname "$private_out")" 2>/dev/null && pwd)" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    die "refusing to write the private key inside the repository ($private_out).
  It would be one 'git add -A' away from being published. Use a path outside
  the checkout, e.g. ~/.streampay/attestation-signing.key"
    ;;
esac

mkdir -p "$(dirname "$private_out")"

say "Generating Ed25519 attestation signing key"
umask 077
openssl genpkey -algorithm ED25519 -out "$private_out" \
  || die "openssl could not generate an Ed25519 key (needs OpenSSL >= 1.1.1)"
chmod 600 "$private_out"

mkdir -p "$REPO_ROOT/attestations"
openssl pkey -in "$private_out" -pubout -out "$REPO_ROOT/$PUB_REL" \
  || die "failed to derive the public key"

fingerprint="$(openssl pkey -pubin -in "$REPO_ROOT/$PUB_REL" -outform DER \
  | sha256sum | awk '{print $1}')"

cat <<EOF

  private key : $private_out   (mode 600, OUTSIDE the repo — keep it offline)
  public key  : $PUB_REL       (commit this)
  fingerprint : sha256:$fingerprint

Next steps:
  1. Publish the fingerprint out of band (release notes, SECURITY.md) so a
     deployer can tell a swapped public key from a legitimate rotation.
  2. Store the private key as the CI secret ATTESTATION_SIGNING_KEY:
       gh secret set ATTESTATION_SIGNING_KEY < $private_out
  3. git add $PUB_REL && git commit

EOF
