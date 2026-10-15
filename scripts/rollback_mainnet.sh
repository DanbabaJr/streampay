#!/usr/bin/env bash
# Roll back a mainnet canary.
#
# A Soroban contract cannot be un-deployed. "Rollback" therefore means: deploy
# the PREVIOUSLY PROMOTED Wasm again as a new contract instance, re-point
# clients at it, and replay any migration steps — then run the canary checks
# against the restored instance and record the event with result=rolled-back.
# See docs/CANARY_RUNBOOK.md for the operator procedure this automates.
#
# Usage: scripts/rollback_mainnet.sh [env]     (env defaults to mainnet-canary)
#
# The tag to restore is discovered, in order, from:
#   1. ROLLBACK_TO_TAG (explicit override, e.g. set by an operator)
#   2. the append-only promotion issue thread (PROMOTION_ISSUE), if reachable
#   3. the in-repo deployments/promotions.log mirror
. "$(dirname "$0")/lib.sh"

env_name="${1:-mainnet-canary}"
log="$REPO_ROOT/deployments/promotions.log"

last_promoted_tag() {
  if [ -n "${ROLLBACK_TO_TAG:-}" ]; then echo "$ROLLBACK_TO_TAG"; return 0; fi
  if [ -n "${PROMOTION_ISSUE:-}" ] && command -v gh >/dev/null 2>&1; then
    local from_issue
    from_issue="$(gh issue view "$PROMOTION_ISSUE" --comments 2>/dev/null \
      | grep "env=${env_name}" | grep 'result=promoted' | tail -n 1 \
      | sed -n 's/.*tag=\([^ ]*\).*/\1/p')"
    if [ -n "$from_issue" ]; then echo "$from_issue"; return 0; fi
  fi
  [ -f "$log" ] && grep "env=${env_name}" "$log" | grep 'result=promoted' | tail -n 1 \
    | sed -n 's/.*tag=\([^ ]*\).*/\1/p'
}

prev_tag="$(last_promoted_tag)"
[ -n "$prev_tag" ] \
  || die "no previously promoted $env_name digest found (set ROLLBACK_TO_TAG or PROMOTION_ISSUE)"

require gh
require stellar

say "Rolling back $env_name to the digest promoted from $prev_tag"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh release download "$prev_tag" --pattern streampay_contract.wasm --dir "$tmp" \
  || die "release $prev_tag has no streampay_contract.wasm asset"
scripts/verify_release_digest.sh "$prev_tag" "$tmp/streampay_contract.wasm"

contract_id="$("$REPO_ROOT/scripts/deploy_contract.sh" "$env_name" "$tmp/streampay_contract.wasm" | tail -n 1)"
[ -n "$contract_id" ] || die "rollback deploy returned no contract id"

"$REPO_ROOT/scripts/canary_check.sh" "$env_name" "$contract_id" || \
  die "rollback deploy ALSO failed its canary — escalate: the last known-good digest is $prev_tag"

digest="$(sha256sum "$tmp/streampay_contract.wasm" | awk '{print $1}')"
baseline="$REPO_ROOT/deployments/interface/${env_name}.sha256"
interface_hash="$([ -f "$baseline" ] && cat "$baseline" || echo "")"

"$REPO_ROOT/scripts/record_promotion.sh" \
  "$env_name" "$prev_tag" "$digest" "$interface_hash" "$contract_id" rolled-back

say "Rollback complete: $env_name now serves $contract_id ($prev_tag)"
