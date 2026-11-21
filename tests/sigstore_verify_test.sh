#!/usr/bin/env bash
# Self-tests for the Sigstore keyless verification gate (issue #611).
#
# The point of this file is that the gate cannot be green forever: it feeds the
# verifier a signed release, then breaks exactly one control at a time and
# requires the gate to reject it.
#
#   * a tampered artifact (bytes changed after signing)
#   * a wrong certificate identity (another workflow, another tag)
#   * a wrong OIDC issuer
#   * a missing Rekor transparency-log entry (signature but no inclusion proof)
#   * a manifest whose Rekor log index disagrees with the bundle's entry
#   * a Wasm that does not match the reproducible-build attestation
#   * a release with no attestation at all
#   * a digest that disagrees with the published SHA256SUMS
#
# No cosign and no network are required: SIGSTORE_COSIGN points at a stub that
# enforces the same four things the real binary enforces — bundle present, tlog
# entry present, exact certificate identity, issuer, and the artifact digest —
# so what these tests exercise is this repository's policy, not cosign's.
#
# Usage: bash tests/sigstore_verify_test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
. "$repo_root/scripts/attestation_lib.sh"
set +e

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0

expect() {
  local want="$1" desc="$2"
  shift 2
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$want" = "ok" ] && [ "$rc" -eq 0 ]; then
    printf 'ok    %s\n' "$desc"
    passed=$((passed + 1))
  elif [ "$want" = "fail" ] && [ "$rc" -ne 0 ]; then
    printf 'ok    %s (rejected)\n' "$desc"
    passed=$((passed + 1))
  else
    printf 'FAIL  %s (expected %s, got rc=%s)\n' "$desc" "$want" "$rc"
    printf '      %s\n' "$out" | head -n 8
    failed=$((failed + 1))
  fi
}

# ── fixtures ────────────────────────────────────────────────────────────────
tag="v1.2.3"
repo="Neziahtech/streampay"
workflow="release-sign.yml"
issuer="https://token.actions.githubusercontent.com"
identity="https://github.com/$repo/.github/workflows/$workflow@refs/tags/$tag"

rel="$tmp/release"
mkdir -p "$rel"

wasm="$rel/streampay_contract.wasm"
printf 'this stands in for the built contract wasm\n' > "$wasm"
wasm_sha="$(att_sha256 "$wasm")"

metadata="$rel/release-metadata.json"
printf '{"wasm_sha256":"%s"}\n' "$wasm_sha" > "$metadata"

printf '%s  target/wasm32v1-none/release/streampay_contract.wasm\n' "$wasm_sha" > "$rel/SHA256SUMS"

attestation="$rel/attestation.json"
cat > "$attestation" <<EOF
{
  "schema": "streampay.attestation/v1",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "tag": "$tag",
  "timestamp": "2026-11-20T00:00:00Z",
  "wasm_sha256": "$wasm_sha",
  "reproducibility": {
    "verified": true,
    "runs": 2,
    "wasm_identical": true,
    "spec_identical": true
  }
}
EOF

# A sigstore bundle as cosign v3 writes it: `verificationMaterial.certificate
# .rawBytes` holds the base64 DER leaf certificate and the tlog entry carries
# the log index and integrated time as protojson int64 strings.
fake_cert_b64="$(printf 'stub-certificate-der' | base64 | tr -d '\n')"
write_bundle() { # path logIndex integratedTime [drop-entry]
  if [ "${4:-}" = "no-entry" ]; then
    printf '{"mediaType":"application/vnd.dev.sigstore.bundle+json;version=0.3","verificationMaterial":{"certificate":{"rawBytes":"%s"}}}\n' \
      "$fake_cert_b64" > "$1"
    return 0
  fi
  printf '{"mediaType":"application/vnd.dev.sigstore.bundle+json;version=0.3","verificationMaterial":{"certificate":{"rawBytes":"%s"},"tlogEntries":[{"logIndex":"%s","integratedTime":"%s","logId":{"keyId":"c0ffee"}}]}}\n' \
    "$fake_cert_b64" "$2" "$3" > "$1"
}
write_bundle "$rel/streampay_contract.wasm.sigstore.json" 42 1700000000

write_manifest() { # path [workflow] [ref] [logIndex] [attSha] [wasmSha]
  local path="$1" wf="${2:-$workflow}" ref="${3:-refs/tags/$tag}"
  local log_index="${4:-42}" att_sha="${5:-$(att_sha256 "$attestation")}"
  local wasm_sha_field="${6:-$wasm_sha}" clean_att="${7:-0}"
  {
    printf '{\n'
    printf '  "schema": "streampay.sigstore-manifest/v1",\n'
    printf '  "tag": "%s",\n' "$tag"
    printf '  "repository": "%s",\n' "$repo"
    printf '  "workflow": "%s",\n' "$wf"
    printf '  "ref": "%s",\n' "$ref"
    printf '  "identity": "%s",\n' "$identity"
    printf '  "issuer": "%s",\n' "$issuer"
    printf '  "rekor_url": "https://rekor.sigstore.dev",\n'
    if [ "$clean_att" = "0" ]; then
      printf '  "attestation_path": "attestations/%s/attestation.json",\n' "$tag"
      printf '  "attestation_sha256": "%s",\n' "$att_sha"
      printf '  "wasm_sha256": "%s",\n' "$wasm_sha_field"
    fi
    printf '  "artifacts": [\n'
    printf '    {"path":"streampay_contract.wasm","sha256":"%s","bundle":"streampay_contract.wasm.sigstore.json","certificate":"streampay_contract.wasm.pem","rekor":{"url":"https://rekor.sigstore.dev","logIndex":%s,"integratedTime":1700000000}}\n' "$wasm_sha" "$log_index"
    printf '  ],\n'
    printf '  "images": [\n  ]\n'
    printf '}\n'
  } > "$path"
}
manifest="$rel/sigstore-manifest.json"
write_manifest "$manifest"

# ── the cosign stub ─────────────────────────────────────────────────────────
# The stub is deliberately strict about flags: it accepts exactly the flags
# cosign v3.1.3 has and exits 2 on anything else, so re-adding
# `--output-certificate` or `--rekor-url` fails here rather than at release time.
cat > "$tmp/cosign" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${COSIGN_ARGV_LOG:-/dev/null}"
sub="${1:-}"
case "$sub" in
  verify) exit 0 ;;
  verify-blob|sign-blob) shift ;;
  *) { echo "stub: unsupported subcommand $sub" >&2; exit 2; } ;;
esac

if [ "$sub" = "sign-blob" ]; then
  artifact="" bundle=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --bundle) bundle="${2:-}"; shift 2 || shift ;;
      --identity-token)
        [ -n "${2:-}" ] || { echo "stub: empty --identity-token" >&2; exit 2; }
        shift 2 || shift ;;
      --yes|--use-signing-config) shift ;;
      -*) { echo "stub: cosign v3 sign-blob has no flag $1" >&2; exit 2; } ;;
      *)
        [ -z "$artifact" ] || { echo "stub: unexpected argument $1" >&2; exit 2; }
        artifact="$1"; shift ;;
    esac
  done
  [ -n "$artifact" ] && [ -f "$artifact" ] || { echo "stub: no artifact to sign" >&2; exit 2; }
  [ -n "$bundle" ] || { echo "stub: sign-blob without --bundle" >&2; exit 2; }
  # base64 of some DER-ish bytes: enough to prove the PEM is derived from the
  # bundle rather than written from somewhere else.
  cert_b64="$(printf 'stub-certificate-der' | base64 | tr -d '\n')"
  if [ "${FIXTURE_NO_TLOG:-0}" = "1" ]; then
    printf '{"mediaType":"application/vnd.dev.sigstore.bundle+json;version=0.3","verificationMaterial":{"certificate":{"rawBytes":"%s"}}}\n' \
      "$cert_b64" > "$bundle"
  else
    printf '{"mediaType":"application/vnd.dev.sigstore.bundle+json;version=0.3","verificationMaterial":{"certificate":{"rawBytes":"%s"},"tlogEntries":[{"logIndex":"42","integratedTime":"1700000000","logId":{"keyId":"c0ffee"}}]}}\n' \
      "$cert_b64" > "$bundle"
  fi
  exit 0
fi

artifact="" identity="" issuer="" bundle=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) bundle="${2:-}"; shift 2 || shift ;;
    --certificate-identity) identity="${2:-}"; shift 2 || shift ;;
    --certificate-oidc-issuer) issuer="${2:-}"; shift 2 || shift ;;
    --trusted-root) shift 2 || shift ;;
    -*) { echo "stub: cosign v3 verify-blob has no flag $1" >&2; exit 2; } ;;
    *) artifact="$1"; shift ;;
  esac
done
[ -n "$bundle" ] && [ -f "$bundle" ] || { echo "stub: no bundle for $artifact" >&2; exit 1; }
grep -q '"logIndex"' "$bundle" || { echo "stub: bundle has no tlog entry" >&2; exit 1; }
[ "$identity" = "${FIXTURE_IDENTITY:-}" ] || { echo "stub: certificate identity '$identity' is not '${FIXTURE_IDENTITY:-}'" >&2; exit 1; }
[ "$issuer" = "${FIXTURE_ISSUER:-}" ] || { echo "stub: issuer '$issuer' rejected" >&2; exit 1; }
digest="$(sha256sum "$artifact" 2>/dev/null | awk '{print $1}')"
[ "$digest" = "${FIXTURE_DIGEST:-}" ] || { echo "stub: blob digest does not match the signed digest" >&2; exit 1; }
exit 0
STUB
chmod +x "$tmp/cosign"

export SIGSTORE_COSIGN="$tmp/cosign"
export FIXTURE_IDENTITY="$identity"
export FIXTURE_ISSUER="$issuer"
export FIXTURE_DIGEST="$wasm_sha"
export COSIGN_ARGV_LOG="$tmp/cosign-argv.log"
: > "$COSIGN_ARGV_LOG"

verify="$repo_root/scripts/verify_sigstore.sh"
base=(bash "$verify" --tag "$tag" --repo "$repo" --manifest "$manifest")

echo "== Sigstore verification gate self-tests =="

# 1. The happy path must pass, or every rejection below proves nothing.
expect ok "a correctly signed artifact, manifest, Rekor entry and attestation verify" \
  "${base[@]}" --artifact "$wasm" --attestation "$attestation" --sha256sums "$rel/SHA256SUMS"

# 2. The certificate identity cosign is asked to prove is exactly this repo's
#    release workflow at this tag — the pin, not a loose regexp.
if grep -Fq -- "--certificate-identity $identity" "$COSIGN_ARGV_LOG"; then
  printf 'ok    cosign was asked for the exact tag-pinned identity\n'
  passed=$((passed + 1))
else
  printf 'FAIL  cosign was not asked for the exact tag-pinned identity\n'
  failed=$((failed + 1))
fi

# 3. The advertised identity is the one the policy expects (docs + tests agree).
printed="$(bash "$verify" --tag "$tag" --repo "$repo" --print-identity 2>&1)"
if [ "$printed" = "$identity" ]; then
  printf 'ok    --print-identity documents the tag-pinned identity\n'
  passed=$((passed + 1))
else
  printf 'FAIL  --print-identity printed %s\n' "$printed"
  failed=$((failed + 1))
fi

# 4. Tampered artifact: one appended byte, same name.
cp "$wasm" "$tmp/tampered.wasm"
printf 'x' >> "$tmp/tampered.wasm"
expect fail "a tampered artifact is rejected" \
  "${base[@]}" --artifact "$tmp/tampered.wasm" --attestation "$attestation"

# 5. Wrong identity: a manifest signed by another workflow.
write_manifest "$tmp/manifest-evil-workflow.json" "release.yml"
expect fail "a manifest from another workflow is rejected" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$tmp/manifest-evil-workflow.json" \
    --artifact "$wasm" --attestation "$attestation"

# 6. Wrong ref: same workflow on a branch instead of the release tag.
write_manifest "$tmp/manifest-branch.json" "$workflow" "refs/heads/main"
expect fail "a manifest bound to a branch ref is rejected" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$tmp/manifest-branch.json" \
    --artifact "$wasm" --attestation "$attestation"

# 7. Wrong certificate identity at cosign: the stub rejects the same way cosign
#    would for a signature minted on another tag.
expect fail "a signature from another tag's identity is rejected" \
  env FIXTURE_IDENTITY="https://github.com/$repo/.github/workflows/$workflow@refs/tags/v0.0.1" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$manifest" \
    --artifact "$wasm" --attestation "$attestation"

# 8. Wrong issuer at cosign.
expect fail "a signature from a different OIDC issuer is rejected" \
  env FIXTURE_ISSUER="https://accounts.example.com" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$manifest" \
    --artifact "$wasm" --attestation "$attestation"

# 9. Signature present but no transparency-log entry.
cp "$rel/streampay_contract.wasm.sigstore.json" "$tmp/bundle-with-entry.json"
write_bundle "$rel/streampay_contract.wasm.sigstore.json" 42 1700000000 no-entry
expect fail "a bundle without a Rekor entry is rejected" \
  "${base[@]}" --artifact "$wasm" --attestation "$attestation"
cp "$tmp/bundle-with-entry.json" "$rel/streampay_contract.wasm.sigstore.json"

# 10. Rekor log index in the manifest disagrees with the bundle.
write_manifest "$tmp/manifest-logindex.json" "$workflow" "refs/tags/$tag" 43
expect fail "a Rekor log index that disagrees with the bundle is rejected" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$tmp/manifest-logindex.json" \
    --artifact "$wasm" --attestation "$attestation"

# 11. Wasm digest differs from the reproducible-build attestation.
cat > "$tmp/attestation-other-build.json" <<EOF
{"tag":"$tag","wasm_sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}
EOF
write_manifest "$tmp/manifest-clean-att.json" "$workflow" "refs/tags/$tag" 42 "" "" 1
expect fail "a Wasm that does not match the reproducibility attestation is rejected" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$tmp/manifest-clean-att.json" \
    --artifact "$wasm" --attestation "$tmp/attestation-other-build.json"

# 12. The manifest's recorded attestation digest must be the attestation used.
expect fail "an attestation that is not the one the manifest recorded is rejected" \
  "${base[@]}" --artifact "$wasm" --attestation "$tmp/attestation-other-build.json"

# 13. A Wasm without its attestation is not verifiable at all.
expect fail "a Wasm with --require-attestation and no attestation is rejected" \
  "${base[@]}" --artifact "$wasm" --require-attestation
expect fail "a Wasm verified without any attestation is rejected" \
  "${base[@]}" --artifact "$wasm"

# 14. Digest drift against the published SHA256SUMS.
printf '%s  target/wasm32v1-none/release/streampay_contract.wasm\n' \
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" > "$tmp/SHA256SUMS.drift"
expect fail "a digest that disagrees with the published SHA256SUMS is rejected" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$manifest" \
    --artifact "$wasm" --attestation "$attestation" --sha256sums "$tmp/SHA256SUMS.drift"

# 15. The signing side, against the same strict stub: cosign v3 sign-blob takes
#     `--bundle` and `--identity-token`, the bundle is the only output, and the
#     published certificate is derived from it.
sign_out="$tmp/sign"
sign_args=(bash "$repo_root/scripts/sigstore_sign.sh" --tag "$tag" --repo "$repo"
  --workflow "$workflow" --out "$sign_out" --artifact "$wasm")
expect ok "sigstore_sign.sh signs with cosign v3 flags only" \
  env SIGSTORE_ID_TOKEN=stub-token "${sign_args[@]}"

signed_bundle="$sign_out/streampay_contract.wasm.sigstore.json"
signed_pem="$sign_out/streampay_contract.wasm.pem"
check_signing_output() {
  [ -f "$signed_bundle" ] || return 1
  grep -q '"logIndex"' "$signed_bundle" || return 1
  [ -f "$signed_pem" ] || return 1
  [ "$(head -n1 "$signed_pem")" = "-----BEGIN CERTIFICATE-----" ] || return 1
  [ "$(tail -n1 "$signed_pem")" = "-----END CERTIFICATE-----" ] || return 1
  local body decoded
  body="$(sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' "$signed_pem" |
    grep -v -- '-----' | tr -d '\n')"
  decoded="$(printf '%s' "$body" | base64 -d 2>/dev/null)" || return 1
  [ "$decoded" = "stub-certificate-der" ] || return 1
  grep -q '"logIndex":42' "$sign_out/sigstore-manifest.json" || return 1
}
if check_signing_output; then
  printf 'ok    the published .pem is the certificate carried by the bundle\n'
  passed=$((passed + 1))
else
  printf 'FAIL  signing did not produce a bundle-backed certificate and manifest\n'
  sed -n '1,5p' "$signed_pem" 2>/dev/null
  failed=$((failed + 1))
fi

# 16. A bundle with a signature but no log entry is a signing failure, not a
#     signed artifact: the manifest would otherwise publish `logIndex: 0`.
expect fail "signing refuses a bundle with no transparency-log entry" \
  env SIGSTORE_ID_TOKEN=stub-token FIXTURE_NO_TLOG=1 \
  bash "$repo_root/scripts/sigstore_sign.sh" --tag "$tag" --repo "$repo" \
    --workflow "$workflow" --out "$tmp/sign-no-tlog" --artifact "$wasm"

# 17. The printed commands are what a human copies onto a signing host, so they
#     must not contain flags cosign v3 rejects.
printed_sign="$(SIGSTORE_ID_TOKEN=stub-token bash "$repo_root/scripts/sigstore_sign.sh" \
  --tag "$tag" --repo "$repo" --workflow "$workflow" --out "$tmp/sign-print" \
  --artifact "$wasm" --print-only 2>&1)"
case "$printed_sign" in
  *--output-certificate*|*--rekor-url*)
    printf 'FAIL  --print-only emits a cosign flag v3 does not have\n'
    printf '      %s\n' "$printed_sign"
    failed=$((failed + 1))
    ;;
  *"sign-blob --yes --bundle"*)
    printf 'ok    --print-only emits only cosign v3 flags\n'
    passed=$((passed + 1))
    ;;
  *)
    printf 'FAIL  --print-only printed no sign-blob command\n'
    failed=$((failed + 1))
    ;;
esac

# 18. The published `.pem` and the bundle must carry the same certificate: two
#     files in one release that disagree mean one of them is not evidence.
write_bundle "$rel/streampay_contract.wasm.sigstore.json" 42 1700000000
write_bundle "$rel/streampay_contract.wasm.sigstore.json" 42 1700000000
printf -- '-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n' \
  "$fake_cert_b64" > "$rel/streampay_contract.wasm.pem"
expect ok "a published .pem that matches the bundle is accepted" \
  "${base[@]}" --artifact "$wasm" --attestation "$attestation"
printf -- '-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n' \
  "$(printf 'other-certificate' | base64 | tr -d '\n')" > "$rel/streampay_contract.wasm.pem"
expect fail "a published .pem from a different certificate is rejected" \
  "${base[@]}" --artifact "$wasm" --attestation "$attestation"
rm -f "$rel/streampay_contract.wasm.pem"

# 19. The manifest records which Rekor instance the entry belongs to; a release
#     claiming a different log is not this verification's release.
expect fail "a manifest recorded against another Rekor instance is rejected" \
  bash "$verify" --tag "$tag" --repo "$repo" --manifest "$manifest" \
    --artifact "$wasm" --attestation "$attestation" \
    --rekor-url "https://rekor.internal.example"

echo
echo "passed: $passed  failed: $failed"
[ "$failed" -eq 0 ] || exit 1
echo "sigstore verification gate: all self-tests passed"
