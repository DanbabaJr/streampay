#!/usr/bin/env bash
# deploy_testnet.sh — one command from clean machine to a live demo stream.
#
#   ./scripts/deploy_testnet.sh
#
# What it does (idempotent-ish: safe to re-run, but each run deploys a NEW
# contract and creates a NEW demo stream):
#   1. Checks prerequisites: stellar CLI, cargo, a funded testnet identity.
#   2. Builds the contract Wasm.
#   3. Generates + funds a deployer, deploys the contract.
#   4. Generates + funds sender/recipient demo identities.
#   5. Mints a demo token, approves, and opens a 1-hour demo stream.
#   6. Prints the contract id — paste it into frontend/.env.local.
#
# Requires: Rust, stellar-cli (cargo install stellar-cli --locked), curl,
# and internet access to the public testnet friendbot.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="testnet"
WASM="target/wasm32v1-none/release/streampay_contract.wasm"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. preflight
say "Checking prerequisites"
command -v stellar >/dev/null 2>&1 || die "stellar CLI not found. Install: cargo install stellar-cli --locked"
command -v cargo   >/dev/null 2>&1 || die "cargo not found. Install: https://rustup.rs"
rustup target list --installed 2>/dev/null | grep -q wasm32v1-none \
  || say "note: wasm32v1-none target missing; building may fail if stellar-cli does not provide it"

# ------------------------------------------------------------------- 2. build
say "Building contract Wasm"
# soroban-sdk 28 requires the stellar-cli build path; plain cargo is rejected.
(cd "$REPO_ROOT/contracts/streaming-payments" && stellar contract build)
[ -f "$REPO_ROOT/$WASM" ] || die "expected Wasm at $WASM after build"

# ------------------------------------------------------------------ 3. deploy
say "Preparing deployer identity (testnet)"
if ! stellar keys address deployer >/dev/null 2>&1; then
  stellar keys generate deployer --network "$NETWORK"
fi
fund_friendbot() { curl -sf "https://friendbot.stellar.org?addr=$1" >/dev/null || true; }
DEPLOYER_ADDR="$(stellar keys address deployer)"
fund_friendbot "$DEPLOYER_ADDR"

say "Deploying contract to $NETWORK"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$REPO_ROOT/$WASM" \
  --source deployer --network "$NETWORK" | tail -n 1)"
[ -n "$CONTRACT_ID" ] || die "deploy returned no contract id"
echo "contract id: $CONTRACT_ID"

# ------------------------------------------------------------ 4. demo actors
say "Preparing sender + recipient identities"
for who in sender recipient; do
  stellar keys address "$who" >/dev/null 2>&1 || stellar keys generate "$who" --network "$NETWORK"
  fund_friendbot "$(stellar keys address "$who")"
done
SENDER="$(stellar keys address sender)"
RECIPIENT="$(stellar keys address recipient)"

# ---------------------------------------------------------- 5. token + stream
say "Registering a demo SAC asset"
if ! stellar keys address demo_issuer >/dev/null 2>&1; then
  stellar keys generate demo_issuer --network "$NETWORK"
fi
fund_friendbot "$(stellar keys address demo_issuer)"
# salt must differ per run; asset registration is one-shot per salt.
SALT="$(openssl rand -hex 16 2>/dev/null || date +%s%N | shasum -a 256 | cut -c1-32)"
TOKEN="$(stellar contract asset create \
  --source demo_issuer --network "$NETWORK" \
  --issuer "$(stellar keys address demo_issuer)" \
  --max-alpha4 "DEMO$(printf '%04d' $((RANDOM % 10000)))" \
  --amount 1000000000 \
  --salt "$SALT" | tail -n 1)"
echo "demo token id: $TOKEN"

say "Minting demo tokens to the sender and approving the contract"
stellar contract invoke \
  --id "$TOKEN" --source demo_issuer --network "$NETWORK" \
  -- mint --to "$SENDER" --amount 1000000000

NOW="$(date +%s)"
END=$((NOW + 3600))  # 1-hour demo stream of 1,000,000 units (100.0000000 with 7 decimals)

say "Approving the streaming contract to pull the deposit"
stellar contract invoke \
  --id "$TOKEN" --source sender --network "$NETWORK" \
  -- approve --spender "$CONTRACT_ID" --amount 1000000000 --expiration_ledger +5000

say "Creating the demo stream (1 hour, cancelable)"
STREAM_ID="$(stellar contract invoke \
  --id "$CONTRACT_ID" --source sender --network "$NETWORK" \
  -- create_stream \
     --sender "$SENDER" --recipient "$RECIPIENT" --token "$TOKEN" \
     --deposit_amount 1000000000 --start_time "$NOW" --end_time "$END" \
     --cancelable true | tail -n 1)"

say "Verifying accrual"
stellar contract invoke \
  --id "$CONTRACT_ID" --source sender --network "$NETWORK" \
  -- available --stream_id "$STREAM_ID"

cat <<EOF

──────────────────────────────────────────────────────────────────
  Demo stream #$STREAM_ID is live on $NETWORK.

  Contract id : $CONTRACT_ID
  Token       : $TOKEN
  Sender      : $SENDER
  Recipient   : $RECIPIENT
  Window      : $NOW → $END (1 hour)

  Next steps:
    • Frontend: echo 'NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT_ID' \\
        >> frontend/.env.local && cd frontend && npm run dev
    • Watch accrual:  repeat the "available" invoke above.
    • Claim:          withdraw_max --stream_id $STREAM_ID (as recipient).

  See docs/DEMO.md for the full walkthrough.
──────────────────────────────────────────────────────────────────
EOF
