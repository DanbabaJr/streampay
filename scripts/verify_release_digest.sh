#!/usr/bin/env bash
# Digest continuity: verify a locally built Wasm byte-for-byte against the
# SHA-256 published by the release workflow — never against another local
# build. Every promotion step calls this, so "the artifact we tested is the
# artifact we ship" stays checkable even though a public chain cannot un-deploy.
#
# Usage:
#   scripts/verify_release_digest.sh <tag> <wasm>                 # downloads the release asset
#   scripts/verify_release_digest.sh --expected-file <SUMS> <wasm> # offline / rehearsal
#
# Exit status is non-zero on any mismatch.
. "$(dirname "$0")/lib.sh"

mode="release"
tag=""
if [ "${1:-}" = "--expected-file" ]; then
  mode="file"
  expected_file="${2:?usage: verify_release_digest.sh --expected-file <SHA256SUMS> <wasm>}"
  wasm="${3:?usage: verify_release_digest.sh --expected-file <SHA256SUMS> <wasm>}"
else
  tag="${1:?usage: verify_release_digest.sh <tag> <wasm>}"
  wasm="${2:?usage: verify_release_digest.sh <tag> <wasm>}"
fi
[ -f "$wasm" ] || die "wasm not found: $wasm"

if [ "$mode" = "release" ]; then
  require gh
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "Downloading published digest for release $tag"
  gh release download "$tag" --pattern 'SHA256SUMS' --dir "$tmp" \
    || die "release $tag has no SHA256SUMS asset — was it published by release.yml?"
  expected_file="$tmp/SHA256SUMS"
fi

expected="$(awk 'NF >= 1 { print $1; exit }' "$expected_file")"
[ -n "$expected" ] || die "no digest found in $expected_file"
actual="$(sha256sum "$wasm" | awk '{print $1}')"

info "expected (published):  $expected"
info "actual   (local build): $actual"
[ "$expected" = "$actual" ] \
  || die "digest mismatch — the local build is NOT the published artifact"
echo "digest-continuity: OK ($actual)"
