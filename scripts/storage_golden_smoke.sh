#!/usr/bin/env bash
# storage_golden_smoke.sh — live-testnet companion to the offline upgrade-replay
# test (issue #210).
#
# The fake-network replay (contracts/streaming-payments/src/storage_golden/replay.rs)
# proves storage survival on a host emulator. This script proves the same
# property on a real chain: it deploys the COMMITTED baseline release wasm,
# writes data through it by reusing scripts/deploy_testnet.sh (identities, SAC
# token, approval, live stream), adds the record kinds that script does not
# touch (fee, scheduled intent, withdrawal), records every read-back value, and
# then upgrades the LIVE instance to the freshly built in-development wasm
# through the contract's own timelocked propose_upgrade / execute_upgrade path.
#
# The 24-hour governance timelock (MIN_UPGRADE_DELAY_SECONDS) is enforced by the
# contract, so the smoke is necessarily two-phase:
#
#   scripts/storage_golden_smoke.sh write     # deploy + write + propose
#   ... 24 h of real ledger time ...
#   scripts/storage_golden_smoke.sh verify    # upgrade + read back + diff
#
# `verify` fails, naming the exact field, if any recorded value moved across the
# upgrade; then it proves the new bytecode still writes (execute_scheduled,
# withdraw_max).
#
# State lives in .storage_golden_smoke/ (gitignored). `write` refuses to run on
# top of an in-flight smoke — delete the directory to start over.
#
# Environment overrides (same conventions as deploy_testnet.sh):
#   DEPLOYER_KEY   Stellar identity alias used as governor/deployer (default: deployer)
#   NETWORK        Stellar network (default: testnet)
#   BASELINE_WASM  baseline artifact to boot (default: the committed fixture)
#   SKIP_BUILD=1   reuse target/wasm32v1-none/release/streampay_contract.wasm
#
# Requires stellar-cli >= 25.2 (tested on 28.1.0), cargo, node, curl, network
# access and testnet funds; identities are created and Friendbot-funded here.
# Nothing in this script runs in CI: it is the manual rehearsal, gated on the
# same 24 h the real promotion is. Use --dry-run for an offline plan print.

. "$(dirname "$0")/lib.sh"

STATE_DIR="${STATE_DIR:-$REPO_ROOT/.storage_golden_smoke}"
NETWORK="${NETWORK:-testnet}"
DEPLOYER_KEY="${DEPLOYER_KEY:-deployer}"
BASELINE_WASM="${BASELINE_WASM:-test_fixtures/storage/baseline/streampay-v0.3.0-baseline.wasm}"
UPGRADE_DELAY="${UPGRADE_DELAY:-86400}"    # the contract-enforced minimum
HORIZON="https://horizon-$NETWORK.stellar.org"
FRIENDBOT="https://friendbot.stellar.org"

MODE=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    write | verify) MODE="$arg" ;;
    --dry-run | -n) DRY_RUN=1 ;;
    *) die "unknown argument: $arg (expected write | verify | --dry-run)" ;;
  esac
done
[ -n "$MODE" ] || die "usage: $0 write | verify | --dry-run"

clean_str() { tr -d '\r'; }

# ------------------------------------------------------------------ readers --

# JSON from one contract read (any view is read-only: no auth, no state change).
invoke_read() {
  stellar contract invoke \
    --id "$CONTRACT_ID" --source "$DEPLOYER_KEY" --network "$NETWORK" -- "$@" 2>&1 | clean_str
}

# Canonicalize a JSON document (sort keys recursively) so only semantic
# differences survive as diffs.
canon() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const sort = (v) => Array.isArray(v) ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
        : v;
    process.stdout.write(JSON.stringify(sort(j)) + "\n");
  '
}

# Leaves of a JSON document as sorted `path=value` lines. Diffs built from
# these name the exact field that moved instead of only "the blobs differ";
# a bare scalar lands under the `value` path.
flatten() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const out = [];
    const walk = (p, v) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(`${p}[${i}]`, x));
      else if (v && typeof v === "object")
        Object.keys(v).sort().forEach((k) => walk(p ? `${p}.${k}` : k, v[k]));
      else out.push(`${p || "value"}=${JSON.stringify(v)}`);
    };
    walk("", j);
    out.sort().forEach((l) => console.log(l));
  '
}

# invoke + canonicalize + remember the read for the verify phase.
# `mode` is `same` (must be byte-identical across the upgrade) or `grow`
# (a time-dependent view that may only move forward).
record() {
  local name="$1" mode="$2"
  shift 2
  local raw
  raw="$(invoke_read "$@")"
  printf '%s\n' "$raw" > "$STATE_DIR/pre.raw.$name.json"
  canon < "$STATE_DIR/pre.raw.$name.json" > "$STATE_DIR/pre.$name.json" \
    || die "read '$name' ($*) is not JSON: $raw"
  printf '%s\t%s\t%s\n' "$name" "$mode" "$*" >> "$STATE_DIR/reads.tsv"
  info "$name = $(head -c 110 "$STATE_DIR/pre.$name.json")"
}

# ------------------------------------------------------------------ actors ---

is_funded() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 \
    "$HORIZON/accounts/$(stellar keys address "$1" | clean_str | tail -n 1)" 2>/dev/null || echo 000)" = 200 ]
}

ensure_identity_and_funding() {
  local who="$1"
  if ! stellar keys address "$who" >/dev/null 2>&1; then
    info "Generating keypair for $who..."
    stellar keys generate "$who" --network "$NETWORK" >/dev/null 2>&1 \
      || die "failed to generate keypair '$who'"
  fi
  local addr
  addr="$(stellar keys address "$who" | clean_str | tail -n 1)"
  if is_funded "$who"; then
    info "Identity '$who' ($addr) is funded."
    return 0
  fi
  info "Requesting Friendbot funding for '$who' ($addr)..."
  curl -sf "$FRIENDBOT?addr=$addr" >/dev/null 2>&1 || true
  local i
  for i in 1 2 3 4 5; do
    if is_funded "$who"; then
      info "Identity '$who' funded."
      return 0
    fi
    sleep 2
  done
  die "could not fund '$who' ($addr) on $NETWORK; friendbot may be rate-limiting"
}

# ------------------------------------------------------------------- preflight

say "Preflight"
require node
[ -f "$REPO_ROOT/$BASELINE_WASM" ] \
  || die "baseline wasm missing at $BASELINE_WASM — it is a committed fixture; check your checkout"
info "baseline: $BASELINE_WASM ($(wc -c < "$REPO_ROOT/$BASELINE_WASM") bytes)"
info "network: $NETWORK   governor: $DEPLOYER_KEY   state: ${STATE_DIR#$REPO_ROOT/}"

if [ "$DRY_RUN" = 1 ]; then
  say "Planned sequence (no network calls)"
  case "$MODE" in
    write)
      info " 1. stellar contract build                       -> $WASM_REL"
      info " 2. stellar contract deploy --wasm <baseline>     -> CONTRACT_ID"
      info " 3. CONTRACT_ID=<baseline> scripts/deploy_testnet.sh   (token + stream + approval)"
      info " 4. mint, set_fee_bps, schedule_stream, withdraw        (via the baseline wasm)"
      info " 5. record 10 read-back values                          -> $STATE_DIR/pre.*.json"
      info " 6. stellar contract install --wasm <dev>          -> hash == sha256(dev wasm)"
      info " 7. propose_upgrade(hash, $UPGRADE_DELAY)                  -> unlock in ${UPGRADE_DELAY}s"
      ;;
    verify)
      info " 1. execute_upgrade                              -> pending_upgrade must be null"
      info " 2. re-read every recorded key, flatten-diff     -> must be empty"
      info " 3. available(stream) must not regress           -> accrual keeps flowing"
      info " 4. execute_scheduled + withdraw_max             -> new bytecode can write"
      ;;
  esac
  exit 0
fi

require stellar
require curl

CONTRACT_ID=""
TOKEN=""
STREAM_ID=""
INTENT_ID=""

# ----------------------------------------------------------------------- write

if [ "$MODE" = "write" ]; then
  require cargo
  if [ -e "$STATE_DIR" ]; then
    die "$STATE_DIR already exists: this would abandon an in-flight smoke run.
Delete it to start a fresh one (the old testnet instance stays on-chain)."
  fi

  say "Building the in-development Wasm"
  if [ "${SKIP_BUILD:-0}" = 1 ] && [ -f "$REPO_ROOT/$WASM_REL" ]; then
    info "SKIP_BUILD=1: reusing $WASM_REL"
  else
    (cd "$REPO_ROOT/contracts/streaming-payments" && stellar contract build)
  fi
  [ -f "$REPO_ROOT/$WASM_REL" ] || die "expected Wasm at $WASM_REL after build"

  ensure_identity_and_funding "$DEPLOYER_KEY"
  DEPLOYER_ADDR="$(stellar keys address "$DEPLOYER_KEY" | clean_str | tail -n 1)"

  say "Deploying the BASELINE release wasm"
  CONTRACT_ID="$(stellar contract deploy \
    --wasm "$REPO_ROOT/$BASELINE_WASM" \
    --source "$DEPLOYER_KEY" --network "$NETWORK" \
    -- --governor "$DEPLOYER_ADDR" | clean_str | tail -n 1)"
  [ -n "$CONTRACT_ID" ] || die "stellar contract deploy returned no contract id"
  info "baseline instance: $CONTRACT_ID"

  mkdir -p "$STATE_DIR"
  printf 'CONTRACT_ID=%s\n' "$CONTRACT_ID" > "$STATE_DIR/state.env"
  : > "$STATE_DIR/reads.tsv"

  say "Writing data through the baseline build (reusing deploy_testnet.sh)"
  # The deploy script creates/funds the actor identities, registers the demo
  # SAC, approves the contract and opens a live stream. Passing CONTRACT_ID
  # makes it reuse our baseline instance instead of deploying the dev build,
  # so every record below is written by the released bytecode.
  demo_out="$(CONTRACT_ID="$CONTRACT_ID" NETWORK="$NETWORK" DEPLOYER_KEY="$DEPLOYER_KEY" \
    "$REPO_ROOT/scripts/deploy_testnet.sh")" \
    || die "deploy_testnet.sh failed against the baseline instance"
  TOKEN="$(printf '%s\n' "$demo_out" | sed -n 's/^ *Token Address *: *//p' | tail -n 1)"
  STREAM_ID="$(printf '%s\n' "$demo_out" | sed -n 's/^ *Stream ID *#: *//p;s/^ *Stream ID *: *#//p' | tail -n 1)"
  [ -n "$TOKEN" ] && [ -n "$STREAM_ID" ] \
    || die "could not parse token/stream from deploy_testnet.sh output"
  SENDER="$(stellar keys address sender | clean_str | tail -n 1)"
  RECIPIENT="$(stellar keys address recipient | clean_str | tail -n 1)"
  ISSUER="$(stellar keys address demo_issuer | clean_str | tail -n 1)"
  info "token=$TOKEN stream=#$STREAM_ID sender=$SENDER"

  say "Extra records the demo path does not touch (fee, intent, withdrawal)"
  # The demo stream escrows the sender's whole mint, so top the balance up and
  # re-approve before scheduling.
  stellar contract invoke --id "$TOKEN" --source demo_issuer --network "$NETWORK" \
    -- mint --to "$SENDER" --amount 4000000000 >/dev/null \
    || die "mint to sender failed"
  stellar contract invoke --id "$TOKEN" --source sender --network "$NETWORK" \
    -- approve --spender "$CONTRACT_ID" --amount 4000000000 --expiration_ledger +5000 >/dev/null \
    || die "re-approval failed"

  NOW="$(date +%s)"
  stellar contract invoke --id "$CONTRACT_ID" --source "$DEPLOYER_KEY" --network "$NETWORK" \
    -- set_fee_bps --caller "$DEPLOYER_ADDR" --new_fee_bps 50 >/dev/null \
    || die "set_fee_bps failed"
  INTENT_ID="$(stellar contract invoke --id "$CONTRACT_ID" --source sender --network "$NETWORK" \
    -- schedule_stream \
       --sender "$SENDER" --recipient "$RECIPIENT" --token "$TOKEN" \
       --deposit_amount 200000000 --start_time "$((NOW + 60))" --end_time "$((NOW + 3600))" \
       --cancelable true --interval 0 --occurrences 1 --fee_budget 1000000 \
       --execute_after "$NOW" --expires_at "$((NOW + UPGRADE_DELAY + 86400))" \
    | clean_str | tail -n 1)"
  [ -n "$INTENT_ID" ] || die "schedule_stream returned no intent id"
  stellar contract invoke --id "$CONTRACT_ID" --source recipient --network "$NETWORK" \
    -- withdraw --stream_id "$STREAM_ID" --amount 1000 >/dev/null \
    || die "withdraw failed"
  info "fee_bps=50 intent=#$INTENT_ID withdrew 1000 from #$STREAM_ID"

  say "Recording pre-upgrade read-backs"
  record total_streams same total_streams
  record schema_version same schema_version
  record stream same get_stream --stream_id "$STREAM_ID"
  record stream_fee same stream_fee --stream_id "$STREAM_ID"
  record available grow available --stream_id "$STREAM_ID"
  record sender_streams same sender_streams --sender "$SENDER" --offset 0 --limit 50
  record recipient_streams same recipient_streams --recipient "$RECIPIENT" --offset 0 --limit 50
  record intent same get_intent --intent_id "$INTENT_ID"
  record sender_intents same sender_intents --sender "$SENDER" --offset 0 --limit 50
  record treasury same treasury_status --token "$TOKEN"

  say "Installing the in-development Wasm and proposing the upgrade"
  DEV_HASH_ONLINE="$(stellar contract install \
    --wasm "$REPO_ROOT/$WASM_REL" --source "$DEPLOYER_KEY" --network "$NETWORK" \
    | clean_str | tail -n 1)"
  DEV_HASH_LOCAL="$(sha256sum "$REPO_ROOT/$WASM_REL" | awk '{print $1}')"
  [ "${DEV_HASH_ONLINE,,}" = "${DEV_HASH_LOCAL,,}" ] \
    || die "installed wasm hash $DEV_HASH_ONLINE != sha256 of the built artifact $DEV_HASH_LOCAL"
  info "in-development wasm hash: $DEV_HASH_ONLINE"

  stellar contract invoke --id "$CONTRACT_ID" --source "$DEPLOYER_KEY" --network "$NETWORK" \
    -- propose_upgrade --caller "$DEPLOYER_ADDR" \
       --new_wasm_hash "$DEV_HASH_ONLINE" --delay_seconds "$UPGRADE_DELAY" >/dev/null \
    || die "propose_upgrade failed"
  info "proposal on ledger: $(invoke_read pending_upgrade | head -c 200)"

  {
    printf 'TOKEN=%s\n' "$TOKEN"
    printf 'SENDER=%s\n' "$SENDER"
    printf 'RECIPIENT=%s\n' "$RECIPIENT"
    printf 'STREAM_ID=%s\n' "$STREAM_ID"
    printf 'INTENT_ID=%s\n' "$INTENT_ID"
    printf 'DEV_HASH=%s\n' "$DEV_HASH_ONLINE"
  } >> "$STATE_DIR/state.env"

  say "Phase 1 complete — the timelock is now running"
  cat <<EOF

  Contract      : $CONTRACT_ID  (running the baseline release wasm)
  Upgrade to    : $DEV_HASH_ONLINE  (in-development build)
  Unlocks at    : $(date -u -d "@$((NOW + UPGRADE_DELAY))" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo "+${UPGRADE_DELAY}s from now")
  Recorded      : $(wc -l < "$STATE_DIR/reads.tsv") reads in ${STATE_DIR#$REPO_ROOT/}

  Run phase 2 after the timelock elapses:
      scripts/storage_golden_smoke.sh verify
EOF
  exit 0
fi

# ---------------------------------------------------------------------- verify

say "Loading smoke state"
[ -f "$STATE_DIR/state.env" ] || die "no smoke state in $STATE_DIR — run '$0 write' first"
. "$STATE_DIR/state.env"
[ -n "$CONTRACT_ID" ] && [ -n "$DEV_HASH" ] || die "smoke state is incomplete"
DEPLOYER_ADDR="$(stellar keys address "$DEPLOYER_KEY" | clean_str | tail -n 1)"

say "Executing the upgrade through the contract's own timelock"
up_out="$(stellar contract invoke --id "$CONTRACT_ID" --source "$DEPLOYER_KEY" --network "$NETWORK" \
  -- execute_upgrade --caller "$DEPLOYER_ADDR" 2>&1)" \
  || die "execute_upgrade failed: $(printf '%s' "$up_out" | tail -n 3)
If the timelock has not elapsed yet, re-run after $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "$(printf '%s\n' "$up_out" | tail -n 1)"

say "The proposal must be consumed"
after_pending="$(invoke_read pending_upgrade)"
if [ "$(printf '%s' "$after_pending" | tr -d ' \n')" != "null" ]; then
  die "pending_upgrade is still set after execute_upgrade: $after_pending"
fi
info "pending_upgrade = null"

say "Re-reading every recorded key and diffing field by field"
failures=()
while IFS=$'\t' read -r name mode args; do
  raw="$(invoke_read $args)"
  printf '%s\n' "$raw" > "$STATE_DIR/post.raw.$name.json"
  canon < "$STATE_DIR/post.raw.$name.json" > "$STATE_DIR/post.$name.json" \
    || die "post-upgrade read '$name' is not JSON: $raw"
  if [ "$mode" = grow ]; then
    # Time-dependent views (accrual) may only move forward across the upgrade.
    pre_leaf="$(flatten < "$STATE_DIR/pre.$name.json" | sed -n 's/^value=//p' | tr -d '\"')"
    post_leaf="$(flatten < "$STATE_DIR/post.$name.json" | sed -n 's/^value=//p' | tr -d '\"')"
    [ -n "$pre_leaf" ] && [ -n "$post_leaf" ] \
      || die "could not read the recorded scalar value of '$name'"
    if [ "$post_leaf" -lt "$pre_leaf" ]; then
      failures+=("$name: value REGRESSED across the upgrade ($pre_leaf -> $post_leaf)")
    else
      info "$name kept flowing: $pre_leaf -> $post_leaf"
    fi
    continue
  fi
  d="$(diff <(flatten < "$STATE_DIR/pre.$name.json") <(flatten < "$STATE_DIR/post.$name.json") || true)"
  if [ -n "$d" ]; then
    failures+=("$name:$(printf '%s' "$d" | tr '\n' ' ')")
    warn "$name changed across the upgrade:"
    printf '%s\n' "$d" | sed 's/^/      /'
  else
    info "$name identical"
  fi
done < "$STATE_DIR/reads.tsv"

if [ "${#failures[@]}" -ne 0 ]; then
  die "testnet upgrade replay LOST or CHANGED stored data (${#failures[@]} record(s)):
$(printf '  %s\n' "${failures[@]}")
Full field dumps: $STATE_DIR/{pre,post}.*.json"
fi

say "Post-upgrade writes on the new bytecode"
stellar contract invoke --id "$CONTRACT_ID" --source "$DEPLOYER_KEY" --network "$NETWORK" \
  -- execute_scheduled --intent_id "$INTENT_ID" --keeper "$DEPLOYER_ADDR" >/dev/null \
  || die "execute_scheduled failed on the upgraded build"
new_total="$(invoke_read total_streams | tr -d '\" \n')"
old_total="$(flatten < "$STATE_DIR/pre.total_streams.json" | sed -n 's/^value=//p' | tr -d '\" ')"
[ "$new_total" -gt "$old_total" ] \
  || die "scheduled stream did not materialize on the new bytecode ($old_total -> $new_total)"
info "total_streams $old_total -> $new_total; the upgraded contract still writes"

stellar contract invoke --id "$CONTRACT_ID" --source recipient --network "$NETWORK" \
  -- withdraw_max --stream_id "$STREAM_ID" >/dev/null \
  || die "withdraw_max failed on the upgraded build"
final_status="$(invoke_read get_stream --stream_id "$STREAM_ID")"
info "withdraw_max succeeded on #${STREAM_ID}; stream now: $(printf '%s' "$final_status" | head -c 160)"

say "Storage-layout smoke passed on $NETWORK"
echo "  Contract   : $CONTRACT_ID"
echo "  Baseline   : $BASELINE_WASM"
echo "  Upgraded to: $DEV_HASH"
echo "  Evidence   : ${STATE_DIR#$REPO_ROOT/}/pre.*.json, post.*.json"
