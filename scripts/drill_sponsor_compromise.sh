#!/bin/bash
# drill_sponsor_compromise.sh - Scenario 2: Sponsor-Key Compromise Drill
#
# Simulates sponsor key compromise and tests containment procedures.
#
# Usage: ./scripts/drill_sponsor_compromise.sh <contract_id> <token_id>

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/drill_common.sh"

# Validate arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 <contract_id> <token_id>"
  echo "  contract_id: The StreamPay contract ID on testnet"
  echo "  token_id: The token contract ID to use for the drill"
  exit 1
fi

CONTRACT_ID="$1"
TOKEN_ID="$2"

echo "=== Scenario 2: Sponsor-Key Compromise Drill ==="
echo "Contract ID: $CONTRACT_ID"
echo "Token ID: $TOKEN_ID"
echo "Network: testnet"
echo ""

# Setup logging
TIMESTAMP=$(date +%s)
LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/drill_sponsor_$TIMESTAMP.log"

log_start "Sponsor-Key Compromise Drill"

# Step 1: Create "compromised" sponsor key
log "Step 1: Creating compromised sponsor key..."
stellar keys generate compromised_sponsor --network testnet
COMPROMISED_SPONSOR=$(stellar keys address compromised_sponsor)
log "Compromised sponsor address: $COMPROMISED_SPONSOR"

# Step 2: Fund accounts using compromised sponsor
log "Step 2: Funding accounts with compromised sponsor..."
COMPROMISED_ACCOUNTS=()
for i in {1..5}; do
  account_name="compromised_account_$i"
  stellar keys generate "$account_name" --network testnet
  addr=$(stellar keys address "$account_name")
  COMPROMISED_ACCOUNTS+=("$addr")

  log "Funding $account_name ($addr)..."
  fund_account "$account_name"
  log "Funded $account_name"
done

# Step 3: Create malicious streams using compromised accounts
log "Step 3: Creating malicious streams from compromised accounts..."
MALICIOUS_STREAMS=()
for i in {1..5}; do
  account_name="compromised_account_$i"
  recipient_name="drill_recipient_$i"

  log "Creating malicious stream from $account_name..."
  stream_id=$(create_test_stream "$CONTRACT_ID" "$account_name" "$recipient_name" "$TOKEN_ID")
  if [ -z "$stream_id" ]; then
    log "ERROR: Failed to create malicious stream from $account_name"
    exit 1
  fi
  MALICIOUS_STREAMS+=("$stream_id")
  log "Created malicious stream $stream_id"
done

# Step 4: Detection (identify unusual pattern)
log "Step 4: Detection phase - checking for suspicious stream creation..."
MALICIOUS_COUNT=${#MALICIOUS_STREAMS[@]}
log "Detected: $MALICIOUS_COUNT streams created from newly-funded accounts in 1 minute"

# Check if threshold for containment is met
SUSPICIOUS_THRESHOLD=3
if [ "$MALICIOUS_COUNT" -ge "$SUSPICIOUS_THRESHOLD" ]; then
  log "SUSPICIOUS ACTIVITY DETECTED: $MALICIOUS_COUNT streams from new accounts (threshold: $SUSPICIOUS_THRESHOLD)"
else
  log "WARNING: Suspicious activity threshold not met"
fi

# Step 5: Containment (cancel malicious streams)
log "Step 5: Containment - cancelling malicious streams..."
CANCELLED_STREAMS=()
for i in {0..4}; do
  stream_id="${MALICIOUS_STREAMS[$i]}"
  account_name="compromised_account_$((i+1))"

  log "Cancelling malicious stream $stream_id from $account_name..."
  if cancel_stream "$CONTRACT_ID" "$stream_id" "$account_name" >> "$LOG_FILE" 2>&1; then
    CANCELLED_STREAMS+=("$stream_id")
    log "Successfully cancelled malicious stream $stream_id"
  else
    log "WARNING: Failed to cancel malicious stream $stream_id"
  fi
done

# Step 6: Key rotation (simulate)
log "Step 6: Key rotation - rotating to new sponsor key..."
stellar keys generate new_sponsor --network testnet
NEW_SPONSOR=$(stellar keys address new_sponsor)
log "New sponsor address: $NEW_SPONSOR"
log "ACTION REQUIRED: Update infrastructure to use new_sponsor (manual step in production)"

# Document compromised accounts for reference
COMPROMISED_LIST="$LOG_DIR/compromised_accounts_$TIMESTAMP.txt"
for addr in "${COMPROMISED_ACCOUNTS[@]}"; do
  echo "$addr" >> "$COMPROMISED_LIST"
done
log "Compromised accounts saved to $COMPROMISED_LIST"

# Step 7: Verification
log "Step 7: Verification - checking all malicious streams are cancelled..."
ALL_CANCELLED=true
STATUS_REPORT=""

for stream_id in "${MALICIOUS_STREAMS[@]}"; do
  status=$(get_stream_status "$CONTRACT_ID" "$stream_id")
  STATUS_REPORT="$STATUS_REPORT\nMalicious stream $stream_id: $status"

  if [ "$status" != "Cancelled" ]; then
    log "ERROR: Malicious stream $stream_id not cancelled: $status"
    ALL_CANCELLED=false
  else
    log "Malicious stream $stream_id: $status (contained)"
  fi
done

log "Status Report:$STATUS_REPORT"

# Final result
if [ "$ALL_CANCELLED" = true ]; then
  log "SUCCESS: All malicious streams contained"
  RESULT="PASS"
else
  log "FAILURE: Some malicious streams not contained"
  RESULT="FAIL"
fi

log_end "Sponsor-Key Compromise Drill"

# Print summary
echo ""
echo "=== Drill Summary ==="
echo "Result: $RESULT"
echo "Compromised sponsor: $COMPROMISED_SPONSOR"
echo "New sponsor: $NEW_SPONSOR"
echo "Compromised accounts: ${#COMPROMISED_ACCOUNTS[@]}"
echo "Malicious streams created: $MALICIOUS_COUNT"
echo "Malicious streams cancelled: ${#CANCELLED_STREAMS[@]}"
echo "All malicious streams contained: $ALL_CANCELLED"
echo "Compromised accounts list: $COMPROMISED_LIST"
echo "Log file: $LOG_FILE"
echo ""

if [ "$RESULT" = "FAIL" ]; then
  exit 1
fi
