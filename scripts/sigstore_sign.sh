#!/usr/bin/env bash
# Sign release artifacts keylessly with Sigstore and record their Rekor entries.
#
# Usage:
#   scripts/sigstore_sign.sh --tag v0.5.0 --artifact <path> [--artifact <path>...]
#                            [--out <dir>] [--repo owner/repo]
#                            [--workflow release-sign.yml]
#                            [--attestation <attestation.json>]
#                            [--image <ref@sha256:...>]
#
# Options:
#   --tag <tag>          release tag being signed (required; pins the identity)
#   --artifact <path>    release asset to sign (repeatable)
#   --image <ref>        container image reference to sign (repeatable)
#   --out <dir>          output dir (default: sigstore/<tag>)
#   --repo <owner/repo>  repository in the signing identity (default: $GITHUB_REPOSITORY)
#   --workflow <file>    workflow in the signing identity (default: release-sign.yml)
#   --attestation <path> reproducible-build attestation to bind the Wasm digest to
#   --print-only         print the cosign commands without running them (tests)
#
# Environment:
#   SIGSTORE_ID_TOKEN    OIDC token override; otherwise fetched from the
#                        ACTIONS_ID_TOKEN_REQUEST_URL workload-identity endpoint
#   SIGSTORE_COSIGN      cosign binary (default: cosign)
#   SIGSTORE_REKOR_URL   Rekor instance recorded in the manifest (default:
#                        https://rekor.sigstore.dev). cosign v3 has no
#                        `--rekor-url` on sign-blob/sign — the endpoint comes
#                        from the signing config (TUF), so this value is what the
#                        release *claims*, and verify_sigstore.sh compares the
#                        bundle's entry against it.
#   SIGSTORE_OIDC_ISSUER expected issuer, recorded in the manifest
#
# Nothing here reads, writes or rotates a private key: cosign exchanges the
# workflow's OIDC token for a short-lived Fulcio certificate per artifact.
. "$(dirname "$0")/sigstore_lib.sh"

tag="" out="" repo="${GITHUB_REPOSITORY:-}" workflow="$SST_DEFAULT_WORKFLOW"
attestation="" print_only=0
artifacts=() images=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)          tag="${2:?--tag requires a value}"; shift 2 ;;
    --artifact)     artifacts+=("${2:?--artifact requires a path}"); shift 2 ;;
    --image)        images+=("${2:?--image requires a reference}"); shift 2 ;;
    --out)          out="${2:?--out requires a dir}"; shift 2 ;;
    --repo)         repo="${2:?--repo requires owner/repo}"; shift 2 ;;
    --workflow)     workflow="${2:?--workflow requires a file}"; shift 2 ;;
    --attestation)  attestation="${2:?--attestation requires a path}"; shift 2 ;;
    --print-only)   print_only=1; shift ;;
    -h|--help)      sed -n '2,32p' "$0"; exit 0 ;;
    *)              die "unknown argument: $1" ;;
  esac
done

[ -n "$tag" ] || die "usage: sigstore_sign.sh --tag <tag> --artifact <path>"
[ ${#artifacts[@]} -gt 0 ] || [ ${#images[@]} -gt 0 ] \
  || die "nothing to sign: pass --artifact and/or --image"
[ -n "$repo" ] || die "no repository for the signing identity: pass --repo owner/repo or set GITHUB_REPOSITORY"
case "$tag" in
  *[!A-Za-z0-9._+-]*) die "tag contains a character that is not safe in a path: $tag" ;;
esac

issuer="${SIGSTORE_OIDC_ISSUER:-$SST_DEFAULT_ISSUER}"
rekor_url="${SIGSTORE_REKOR_URL:-$SST_DEFAULT_REKOR}"
identity="$(sst_identity "$repo" "$workflow" "$tag")"
out="${out:-$REPO_ROOT/sigstore/$tag}"

say "Keyless signing $tag"
info "identity: $identity"
info "issuer:   $issuer"
# Recorded in the manifest, not passed to cosign: v3 has no --rekor-url.
info "rekor:    $rekor_url (recorded; the signing config selects the log)"

for a in "${artifacts[@]+"${artifacts[@]}"}"; do
  [ -f "$a" ] || die "artifact not found: $a"
done

if [ "$print_only" = "0" ]; then
  require "$SST_COSIGN"
  token="$(sst_oidc_token)" || die \
    "no OIDC identity token available (SIGSTORE_ID_TOKEN, or
    ACTIONS_ID_TOKEN_REQUEST_URL + ACTIONS_ID_TOKEN_REQUEST_TOKEN).
    Keyless signing needs the workflow's workload identity: without it the
    only way to sign would be a long-lived key, which this chain does not use."
fi

mkdir -p "$out"

# One entry per artifact, on its own line: {"path":...,"sha256":...,...}
entries=""
sign_blob() {
  local artifact="$1" name digest entry bundle cert log_index integrated
  name="$(basename "$artifact")"
  digest="$(att_sha256 "$artifact")"
  bundle="$out/$name.sigstore.json"
  cert="$out/$name.pem"

  info "signing $name (sha256:$digest)"
  # cosign v3: `--output-certificate`, `--output-signature` and `--rekor-url`
  # are gone; the bundle is the single output and carries the certificate.
  if [ "$print_only" = "1" ]; then
    printf 'cosign sign-blob --yes --bundle %s <artifact>\n' "$bundle"
  else
    "$SST_COSIGN" sign-blob --yes \
      --bundle "$bundle" \
      --identity-token "$token" \
      "$artifact" >/dev/null \
      || die "cosign sign-blob failed for $artifact"
    # The `.pem` the release publishes is extracted from the bundle, so it can
    # only ever describe the signature that was actually made. No certificate
    # in the bundle means no certificate to publish: that is a failure, not an
    # empty file.
    sst_bundle_certificate "$bundle" "$cert" \
      || die "bundle for $name carries no leaf certificate to publish as $(basename "$cert")"
  fi

  if [ "$print_only" = "1" ]; then
    log_index="0"; integrated="0"
  else
    # The signature is worthless as evidence without its log entry: a bundle
    # that carries no tlog entry is a signing failure, not a signed artifact.
    log_index="$(sst_bundle_log_index "$bundle")" || true
    integrated="$(sst_bundle_integrated_time "$bundle")" || true
    [ -n "$log_index" ] || die "bundle for $name carries no Rekor logIndex (was transparency logging disabled?)"
    [ -n "$integrated" ] || die "bundle for $name carries no Rekor integratedTime"
    info "rekor logIndex $log_index (integratedTime $integrated)"
  fi

  [ -n "$entries" ] && entries="$entries,"
  # Paths are recorded relative to the manifest so the signed set travels with
  # the release assets instead of pointing into the build machine's filesystem.
  entry="    {\"path\":\"$(att_json_escape "$name")\",\"sha256\":\"$digest\",\"bundle\":\"$(att_json_escape "$(basename "$bundle")")\",\"certificate\":\"$(att_json_escape "$(basename "$cert")")\",\"rekor\":{\"url\":\"$(att_json_escape "$rekor_url")\",\"logIndex\":$log_index,\"integratedTime\":$integrated}}"
  entries="$entries
$entry"
}

for a in "${artifacts[@]+"${artifacts[@]}"}"; do
  sign_blob "$a"
done

image_entries=""
for img in "${images[@]+"${images[@]}"}"; do
  info "signing image $img"
  if [ "$print_only" = "1" ]; then
    printf 'cosign sign --yes %s\n' "$img"
  else
    "$SST_COSIGN" sign --yes --identity-token "$token" "$img" >/dev/null \
      || die "cosign sign failed for image $img"
  fi
  [ -n "$image_entries" ] && image_entries="$image_entries,"
  image_entries="$image_entries
    {\"ref\":\"$(att_json_escape "$img")\",\"identity\":\"$(att_json_escape "$identity")\"}"
done

# --- reproducible-build binding ---------------------------------------------
att_entries=""
wasm_digest=""
if [ -n "$attestation" ]; then
  [ -f "$attestation" ] || die "attestation not found: $attestation"
  wasm_digest="$(att_json_get "$attestation" wasm_sha256)" || wasm_digest=""
  [ -n "$wasm_digest" ] || die "$attestation records no wasm_sha256 to bind signatures to"
  # Distinct key names, not a nested object: the verifier reads this document
  # without jq, and `sha256`/`path` are already used by every artifact entry.
  att_path="$(basename "$attestation")"
  case "$attestation" in
    "$REPO_ROOT"/*) att_path="${attestation#"$REPO_ROOT"/}" ;;
  esac
  att_entries="  \"attestation_path\": \"$(att_json_escape "$att_path")\",
  \"attestation_sha256\": \"$(att_sha256 "$attestation")\",
  \"wasm_sha256\": \"$wasm_digest\","
fi

manifest="$out/sigstore-manifest.json"
{
  printf '{\n'
  printf '  "schema": "%s",\n' "$SST_SCHEMA"
  printf '  "tag": "%s",\n' "$(att_json_escape "$tag")"
  printf '  "repository": "%s",\n' "$(att_json_escape "$repo")"
  printf '  "workflow": "%s",\n' "$(att_json_escape "$workflow")"
  printf '  "ref": "refs/tags/%s",\n' "$(att_json_escape "$tag")"
  printf '  "identity": "%s",\n' "$(att_json_escape "$identity")"
  printf '  "issuer": "%s",\n' "$(att_json_escape "$issuer")"
  printf '  "rekor_url": "%s",\n' "$(att_json_escape "$rekor_url")"
  [ -n "$att_entries" ] && printf '%s\n' "$att_entries"
  printf '  "artifacts": [%s\n  ],\n' "$entries"
  printf '  "images": [%s\n  ]\n' "$image_entries"
  printf '}\n'
} > "$manifest"

# Read the manifest back before publishing it: the verifier parses these fields,
# so a payload it could not parse must never be the payload we ship.
[ "$(sst_json_field "$(cat "$manifest")" tag)" = "$tag" ] \
  || die "generated manifest failed its own round-trip check on 'tag'"
for a in "${artifacts[@]+"${artifacts[@]}"}"; do
  digest="$(att_sha256 "$a")"
  entry="$(sst_manifest_entry "$manifest" "$digest")"
  [ -n "$entry" ] || die "generated manifest has no entry for $(basename "$a")"
  [ "$(sst_json_field "$entry" sha256)" = "$digest" ] \
    || die "generated manifest entry for $(basename "$a") failed its round-trip check"
done

info "manifest: ${manifest#"$REPO_ROOT"/}"
echo "$manifest"
