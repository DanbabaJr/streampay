#!/usr/bin/env bash
# Full dress rehearsal: sandbox gates (real) -> testnet (mocked deploy) ->
# mainnet canary (mocked deploy), producing the same evidence bundle and
# promotion records the governed pipeline produces in CI.
#
# It needs the Rust/stellar toolchain to run the gates, but no chain credentials
# and no funded key — the deploys and canary checks run in mock mode. This is
# what makes the pipeline testable on any contributor machine and in CI without
# secrets. The real, approval-gated path is .github/workflows/promote.yml.
#
# Usage: scripts/promote_rehearsal.sh
. "$(dirname "$0")/lib.sh"

require cargo
require stellar

release_tag="${RELEASE_TAG:-rehearsal-$(date -u +%Y%m%d)}"
export EVIDENCE_DIR="${EVIDENCE_DIR:-$REPO_ROOT/evidence/rehearsal}"
export RELEASE_TAG="$release_tag"
export SYNTHETIC_RELEASE=1
export SCHEMA_CHANGE_ACK="${SCHEMA_CHANGE_ACK:-1}"   # rehearsal pre-approves schema changes
mkdir -p "$EVIDENCE_DIR"

say "Dress rehearsal $release_tag"
info "evidence: ${EVIDENCE_DIR#$REPO_ROOT/}"

# ---------------------------------------------------------------- sandbox ---
export TARGET_ENV="testnet"
"$REPO_ROOT/scripts/release_gates.sh"

wasm="$REPO_ROOT/$WASM_REL"
digest="$(sha256sum "$wasm" | awk '{print $1}')"
interface_hash="$(cat "$EVIDENCE_DIR/interface.sha256")"

# ---------------------------------------------------------------- testnet ---
say "Promoting to testnet (mocked deploy)"
testnet_id="$("$REPO_ROOT/scripts/deploy_contract.sh" testnet "$wasm" --dry-run | tail -n 1)"
info "contract id (mock): $testnet_id"
"$REPO_ROOT/scripts/canary_check.sh" testnet "$testnet_id" --mock | tee "$EVIDENCE_DIR/canary-testnet.txt"
EVIDENCE_DIR="$EVIDENCE_DIR" "$REPO_ROOT/scripts/record_promotion.sh" \
  testnet "$release_tag" "$digest" "$interface_hash" "$testnet_id" rehearsed \
  --out "$EVIDENCE_DIR/promotions.log" >/dev/null

# --------------------------------------------------------- mainnet canary ---
export TARGET_ENV="mainnet-canary"
say "Mainnet canary (mocked deploy)"
mainnet_id="$("$REPO_ROOT/scripts/deploy_contract.sh" mainnet-canary "$wasm" --dry-run | tail -n 1)"
info "contract id (mock): $mainnet_id"
"$REPO_ROOT/scripts/canary_check.sh" mainnet-canary "$mainnet_id" --mock | tee "$EVIDENCE_DIR/canary-mainnet.txt"
EVIDENCE_DIR="$EVIDENCE_DIR" "$REPO_ROOT/scripts/record_promotion.sh" \
  mainnet-canary "$release_tag" "$digest" "$interface_hash" "$mainnet_id" rehearsed \
  --out "$EVIDENCE_DIR/promotions.log" >/dev/null

# ----------------------------------------------------------------- summary --
{
  echo "# Dress rehearsal — $release_tag"
  echo
  echo "Sandbox -> testnet -> mainnet-canary, deploys mocked."
  echo
  echo "| Step | Result |"
  echo "|---|---|"
  echo "| Sandbox gates | PASS |"
  echo "| Testnet deploy (mock) | \`$testnet_id\` |"
  echo "| Testnet canary | PASS (mock) |"
  echo "| Mainnet canary deploy (mock) | \`$mainnet_id\` |"
  echo "| Mainnet canary checks | PASS (mock) |"
  echo
  echo "Wasm digest: \`$digest\`"
  echo "Interface hash: \`$interface_hash\`"
} > "$EVIDENCE_DIR/rehearsal-summary.md"

say "Rehearsal complete"
cat "$EVIDENCE_DIR/rehearsal-summary.md"
