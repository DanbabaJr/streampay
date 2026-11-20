#!/usr/bin/env bash
# Shared helpers for the Sigstore keyless release-signing chain (issue #611):
# identity policy, OIDC workload-identity token acquisition, the signature
# manifest, and the Rekor transparency-log fields the verifier requires.
#
# Sourced by scripts/sigstore_sign.sh, scripts/verify_sigstore.sh and
# tests/sigstore_verify_test.sh; it also pulls in attestation_lib.sh, so callers
# get say/info/warn/die/require and the digest helpers too.
#
# Design notes (docs/SIGSTORE.md):
#   * No signing key is created, stored or rotated here. cosign obtains a
#     short-lived Fulcio certificate from the workflow's OIDC identity, so the
#     private key exists only inside that process for the length of the signing
#     call. Rotation is certificate expiry, by construction.
#   * The manifest is written one artifact per line so the standalone verifier
#     can read it with sed/grep on a host without jq. It is ordinary JSON for
#     everyone else (schema in docs/SIGSTORE.md).
#   * Every policy check fails closed. An unreadable manifest, an artifact whose
#     digest is not the one signed, a missing Rekor entry, an identity other than
#     the tagged release workflow, or a digest that disagrees with the
#     reproducible-build attestation is a hard error, never a warning.

. "$(dirname "${BASH_SOURCE[0]}")/attestation_lib.sh"

SST_SCHEMA="streampay.sigstore-manifest/v1"
SST_DEFAULT_WORKFLOW="release-sign.yml"
SST_DEFAULT_ISSUER="https://token.actions.githubusercontent.com"
SST_DEFAULT_REKOR="https://rekor.sigstore.dev"
# Overridable so the self-tests can inject a stub that rejects exactly what the
# real binary rejects; a verifier that cannot be exercised offline is untested.
SST_COSIGN="${SIGSTORE_COSIGN:-cosign}"

# The certificate identity a GitHub Actions keyless signature carries:
#   https://github.com/<owner>/<repo>/.github/workflows/<workflow>@<ref>
# `ref` is the tag ref for a tag-triggered release, so the identity IS the
# release: a signature from the same workflow on another tag or branch cannot
# satisfy it.
sst_identity() {
  local repo="$1" workflow="$2" tag="$3"
  printf 'https://github.com/%s/.github/workflows/%s@refs/tags/%s' \
    "$repo" "$workflow" "$tag"
}

# Resolve the signing identity token from GitHub's OIDC workload-identity
# endpoint. This is the whole keyless story: the token is minted per run, bound
# to this repository/workflow/ref, and expires in minutes.
# Prefers SIGSTORE_ID_TOKEN (cosign's own convention) when a caller passes one.
sst_oidc_token() {
  if [ -n "${SIGSTORE_ID_TOKEN:-}" ]; then
    printf '%s' "$SIGSTORE_ID_TOKEN"
    return 0
  fi
  [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || return 1
  [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || return 1
  local raw value
  raw="$(curl -fsS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sigstore" 2>/dev/null)" || return 1
  # {"count":1,"value":"<jwt>"} — no jq on a signing runner by default.
  value="$(printf '%s' "$raw" |
    sed -nE 's/.*"value"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# --- manifest readers -------------------------------------------------------
# The manifest's artifact entries are one JSON object per line, so the entry for
# a digest is the unique line carrying that digest.
sst_manifest_entry() {
  local manifest="$1" digest="$2"
  [ -f "$manifest" ] || return 1
  grep -F "\"sha256\":\"$digest\"" "$manifest" | head -n1 || true
}

# Read a string field from one line (or the whole document for top-level keys).
# The trailing `.*` is greedy on purpose: every field name in the manifest is
# unique per line, so last-match == only-match, and no jq is required.
sst_json_field() {
  local text="$1" key="$2"
  printf '%s' "$text" |
    sed -nE "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" |
    head -n1
}

# Read a numeric field. Accepts both shapes a number can arrive in: the manifest
# writes `logIndex` unquoted, while a cosign bundle's protojson encodes int64
# fields as strings ("logIndex":"42").
sst_json_number() {
  local text="$1" key="$2"
  printf '%s' "$text" |
    sed -nE "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"?([0-9]+)\"?.*/\\1/p" |
    head -n1
}

# --- Rekor ------------------------------------------------------------------
# A cosign sigstore bundle carries the transparency-log entry the signer
# recorded. cosign verifies the inclusion proof and the signed entry timestamp
# during `verify-blob --bundle`; the gate additionally requires the entry to be
# present and to match what the manifest published, so a bundle that carries a
# signature but no log entry cannot pass as "transparency-logged".
sst_bundle_text() {
  [ -f "$1" ] || return 1
  tr -d '\n\r' < "$1"
}

sst_bundle_log_index() {
  local text
  text="$(sst_bundle_text "$1")" || return 1
  [ -n "$text" ] || return 1
  sst_json_number "$text" logIndex
}

sst_bundle_integrated_time() {
  local text
  text="$(sst_bundle_text "$1")" || return 1
  [ -n "$text" ] || return 1
  sst_json_number "$text" integratedTime
}

# --- certificate ------------------------------------------------------------
# The leaf (Fulcio) certificate carried by a cosign v3 bundle, as PEM.
#
# cosign v3 removed `sign-blob --output-certificate`: the bundle is the only
# output, and it holds the certificate as verificationMaterial.certificate
# .rawBytes (base64 DER). Deriving the published `.pem` from the bundle keeps
# the two files describing the same signature by construction; deriving it also
# fails closed, so a bundle without a certificate can never yield an empty one.
#
# With a second argument the PEM is written there; without one it goes to
# stdout, which is what the verifier uses to compare against a published file.
sst_bundle_certificate() {
  local bundle="$1" target="${2:-}" text encoded
  text="$(sst_bundle_text "$bundle")" || return 1
  [ -n "$text" ] || return 1
  encoded="$(printf '%s' "$text" |
    sed -nE 's/.*"certificate"[[:space:]]*:[[:space:]]*\{[^}]*"rawBytes"[[:space:]]*:[[:space:]]*"([A-Za-z0-9+/=]+)".*/\1/p' |
    head -n1)"
  [ -n "$encoded" ] || return 1
  if [ -n "$target" ]; then
    {
      printf -- '-----BEGIN CERTIFICATE-----\n'
      printf '%s' "$encoded" | fold -w 64
      printf -- '\n-----END CERTIFICATE-----\n'
    } > "$target" || return 1
    [ -s "$target" ] || return 1
  else
    printf -- '-----BEGIN CERTIFICATE-----\n'
    printf '%s' "$encoded" | fold -w 64
    printf -- '\n-----END CERTIFICATE-----\n'
  fi
}
