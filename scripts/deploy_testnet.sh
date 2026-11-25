#!/usr/bin/env bash
# deploy_testnet.sh — End-to-end testnet deployment script & live demo stream.
#
#   ./scripts/deploy_testnet.sh
#
# What it does:
#   1. Preflight checks: stellar CLI, cargo, and funded testnet accounts.
#      Exits non-zero with actionable errors if any prerequisite fails.
#   2. Builds the contract Wasm via `stellar contract build`.
#   3. Verifies those bytes against a signed release attestation and refuses to
#      deploy if they are not proven (see docs/ATTESTATION.md).
#   4. Deploys the contract with deployer as treasury governor (or reuses active deployment).
#   5. Prepares and verifies funded sender, recipient, and demo issuer identities.
#   6. Deploys a SAC (Stellar Asset Contract) for custom demo asset and mints tokens to sender.
#   7. Approves contract allowance and opens a 1-hour cancelable demo stream.
#   8. Verifies initial accrual and prints a structured summary.
#
# Environment variables (optional overrides for idempotency):
#   DEPLOYER_KEY: Stellar identity alias for deployer (default: "deployer")
#   CONTRACT_ID:  Pre-deployed contract ID to reuse
#   TOKEN_ID:     Pre-deployed demo token address to reuse
#   STREAM_ID:    Pre-created stream ID to reuse
#
# Attestation gate:
#   CONTRACT_WASM:                 deploy this artifact instead of building one
#   WASM_ATTESTATION_TAG:          verify against this release (default: latest)
#   WASM_ATTESTATION_FINGERPRINT:  pin the signing key, e.g. sha256:<hex>
#   VERIFY_REQUIRE_REPRO:          0 to accept an attestation without a passing
#                                  double build (default: 1)
#   SKIP_WASM_ATTESTATION:         1 to deploy unverified local work, knowingly
#
# Requires: stellar-cli (>=25.2, tested on 28.1.0), cargo, curl, openssl,
#           internet access.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="testnet"
WASM="target/wasm32v1-none/release/streampay_contract.wasm"
WASM_ABS=""
ATTESTATION_STATUS="NOT CHECKED"
DEPLOYER_KEY="${DEPLOYER_KEY:-deployer}"
CACHE_FILE="$REPO_ROOT/.testnet_contract_id"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Helper to strip Windows CR (\r) from CLI outputs
clean_str() { tr -d '\r'; }

# ---------------------------------------------------------------- 1. preflight
say "Checking prerequisites"

command -v stellar >/dev/null 2>&1 \
  || die "stellar CLI not found on PATH. Install: cargo install stellar-cli --locked"

command -v cargo >/dev/null 2>&1 \
  || die "cargo not found on PATH. Install: https://rustup.rs"

command -v curl >/dev/null 2>&1 \
  || die "curl not found on PATH. Please install curl to interact with Friendbot and RPC."

info "stellar CLI: $(stellar --version 2>&1 | head -n 1 | clean_str)"
info "cargo: $(cargo --version 2>&1 | head -n 1 | clean_str)"

rustup target list --installed 2>/dev/null | grep -q wasm32v1-none \
  || warn "wasm32v1-none target missing; run 'rustup target add wasm32v1-none' if build fails"

# Verification of account funding status on testnet
is_account_funded() {
  local addr="$1"
  local status_code
  status_code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "https://horizon-testnet.stellar.org/accounts/${addr}" 2>/dev/null || echo "000")"
  [ "$status_code" = "200" ]
}

ensure_identity_and_funding() {
  local who="$1"
  if ! stellar keys address "$who" >/dev/null 2>&1; then
    info "Generating keypair for $who..."
    stellar keys generate "$who" --network "$NETWORK" >/dev/null 2>&1 \
      || die "Failed to generate keypair '$who'."
  fi

  local addr
  addr="$(stellar keys address "$who" | clean_str | tail -n 1)"
  [ -n "$addr" ] || die "Could not retrieve address for '$who'."

  if is_account_funded "$addr"; then
    info "Identity '$who' ($addr) is funded."
    return 0
  fi

  info "Requesting Friendbot funding for '$who' ($addr)..."
  curl -sf "https://friendbot.stellar.org?addr=${addr}" >/dev/null 2>&1 || true

  # Poll up to 10 seconds for ledger confirmation
  local funded=0
  for _ in 1 2 3 4 5; do
    if is_account_funded "$addr"; then
      funded=1
      break
    fi
    sleep 2
  done

  if [ "$funded" -ne 1 ]; then
    die "Identity '$who' ($addr) could not be funded on testnet.
Friendbot may be experiencing downtime or rate-limiting.
Please manually fund the account using the Stellar Laboratory:
  https://laboratory.stellar.org/#account-creator?network=testnet
and re-run this script."
  fi
  info "Identity '$who' ($addr) successfully funded."
}

say "Verifying deployer account ($DEPLOYER_KEY)"
ensure_identity_and_funding "$DEPLOYER_KEY"
DEPLOYER_ADDR="$(stellar keys address "$DEPLOYER_KEY" | clean_str | tail -n 1)"

# ------------------------------------------------------------------- 2. build
say "Building contract Wasm"
if [ -n "${CONTRACT_WASM:-}" ]; then
  [ -f "$CONTRACT_WASM" ] || die "CONTRACT_WASM not found: $CONTRACT_WASM"
  WASM_ABS="$CONTRACT_WASM"
  info "Using the supplied artifact instead of a local build: $WASM_ABS"
else
  # soroban-sdk 28 requires the stellar-cli build path for spec-shaking v2
  (cd "$REPO_ROOT/contracts/streaming-payments" && stellar contract build)
  [ -f "$REPO_ROOT/$WASM" ] || die "expected Wasm at $WASM after build"
  WASM_ABS="$REPO_ROOT/$WASM"
  info "Wasm binary ready at: $WASM"
fi

# ---------------------------------------------------- 2b. verify before deploy
# A public chain cannot un-deploy, so the bytes are proven *before* they go on,
# never after. This runs the same check an independent auditor would: recompute
# the digest, fetch the signed attestation, verify the Ed25519 signature against
# the key pinned in this checkout, and confirm the payload names these bytes.
say "Verifying the Wasm against a signed release attestation"
if [ "${SKIP_WASM_ATTESTATION:-0}" = "1" ]; then
  warn "SKIP_WASM_ATTESTATION=1 — deploying WITHOUT attestation verification."
  warn "Nothing proves these bytes match a reviewed, signed release."
  ATTESTATION_STATUS="SKIPPED (SKIP_WASM_ATTESTATION=1)"
else
  verify_args=("$WASM_ABS")
  if [ -n "${WASM_ATTESTATION_TAG:-}" ]; then
    verify_args+=(--tag "$WASM_ATTESTATION_TAG")
    info "pinned to release: $WASM_ATTESTATION_TAG"
  else
    info "no WASM_ATTESTATION_TAG set — resolving the latest published release"
  fi
  if [ "${VERIFY_REQUIRE_REPRO:-1}" = "1" ]; then
    verify_args+=(--require-repro)
  fi
  if [ -n "${WASM_ATTESTATION_FINGERPRINT:-}" ]; then
    verify_args+=(--fingerprint "$WASM_ATTESTATION_FINGERPRINT")
  fi

  if bash "$REPO_ROOT/scripts/verify_wasm.sh" "${verify_args[@]}"; then
    ATTESTATION_STATUS="VERIFIED"
  else
    ATTESTATION_STATUS="FAILED"
    die "attestation verification failed — refusing to deploy.

  This local build is not the artifact any signed attestation describes. That is
  the normal state when you are working on unreleased code, and it is also
  exactly what a tampered build looks like, so this script cannot tell the two
  apart for you. Choose deliberately:

    • deploy the published, provable artifact instead of your local build:
        gh release download <tag> --pattern 'streampay_contract.wasm' --dir /tmp
        CONTRACT_WASM=/tmp/streampay_contract.wasm $0

    • verify against a specific release:
        WASM_ATTESTATION_TAG=v0.5.0 $0

    • deploy unreleased local work to testnet anyway, knowingly:
        SKIP_WASM_ATTESTATION=1 $0

  See docs/ATTESTATION.md for what the check does and does not prove."
  fi
fi

# ------------------------------------------------------------------ 3. deploy
CONTRACT_ID="${CONTRACT_ID:-}"
if [ -z "$CONTRACT_ID" ] && [ -f "$CACHE_FILE" ]; then
  CONTRACT_ID="$(cat "$CACHE_FILE" | clean_str | tr -d ' ')"
fi

is_contract_active() {
  local cid="$1"
  [ -n "$cid" ] || return 1
  # Invoke a light read call to verify contract deployment liveness
  stellar contract invoke \
    --id "$cid" --source "$DEPLOYER_KEY" --network "$NETWORK" \
    -- total_streams >/dev/null 2>&1 && return 0
  return 1
}

say "Deploying or verifying contract on $NETWORK"
if [ -n "$CONTRACT_ID" ] && is_contract_active "$CONTRACT_ID"; then
  info "Contract already deployed and active at: $CONTRACT_ID (reusing)"
else
  info "Deploying new contract to $NETWORK (governor: $DEPLOYER_ADDR)"
  CONTRACT_ID="$(stellar contract deploy \
    --wasm "$WASM_ABS" \
    --source "$DEPLOYER_KEY" --network "$NETWORK" \
    -- --governor "$DEPLOYER_ADDR" | clean_str | tail -n 1)"
  [ -n "$CONTRACT_ID" ] || die "stellar contract deploy returned no contract id"
  echo "$CONTRACT_ID" > "$CACHE_FILE"
  info "Contract deployed successfully: $CONTRACT_ID"
fi

# ------------------------------------------------------------ 4. demo actors
say "Preparing demo actors (sender & recipient)"
ensure_identity_and_funding "sender"
ensure_identity_and_funding "recipient"
SENDER="$(stellar keys address sender | clean_str | tail -n 1)"
RECIPIENT="$(stellar keys address recipient | clean_str | tail -n 1)"

# ---------------------------------------------------------- 5. token + stream
say "Preparing demo SAC asset"
ensure_identity_and_funding "demo_issuer"
ISSUER_ADDR="$(stellar keys address demo_issuer | clean_str | tail -n 1)"

TOKEN="${TOKEN_ID:-}"
if [ -z "$TOKEN" ]; then
  SALT="$(openssl rand -hex 16 2>/dev/null || date +%s%N | cut -c1-32 || date +%s)"
  ASSET_CODE="DEMO$(printf '%04d' $((RANDOM % 10000)))"
  info "Creating demo asset $ASSET_CODE with issuer $ISSUER_ADDR"
  TOKEN="$(stellar contract asset create \
    --source demo_issuer --network "$NETWORK" \
    --issuer "$ISSUER_ADDR" \
    --max-alpha4 "$ASSET_CODE" \
    --amount 1000000000 \
    --salt "$SALT" | clean_str | tail -n 1)"
  [ -n "$TOKEN" ] || die "Failed to register demo SAC token"
  info "Demo token address: $TOKEN"

  info "Minting 1,000,000,000 units to sender ($SENDER)"
  stellar contract invoke \
    --id "$TOKEN" --source demo_issuer --network "$NETWORK" \
    -- mint --to "$SENDER" --amount 1000000000 >/dev/null 2>&1 \
    || die "Failed to mint demo tokens to sender"
else
  info "Reusing existing token: $TOKEN"
fi

STREAM_ID="${STREAM_ID:-}"
is_stream_active() {
  local sid="$1"
  [ -n "$sid" ] || return 1
  stellar contract invoke \
    --id "$CONTRACT_ID" --source sender --network "$NETWORK" \
    -- available --stream_id "$sid" >/dev/null 2>&1 && return 0
  return 1
}

if [ -n "$STREAM_ID" ] && is_stream_active "$STREAM_ID"; then
  info "Reusing existing active stream: #$STREAM_ID"
else
  say "Approving streaming contract as spender"
  stellar contract invoke \
    --id "$TOKEN" --source sender --network "$NETWORK" \
    -- approve --spender "$CONTRACT_ID" --amount 1000000000 --expiration_ledger +5000 >/dev/null 2>&1 \
    || die "Token approval failed"

  say "Creating demo stream (1 hour, cancelable)"
  NOW="$(date +%s)"
  END=$((NOW + 3600))
  STREAM_ID="$(stellar contract invoke \
    --id "$CONTRACT_ID" --source sender --network "$NETWORK" \
    -- create_stream \
       --sender "$SENDER" --recipient "$RECIPIENT" --token "$TOKEN" \
       --deposit_amount 1000000000 --start_time "$NOW" --end_time "$END" \
       --cancelable true | clean_str | tail -n 1)"
  [ -n "$STREAM_ID" ] || die "Failed to create demo stream"
  info "Stream created successfully: #$STREAM_ID"
fi

say "Verifying stream accrual"
AVAILABLE="$(stellar contract invoke \
  --id "$CONTRACT_ID" --source sender --network "$NETWORK" \
  -- available --stream_id "$STREAM_ID" | clean_str | tail -n 1)"

# ------------------------------------------------------------------ 6. summary
cat <<EOF

==================================================================
  ⚡ StreamPay Testnet Demo Stream #$STREAM_ID is Live!
==================================================================

  Contract ID   : $CONTRACT_ID
  Stream ID     : $STREAM_ID
  Token Address : $TOKEN
  Available Now : $AVAILABLE units
  Attestation   : $ATTESTATION_STATUS

  Accounts:
    • Governor / Deployer : $DEPLOYER_ADDR
    • Sender              : $SENDER
    • Recipient           : $RECIPIENT
    • Demo Token Issuer   : $ISSUER_ADDR

  Next Steps:
    1. Configure Frontend:
       echo 'NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT_ID' >> frontend/.env.local
       cd frontend && npm install && npm run dev

    2. Query Current Accrual:
       stellar contract invoke --id $CONTRACT_ID --source sender --network $NETWORK -- available --stream_id $STREAM_ID

    3. Recipient Claim (Atomic Full Accrual):
       stellar contract invoke --id $CONTRACT_ID --source recipient --network $NETWORK -- withdraw_max --stream_id $STREAM_ID

    4. Pro-Rata Cancellation:
       stellar contract invoke --id $CONTRACT_ID --source sender --network $NETWORK -- cancel_stream --caller $SENDER --stream_id $STREAM_ID

  Walkthrough & Troubleshooting:
    Read docs/DEMO.md for the complete interactive lifecycle guide.
==================================================================

EOF
