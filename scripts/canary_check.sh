#!/usr/bin/env bash
# Canary checks for a just-deployed contract. A non-zero exit is a rollback
# trigger — the workflow turns it into the rollback job (see
# docs/CANARY_RUNBOOK.md). The three checks are deliberately cheap and
# chain-truth-based:
#
#   1. schema continuity — the interface the chain is serving matches the
#      promoted interface hash (catches a wrong-Wasm deploy);
#   2. liveness — a read call returns, whether with data or the typed
#      `StreamNotFound` (#1) error, proving the host answers;
#   3. economics — a provided smoke stream's `available` is non-negative and
#      does not decrease across two reads (catches broken accrual / a wrong
#      token wiring).
#
# Usage: scripts/canary_check.sh <env> <contract-id> [--mock]
# Env: SMOKE_STREAM_ID (optional) — a stream id to read for check 3.
. "$(dirname "$0")/lib.sh"

env_name="${1:?usage: canary_check.sh <env> <contract-id> [--mock]}"
contract_id="${2:?usage: canary_check.sh <env> <contract-id> [--mock]}"
mode="${3:-}"

if [ "$mode" = "--mock" ]; then
  say "MOCK canary for $env_name ($contract_id) — no chain calls"
  echo "canary[1/3] schema continuity: OK (mocked)"
  echo "canary[2/3] liveness: OK (mocked)"
  echo "canary[3/3] economics: OK (mocked)"
  echo "canary: PASS (mocked)"
  exit 0
fi

network="$(network_for "$env_name")"
require stellar

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- 1. schema continuity ---------------------------------------------------
say "Canary 1/3 — on-chain interface matches the promoted schema"
stellar contract info interface --contract-id "$contract_id" --network "$network" --output json \
  > "$tmp/onchain.json" || die "could not read the on-chain interface"
canonicalize_json "$tmp/onchain.json" "$tmp/onchain.canon.json"
onchain_hash="$(sha256sum "$tmp/onchain.canon.json" | awk '{print $1}')"
baseline="$REPO_ROOT/deployments/interface/${env_name}.sha256"
if [ -f "$baseline" ]; then
  expected="$(cat "$baseline")"
  [ "$onchain_hash" = "$expected" ] \
    || die "on-chain interface $onchain_hash != promoted $expected (wrong Wasm deployed?)"
  echo "canary[1/3] schema continuity: OK ($onchain_hash)"
else
  warn "no promoted baseline for '$env_name' — skipping interface comparison"
  echo "canary[1/3] schema continuity: SKIPPED (no baseline)"
fi

# --- 2. liveness ------------------------------------------------------------
say "Canary 2/3 — read call (liveness)"
set +e
stellar contract invoke --id "$contract_id" --network "$network" -- available --stream_id 1 \
  > "$tmp/read.log" 2>&1
rc=$?
set -e
if grep -q "Error(Contract, #1)" "$tmp/read.log"; then
  echo "canary[2/3] liveness: OK (responding; StreamNotFound #1 for stream 1)"
elif [ "$rc" -eq 0 ]; then
  echo "canary[2/3] liveness: OK"
else
  cat "$tmp/read.log" >&2
  die "liveness check failed (rc=$rc)"
fi

# --- 3. economics -----------------------------------------------------------
say "Canary 3/3 — smoke stream economics"
if [ -z "${SMOKE_STREAM_ID:-}" ]; then
  warn "SMOKE_STREAM_ID not set — skipping the accrual check"
  echo "canary[3/3] economics: SKIPPED (no smoke stream)"
else
  read_available() {
    stellar contract invoke --id "$contract_id" --network "$network" \
      -- available --stream_id "$SMOKE_STREAM_ID" | tail -n 1
  }
  a1="$(read_available)"
  sleep 5
  a2="$(read_available)"
  echo "canary[3/3] available: $a1 -> $a2"
  [ "$a1" -ge 0 ] 2>/dev/null || die "available is negative: $a1"
  [ "$a2" -ge "$a1" ] 2>/dev/null || die "available decreased across reads ($a1 -> $a2)"
  echo "canary[3/3] economics: OK"
fi

echo "canary: PASS"
