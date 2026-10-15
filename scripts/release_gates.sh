#!/usr/bin/env bash
# Sandbox gates: everything that must be green before a promotion is allowed to
# touch an environment. Produces the evidence bundle the promotion record cites.
#
# Usage: RELEASE_TAG=v0.4.0 scripts/release_gates.sh
#
# Environment:
#   RELEASE_TAG          (required) release whose published digest we verify against
#   TARGET_ENV           environment whose schema baseline we diff against (default: testnet)
#   EVIDENCE_DIR         evidence output directory (default: <repo>/evidence)
#   FUZZ_SECONDS         fuzz soak budget (default: 60)
#   EXPECTED_DIGEST_FILE alternative SHA256SUMS (rehearsal only; production uses the release)
#   ALLOW_FUZZ_SKIP=1    permit skipping the fuzz soak when the toolchain is absent
. "$(dirname "$0")/lib.sh"

: "${RELEASE_TAG:?set RELEASE_TAG to the release being promoted}"
target_env="${TARGET_ENV:-testnet}"
evidence="${EVIDENCE_DIR:-$REPO_ROOT/evidence}"
fuzz_seconds="${FUZZ_SECONDS:-60}"
mkdir -p "$evidence"

require cargo
require stellar

# --- 1. tests ---------------------------------------------------------------
say "Gate 1/4 — contract tests"
set +e
(cd "$REPO_ROOT" && cargo test -p streampay-contract --locked) 2>&1 | tee "$evidence/tests.log"
tests_rc=${PIPESTATUS[0]}
set -e
[ "$tests_rc" -eq 0 ] || die "contract tests failed (rc=$tests_rc)"

# --- 2. fuzz soak -----------------------------------------------------------
say "Gate 2/4 — fuzz soak (${fuzz_seconds}s on the accrual math)"
if cargo +nightly fuzz --version >/dev/null 2>&1; then
  set +e
  (cd "$REPO_ROOT/fuzz" && cargo +nightly fuzz run streamed_at -- \
    -max_total_time="$fuzz_seconds" -rss_limit_mb=4096) 2>&1 | tee "$evidence/fuzz.log"
  fuzz_rc=${PIPESTATUS[0]}
  set -e
  [ "$fuzz_rc" -eq 0 ] || die "fuzz soak found a crash (rc=$fuzz_rc)"
else
  if [ "${ALLOW_FUZZ_SKIP:-0}" = "1" ]; then
    warn "cargo-fuzz unavailable — fuzz soak SKIPPED (ALLOW_FUZZ_SKIP=1)"
    echo "SKIPPED: cargo-fuzz unavailable, ALLOW_FUZZ_SKIP=1" > "$evidence/fuzz.log"
  else
    die "cargo-fuzz unavailable; install it or set ALLOW_FUZZ_SKIP=1 to record the gap"
  fi
fi

# --- 3. reproducible build + digest continuity ------------------------------
say "Gate 3/4 — reproducible Wasm build"
(cd "$REPO_ROOT/contracts/streaming-payments" && stellar contract build)
wasm="$REPO_ROOT/$WASM_REL"
[ -f "$wasm" ] || die "expected Wasm at $WASM_REL after build"
digest="$(sha256sum "$wasm" | awk '{print $1}')"
printf '%s  %s\n' "$digest" "$WASM_REL" > "$evidence/SHA256SUMS"
cat "$evidence/SHA256SUMS" | tee "$evidence/digest.txt"

say "Gate 4/4 — digest continuity vs release $RELEASE_TAG (never a local build)"
if [ -n "${EXPECTED_DIGEST_FILE:-}" ]; then
  "$REPO_ROOT/scripts/verify_release_digest.sh" --expected-file "$EXPECTED_DIGEST_FILE" "$wasm" \
    | tee "$evidence/digest-continuity.txt"
elif [ "${SYNTHETIC_RELEASE:-0}" = "1" ]; then
  # Rehearsal only: there is no published release to compare against, so publish
  # the just-built digest into a synthetic SHA256SUMS and verify against it. The
  # check itself (download/parse/compare) is exercised end to end; production
  # never uses this path.
  warn "SYNTHETIC release — verifying against the just-built digest (rehearsal only)"
  cp "$evidence/SHA256SUMS" "$evidence/SHA256SUMS.synthetic"
  "$REPO_ROOT/scripts/verify_release_digest.sh" --expected-file "$evidence/SHA256SUMS.synthetic" "$wasm" \
    | tee "$evidence/digest-continuity.txt"
else
  "$REPO_ROOT/scripts/verify_release_digest.sh" "$RELEASE_TAG" "$wasm" \
    | tee "$evidence/digest-continuity.txt"
fi

# --- interface + schema diff ------------------------------------------------
say "Contract interface hash + schema diff ($target_env)"
"$REPO_ROOT/scripts/contract_interface_hash.sh" "$wasm" "$evidence" "$RELEASE_TAG" \
  | tee "$evidence/interface-hash.txt"
"$REPO_ROOT/scripts/schema_diff.sh" "$evidence/interface.sha256" "$target_env" \
  | tee "$evidence/schema-diff.txt"

# --- evidence summary -------------------------------------------------------
interface_hash="$(cat "$evidence/interface.sha256")"
{
  echo "# Release gates — $RELEASE_TAG"
  echo
  echo "- target environment: \`$target_env\`"
  echo "- wasm digest (SHA-256): \`$digest\`"
  echo "- interface hash: \`$interface_hash\`"
  echo
  echo "| Gate | Evidence |"
  echo "|---|---|"
  echo "| Contract tests | \`tests.log\` |"
  echo "| Fuzz soak (${fuzz_seconds}s) | \`fuzz.log\` |"
  echo "| Digest continuity | \`digest-continuity.txt\` |"
  echo "| Schema diff | \`schema-diff.txt\` |"
  echo "| Contract interface | \`interface.json\`, \`interface.sha256\` |"
} > "$evidence/summary.md"

say "All gates green — evidence in ${evidence#$REPO_ROOT/}"
cat "$evidence/summary.md"
