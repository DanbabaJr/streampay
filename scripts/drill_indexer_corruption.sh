#!/bin/bash
# drill_indexer_corruption.sh - Scenario 3: Indexer Corruption Drill
#
# Simulates indexer data corruption and tests rebuild procedures.
#
# Usage: ./scripts/drill_indexer_corruption.sh <contract_id> <token_id> [indexer_db_path]

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/drill_common.sh"

# Validate arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 <contract_id> <token_id> [indexer_db_path]"
  echo "  contract_id: The StreamPay contract ID on testnet"
  echo "  token_id: The token contract ID to use for the drill"
  echo "  indexer_db_path: Optional path to indexer SQLite database (for simulation)"
  exit 1
fi

CONTRACT_ID="$1"
TOKEN_ID="$2"
INDEXER_DB="${3:-/tmp/streampay_indexer_test.db}"

echo "=== Scenario 3: Indexer Corruption Drill ==="
echo "Contract ID: $CONTRACT_ID"
echo "Token ID: $TOKEN_ID"
echo "Indexer DB path: $INDEXER_DB"
echo "Network: testnet"
echo ""

# Setup logging
TIMESTAMP=$(date +%s)
LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/drill_indexer_$TIMESTAMP.log"

log_start "Indexer Corruption Drill"

# Step 1: Create test streams for indexer to track
log "Step 1: Creating test streams for indexer..."
STREAM_IDS=()
for i in {1..5}; do
  log "Creating stream $i..."
  stream_id=$(create_test_stream "$CONTRACT_ID" "drill_sender_$i" "drill_recipient_$i" "$TOKEN_ID")
  if [ -z "$stream_id" ]; then
    log "ERROR: Failed to create stream $i"
    exit 1
  fi
  STREAM_IDS+=("$stream_id")
  log "Created stream $stream_id"
done

# Step 2: Simulate indexer sync
log "Step 2: Simulating indexer sync..."
sleep 2

# Create a mock indexer database for simulation
if [ ! -f "$INDEXER_DB" ]; then
  log "Creating mock indexer database at $INDEXER_DB..."
  sqlite3 "$INDEXER_DB" <<EOF
CREATE TABLE IF NOT EXISTS streams (
  stream_id INTEGER PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  token TEXT NOT NULL,
  deposit INTEGER NOT NULL,
  withdrawn INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  data TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
EOF

  # Insert mock data
  for stream_id in "${STREAM_IDS[@]}"; do
    sqlite3 "$INDEXER_DB" <<EOF
INSERT INTO streams (stream_id, sender, recipient, token, deposit, withdrawn, start_time, end_time, status, created_at)
VALUES ($stream_id, 'sender_$stream_id', 'recipient_$stream_id', '$TOKEN_ID', 1000000000, 0, $(date +%s), $(($(date +%s) + 3600)), 'Active', $(date +%s));
EOF
  done

  log "Mock indexer database created with ${#STREAM_IDS[@]} streams"
else
  log "Using existing indexer database at $INDEXER_DB"
fi

# Step 3: Simulate corruption
log "Step 3: Simulating corruption - modifying indexer state..."
BACKUP_DB="$INDEXER_DB.backup_before_corruption"
cp "$INDEXER_DB" "$BACKUP_DB"

# Corrupt the database by deleting some streams
CORRUPT_COUNT=2
for i in {0..1}; do
  stream_id="${STREAM_IDS[$i]}"
  sqlite3 "$INDEXER_DB" "DELETE FROM streams WHERE stream_id = $stream_id;"
  log "Corrupted: removed stream $stream_id from indexer"
done

# Verify corruption
STREAM_COUNT=$(sqlite3 "$INDEXER_DB" "SELECT COUNT(*) FROM streams;")
EXPECTED_COUNT=${#STREAM_IDS[@]}
log "Indexer now has $STREAM_COUNT streams (expected: $EXPECTED_COUNT, corrupted: $((EXPECTED_COUNT - STREAM_COUNT)))"

# Step 4: Detection (query mismatch)
log "Step 4: Detection phase - checking indexer vs contract..."
DETECTED_ISSUES=0

for stream_id in "${STREAM_IDS[@]}"; do
  # Check if stream exists in indexer
  indexer_count=$(sqlite3 "$INDEXER_DB" "SELECT COUNT(*) FROM streams WHERE stream_id = $stream_id;")
  contract_status=$(get_stream_status "$CONTRACT_ID" "$stream_id")

  if [ "$indexer_count" -eq 0 ]; then
    log "DETECTED: Stream $stream_id missing from indexer (contract status: $contract_status)"
    DETECTED_ISSUES=$((DETECTED_ISSUES + 1))
  else
    log "Stream $stream_id: indexer OK, contract status: $contract_status"
  fi
done

log "Detection complete: $DETECTED_ISSUES issues found"

# Check if threshold for rebuild is met
CORRUPTION_THRESHOLD=1
if [ "$DETECTED_ISSUES" -ge "$CORRUPTION_THRESHOLD" ]; then
  log "CORRUPTION THRESHOLD MET: $DETECTED_ISSUES discrepancies (threshold: $CORRUPTION_THRESHOLD)"
else
  log "WARNING: Corruption threshold not met"
fi

# Step 5: Stop indexer (simulated)
log "Step 5: Stopping indexer service (simulated)..."
log "In production: systemctl stop streampay-indexer"
log "Simulated: indexer stopped"

# Step 6: Backup corrupted data
log "Step 6: Backing up corrupted data..."
CORRUPTED_BACKUP="$LOG_DIR/indexer_corrupted_$TIMESTAMP.db"
cp "$INDEXER_DB" "$CORRUPTED_BACKUP"
log "Backed up corrupted database to $CORRUPTED_BACKUP"

# Step 7: Reset state
log "Step 7: Resetting indexer state..."
rm "$INDEXER_DB"
log "Deleted corrupted indexer database"

# Step 8: Rebuild from chain (simulated)
log "Step 8: Rebuilding indexer from chain (simulated)..."
sleep 2

# Rebuild the database from contract data
sqlite3 "$INDEXER_DB" <<EOF
CREATE TABLE IF NOT EXISTS streams (
  stream_id INTEGER PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  token TEXT NOT NULL,
  deposit INTEGER NOT NULL,
  withdrawn INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  data TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
EOF

REBUILT_COUNT=0
for stream_id in "${STREAM_IDS[@]}"; do
  # In production, would query contract via RPC
  # For simulation, we'll reconstruct from our knowledge
  stream_status=$(get_stream_status "$CONTRACT_ID" "$stream_id")

  sqlite3 "$INDEXER_DB" <<EOF
INSERT INTO streams (stream_id, sender, recipient, token, deposit, withdrawn, start_time, end_time, status, created_at)
VALUES ($stream_id, 'sender_$stream_id', 'recipient_$stream_id', '$TOKEN_ID', 1000000000, 0, $(date +%s), $(($(date +%s) + 3600)), '$stream_status', $(date +%s));
EOF

  REBUILT_COUNT=$((REBUILT_COUNT + 1))
  log "Rebuilt stream $stream_id with status: $stream_status"
done

log "Rebuild complete: $REBUILT_COUNT streams reconstructed"

# Step 9: Verification
log "Step 9: Verification - comparing indexer vs contract..."
VERIFIED=true
MISMATCH_COUNT=0

for stream_id in "${STREAM_IDS[@]}"; do
  indexer_count=$(sqlite3 "$INDEXER_DB" "SELECT COUNT(*) FROM streams WHERE stream_id = $stream_id;")
  contract_status=$(get_stream_status "$CONTRACT_ID" "$stream_id")

  if [ "$indexer_count" -eq 0 ]; then
    log "ERROR: Stream $stream_id still missing from indexer after rebuild"
    VERIFIED=false
    MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
  else
    indexer_status=$(sqlite3 "$INDEXER_DB" "SELECT status FROM streams WHERE stream_id = $stream_id;")
    if [ "$indexer_status" = "$contract_status" ]; then
      log "Stream $stream_id: indexer status matches contract ($contract_status)"
    else
      log "WARNING: Stream $stream_id status mismatch - indexer: $indexer_status, contract: $contract_status"
      VERIFIED=false
      MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
    fi
  fi
done

# Step 10: Restart indexer (simulated)
log "Step 10: Restarting indexer service (simulated)..."
log "In production: systemctl start streampay-indexer"
log "Simulated: indexer restarted"

# Final result
if [ "$VERIFIED" = true ]; then
  log "SUCCESS: Indexer rebuilt and verified"
  RESULT="PASS"
else
  log "FAILURE: Indexer verification failed with $MISMATCH_COUNT mismatches"
  RESULT="FAIL"
fi

log_end "Indexer Corruption Drill"

# Print summary
echo ""
echo "=== Drill Summary ==="
echo "Result: $RESULT"
echo "Streams created: ${#STREAM_IDS[@]}"
echo "Streams corrupted: $CORRUPT_COUNT"
echo "Issues detected: $DETECTED_ISSUES"
echo "Streams rebuilt: $REBUILT_COUNT"
echo "Verification mismatches: $MISMATCH_COUNT"
echo "Indexer database: $INDEXER_DB"
echo "Corrupted backup: $CORRUPTED_BACKUP"
echo "Pre-corruption backup: $BACKUP_DB"
echo "Log file: $LOG_FILE"
echo ""

if [ "$RESULT" = "FAIL" ]; then
  exit 1
fi
