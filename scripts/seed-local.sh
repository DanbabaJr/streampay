#!/usr/bin/env bash
# seed-local.sh — deploy the real contract to the local Stellar sandbox and
# open 10 demo streams that cover the interesting lifecycle states a new
# contributor wants to see in the UI.
#
# Designed to be called from:
#   .devcontainer/postCreate.sh   (automatic, first boot)
#   .gitpod.yml                   (automatic, workspace init)
#   npm run seed                  (manual re-seed any time)
#
# Requires: stellar-cli >= 25.2 (v28.1.0 pinned by this repo), bash, curl.
# The local sandbox must already be running on port 8000 (quickstart container).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="${REPO_ROOT}/target/wasm32v1-none/release/streampay_contract.wasm"
NETWORK="local"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"
RPC_URL="http://localhost:8000/soroban/rpc"
ENV_LOCAL="${REPO_ROOT}/frontend/.env.local"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight
say "Checking prerequisites"
command -v stellar >/dev/null 2>&1 || die "stellar not found — run .devcontainer/postCreate.sh first"

# Register the local network config (idempotent — silently skips if already set).
stellar network add "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null || true

# Wait for the RPC to be reachable (quickstart can take ~15 s to boot).
say "Waiting for local sandbox RPC"
for i in $(seq 1 30); do
  curl -sf "$RPC_URL" -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":{}}' \
    -o /dev/null && break
  [ "$i" -lt 30 ] || die "sandbox RPC at $RPC_URL did not become ready after 30 retries"
  sleep 2
done
info "RPC is up"

# ---------------------------------------------------------------- build wasm
if [ ! -f "$WASM" ]; then
  say "Building contract Wasm (not cached)"
  (cd "${REPO_ROOT}/contracts/streaming-payments" && stellar contract build)
fi
info "wasm: $(ls -sh "$WASM")"

# ------------------------------------------------------------------ identities
say "Creating sandbox identities"
for name in seed-deployer seed-governor seed-issuer seed-alice seed-bob seed-carol seed-dave; do
  if ! stellar keys address "$name" >/dev/null 2>&1; then
    stellar keys generate "$name" --network "$NETWORK"
  fi
  # Fund via the local quickstart's Friendbot endpoint.
  curl -sf "http://localhost:8000/friendbot?addr=$(stellar keys address "$name")" \
    -o /dev/null || true
done

GOVERNOR="$(stellar keys address seed-governor)"
ALICE="$(stellar keys address seed-alice)"
BOB="$(stellar keys address seed-bob)"
CAROL="$(stellar keys address seed-carol)"
DAVE="$(stellar keys address seed-dave)"

# -------------------------------------------------------------------- deploy
say "Deploying StreamingPayments contract (governor = seed-governor)"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source seed-deployer \
  --network "$NETWORK" \
  -- --governor "$GOVERNOR" | tail -n 1)"
[ -n "$CONTRACT_ID" ] || die "contract deploy returned empty id"
info "contract id: $CONTRACT_ID"

# ---------------------------------------------------------------------- token
say "Creating demo SAC token (STRM)"
# wrap the native XLM SAC for simplicity — always available on any quickstart
TOKEN="$(stellar contract asset deploy \
  --asset native \
  --source seed-issuer \
  --network "$NETWORK" | tail -n 1)"
[ -n "$TOKEN" ] || die "asset deploy returned empty id"
info "token id: $TOKEN"

# Mint a generous supply to each sender so the approve+stream calls go through.
SUPPLY=10000000000000   # 1 000 000.0000000 (7-decimal SAC)
for addr in "$ALICE" "$BOB" "$CAROL" "$DAVE"; do
  stellar contract invoke \
    --id "$TOKEN" --source seed-issuer --network "$NETWORK" \
    -- mint --to "$addr" --amount "$SUPPLY" 2>/dev/null || true
done

# Helper: approve and immediately create a stream, then echo the stream id.
# Usage: make_stream <from-key> <from-addr> <to-addr> <deposit> <start-offset> <end-offset> <cancelable>
make_stream() {
  local src_key="$1" src_addr="$2" dst_addr="$3"
  local deposit="$4" start_off="$5" end_off="$6" cancelable="$7"
  local NOW; NOW="$(date +%s)"
  local START=$(( NOW + start_off ))
  local END=$(( NOW + end_off ))

  # Approve the streaming contract to pull deposit from sender.
  stellar contract invoke \
    --id "$TOKEN" --source "$src_key" --network "$NETWORK" \
    -- approve \
       --from "$src_addr" \
       --spender "$CONTRACT_ID" \
       --amount "$deposit" \
       --expiration_ledger 999999 >/dev/null

  # create_stream — use sender's key so auth passes.
  local sid
  sid="$(stellar contract invoke \
    --id "$CONTRACT_ID" --source "$src_key" --network "$NETWORK" \
    -- create_stream \
       --sender    "$src_addr" \
       --recipient "$dst_addr" \
       --token     "$TOKEN" \
       --deposit_amount "$deposit" \
       --start_time     "$START" \
       --end_time       "$END" \
       --cancelable     "$cancelable" | tail -n 1)"
  printf '%s' "$sid"
}

# ----------------------------------------------------------------- 10 streams
# Stream mix chosen to demonstrate every interesting UI state:
#   1  Alice→Bob    running short  (30 min, cancelable)      — accruing right now
#   2  Alice→Carol  running long   (8 h, cancelable)         — slow drip
#   3  Alice→Dave   running long   (24 h, not cancelable)    — locked
#   4  Bob→Alice    future         (starts +5 min, 1 h)      — nothing accrued yet
#   5  Bob→Carol    future long    (starts +30 min, 4 h)     — nothing accrued yet
#   6  Carol→Alice  tiny deposit   (1 000 units, 10 min)     — fast-depleting
#   7  Carol→Bob    large deposit  (50 000 000, 48 h)        — payroll-style
#   8  Dave→Alice   ~instant       (1 s window)              — fully accrued, claimable
#   9  Dave→Bob     running medium (2 h, cancelable)         — mid-stream
#  10  Dave→Carol   running with top-up                      — shows top_up path

say "Opening 10 demo streams"

# 1 — Alice → Bob, 30-minute run, cancelable
S1=$(make_stream seed-alice "$ALICE" "$BOB"   1000000000    0    1800  true)
info "stream 1 (alice→bob, 30 min):    id $S1"

# 2 — Alice → Carol, 8-hour run, cancelable
S2=$(make_stream seed-alice "$ALICE" "$CAROL"  5000000000    0   28800  true)
info "stream 2 (alice→carol, 8 h):     id $S2"

# 3 — Alice → Dave, 24-hour run, non-cancelable
S3=$(make_stream seed-alice "$ALICE" "$DAVE"  10000000000    0   86400 false)
info "stream 3 (alice→dave, 24 h):     id $S3"

# 4 — Bob → Alice, starts in +5 min, 1 hour
S4=$(make_stream seed-bob   "$BOB"   "$ALICE"  2000000000  300    3900  true)
info "stream 4 (bob→alice, future):    id $S4"

# 5 — Bob → Carol, starts in +30 min, 4 hours
S5=$(make_stream seed-bob   "$BOB"   "$CAROL"  8000000000 1800   16200  true)
info "stream 5 (bob→carol, future):    id $S5"

# 6 — Carol → Alice, tiny / fast (10 min)
S6=$(make_stream seed-carol "$CAROL" "$ALICE"     10000       0     600  true)
info "stream 6 (carol→alice, tiny):    id $S6"

# 7 — Carol → Bob, large payroll-style (48 h)
S7=$(make_stream seed-carol "$CAROL" "$BOB"   50000000000    0  172800 false)
info "stream 7 (carol→bob, 48 h):      id $S7"

# 8 — Dave → Alice, 1-second window (effectively instant — fully accrued the
#     moment it starts; demonstrates a stream the recipient can drain immediately)
S8=$(make_stream seed-dave  "$DAVE"  "$ALICE"  3000000000    0       1  true)
info "stream 8 (dave→alice, ~instant): id $S8"

# 9 — Dave → Bob, 2-hour run, cancelable
S9=$(make_stream seed-dave  "$DAVE"  "$BOB"    4000000000    0    7200  true)
info "stream 9 (dave→bob, 2 h):        id $S9"

# 10 — Dave → Carol, 6-hour run then topped up
S10=$(make_stream seed-dave "$DAVE"  "$CAROL"  1000000000    0   21600  true)
info "stream 10 (dave→carol, pre top-up): id $S10"

# Top-up stream 10 — approve the extra amount then call top_up.
stellar contract invoke \
  --id "$TOKEN" --source seed-dave --network "$NETWORK" \
  -- approve \
     --from "$DAVE" \
     --spender "$CONTRACT_ID" \
     --amount 500000000 \
     --expiration_ledger 999999 >/dev/null
stellar contract invoke \
  --id "$CONTRACT_ID" --source seed-dave --network "$NETWORK" \
  -- top_up \
     --stream_id "$S10" \
     --amount 500000000 >/dev/null
info "stream 10 topped up (+500000000)"

# ------------------------------------------------------- write .env.local
say "Writing frontend/.env.local"
cat > "$ENV_LOCAL" <<ENV
# Generated by scripts/seed-local.sh — do not commit.
NEXT_PUBLIC_SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc
NEXT_PUBLIC_NETWORK=STANDALONE
NEXT_PUBLIC_STREAMING_CONTRACT_ID=${CONTRACT_ID}
ENV
info "wrote ${ENV_LOCAL}"

# ------------------------------------------------------------------ summary
cat <<EOF

┌─────────────────────────────────────────────────────────────────┐
│  Local sandbox seeded with 10 demo streams                      │
│                                                                 │
│  Contract  : ${CONTRACT_ID}
│  Token     : ${TOKEN}
│                                                                 │
│  Actors                                                         │
│    Alice   : ${ALICE}
│    Bob     : ${BOB}
│    Carol   : ${CAROL}
│    Dave    : ${DAVE}
│                                                                 │
│  Streams   : ids ${S1} – ${S10} (run  npm run matrix to see all)         │
│                                                                 │
│  Start the frontend:                                            │
│    cd frontend && npm run dev                                   │
│    — or —                                                       │
│    npm run dev       (from repo root via matrix)                │
└─────────────────────────────────────────────────────────────────┘
EOF
