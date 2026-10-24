#!/usr/bin/env bash
# Tamper audit for the release-attestation chain.
#
# Every control in verify_wasm.sh is asserted by breaking it: a flipped byte in
# the Wasm, a forged payload, a corrupted signature, a swapped public key, the
# wrong tag. A verifier that has never been shown a tampered artifact is not a
# verifier, it is a hope.
#
# Runs entirely in a throwaway sandbox that imitates a repository root, so it
# needs no network, no stellar-cli, no Docker and no real signing key — only
# bash, openssl and coreutils. CI runs it on every pull request.
#
# Usage: tests/attestation_tamper_audit.sh
set -euo pipefail

REAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

for t in openssl sha256sum dd od sed awk; do
  command -v "$t" >/dev/null 2>&1 || { echo "SKIP: $t not available" >&2; exit 0; }
done

# ------------------------------------------------------------ sandbox "repo"
mkdir -p "$sandbox/scripts" "$sandbox/attestations" \
         "$sandbox/target/wasm32v1-none/release"
cp "$REAL_ROOT/scripts/lib.sh" \
   "$REAL_ROOT/scripts/attestation_lib.sh" \
   "$REAL_ROOT/scripts/attest.sh" \
   "$REAL_ROOT/scripts/verify_wasm.sh" "$sandbox/scripts/"
cp "$REAL_ROOT/rust-toolchain.toml" "$sandbox/"

VERIFY=(bash "$sandbox/scripts/verify_wasm.sh")
WASM_REL="target/wasm32v1-none/release/streampay_contract.wasm"
wasm="$sandbox/$WASM_REL"
att_dir="$sandbox/attestations/vtest"
payload="$att_dir/attestation.json"
sig="$att_dir/attestation.json.sig"

openssl genpkey -algorithm ED25519 -out "$sandbox/release.key" 2>/dev/null
openssl pkey -in "$sandbox/release.key" -pubout -out "$sandbox/attestations/signing-key.pub"
release_fp="$(openssl pkey -pubin -in "$sandbox/attestations/signing-key.pub" -outform DER \
  | sha256sum | awk '{print $1}')"

head -c 4096 /dev/urandom > "$wasm"

ATTESTATION_SIGNING_KEY="$sandbox/release.key" \
ATTEST_COMMIT="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
ATTEST_TIMESTAMP="2026-01-01T00:00:00Z" \
ATTEST_WORKFLOW="tamper-audit" \
  bash "$sandbox/scripts/attest.sh" --tag vtest --wasm "$wasm" >"$sandbox/attest.log" 2>&1 \
  || { echo "attest.sh failed to produce a baseline attestation:" >&2; cat "$sandbox/attest.log" >&2; exit 1; }

cp "$wasm" "$sandbox/wasm.pristine"
cp "$payload" "$sandbox/payload.pristine"
cp "$sig" "$sandbox/sig.pristine"
cp "$sandbox/attestations/signing-key.pub" "$sandbox/pubkey.pristine"
restore() {
  cp "$sandbox/wasm.pristine" "$wasm"
  cp "$sandbox/payload.pristine" "$payload"
  cp "$sandbox/sig.pristine" "$sig"
  cp "$sandbox/pubkey.pristine" "$sandbox/attestations/signing-key.pub"
}

# ------------------------------------------------------------- assert helpers
passed=0 failed=0 last_out="$sandbox/.out"
run() { set +e; "$@" >"$last_out" 2>&1; rc=$?; set -e; }
ok()  { passed=$((passed + 1)); printf '  \033[1;32mPASS\033[0m  %s\n' "$1"; }
bad() {
  failed=$((failed + 1))
  printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"
  sed 's/^/          | /' "$last_out" >&2
}
expect_ok() {
  local desc="$1"; shift; restore; run "$@"
  if [ "$rc" -eq 0 ]; then ok "$desc"; else bad "$desc — expected exit 0, got $rc"; fi
}
expect_fail() {
  local desc="$1" pattern="$2"; shift 2; restore; run "$@"
  if [ "$rc" -eq 0 ]; then
    bad "$desc — expected failure, but verification PASSED"
  elif ! grep -q "$pattern" "$last_out"; then
    bad "$desc — failed, but not with '$pattern'"
  else
    ok "$desc"
  fi
}

# Flip one byte in place, deterministically, without shell-quoting a NUL.
flip_byte() {
  local f="$1" off="${2:-1024}" cur new
  cur="$(dd if="$f" bs=1 skip="$off" count=1 status=none | od -An -tu1 | tr -d ' \n')"
  new=$(( (cur + 1) % 256 ))
  printf "\\$(printf '%03o' "$new")" \
    | dd of="$f" bs=1 seek="$off" count=1 conv=notrunc status=none
}

printf '\n\033[1;36m==> Attestation tamper audit\033[0m\n'
printf '    signing key fingerprint: sha256:%s\n\n' "$release_fp"

# ------------------------------------------------------- the honest baseline
expect_ok "untampered Wasm verifies against its attestation" \
  "${VERIFY[@]}" "$wasm" --tag vtest --offline

expect_ok "verifies with the key fingerprint pinned out of band" \
  "${VERIFY[@]}" "$wasm" --tag vtest --offline --fingerprint "sha256:$release_fp"

expect_ok "verifies when the attested commit is asserted" \
  "${VERIFY[@]}" "$wasm" --tag vtest --offline \
  --expect-commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef

expect_ok "resolves the artifact from the default build path" \
  bash -c "cd '$sandbox' && '${VERIFY[1]}' --tag vtest --offline"

# ------------------------------------------------------------- tamper: Wasm
restore
flip_byte "$wasm" 1024
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ] && grep -q "DIGEST MISMATCH" "$last_out"; then
  ok "flipped byte at offset 1024 fails with DIGEST MISMATCH"
else
  bad "flipped byte at offset 1024 was not caught (rc=$rc)"
fi

restore
flip_byte "$wasm" 0
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ]; then ok "flipped byte at offset 0 (Wasm magic) fails"; else bad "flipped magic byte passed"; fi

restore
flip_byte "$wasm" 4095
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ]; then ok "flipped last byte fails"; else bad "flipped last byte passed"; fi

# ------------------------------------------------- tamper: forged payload
restore
flip_byte "$wasm" 1024
forged_sha="$(sha256sum "$wasm" | awk '{print $1}')"
sed "s/\"wasm_sha256\": \"[0-9a-f]\{64\}\"/\"wasm_sha256\": \"$forged_sha\"/" \
  "$payload" > "$sandbox/forged.json"
cp "$sandbox/forged.json" "$payload"
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ] && grep -q "signature does NOT verify" "$last_out"; then
  ok "payload re-hashed to match a tampered Wasm fails signature verification"
else
  bad "forged payload was accepted (rc=$rc) — the digest is not covered by the signature"
fi

restore
sed 's/"commit": "[0-9a-f]*"/"commit": "0000000000000000000000000000000000000000"/' \
  "$payload" > "$sandbox/forged2.json"
cp "$sandbox/forged2.json" "$payload"
run "${VERIFY[@]}" "$wasm" --tag vtest --offline \
  --expect-commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
if [ "$rc" -ne 0 ] && grep -q "signature does NOT verify" "$last_out"; then
  ok "rewriting the attested commit fails signature verification"
else
  bad "commit rewrite was accepted (rc=$rc)"
fi

# ------------------------------------------------- tamper: the signature
restore
first_char="$(head -c 1 "$sig")"
replacement=$([ "$first_char" = "A" ] && echo B || echo A)
{ printf '%s' "$replacement"; tail -c +2 "$sig"; } > "$sandbox/badsig"
cp "$sandbox/badsig" "$sig"
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ] && grep -q "signature does NOT verify" "$last_out"; then
  ok "a corrupted signature is rejected"
else
  bad "corrupted signature was accepted (rc=$rc)"
fi

restore
head -c 40 "$sig" > "$sandbox/truncsig"
cp "$sandbox/truncsig" "$sig"
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ]; then ok "a truncated signature is rejected"; else bad "truncated signature was accepted"; fi

restore
rm -f "$sig"
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ] && grep -q "detached signature not found" "$last_out"; then
  ok "a missing signature is rejected (no fail-open)"
else
  bad "missing signature was accepted (rc=$rc)"
fi

# ------------------------------------------------- tamper: wrong binding
expect_fail "an attestation for another tag is rejected" "wrong release" \
  "${VERIFY[@]}" "$wasm" --tag v9.9.9 --attestation "$att_dir"

expect_fail "an attestation naming a different commit is rejected" "you expected" \
  "${VERIFY[@]}" "$wasm" --tag vtest --offline \
  --expect-commit ffffffffffffffffffffffffffffffffffffffff

expect_fail "--require-repro rejects an attestation without a passing double build" "require-repro" \
  "${VERIFY[@]}" "$wasm" --tag vtest --offline --require-repro

# ------------------------------------------------- tamper: key substitution
# The documented limit of an in-repo trust anchor: whoever controls the checkout
# controls the pinned key. Re-signing with an attacker key passes verification
# unless the deployer pins the fingerprint they were told out of band.
restore
openssl genpkey -algorithm ED25519 -out "$sandbox/attacker.key" 2>/dev/null
openssl pkey -in "$sandbox/attacker.key" -pubout -out "$sandbox/attestations/signing-key.pub"
flip_byte "$wasm" 1024
ATTESTATION_SIGNING_KEY="$sandbox/attacker.key" \
ATTEST_COMMIT="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
ATTEST_TIMESTAMP="2026-01-01T00:00:00Z" \
  bash "$sandbox/scripts/attest.sh" --tag vtest --wasm "$wasm" --out "$att_dir" >/dev/null 2>&1

run "${VERIFY[@]}" "$wasm" --tag vtest --offline --fingerprint "sha256:$release_fp"
if [ "$rc" -ne 0 ] && grep -q "key substitution" "$last_out"; then
  ok "a swapped signing key is caught by an out-of-band fingerprint pin"
else
  bad "key substitution was not caught by the fingerprint pin (rc=$rc)"
fi

run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -eq 0 ]; then
  ok "without a fingerprint pin, a swapped key is NOT caught (documented limit)"
else
  bad "expected the unpinned path to pass, documenting the limit (rc=$rc)"
fi

# ------------------------------------------------- tamper: no trust anchor
restore
rm -f "$sandbox/attestations/signing-key.pub"
run "${VERIFY[@]}" "$wasm" --tag vtest --offline
if [ "$rc" -ne 0 ] && grep -q "no pinned public key" "$last_out"; then
  ok "verification refuses to run with no pinned public key"
else
  bad "verification ran without a trust anchor (rc=$rc)"
fi
restore

printf '\n  %s passed, %s failed\n\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
