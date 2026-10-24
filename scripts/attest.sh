#!/usr/bin/env bash
# Generate and sign a release attestation for a built contract Wasm.
#
# The attestation is the link an independent verifier was missing: a signed
# statement of WHICH COMMIT, WHICH TOOLCHAIN and WHICH BUILD COMMAND produced
# THESE EXACT BYTES. It is written to attestations/<tag>/ in-repo (the durable
# mirror) and uploaded to the GitHub release by release.yml.
#
# Usage:
#   scripts/attest.sh --tag v0.5.0 --wasm <path> [options]
#
# Options:
#   --tag <tag>              release tag being attested (required)
#   --wasm <path>            the built contract Wasm (required)
#   --out <dir>              output dir (default: attestations/<tag>)
#   --artifact <path>        extra release asset to digest (repeatable)
#   --repro-report <path>    KEY=VALUE result file from reproducible_build.sh
#
# Environment:
#   ATTESTATION_SIGNING_KEY  private Ed25519 PEM, as a path or inline (required)
#   ATTEST_COMMIT            override the recorded commit (default: git HEAD)
#   ATTEST_TIMESTAMP         override the recorded UTC timestamp (tests only)
#   ATTEST_WORKFLOW / ATTEST_RUN_ID / ATTEST_RUN_URL   builder identity
#
# Fails closed: with no signing key there is no attestation, and an unsigned
# release is not a degraded release — it is no release.
. "$(dirname "$0")/attestation_lib.sh"

tag="" wasm="" out="" repro_report=""
artifacts=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)          tag="${2:?--tag requires a value}"; shift 2 ;;
    --wasm)         wasm="${2:?--wasm requires a path}"; shift 2 ;;
    --out)          out="${2:?--out requires a dir}"; shift 2 ;;
    --artifact)     artifacts+=("${2:?--artifact requires a path}"); shift 2 ;;
    --repro-report) repro_report="${2:?--repro-report requires a path}"; shift 2 ;;
    -h|--help)      sed -n '2,26p' "$0"; exit 0 ;;
    *)              die "unknown argument: $1" ;;
  esac
done

[ -n "$tag" ]  || die "usage: attest.sh --tag <tag> --wasm <path>"
[ -n "$wasm" ] || die "usage: attest.sh --tag <tag> --wasm <path>"
[ -f "$wasm" ] || die "wasm not found: $wasm"
case "$tag" in
  *[!A-Za-z0-9._+-]*) die "tag contains a character that is not safe in a path: $tag" ;;
esac

require openssl

key="$(att_private_key_path)" || die \
  "ATTESTATION_SIGNING_KEY is not set.
  An unsigned release cannot be verified, so this step fails closed.
  Bootstrap a key with scripts/attestation_keygen.sh, then:
    gh secret set ATTESTATION_SIGNING_KEY < ~/.streampay/attestation-signing.key"
[ -f "$key" ] || die "signing key not readable: $key"
# Only ever shred a key this script materialized from inline secret text — never
# a PEM file the caller owns.
[ -n "$ATT_PRIVATE_KEY_TMP" ] && trap 'rm -f "$ATT_PRIVATE_KEY_TMP"' EXIT || true

out="${out:-$REPO_ROOT/$ATT_DIR_REL/$tag}"
mkdir -p "$out"
payload="$out/$ATT_PAYLOAD_NAME"
sig="$out/$ATT_SIG_NAME"
pubkey="$REPO_ROOT/$ATT_PUBKEY_REL"

# ----------------------------------------------------------------- the subject
say "Attesting $tag"
wasm_sha="$(att_sha256 "$wasm")"
info "wasm sha256: $wasm_sha"

commit="${ATTEST_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
timestamp="${ATTEST_TIMESTAMP:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# --------------------------------------------------------------- the toolchain
# `|| true` matters here: the tools are optional at attestation time (the
# attestation records what it can observe), and with pipefail a missing rustc
# would otherwise abort the whole release step.
rust_channel="$(sed -nE 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
  "$REPO_ROOT/rust-toolchain.toml" 2>/dev/null | head -n1 || true)"
rustc_version="$(rustc --version 2>/dev/null | head -n1 | awk '{print $2}' || true)"
stellar_version="$(stellar --version 2>/dev/null | head -n1 | awk '{print $2}' || true)"

# ---------------------------------------------------------- reproducibility run
repro_verified=false repro_runs=0
repro_wasm_identical=false repro_spec_identical=false
if [ -n "$repro_report" ]; then
  [ -f "$repro_report" ] || die "repro report not found: $repro_report"
  # shellcheck disable=SC1090
  . "$repro_report"
  repro_verified="${REPRO_VERIFIED:-false}"
  repro_runs="${REPRO_RUNS:-0}"
  repro_wasm_identical="${REPRO_WASM_IDENTICAL:-false}"
  repro_spec_identical="${REPRO_SPEC_IDENTICAL:-false}"
fi

[ "$repro_verified" = "true" ] \
  || warn "attesting WITHOUT a passing double-build reproducibility check"

# ------------------------------------------------------------------- artifacts
artifact_entries=""
add_artifact() {
  local p="$1"
  [ -f "$p" ] || { warn "skipping missing artifact: $p"; return 0; }
  local rel="${p#"$REPO_ROOT"/}"
  [ -n "$artifact_entries" ] && artifact_entries="$artifact_entries,"
  artifact_entries="$artifact_entries
    { \"path\": \"$(att_json_escape "$rel")\", \"sha256\": \"$(att_sha256 "$p")\" }"
}
add_artifact "$wasm"
for a in "${artifacts[@]+"${artifacts[@]}"}"; do add_artifact "$a"; done

# ---------------------------------------------------------------------- payload
key_fingerprint="$([ -f "$pubkey" ] && att_fingerprint "$pubkey" || echo "")"

{
  printf '{\n'
  printf '  "schema": "%s",\n' "$ATT_SCHEMA"
  printf '  "commit": "%s",\n' "$(att_json_escape "$commit")"
  printf '  "tag": "%s",\n' "$(att_json_escape "$tag")"
  printf '  "timestamp": "%s",\n' "$(att_json_escape "$timestamp")"
  printf '  "wasm_sha256": "%s",\n' "$wasm_sha"
  printf '  "build": {\n'
  printf '    "command": "stellar contract build",\n'
  printf '    "working_directory": "contracts/streaming-payments",\n'
  printf '    "target": "wasm32v1-none",\n'
  printf '    "profile": "release",\n'
  printf '    "artifact_path": "%s"\n' "$(att_json_escape "$WASM_REL")"
  printf '  },\n'
  printf '  "toolchain": {\n'
  printf '    "rust_channel": "%s",\n' "$(att_json_escape "${rust_channel:-unknown}")"
  printf '    "rustc_version": "%s",\n' "$(att_json_escape "${rustc_version:-unknown}")"
  printf '    "stellar_cli_version": "%s",\n' "$(att_json_escape "${stellar_version:-unknown}")"
  printf '    "wasm_target": "wasm32v1-none"\n'
  printf '  },\n'
  printf '  "reproducibility": {\n'
  printf '    "verified": %s,\n' "$repro_verified"
  printf '    "runs": %s,\n' "$repro_runs"
  printf '    "wasm_identical": %s,\n' "$repro_wasm_identical"
  printf '    "spec_identical": %s\n' "$repro_spec_identical"
  printf '  },\n'
  printf '  "artifacts": [%s\n  ],\n' "$artifact_entries"
  printf '  "builder": {\n'
  printf '    "workflow": "%s",\n' "$(att_json_escape "${ATTEST_WORKFLOW:-local}")"
  printf '    "run_id": "%s",\n' "$(att_json_escape "${ATTEST_RUN_ID:-}")"
  printf '    "run_url": "%s"\n' "$(att_json_escape "${ATTEST_RUN_URL:-}")"
  printf '  },\n'
  printf '  "signing_key_fingerprint": "%s"\n' "$(att_json_escape "$key_fingerprint")"
  printf '}\n'
} > "$payload"

# A payload we cannot read back is worse than no payload: the verifier parses
# these same fields, so prove the round trip before signing anything.
[ "$(att_json_get "$payload" wasm_sha256)" = "$wasm_sha" ] \
  || die "generated payload failed its own round-trip check (is jq/sed behaving?)"
[ "$(att_json_get "$payload" commit)" = "$commit" ] \
  || die "generated payload failed its own round-trip check on 'commit'"

# ------------------------------------------------------------------- signature
say "Signing with Ed25519"
att_sign "$key" "$payload" "$sig" \
  || die "signing failed — is ATTESTATION_SIGNING_KEY a valid Ed25519 private PEM?"

att_verify_sig "$pubkey" "$payload" "$sig" \
  || die "signature did not verify against $ATT_PUBKEY_REL.
  The committed public key does not match ATTESTATION_SIGNING_KEY. Rotate
  deliberately (see scripts/attestation_keygen.sh) — do not publish this."

info "payload:     ${payload#"$REPO_ROOT"/}"
info "signature:   ${sig#"$REPO_ROOT"/}"
info "key fingerprint: sha256:$key_fingerprint"
echo "$payload"
