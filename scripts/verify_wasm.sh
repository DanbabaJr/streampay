#!/usr/bin/env bash
# verify_wasm.sh — prove a contract Wasm before you deploy it.
#
# Recomputes the digest of the Wasm you are about to deploy, fetches the signed
# attestation for the release, verifies the Ed25519 signature against the
# public key pinned in THIS checkout, and checks that the signed payload names
# the bytes you actually hold. Any failure exits non-zero with a report saying
# which link of the chain broke.
#
# The trust anchor is attestations/signing-key.pub from your own checkout, never
# something downloaded alongside the artifact: an attacker who can rewrite the
# release could otherwise hand you their own key. Pin its fingerprint out of
# band (--fingerprint, or ATTESTATION_KEY_FINGERPRINT) to close that gap.
#
# Usage:
#   scripts/verify_wasm.sh                                  # local build, latest release
#   scripts/verify_wasm.sh path/to.wasm --tag v0.5.0
#   scripts/verify_wasm.sh --attestation attestations/v0.5.0 --offline
#   scripts/verify_wasm.sh --fingerprint sha256:<hex> --require-repro
#
# Options:
#   --tag <tag>              release tag (default: the latest published release)
#   --attestation <dir|json> use a local payload+signature instead of fetching
#   --offline                never touch the network
#   --fingerprint sha256:H   require the pinned public key to have this fingerprint
#   --expect-commit <sha>    require the attestation to name this commit
#   --require-repro          require reproducibility.verified == true in the payload
#
# Environment:
#   GITHUB_REPOSITORY              owner/repo (default: Neziahtech/streampay)
#   ATTESTATION_PUBKEY             path to an out-of-band public key
#   ATTESTATION_KEY_FINGERPRINT    same as --fingerprint
#
# Exit status: 0 only when every link of the chain held.
. "$(dirname "$0")/attestation_lib.sh"

wasm="" tag="" local_att="" offline=0
want_fingerprint="${ATTESTATION_KEY_FINGERPRINT:-}"
expect_commit="" require_repro=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)          tag="${2:?--tag requires a value}"; shift 2 ;;
    --attestation)  local_att="${2:?--attestation requires a dir or file}"; shift 2 ;;
    --offline)      offline=1; shift ;;
    --fingerprint)  want_fingerprint="${2:?--fingerprint requires sha256:<hex>}"; shift 2 ;;
    --expect-commit) expect_commit="${2:?--expect-commit requires a sha}"; shift 2 ;;
    --require-repro) require_repro=1; shift ;;
    -h|--help)      sed -n '2,38p' "$0"; exit 0 ;;
    -*)             die "unknown option: $1" ;;
    *)              wasm="${wasm:-$1}"; shift ;;
  esac
done

repo="${GITHUB_REPOSITORY:-Neziahtech/streampay}"
wasm="${wasm:-$REPO_ROOT/$WASM_REL}"
failures=""
note() { info "$*"; }
fail() { failures="${failures}
  - $*"; }

say "StreamPay Wasm attestation check"
[ -f "$wasm" ] || die "wasm not found: $wasm
  Build it first (stellar contract build in contracts/streaming-payments) or
  pass the path to the artifact you intend to deploy."

# ------------------------------------------------------- 1. recompute the digest
actual_sha="$(att_sha256 "$wasm")"
actual_size="$(wc -c < "$wasm" | tr -d ' ')"
note "artifact : ${wasm#"$REPO_ROOT"/}"
note "sha256   : $actual_sha ($actual_size bytes)"

# ------------------------------------------------------- 2. the pinned verifier key
pubkey_candidates=()
if [ -n "${ATTESTATION_PUBKEY:-}" ]; then
  [ -f "$ATTESTATION_PUBKEY" ] || die "ATTESTATION_PUBKEY not readable: $ATTESTATION_PUBKEY"
  pubkey_candidates+=("$ATTESTATION_PUBKEY")
else
  [ -f "$REPO_ROOT/$ATT_PUBKEY_REL" ] && pubkey_candidates+=("$REPO_ROOT/$ATT_PUBKEY_REL")
  if [ -d "$REPO_ROOT/$ATT_KEYS_DIR_REL" ]; then
    while IFS= read -r k; do pubkey_candidates+=("$k"); done \
      < <(find "$REPO_ROOT/$ATT_KEYS_DIR_REL" -name '*.pub' -type f 2>/dev/null | sort)
  fi
fi
[ "${#pubkey_candidates[@]}" -gt 0 ] || die \
  "no pinned public key found at $ATT_PUBKEY_REL.
  This checkout cannot verify anything. Either you are on a commit that
  predates the attestation chain, or the key was removed — check
  'git log -- $ATT_PUBKEY_REL' and compare its fingerprint against the one
  published in the release notes before trusting a replacement."

# ------------------------------------------------------- 3. locate the attestation
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
payload="" sig="" att_source=""

if [ -n "$local_att" ]; then
  if [ -d "$local_att" ]; then
    payload="$local_att/$ATT_PAYLOAD_NAME"; sig="$local_att/$ATT_SIG_NAME"
  else
    payload="$local_att"; sig="${local_att}.sig"
  fi
  att_source="local: ${local_att#"$REPO_ROOT"/}"
  [ -f "$payload" ] || die "attestation payload not found: $payload"
  [ -f "$sig" ] || die "detached signature not found: $sig (expected it beside $payload)"
else
  inrepo="$REPO_ROOT/$ATT_DIR_REL/${tag:-}"
  if [ -n "$tag" ] && [ -f "$inrepo/$ATT_PAYLOAD_NAME" ]; then
    payload="$inrepo/$ATT_PAYLOAD_NAME"; sig="$inrepo/$ATT_SIG_NAME"
    att_source="in-repo: $ATT_DIR_REL/$tag"
  elif [ "$offline" = 1 ]; then
    [ -n "$tag" ] || die "--offline needs --tag (or --attestation) to know which in-repo attestation to read"
    die "no attestation for $tag in $ATT_DIR_REL/ and --offline forbids fetching the release asset"
  else
    require curl
    if [ -z "$tag" ]; then
      say "Resolving the latest release"
      if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        tag="$(gh release view --repo "$repo" --json tagName -q .tagName 2>/dev/null || true)"
      fi
      if [ -z "$tag" ]; then
        tag="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" \
          | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
      fi
      [ -n "$tag" ] || die "could not determine the latest release tag for $repo"
      note "latest release: $tag"
    fi

    say "Fetching the attestation for $tag"
    base="https://github.com/$repo/releases/download/$tag"
    got=1
    curl -fsSL "$base/$ATT_PAYLOAD_NAME" -o "$tmp/$ATT_PAYLOAD_NAME" || got=0
    curl -fsSL "$base/$ATT_SIG_NAME"     -o "$tmp/$ATT_SIG_NAME"     || got=0
    if [ "$got" = 1 ]; then
      payload="$tmp/$ATT_PAYLOAD_NAME"; sig="$tmp/$ATT_SIG_NAME"
      att_source="release asset: $repo@$tag"
    else
      # The release may predate the attestation chain; fall back to the mirror
      # committed at the tag, which is the same signed bytes.
      note "release $tag carries no attestation asset — trying the in-repo mirror at that tag"
      git -C "$REPO_ROOT" cat-file -e "$tag:$ATT_DIR_REL/$tag/$ATT_PAYLOAD_NAME" 2>/dev/null \
        || die "release $tag has no attestation: not a release asset, and not committed at
  $ATT_DIR_REL/$tag/. It was published before the attestation chain existed, or
  the chain was stripped. Do not deploy it without a manual digest comparison
  against the release body."
      git -C "$REPO_ROOT" show "$tag:$ATT_DIR_REL/$tag/$ATT_PAYLOAD_NAME" > "$tmp/$ATT_PAYLOAD_NAME"
      git -C "$REPO_ROOT" show "$tag:$ATT_DIR_REL/$tag/$ATT_SIG_NAME"     > "$tmp/$ATT_SIG_NAME"
      payload="$tmp/$ATT_PAYLOAD_NAME"; sig="$tmp/$ATT_SIG_NAME"
      att_source="in-repo mirror at tag $tag"
    fi
  fi
fi
[ -f "$payload" ] || die "attestation payload not found"
[ -f "$sig" ] || die "detached signature not found: $sig"
note "attestation: $att_source"

# ------------------------------------------------------- 4. parse the payload
p_schema="$(att_json_get "$payload" schema)"
p_commit="$(att_json_get "$payload" commit)"
p_tag="$(att_json_get "$payload" tag)"
p_wasm_sha="$(att_json_get "$payload" wasm_sha256)"
p_timestamp="$(att_json_get "$payload" timestamp)"
payload_sha="$(att_sha256 "$payload")"

[ "$p_schema" = "$ATT_SCHEMA" ] \
  || fail "unsupported attestation schema '$p_schema' (this verifier understands '$ATT_SCHEMA')"
[ -n "$p_wasm_sha" ] || fail "the payload carries no wasm_sha256 field"

# ------------------------------------------------------- 5. verify the signature
say "Verifying the detached Ed25519 signature"
require openssl
verified_key="" verified_fp=""
for k in "${pubkey_candidates[@]}"; do
  if att_verify_sig "$k" "$payload" "$sig"; then
    verified_key="$k"
    verified_fp="$(att_fingerprint "$k")"
    break
  fi
done

if [ -z "$verified_key" ]; then
  fail "the signature does NOT verify against any public key pinned in this checkout
       payload sha256 : $payload_sha
       signature      : ${sig##*/}
       keys tried     : ${#pubkey_candidates[@]}
    Either the payload or the signature was altered after signing, or the key
    that signed it is not the key this checkout trusts. Treat the artifact as
    untrusted until someone explains the discrepancy."
else
  note "signature  : valid (key ${verified_key#"$REPO_ROOT"/})"
  note "key sha256 : $verified_fp"
fi

if [ -n "$want_fingerprint" ]; then
  want="${want_fingerprint#sha256:}"
  if [ "$verified_fp" != "$want" ]; then
    fail "the verifying key's fingerprint is $verified_fp but you pinned sha256:$want.
    The public key in this checkout is not the one you trusted out of band —
    possible key substitution. Do not deploy."
  else
    note "fingerprint: matches your out-of-band pin"
  fi
fi

# ------------------------------------------------------- 6. bind payload to bytes
say "Binding the attestation to the artifact"
if [ -n "$p_wasm_sha" ] && [ "$p_wasm_sha" != "$actual_sha" ]; then
  fail "DIGEST MISMATCH — the signed attestation describes different bytes
       attested : $p_wasm_sha
       yours    : $actual_sha
    The Wasm you hold is not the Wasm that was built, reviewed and signed. A
    single flipped byte produces this. Do not deploy."
else
  note "digest     : matches the attested wasm_sha256"
fi

if [ -n "$tag" ] && [ -n "$p_tag" ] && [ "$p_tag" != "$tag" ]; then
  fail "the attestation is for tag '$p_tag' but you asked about '$tag' — wrong release"
fi
if [ -n "$expect_commit" ] && [ "$p_commit" != "$expect_commit" ]; then
  fail "the attestation names commit $p_commit, not the $expect_commit you expected"
fi
if [ "$require_repro" = 1 ]; then
  repro="$(att_json_bool "$payload" reproducibility verified)"
  [ "$repro" = "true" ] || fail "--require-repro: reproducibility.verified is '${repro:-absent}', not true"
fi

# ------------------------------------------------------- 7. report
toolchain_rust="$(att_json_get "$payload" toolchain.rust_channel)"
toolchain_stellar="$(att_json_get "$payload" toolchain.stellar_cli_version)"
builder_workflow="$(att_json_get "$payload" builder.workflow)"
echo
if [ -n "$failures" ]; then
  printf '\033[1;31m============================================================\033[0m\n'
  printf '\033[1;31m  ATTESTATION VERIFICATION FAILED — DO NOT DEPLOY\033[0m\n'
  printf '\033[1;31m============================================================\033[0m\n'
  printf '  artifact   : %s\n' "${wasm#"$REPO_ROOT"/}"
  printf '  sha256     : %s\n' "$actual_sha"
  printf '  attestation: %s\n' "$att_source"
  printf '\n  What broke:%s\n\n' "$failures"
  printf '  See docs/ATTESTATION.md for what each failure does and does\n'
  printf '  not imply, and how to investigate it.\n'
  exit 1
fi

printf '\033[1;32m============================================================\033[0m\n'
printf '\033[1;32m  ATTESTATION VERIFIED — this Wasm is the signed release build\033[0m\n'
printf '\033[1;32m============================================================\033[0m\n'
printf '  artifact     : %s\n' "${wasm#"$REPO_ROOT"/}"
printf '  sha256       : %s\n' "$actual_sha"
printf '  attestation  : %s\n' "$att_source"
printf '  payload      : sha256:%s\n' "$payload_sha"
printf '  signature    : valid Ed25519\n'
printf '  signing key  : sha256:%s\n' "$verified_fp"
printf '  commit       : %s\n' "$p_commit"
printf '  tag          : %s\n' "$p_tag"
printf '  built at     : %s\n' "$p_timestamp"
if [ -n "$toolchain_rust$toolchain_stellar" ]; then
  printf '  toolchain    : rust %s / stellar-cli %s\n' \
    "${toolchain_rust:-?}" "${toolchain_stellar:-?}"
fi
if [ -n "$builder_workflow" ]; then
  printf '  built by     : %s\n' "$builder_workflow"
fi
if [ "$(att_json_bool "$payload" reproducibility verified)" = "true" ]; then
  printf '  reproducible : yes (double build, wasm + spec-json identical)\n'
else
  printf '  reproducible : NOT ASSERTED in this attestation\n'
fi
printf '\n'
exit 0
