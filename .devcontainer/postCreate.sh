#!/usr/bin/env bash
# Runs once after the container is created (devcontainer postCreateCommand).
# Goal: < 5 minutes from clone to a fully working environment.
set -euo pipefail

STELLAR_CLI_VERSION="${STELLAR_CLI_VERSION:-28.1.0}"
ARCH="$(uname -m)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- stellar-cli
say "Installing stellar-cli v${STELLAR_CLI_VERSION}"
TARBALL="stellar-cli-${STELLAR_CLI_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz"
curl -fsSL \
  "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/${TARBALL}" \
  | tar xz -C /tmp
sudo install /tmp/stellar /usr/local/bin/stellar
stellar --version

# -------------------------------------------------------------------- wasm build smoke test
# soroban-sdk 28 requires the stellar-cli build path (spec-shaking v2 handshake).
# Verify it works in-container so CI parity is confirmed at image creation time.
say "Smoke-testing wasm build"
(cd "${REPO_ROOT}/contracts/streaming-payments" && stellar contract build)
echo "  wasm OK: $(ls -sh "${REPO_ROOT}/target/wasm32v1-none/release/streampay_contract.wasm")"

# --------------------------------------------------------------------- node deps
say "Installing root workspace npm deps"
# npm ci requires a lockfile; use install on first container creation so
# contributors don't need to generate one manually. The lockfile is written
# and committed after the first run.
if [ -f "${REPO_ROOT}/package-lock.json" ]; then
  (cd "${REPO_ROOT}" && npm ci)
else
  (cd "${REPO_ROOT}" && npm install)
fi
say "Installing frontend npm deps"
(cd "${REPO_ROOT}/frontend" && npm ci)

# --------------------------------------------------------------- local network
say "Starting local Stellar sandbox"
stellar network add local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017" 2>/dev/null || true
stellar network container start local --image stellar/quickstart:testing 2>/dev/null || true

# Give the container a few seconds to be ready; the seed script retries anyway.
sleep 5

# --------------------------------------------------------------- seed streams
say "Seeding local sandbox with 10 demo streams"
"${REPO_ROOT}/scripts/seed-local.sh"

say "Environment ready — run 'npm run dev' inside frontend/ to start the UI"
