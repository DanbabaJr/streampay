#!/usr/bin/env bash
# keeper.sh — reference keeper for StreamPay scheduled intents.
#
# A keeper watches scheduled intents and, for each one that is currently
# executable, calls `execute_scheduled`, which creates the stream and pays the
# keeper the escrowed per-occurrence fee. Execution is permissionless: the
# keeper only has to authorize (and pay the network fee for) the call.
#
# Usage:
#   INTENTS="1 2 3" ./scripts/keeper.sh          # watch explicit intent ids
#   SENDER=G... ./scripts/keeper.sh              # auto-discover a sender's intents
#   ONCE=1 INTENTS="1" ./scripts/keeper.sh       # one pass, then exit
#
# Configuration (env vars):
#   CONTRACT_ID   (required) streaming contract id.
#   NETWORK       network to target (default: testnet).
#   KEEPER        stellar identity to sign with (default: keeper).
#   INTENTS       space/comma separated intent ids to watch.
#   SENDER        if set and INTENTS is empty, watch every intent of this sender.
#   RATE          poll interval in seconds (default: 5).
#   MIN_FEE       skip occurrences whose per-occurrence fee is below this
#                 (default: 0 — execute anything). Requires jq.
#   RECLAIM       "1" to also reclaim pending intents past their expiry
#                 (refunds the sender; no keeper reward). Default: 0.
#   ONCE          "1" to run a single pass and exit. Default: 0.
#
# Discovery: this script watches explicit intent ids, or enumerates a sender's
# intents with `sender_intents`. A production keeper should instead subscribe to
# the contract's `StreamScheduled` events so it never misses one:
#
#   stellar contract events --id "$CONTRACT_ID" --network "$NETWORK" \
#     --start-ledger <L> --topic-1 stream_scheduled
#
# Requires: stellar CLI, jq (recommended), and network access.

set -euo pipefail

CONTRACT_ID="${CONTRACT_ID:-}"
NETWORK="${NETWORK:-testnet}"
KEEPER="${KEEPER:-keeper}"
INTENTS="${INTENTS:-}"
SENDER="${SENDER:-}"
RATE="${RATE:-5}"
MIN_FEE="${MIN_FEE:-0}"
RECLAIM="${RECLAIM:-0}"
ONCE="${ONCE:-0}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
command -v stellar >/dev/null 2>&1 || die "stellar CLI not found. Install: cargo install stellar-cli --locked"
[ -n "$CONTRACT_ID" ] || die "CONTRACT_ID is required (the streaming contract id)"
[ -n "$INTENTS" ] || [ -n "$SENDER" ] || die "provide INTENTS=\"id id ...\" or SENDER=<address>"

HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
else
  warn "jq not found; MIN_FEE and status filters are disabled (execution still uses on-chain simulation)"
fi

if ! stellar keys address "$KEEPER" >/dev/null 2>&1; then
  say "Generating keeper identity '$KEEPER'"
  stellar keys generate "$KEEPER" --network "$NETWORK" >/dev/null
fi
KEEPER_ADDR="$(stellar keys address "$KEEPER")"

invoke() { stellar contract invoke --id "$CONTRACT_ID" --network "$NETWORK" "$@"; }

# Read one field from get_intent, tolerating a Result::Ok wrapper and unit enums.
intent_field() { # $1=intent_id $2=jq filter
  [ "$HAVE_JQ" = 1 ] || return 0
  invoke -- get_intent --intent_id "$1" 2>/dev/null \
    | jq -r "(.Ok // .) | $2" 2>/dev/null || true
}

discover() {
  say "Discovering intents for sender $SENDER"
  local ids
  ids="$(invoke -- sender_intents --sender "$SENDER" --offset 0 --limit 100 2>/dev/null \
    | jq -r '(.Ok // .) | .[]?' 2>/dev/null || true)"
  # shellcheck disable=SC2086
  printf '%s\n' $ids
}

execute_one() { # $1=intent_id
  local id="$1" status fee simulate_out

  if [ "$HAVE_JQ" = 1 ]; then
    status="$(intent_field "$id" 'if (.status|type)=="object" then (.status|keys[0]) else (.status|tostring) end')"
    case "$status" in
      Pending) ;;
      "") info "intent #$id: could not read status; relying on simulation" ;;
      *) info "intent #$id: status=$status, skip"; return 0 ;;
    esac

    fee="$(intent_field "$id" '.fee_budget // 0')"
    if [ -n "$fee" ] && [ "$fee" != "0" ] && [ "$MIN_FEE" != "0" ] \
       && [ "$(awk "BEGIN{print ($fee < $MIN_FEE)}")" = "1" ]; then
      info "intent #$id: fee $fee < MIN_FEE $MIN_FEE, skip"
      return 0
    fi

    if [ "$RECLAIM" = 1 ]; then
      local expires now
      expires="$(intent_field "$id" '.expires_at // 0')"
      now="$(date +%s)"
      if [ -n "$expires" ] && [ "$expires" != "0" ] && [ "$now" -ge "$expires" ]; then
        say "intent #$id expired; reclaiming (refund -> sender)"
        if invoke --source "$KEEPER" -- reclaim_expired --intent_id "$id" >/dev/null 2>&1; then
          info "intent #$id reclaimed"
        else
          info "intent #$id reclaim reverted; likely already terminal"
        fi
        return 0
      fi
    fi
  fi

  # Simulate first (`--send=no`): this is the source of truth for executability
  # (pending, due for the next occurrence, not expired) and avoids burning the
  # network fee on a call that would revert.
  if ! simulate_out="$(invoke --send=no --source "$KEEPER" -- \
        execute_scheduled --intent_id "$id" --keeper "$KEEPER_ADDR" 2>&1)"; then
    info "intent #$id not executable (not due / not pending); skip"
    return 0
  fi

  say "intent #$id is executable; sending execute_scheduled"
  if invoke --source "$KEEPER" -- \
       execute_scheduled --intent_id "$id" --keeper "$KEEPER_ADDR" >/dev/null 2>&1; then
    info "intent #$id executed -> fee paid to $KEEPER_ADDR"
  else
    # Someone else may have executed it between our simulation and send; that is
    # expected and harmless (execute is once-per-occurrence).
    info "intent #$id send reverted; likely executed by another keeper meanwhile"
  fi
}

main() {
  say "StreamPay keeper"
  info "contract : $CONTRACT_ID"
  info "network  : $NETWORK"
  info "keeper   : $KEEPER ($KEEPER_ADDR)"
  info "min_fee  : $MIN_FEE   reclaim: $RECLAIM   once: $ONCE"

  while :; do
    local ids=""
    if [ -n "$INTENTS" ]; then
      ids="$(printf '%s' "$INTENTS" | tr ',' ' ')"
    else
      ids="$(discover)"
    fi

    if [ -z "$ids" ]; then
      info "no intents to watch this pass"
    else
      for id in $ids; do
        execute_one "$id" || warn "intent #$id: unexpected error; continuing"
      done
    fi

    [ "$ONCE" = 1 ] && break
    sleep "$RATE"
  done
}

main
