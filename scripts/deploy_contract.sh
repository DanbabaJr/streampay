#!/usr/bin/env bash
# Deploy a digest-verified Wasm to an environment and print the contract id.
#
# A public chain cannot un-deploy: this is the only forward action, and the
# rollback path is a *new deploy* of the previously promoted digest (see
# docs/CANARY_RUNBOOK.md). Dry-run mode is used by the dress rehearsal and by
# the workflow's `dry_run` input: it performs no chain call and prints a stable
# mock id derived from the digest so downstream (mocked) canary checks have
# something to reference.
#
# Usage: scripts/deploy_contract.sh <env> <wasm> [--dry-run]
#   <env> is one of: testnet | mainnet | mainnet-canary
#
# Signing key: set STELLAR_SOURCE_KEY to a stellar-cli key name. For testnet an
# ephemeral friendbot-funded identity is created when it is unset; mainnet
# requires it explicitly.
. "$(dirname "$0")/lib.sh"

env_name="${1:?usage: deploy_contract.sh <env> <wasm> [--dry-run]}"
wasm="${2:?usage: deploy_contract.sh <env> <wasm> [--dry-run]}"
dry=0
[ "${3:-}" = "--dry-run" ] && dry=1

[ -f "$wasm" ] || die "wasm not found: $wasm"
network="$(network_for "$env_name")"
digest="$(sha256sum "$wasm" | awk '{print $1}')"

if [ "$dry" = "1" ]; then
  say "DRY RUN — would deploy $wasm to $network"
  info "digest: $digest"
  echo "DRYRUN_${digest:0:12}"
  exit 0
fi

require stellar

source_key="${STELLAR_SOURCE_KEY:-}"
if [ -z "$source_key" ]; then
  if [ "$network" = "testnet" ]; then
    say "Preparing an ephemeral funded testnet identity"
    source_key="streampay-ci"
    stellar keys address "$source_key" >/dev/null 2>&1 \
      || stellar keys generate "$source_key" --network testnet
    curl -sf "https://friendbot.stellar.org?addr=$(stellar keys address "$source_key")" >/dev/null \
      || warn "friendbot did not fund the account (it may already be funded)"
  else
    die "deploying to $network requires STELLAR_SOURCE_KEY (a stellar-cli signer key name)"
  fi
fi

say "Deploying to $network (digest ${digest:0:12}…)"
contract_id="$(stellar contract deploy \
  --wasm "$wasm" \
  --source "$source_key" --network "$network" | tail -n 1)"
[ -n "$contract_id" ] || die "stellar contract deploy returned no contract id"

info "contract id: $contract_id"
echo "$contract_id"
