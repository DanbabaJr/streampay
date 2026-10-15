#!/usr/bin/env bash
# Shared helpers for the StreamPay release/promotion scripts.
#
# Source it, do not execute it:
#   . "$(dirname "$0")/lib.sh"

set -euo pipefail

# Resolve the repo root from this file's location, so the scripts work from any
# working directory (CI, a contributor's shell, a nested checkout).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Where `stellar contract build` writes the contract Wasm.
WASM_REL="target/wasm32v1-none/release/streampay_contract.wasm"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"; }

# Canonicalize a JSON file in place-ish (writes <file>.canon). Falls back to a
# byte copy when jq is unavailable, which still hashes deterministically for a
# given tool version.
canonicalize_json() {
  local src="$1" dst="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -S . "$src" > "$dst"
  else
    warn "jq not found; hashing raw JSON (key order may vary across tool versions)"
    cp "$src" "$dst"
  fi
}

# Map a pipeline environment name to a Stellar network name.
network_for() {
  case "$1" in
    sandbox) echo "testnet" ;;
    testnet) echo "testnet" ;;
    mainnet|mainnet-canary) echo "public" ;;
    *) die "unknown environment: $1" ;;
  esac
}
