#!/usr/bin/env bash
# Standalone verification gate for Sigstore keyless release signatures.
#
# Verifies, for every artifact of a release, that four independent things hold —
# and fails closed if any of them does not:
#
#   1. identity      the Fulcio certificate belongs to THIS repository's release
#                    workflow at THIS tag (`--certificate-identity` exact match,
#                    plus the OIDC issuer), not merely to some workflow of some
#                    repository;
#   2. digest        the artifact's current sha256 is the digest in the signed
#                    manifest entry, and the bundle cosign verifies is that
#                    entry's;
#   3. Rekor         the bundle carries a transparency-log entry with a numeric
#                    `logIndex` and `integratedTime`, and they match the
#                    manifest — cosign verifies the inclusion proof and signed
#                    entry timestamp while checking the bundle;
#   4. attestation   the digest equals the reproducible-build attestation's
#                    `wasm_sha256` for the contract Wasm (issue #207's chain) and
#                    the published SHA256SUMS when those are supplied.
#
# Usage:
#   scripts/verify_sigstore.sh --tag <tag> --manifest <manifest> --artifact <path> [options]
#
# Options:
#   --tag <tag>            release tag the identity is pinned to (required)
#   --manifest <path>      sigstore-manifest.json written by sigstore_sign.sh
#   --artifact <path>      release asset to verify (repeatable)
#   --image <ref@sha256:…> image reference to verify with `cosign verify`
#   --attestation <path>   reproducible-build attestation to bind the Wasm digest to
#   --sha256sums <path>    published SHA256SUMS to bind the digest to
#   --repo <owner/repo>    expected repository (default: $GITHUB_REPOSITORY)
#   --workflow <file>      expected workflow (default: release-sign.yml)
#   --issuer <url>         expected OIDC issuer (default: the Actions issuer)
#   --rekor-url <url>      expected Rekor instance (default: rekor.sigstore.dev)
#   --require-attestation  refuse to verify a release with no attestation
#   --print-identity       print the pinned identity and exit (for docs/tests)
#
# Environment:
#   SIGSTORE_COSIGN        cosign binary (default: cosign). The self-tests point
#                          this at a stub, so the policy here is exercised
#                          offline without weakening what is asserted.
#
# Exit status is non-zero on any mismatch. Nothing is downloaded from Rekor: the
# entry travels in the bundle, so verification of a published release needs only
# cosign and the release assets.
. "$(dirname "$0")/sigstore_lib.sh"

tag="" manifest="" attestation="" sha256sums=""
repo="${GITHUB_REPOSITORY:-}"
workflow="$SST_DEFAULT_WORKFLOW"
issuer="$SST_DEFAULT_ISSUER"
rekor_url="$SST_DEFAULT_REKOR"
require_attestation=0
print_identity=0
artifacts=() images=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)                 tag="${2:?--tag requires a value}"; shift 2 ;;
    --manifest)            manifest="${2:?--manifest requires a path}"; shift 2 ;;
    --artifact)            artifacts+=("${2:?--artifact requires a path}"); shift 2 ;;
    --image)               images+=("${2:?--image requires a reference}"); shift 2 ;;
    --attestation)         attestation="${2:?--attestation requires a path}"; shift 2 ;;
    --sha256sums)          sha256sums="${2:?--sha256sums requires a path}"; shift 2 ;;
    --repo)                repo="${2:?--repo requires owner/repo}"; shift 2 ;;
    --workflow)            workflow="${2:?--workflow requires a file}"; shift 2 ;;
    --issuer)              issuer="${2:?--issuer requires a url}"; shift 2 ;;
    --rekor-url)           rekor_url="${2:?--rekor-url requires a url}"; shift 2 ;;
    --require-attestation) require_attestation=1; shift ;;
    --print-identity)      print_identity=1; shift ;;
    -h|--help)             sed -n '2,46p' "$0"; exit 0 ;;
    *)                     die "unknown argument: $1" ;;
  esac
done

[ -n "$tag" ] || die "usage: verify_sigstore.sh --tag <tag> --manifest <path> --artifact <path>"
[ -n "$repo" ] || die "no expected repository: pass --repo owner/repo or set GITHUB_REPOSITORY"

identity="$(sst_identity "$repo" "$workflow" "$tag")"

if [ "$print_identity" = "1" ]; then
  echo "$identity"
  exit 0
fi

[ -n "$manifest" ] || die "--manifest is required"
[ -f "$manifest" ] || die "manifest not found: $manifest"
[ ${#artifacts[@]} -gt 0 ] || [ ${#images[@]} -gt 0 ] \
  || die "nothing to verify: pass --artifact and/or --image"
require "$SST_COSIGN"

say "Verifying Sigstore signatures for $tag"
info "pinned identity: $identity"
info "issuer:          $issuer"

# --- manifest identity ------------------------------------------------------
# The manifest is not a trust anchor (cosign checks the certificate), but a
# manifest naming a different release, workflow or issuer means the assets and
# the signature record belong to different runs: fail before looking at any
# signature so the diagnosis is the real one.
doc="$(cat "$manifest")"
[ "$(sst_json_field "$doc" schema)" = "$SST_SCHEMA" ] \
  || die "$manifest is not a $SST_SCHEMA document"
[ "$(sst_json_field "$doc" tag)" = "$tag" ] \
  || die "manifest is for tag '$(sst_json_field "$doc" tag)', not '$tag'"
[ "$(sst_json_field "$doc" repository)" = "$repo" ] \
  || die "manifest was produced for repository '$(sst_json_field "$doc" repository)', not '$repo'"
[ "$(sst_json_field "$doc" workflow)" = "$workflow" ] \
  || die "manifest was produced by workflow '$(sst_json_field "$doc" workflow)', not '$workflow'"
[ "$(sst_json_field "$doc" ref)" = "refs/tags/$tag" ] \
  || die "manifest is bound to ref '$(sst_json_field "$doc" ref)', not 'refs/tags/$tag'"
[ "$(sst_json_field "$doc" issuer)" = "$issuer" ] \
  || die "manifest was issued by '$(sst_json_field "$doc" issuer)', not '$issuer'"

# --- reproducible-build attestation ----------------------------------------
wasm_digest=""
if [ -n "$attestation" ]; then
  [ -f "$attestation" ] || die "attestation not found: $attestation"
  wasm_digest="$(att_json_get "$attestation" wasm_sha256)" || wasm_digest=""
  [ -n "$wasm_digest" ] || die "$attestation records no wasm_sha256"
  [ "$(att_json_get "$attestation" tag)" = "$tag" ] \
    || die "$attestation is for tag '$(att_json_get "$attestation" tag)', not '$tag'"
elif [ "$require_attestation" = "1" ]; then
  die "--require-attestation was given but no --attestation path was"
fi

# The attestation digest recorded in the manifest, when present, must be the
# attestation being checked: otherwise signatures and attestation describe two
# different builds.
recorded_att="$(sst_json_field "$doc" attestation_sha256)"
if [ -n "$attestation" ] && [ -n "$recorded_att" ]; then
  [ "$recorded_att" = "$(att_sha256 "$attestation")" ] \
    || die "the manifest records attestation sha256 $recorded_att but $attestation is $(att_sha256 "$attestation")"
fi
recorded_wasm="$(sst_json_field "$doc" wasm_sha256)"
if [ -n "$attestation" ] && [ -n "$recorded_wasm" ] && [ "$recorded_wasm" != "$wasm_digest" ]; then
  die "the manifest binds wasm sha256 $recorded_wasm but the attestation says $wasm_digest"
fi

verify_blob() {
  local artifact="$1" digest entry entry_path bundle cert log_index integrated
  local entry_log_index entry_integrated cert_identity

  [ -f "$artifact" ] || die "artifact not found: $artifact"
  digest="$(att_sha256 "$artifact")"
  info "sha256($(basename "$artifact")) = $digest"

  entry="$(sst_manifest_entry "$manifest" "$digest")"
  [ -n "$entry" ] || die \
    "artifact digest $digest is not the digest signed in $manifest
  Either the artifact was modified after signing, or it was never signed.
  Both fail closed: an unsigned artifact is not a release asset."

  entry_path="$(sst_json_field "$entry" path)"
  [ "$(basename "$entry_path")" = "$(basename "$artifact")" ] || die \
    "manifest entry for digest $digest names '$entry_path', not '$(basename "$artifact")'"

  # Bundles travel next to the manifest (same release, same directory).
  bundle="$(dirname "$manifest")/$(sst_json_field "$entry" bundle)"
  [ -f "$bundle" ] || die "signature bundle for $(basename "$artifact") not found at $bundle"

  log_index="$(sst_bundle_log_index "$bundle")" || true
  integrated="$(sst_bundle_integrated_time "$bundle")" || true
  [ -n "$log_index" ] || die \
    "bundle for $(basename "$artifact") carries no Rekor logIndex: there is no
  transparency-log entry proving when this signature was published"
  [ -n "$integrated" ] || die "bundle for $(basename "$artifact") carries no Rekor integratedTime"

  entry_log_index="$(sst_json_number "$entry" logIndex)"
  entry_integrated="$(sst_json_number "$entry" integratedTime)"
  [ "$entry_log_index" = "$log_index" ] || die \
    "manifest publishes Rekor logIndex $entry_log_index but the bundle's entry is $log_index
  (the manifest and the transparency-log entry describe different signatures)"
  [ "$entry_integrated" = "$integrated" ] || die \
    "manifest publishes Rekor integratedTime $entry_integrated but the bundle's entry is $integrated"

  cert_identity="$identity"
  # cosign verifies the certificate chain, the signature over this exact blob,
  # the Rekor inclusion proof and its signed entry timestamp. The identity flags
  # are exact, not regexps: only this repository's release workflow at this tag
  # can satisfy them.
  "$SST_COSIGN" verify-blob \
    --bundle "$bundle" \
    --certificate-identity "$cert_identity" \
    --certificate-oidc-issuer "$issuer" \
    --rekor-url "$rekor_url" \
    "$artifact" >/dev/null \
    || die "cosign rejected the signature on $(basename "$artifact"): wrong identity, wrong issuer, tampered bytes, or no valid Rekor inclusion proof"

  info "signature + Rekor entry OK (logIndex $log_index, integratedTime $integrated)"

  case "$artifact" in
    *.wasm)
      if [ -n "$wasm_digest" ] && [ "$wasm_digest" != "$digest" ]; then
        die "Wasm digest $digest does not match the reproducibility attestation's $wasm_digest"
      fi
      ;;
  esac

  if [ -n "$sha256sums" ]; then
    local published
    published="$(awk 'NF >= 1 { print $1; exit }' "$sha256sums")"
    [ -n "$published" ] || die "no digest found in $sha256sums"
    [ "$published" = "$digest" ] || die \
      "artifact digest $digest does not match the published SHA256SUMS digest $published"
  fi

  # A Wasm artifact is never verifiable on its own: it must also be the binary
  # the reproducible-build attestation describes.
  case "$artifact" in
    *.wasm)
      [ -n "$wasm_digest" ] || die \
        "refusing to verify a Wasm without the reproducible-build attestation
  (pass --attestation; a signature proves who built it, the attestation proves what)"
      ;;
  esac
}

for a in "${artifacts[@]+"${artifacts[@]}"}"; do
  verify_blob "$a"
done

for img in "${images[@]+"${images[@]}"}"; do
  info "verifying image $img"
  "$SST_COSIGN" verify "$img" \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer "$issuer" >/dev/null \
    || die "cosign verify rejected $img: wrong identity, issuer, or no Rekor proof"
done

say "All signatures, Rekor entries and digest bindings verified"
