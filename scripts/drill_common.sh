#!/bin/bash
# drill_common.sh - Shared utilities for incident response drill scripts
#
# This script provides common functions used across all drill scenarios.
# Source this file in your drill scripts: source ./scripts/drill_common.sh

# Logging function with timestamp
log() {
  local message="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $message" | tee -a "${LOG_FILE:-/dev/stderr}"
}

# Log drill start
log_start() {
  local drill_name="$1"
  log "=== START: $drill_name ==="
  DRILL_START_TIME=$(date +%s)
}

# Log drill end with duration
log_end() {
  local drill_name="$1"
  local end_time=$(date +%s)
  local duration=$((end_time - DRILL_START_TIME))
  log "=== END: $drill_name (duration: ${duration}s) ==="
}

# Fund an account via friendbot
fund_account() {
  local account_name="$1"
  local addr=$(stellar keys address "$account_name" 2>/dev/null || echo "")

  if [ -z "$addr" ]; then
    log "ERROR: Account $account_name not found"
    return 1
  fi

  log "Funding account $account_name ($addr) via friendbot..."
  curl -sf "https://friendbot.stellar.org?addr=$addr" > /dev/null 2>&1 || {
    log "WARNING: Friendbot funding failed for $account_name"
  }
}

# Create a test stream
create_test_stream() {
  local contract_id="$1"
  local sender="$2"
  local recipient="$3"
  local token_id="${4:-}"

  # Ensure keys exist
  if ! stellar keys address "$sender" >/dev/null 2>&1; then
    log "Generating key for $sender..."
    stellar keys generate "$sender" --network testnet
  fi

  if ! stellar keys address "$recipient" >/dev/null 2>&1; then
    log "Generating key for $recipient..."
    stellar keys generate "$recipient" --network testnet
  fi

  # Fund accounts
  fund_account "$sender"
  fund_account "$recipient"

  # If no token provided, use a demo token (caller must provide or create)
  if [ -z "$token_id" ]; then
    log "ERROR: No token ID provided. Cannot create stream."
    return 1
  fi

  local sender_addr=$(stellar keys address "$sender")
  local recipient_addr=$(stellar keys address "$recipient")

  # Mint tokens to sender (requires issuer key)
  log "Minting tokens to $sender..."
  stellar contract invoke \
    --id "$token_id" \
    --source demo_issuer \
    --network testnet \
    -- mint --to "$sender_addr" --amount 1000000000 || {
    log "ERROR: Failed to mint tokens to $sender"
    return 1
  }

  # Approve contract to spend tokens
  log "Approving contract $contract_id..."
  stellar contract invoke \
    --id "$token_id" \
    --source "$sender" \
    --network testnet \
    -- approve --spender "$contract_id" --amount 1000000000 --expiration_ledger +5000 || {
    log "ERROR: Failed to approve contract"
    return 1
  }

  # Create stream
  local now=$(date +%s)
  local end=$((now + 3600))  # 1-hour stream

  log "Creating stream from $sender to $recipient..."
  local stream_id=$(stellar contract invoke \
    --id "$contract_id" \
    --source "$sender" \
    --network testnet \
    -- create_stream \
    --sender "$sender_addr" \
    --recipient "$recipient_addr" \
    --token "$token_id" \
    --deposit_amount 1000000000 \
    --start_time "$now" \
    --end_time "$end" \
    --cancelable true 2>&1 | tail -n 1)

  if [ -z "$stream_id" ]; then
    log "ERROR: Failed to create stream"
    return 1
  fi

  log "Created stream $stream_id"
  echo "$stream_id"
}

# Check if an account is in a list of compromised accounts
is_compromised() {
  local account="$1"
  local compromised_list="${2:-compromised_accounts.txt}"

  if [ -f "$compromised_list" ]; then
    grep -q "^$account$" "$compromised_list"
    return $?
  fi

  return 1
}

# Compare stream data from two sources
compare_stream() {
  local data1="$1"
  local data2="$2"

  # Compare critical fields (simplified - in production would use jq)
  # For now, just check if the JSON strings are equal
  [ "$data1" = "$data2" ]
}

# Get stream status
get_stream_status() {
  local contract_id="$1"
  local stream_id="$2"

  stellar contract invoke \
    --id "$contract_id" \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id "$stream_id" 2>/dev/null | \
    jq -r '.status' 2>/dev/null || echo "Unknown"
}

# Cancel a stream
cancel_stream() {
  local contract_id="$1"
  local stream_id="$2"
  local caller="$3"

  log "Cancelling stream $stream_id by $caller..."
  stellar contract invoke \
    --id "$contract_id" \
    --source "$caller" \
    --network testnet \
    -- cancel_stream \
    --caller "$(stellar keys address "$caller")" \
    --stream_id "$stream_id"
}

# Withdraw max from a stream
withdraw_max() {
  local contract_id="$1"
  local stream_id="$2"
  local recipient="$3"

  log "Withdrawing max from stream $stream_id..."
  stellar contract invoke \
    --id "$contract_id" \
    --source "$recipient" \
    --network testnet \
    -- withdraw_max --stream_id "$stream_id"
}

# Export functions for use in other scripts
export -f log
export -f log_start
export -f log_end
export -f fund_account
export -f create_test_stream
export -f is_compromised
export -f compare_stream
export -f get_stream_status
export -f cancel_stream
export -f withdraw_max
