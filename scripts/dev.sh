#!/usr/bin/env bash
# scripts/dev.sh — End-to-end bootstrap for local development and testing.
#
# Takes a fresh clone from git clone to a running local demo:
#   1. Verifies prerequisites:
#        - stellar-cli >= 25.2 (prints install instructions if missing or outdated)
#        - cargo and rustup wasm32v1-none target
#        - Node.js (>= 20) and npm
#   2. Builds the contract Wasm via `stellar contract build` in contracts/streaming-payments
#   3. Starts or connects to a local Stellar sandbox container (stellar/quickstart via `stellar container start local` or Docker)
#   4. Deploys the contract to the local network
#   5. Writes NEXT_PUBLIC_STREAMING_CONTRACT_ID, RPC URL, and network into frontend/.env.local
#   6. Installs frontend dependencies (npm ci) and starts the development server (npm run dev)
#
# Safe to re-run (idempotent).
#
# Usage:
#   ./scripts/dev.sh [--skip-frontend]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_NETWORK="local"
LOCAL_RPC_URL="http://localhost:8000/rpc"
LOCAL_PASSPHRASE="Standalone Network ; February 2017"
LOCAL_FRIENDBOT_URL="http://localhost:8000/friendbot"
WASM_PATH="contracts/streaming-payments/target/wasm32v1-none/release/streampay_contract.wasm"

# Fallback root path check if built directly into target/
ALT_WASM_PATH="target/wasm32v1-none/release/streampay_contract.wasm"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() {
  printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------- 1. verify prerequisites
say "Verifying development prerequisites"

# Check Node.js & npm
command -v node >/dev/null 2>&1 || die "Node.js not found. Please install Node.js >= 20: https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm not found. Please install npm: https://nodejs.org"

# Check cargo & Rust
command -v cargo >/dev/null 2>&1 || die "cargo not found. Please install Rust >= 1.85: https://rustup.rs"

if command -v rustup >/dev/null 2>&1; then
  if ! rustup target list --installed 2>/dev/null | grep -q wasm32v1-none; then
    warn "wasm32v1-none target missing. Attempting to add target..."
    rustup target add wasm32v1-none || warn "Failed to add wasm32v1-none target automatically. stellar contract build may still work if bundled."
  fi
fi

# Check stellar-cli
if ! command -v stellar >/dev/null 2>&1; then
  cat <<'EOF' >&2

Stellar CLI was not found on your PATH.
soroban-sdk 28 requires `stellar contract build` (stellar-cli >= 25.2.0).

Install instructions:
  - Using cargo:
      cargo install --locked stellar-cli --version ">=25.2.0"
  - Using Homebrew (macOS / Linux):
      brew install stellar-cli
  - Using official installer script:
      curl -fsSL https://github.com/stellar/stellar-cli/raw/main/install.sh | sh

For detailed instructions, see: https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli
EOF
  die "stellar-cli is required but not installed."
fi

# Check stellar-cli version >= 25.2
VERSION_STR="$(stellar version --only-version 2>/dev/null || stellar version 2>/dev/null || stellar --version 2>/dev/null || true)"
VERSION_NUM="$(echo "$VERSION_STR" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1)"

if [ -z "$VERSION_NUM" ]; then
  warn "Could not parse stellar-cli version string ('$VERSION_STR'). Proceeding cautiously..."
else
  MAJOR="$(echo "$VERSION_NUM" | cut -d. -f1)"
  MINOR="$(echo "$VERSION_NUM" | cut -d. -f2)"

  if [ "$MAJOR" -lt 25 ] || { [ "$MAJOR" -eq 25 ] && [ "$MINOR" -lt 2 ]; }; then
    cat <<EOF >&2

Detected stellar-cli version $VERSION_NUM.
soroban-sdk 28 requires stellar contract build with stellar-cli >= 25.2.0.
Plain 'cargo build --target wasm32v1-none' is rejected by the SDK build script.

Please update stellar-cli:
    cargo install --locked stellar-cli
or visit: https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli
EOF
    die "stellar-cli version $VERSION_NUM is too old (>= 25.2.0 required)."
  fi
  info "Found stellar-cli version $VERSION_NUM (>= 25.2.0 requirement met)"
fi

# ---------------------------------------------------------------- 2. build contract
say "Building contract Wasm with stellar contract build"
(cd "$REPO_ROOT/contracts/streaming-payments" && stellar contract build)

RESOLVED_WASM=""
if [ -f "$REPO_ROOT/$WASM_PATH" ]; then
  RESOLVED_WASM="$REPO_ROOT/$WASM_PATH"
elif [ -f "$REPO_ROOT/$ALT_WASM_PATH" ]; then
  RESOLVED_WASM="$REPO_ROOT/$ALT_WASM_PATH"
else
  die "Wasm artifact not found after build. Expected at $WASM_PATH or $ALT_WASM_PATH"
fi
info "Built Wasm: $RESOLVED_WASM"

# ---------------------------------------------------------------- 3. local network / sandbox
say "Checking local Stellar sandbox network"

is_sandbox_ready() {
  curl -s -f -X POST "$LOCAL_RPC_URL" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc": "2.0", "id": 1, "method": "getHealth"}' >/dev/null 2>&1 \
  || curl -s -f "$LOCAL_FRIENDBOT_URL" >/dev/null 2>&1 \
  || curl -s -f "http://localhost:8000/" >/dev/null 2>&1
}

if is_sandbox_ready; then
  info "Local Stellar sandbox is already running on port 8000."
else
  say "Starting local Stellar network sandbox container..."
  if stellar container --help >/dev/null 2>&1; then
    info "Launching container via 'stellar container start local'..."
    stellar container start local || warn "Failed to launch using 'stellar container start local'. Trying fallback..."
  fi

  if ! is_sandbox_ready && command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      if docker ps --format '{{.Names}}' | grep -q 'stellar-local-sandbox'; then
        info "Found existing stellar-local-sandbox container. Starting it..."
        docker start stellar-local-sandbox >/dev/null 2>&1 || true
      else
        info "Running stellar/quickstart container via docker..."
        docker run -d --name stellar-local-sandbox -p 8000:8000 stellar/quickstart --local >/dev/null 2>&1 || true
      fi
    fi
  fi

  # Wait up to 30 seconds for local sandbox to respond
  info "Waiting for local sandbox RPC service to become healthy..."
  HEALTHY=0
  for i in $(seq 1 30); do
    if is_sandbox_ready; then
      HEALTHY=1
      break
    fi
    sleep 1
  done

  if [ "$HEALTHY" -ne 1 ]; then
    cat <<'EOF' >&2

Warning: Local sandbox RPC did not respond on http://localhost:8000.
To run the local sandbox, ensure Docker is running and execute either:
    stellar container start local
or:
    docker run --rm -d -p 8000:8000 --name stellar-local-sandbox stellar/quickstart --local

Continuing with network configuration...
EOF
  else
    info "Local Stellar sandbox is healthy and responding!"
  fi
fi

# Configure local network profile in stellar-cli if not present
if ! stellar network ls 2>/dev/null | grep -qw "$LOCAL_NETWORK"; then
  info "Adding '$LOCAL_NETWORK' network profile to stellar-cli..."
  stellar network add "$LOCAL_NETWORK" \
    --rpc-url "$LOCAL_RPC_URL" \
    --network-passphrase "$LOCAL_PASSPHRASE" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 4. deploy contract
say "Deploying StreamingPayments contract to $LOCAL_NETWORK network"

# Generate or reuse local deployer identity
if ! stellar keys address local-deployer >/dev/null 2>&1; then
  info "Generating local-deployer identity..."
  stellar keys generate local-deployer --network "$LOCAL_NETWORK" >/dev/null 2>&1 \
    || stellar keys generate local-deployer >/dev/null 2>&1
fi

DEPLOYER_ADDR="$(stellar keys address local-deployer 2>/dev/null || echo "")"
if [ -n "$DEPLOYER_ADDR" ]; then
  # Fund via local friendbot if available
  curl -sf "$LOCAL_FRIENDBOT_URL?addr=$DEPLOYER_ADDR" >/dev/null 2>&1 || true
fi

# Deploy contract (idempotent: reuse existing ID from .env.local if valid or redeploy)
CONTRACT_ID=""
if [ -f "$REPO_ROOT/frontend/.env.local" ]; then
  EXISTING_ID="$(grep '^NEXT_PUBLIC_STREAMING_CONTRACT_ID=' "$REPO_ROOT/frontend/.env.local" | cut -d= -f2- | tr -d ' "')"
  if [ -n "$EXISTING_ID" ]; then
    info "Found existing contract id in frontend/.env.local: $EXISTING_ID"
    CONTRACT_ID="$EXISTING_ID"
  fi
fi

if [ -z "$CONTRACT_ID" ]; then
  info "Deploying contract wasm..."
  DEPLOY_ARGS=(
    contract deploy
    --wasm "$RESOLVED_WASM"
    --source local-deployer
    --network "$LOCAL_NETWORK"
  )
  if [ -n "$DEPLOYER_ADDR" ]; then
    DEPLOY_ARGS+=(-- --governor "$DEPLOYER_ADDR")
  fi

  CONTRACT_ID="$(stellar "${DEPLOY_ARGS[@]}" 2>/dev/null | tail -n 1 || true)"

  # Fallback if local network isn't configured in stellar-cli or flags differ
  if [ -z "$CONTRACT_ID" ] || [[ ! "$CONTRACT_ID" =~ ^C[A-Z0-9]{55}$ ]]; then
    CONTRACT_ID="$(stellar contract deploy \
      --wasm "$RESOLVED_WASM" \
      --source local-deployer \
      --rpc-url "$LOCAL_RPC_URL" \
      --network-passphrase "$LOCAL_PASSPHRASE" 2>/dev/null | tail -n 1 || true)"
  fi
fi

if [ -z "$CONTRACT_ID" ] || [[ ! "$CONTRACT_ID" =~ ^C ]]; then
  warn "Contract deploy did not return a standard contract id (local network might not be started yet)."
  warn "Using placeholder/configured contract id. You can re-run ./scripts/dev.sh once the sandbox is up."
  CONTRACT_ID="${CONTRACT_ID:-CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}"
fi

info "Contract ID: $CONTRACT_ID"

# ---------------------------------------------------------------- 5. configure frontend/.env.local
say "Configuring frontend/.env.local"

ENV_LOCAL="$REPO_ROOT/frontend/.env.local"
cat <<EOF > "$ENV_LOCAL"
# Generated automatically by scripts/dev.sh
NEXT_PUBLIC_SOROBAN_RPC_URL=$LOCAL_RPC_URL
NEXT_PUBLIC_NETWORK=STANDALONE
NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT_ID
EOF
info "Wrote configuration to frontend/.env.local"

# ---------------------------------------------------------------- 6. frontend setup & run
say "Setting up frontend dependencies"
cd "$REPO_ROOT/frontend"

info "Running npm ci..."
npm ci

cat <<EOF

──────────────────────────────────────────────────────────────────
  StreamPay Local Demo is ready!

  Network      : $LOCAL_NETWORK ($LOCAL_RPC_URL)
  Contract ID  : $CONTRACT_ID
  Env File     : frontend/.env.local

  Starting local frontend development server on http://localhost:3000
──────────────────────────────────────────────────────────────────
EOF

if [ "${1:-}" = "--skip-frontend" ]; then
  info "Skipping frontend server start (--skip-frontend supplied)."
  exit 0
fi

say "Starting frontend dev server (npm run dev)"
npm run dev
