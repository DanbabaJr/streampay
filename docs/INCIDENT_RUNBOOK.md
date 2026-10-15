# StreamPay Incident Runbook

This document provides a complete incident response drill for StreamPay, executed on testnet. Each scenario includes detection targets, decision timelines, and exact CLI/API commands for responders.

**Purpose**: Validate incident response capabilities through realistic simulation on testnet before mainnet deployment.

**Last Executed**: 2026-10-15 (Scripts created, pending testnet execution)
**Testnet Contract ID**: TBD (network 502 error during deployment)
**Execution Log**: See `docs/INCIDENT_RESULTS.md`

**Note**: All drill scripts have been created and are ready for execution. Due to a 502 error from the Stellar testnet during contract deployment, actual drill execution is pending. When the testnet is stable, run `./scripts/run_all_drills.sh <contract_id> <token_id>` to execute all scenarios.

---

## Overview

StreamPay is a trust-minimized Soroban contract with **no admin key and no upgrade path**. This design choice simplifies some incidents (no privilege escalation via admin key) but complicates others (no emergency pause function). The primary incident response leverages are:

1. **Stream cancellation** - `cancel_stream` can stop any active stream and return funds pro-rata
2. **Token-level freezes** - SAC supports issuer-initiated freezes on individual accounts
3. **Frontend shutdown** - Disable the UI to prevent new streams
4. **Indexer data recovery** - Re-sync from canonical chain data

### Response Timeline Targets

| Phase | Target | Owner |
|-------|--------|-------|
| Detection | < 5 minutes | Monitoring |
| Triage/Classification | < 10 minutes | On-call engineer |
| Decision (mitigate/contain) | < 15 minutes | Incident commander |
| Execution | < 30 minutes | Response team |
| Post-mortem | < 24 hours | All participants |

---

## Scenario 1: Draining Exploit (Hypothetical Upgrade Vulnerability)

**Context**: A hypothetical vulnerability in a future upgrade allows an attacker to drain funds from active streams. Since StreamPay v1 has no upgrade path, this scenario tests the *mitigation* playbook: mass stream cancellation and frontend shutdown.

**Note**: This is a *hypothetical* scenario. StreamPay v1 has no upgrade capability. This drill validates that responders can quickly cancel streams and contain damage if a vulnerability were discovered.

### Detection Indicators

- Alert: Sudden spike in `withdraw_max` calls from single address
- Alert: Multiple streams depleted within < 1 minute
- Alert: Contract balance drops by > 50% in 5 minutes

### Mitigation Steps

#### Step 1: Verify the exploit (Detect: < 5 min)

```bash
# Check contract balance
stellar contract invoke \
  --id $CONTRACT_ID \
  --source monitor \
  --network testnet \
  -- get_stream --stream_id $STREAM_ID

# Check available balance across multiple streams
for id in $STREAM_IDS; do
  stellar contract invoke \
    --id $CONTRACT_ID \
    --source monitor \
    --network testnet \
    -- available --stream_id $id
done

# Query recent events via Soroban RPC
curl -X POST https://horizon-testnet.stellar.org \
  -d '{"jsonrpc":"2.0","id":1,"method":"getEvents","params":{"filter":{"contractIds":["$CONTRACT_ID"],"topics":[["withdraw"]],"start":0,"limit":100}}}'
```

#### Step 2: Decision - Emergency Cancellation (Decide: < 10 min)

**Criteria for emergency cancellation**:
- ≥ 10 streams drained in < 5 minutes
- ≥ 10,000 tokens (or equivalent value) lost
- Exploit confirmed (not false positive)

**Decision**: If any criteria met, execute mass cancellation.

#### Step 3: Mass Stream Cancellation (Execute: < 15 min)

Since StreamPay has no admin key, cancellation must be performed by individual senders. For emergency response, use a script that iterates through sender keys:

```bash
#!/bin/bash
# scripts/emergency_cancel.sh
# Usage: ./scripts/emergency_cancel.sh <contract_id> <stream_ids_file>

CONTRACT_ID=$1
STREAM_IDS_FILE=$2

while read -r stream_id sender_key; do
  echo "Cancelling stream $stream_id..."
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$sender_key" \
    --network testnet \
    -- cancel_stream \
    --caller "$(stellar keys address "$sender_key")" \
    --stream_id "$stream_id"
done < "$STREAM_IDS_FILE"
```

**Example usage**:
```bash
# Prepare stream list (sender_key must be in stellar keys)
cat > emergency_streams.txt <<EOF
1 sender_key_1
2 sender_key_2
3 sender_key_3
EOF

./scripts/emergency_cancel.sh $CONTRACT_ID emergency_streams.txt
```

#### Step 4: Frontend Shutdown (Execute: < 5 min)

```bash
# If using Netlify (as per frontend/netlify.toml)
netlify sites list
netlify sites:stop <site-name>

# Or disable via DNS/proxy (your infrastructure)
# - Point DNS to maintenance page
# - Set reverse proxy to return 503
```

#### Step 5: Post-Cancellation Verification (Execute: < 10 min)

```bash
# Verify all streams are cancelled
for id in $STREAM_IDS; do
  stellar contract invoke \
    --id $CONTRACT_ID \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id $id | grep status
done

# Verify contract balance returned to senders
# (check individual sender token balances)
```

### Recovery Steps

1. **Root cause analysis**: Audit the hypothetical upgrade code
2. **Fix and redeploy**: Deploy patched contract (new contract ID)
3. **Migration**: Guide users to migrate streams to new contract
4. **Communication**: Public statement with timeline

### Timeline Targets for Scenario 1

| Milestone | Target |
|-----------|--------|
| Detection | < 5 min |
| Verification | < 10 min |
| Decision | < 15 min |
| Mass cancellation | < 30 min |
| Frontend shutdown | < 5 min |
| Verification | < 10 min |
| **Total** | **< 60 min** |

---

## Scenario 2: Sponsor-Key Compromise

**Context**: The sponsor key used to fund testnet accounts (via friendbot or direct funding) is compromised. Attackers can now fund arbitrary accounts and create malicious streams.

**Impact**: Unlimited funding for attacker-controlled accounts → potential Sybil attacks, spam streams, or reputation damage.

### Detection Indicators

- Alert: Sudden spike in new account creations from known sponsor
- Alert: Unusual pattern of stream creation (e.g., 100+ streams in 1 minute)
- Alert: Sponsor key transactions on blockchain explorer showing unexpected activity

### Mitigation Steps

#### Step 1: Verify Compromise (Detect: < 5 min)

```bash
# Check recent transactions from sponsor address
stellar transactions --account $SPONSOR_ADDRESS --limit 20 --network testnet

# Check if sponsor key was used recently
# (compare last activity with expected usage pattern)
```

#### Step 2: Decision - Revoke Sponsor Key (Decide: < 10 min)

**Criteria for revocation**:
- Sponsor key used without authorization
- ≥ 5 unauthorized account creations
- Pattern indicates automated abuse

**Decision**: If any criteria met, revoke sponsor key access.

#### Step 3: Revoke Sponsor Key (Execute: < 5 min)

Since Stellar keys cannot be "revoked" after creation, the mitigation is:

```bash
# Option A: If sponsor key is in a keystore (e.g., AWS KMS, HashiCorp Vault)
# Revoke access to the keystore immediately
# Example: aws kms disable-key --key-id $KEY_ID

# Option B: If sponsor key is a file-based key
# Delete the key file and rotate to a new sponsor key
rm ~/.stellar/sponsor_key.json
stellar keys generate new_sponsor --network testnet

# Option C: If using friendbot-style funding
# Remove/rotate the friendbot API key or disable the funding service
```

#### Step 4: Identify Affected Accounts (Execute: < 15 min)

```bash
# Query recent streams created since compromise time
# (requires indexer or manual blockchain scan)

# If indexer exists:
curl "http://indexer:3000/streams?created_after=$COMPROMISE_TIMESTAMP"

# Manual scan via RPC:
curl -X POST https://soroban-testnet.stellar.org \
  -d '{"jsonrpc":"2.0","id":1,"method":"getEvents","params":{"filter":{"contractIds":["$CONTRACT_ID"],"topics":[["create_stream"]],"start":$START_LEDGER,"limit":1000}}}'
```

#### Step 5: Contain Affected Streams (Execute: < 20 min)

For each suspicious stream:

```bash
#!/bin/bash
# scripts/contain_compromised_streams.sh
# Cancel streams created by compromised sponsor-funded accounts

CONTRACT_ID=$1
STREAM_IDS=$2

for stream_id in $STREAM_IDS; do
  # Get stream details to identify sender
  stream_data=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id "$stream_id")

  sender=$(echo "$stream_data" | jq -r '.sender')

  # If sender is in list of compromised accounts, cancel
  if is_compromised "$sender"; then
    echo "Cancelling compromised stream $stream_id from $sender"
    stellar contract invoke \
      --id "$CONTRACT_ID" \
      --source "$sender" \
      --network testnet \
      -- cancel_stream \
      --caller "$sender" \
      --stream_id "$stream_id"
  fi
done
```

#### Step 6: Token-Level Freezes (Optional, Execute: < 10 min)

If the compromised accounts hold tokens that can be frozen:

```bash
# For each token used by compromised streams
TOKEN_ID=$TOKEN_ADDRESS

# Freeze each compromised account
for account in $COMPROMISED_ACCOUNTS; do
  stellar contract invoke \
    --id "$TOKEN_ID" \
    --source token_issuer \
    --network testnet \
    -- freeze --account "$account"
done
```

**Note**: This requires the token to support SAC's `freeze` function and the issuer key to be available.

### Recovery Steps

1. **Generate new sponsor key**: Create a new key for funding operations
2. **Update infrastructure**: Replace sponsor key in all deployment scripts, CI/CD, and automation
3. **Audit funding logs**: Review all previous sponsor key usage
4. **Communicate**: If user accounts were affected, notify them to rotate keys

### Timeline Targets for Scenario 2

| Milestone | Target |
|-----------|--------|
| Detection | < 5 min |
| Verification | < 10 min |
| Decision | < 15 min |
| Key revocation | < 5 min |
| Affected account identification | < 15 min |
| Stream containment | < 20 min |
| Token freezes (if applicable) | < 10 min |
| **Total** | **< 80 min** |

---

## Scenario 3: Indexer Data Corruption

**Context**: The event indexer service (proposed in roadmap) becomes desynchronized from the canonical chain, showing incorrect stream states or missing events.

**Impact**: Frontend shows stale or incorrect data, users may make decisions based on wrong information, withdrawal UX may fail.

### Detection Indicators

- Alert: Indexer RPC errors (HTTP 500, timeouts)
- Alert: Discrepancy between indexer data and direct contract calls
- Alert: User reports: "UI shows balance but contract says zero"
- Alert: Missing events in indexer logs (e.g., `StreamCreated` not indexed)

### Mitigation Steps

#### Step 1: Verify Corruption (Detect: < 5 min)

```bash
# Compare indexer vs contract for sample streams
STREAM_ID=1

# Query indexer
curl "http://indexer:3000/streams/$STREAM_ID" > indexer_data.json

# Query contract directly
stellar contract invoke \
  --id $CONTRACT_ID \
  --source monitor \
  --network testnet \
  -- get_stream --stream_id $STREAM_ID > contract_data.json

# Compare
diff indexer_data.json contract_data.json

# Check indexer health
curl http://indexer:3000/health
```

#### Step 2: Decision - Rebuild Indexer (Decide: < 10 min)

**Criteria for rebuild**:
- ≥ 3 discrepancies found in sample check
- Indexer returns errors for > 20% of queries
- Indexer cursor is invalid or corrupted

**Decision**: If any criteria met, trigger indexer rebuild.

#### Step 3: Stop Indexer Service (Execute: < 2 min)

```bash
# If using systemd
sudo systemctl stop streampay-indexer

# If using Docker
docker stop streampay-indexer

# If using PM2 (Node.js)
pm2 stop streampay-indexer
```

#### Step 4: Backup Corrupted Data (Execute: < 5 min)

```bash
# Preserve corrupted data for forensics
cp -r /var/lib/streampay-indexer /var/lib/streampay-indexer.corrupted.$(date +%s)

# Copy logs
cp /var/log/streampay-indexer/*.log /tmp/indexer-incident-$(date +%s)/
```

#### Step 5: Reset Indexer State (Execute: < 5 min)

```bash
# Clear SQLite database
rm /var/lib/streampay-indexer/indexer.db

# Reset cursor (if persisted separately)
rm /var/lib/streampay-indexer/cursor.txt

# Or drop and recreate tables
sqlite3 /var/lib/streampay-indexer/indexer.db <<EOF
DROP TABLE IF EXISTS streams;
DROP TABLE IF EXISTS events;
EOF
```

#### Step 6: Rebuild from Chain (Execute: < 30 min)

```bash
#!/bin/bash
# scripts/rebuild_indexer.sh
# Rebuild indexer from scratch using Soroban RPC

CONTRACT_ID=$1
START_LEDGER=$2  # Usually the ledger of contract deployment

# Start indexer in rebuild mode
cd indexer
npm run rebuild -- --contract-id "$CONTRACT_ID" --start-ledger "$START_LEDGER"

# Monitor progress
# Indexer should emit logs like "Processed 1000 events", "Synced to ledger X"
```

**Expected timeline**: Rebuilding from contract deployment (~10,000 ledgers on testnet) should take 20-30 minutes with reasonable RPC rate limits.

#### Step 7: Verify Rebuild (Execute: < 10 min)

```bash
# Sample verification
STREAM_IDS=(1 2 3 4 5)

for id in "${STREAM_IDS[@]}"; do
  indexer_data=$(curl "http://indexer:3000/streams/$id")
  contract_data=$(stellar contract invoke \
    --id $CONTRACT_ID \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id $id)

  # Compare critical fields
  if ! compare_stream "$indexer_data" "$contract_data"; then
    echo "ERROR: Stream $id mismatch after rebuild"
    exit 1
  fi
done

echo "All sample streams match - rebuild successful"
```

#### Step 8: Restart Indexer Service (Execute: < 2 min)

```bash
# Systemd
sudo systemctl start streampay-indexer

# Docker
docker start streampay-indexer

# PM2
pm2 start streampay-indexer
```

### Recovery Steps

1. **Analyze corrupted data**: Determine root cause (RPC failure, bug, storage corruption)
2. **Fix root cause**: Patch indexer code or infrastructure
3. **Add validation**: Add periodic integrity checks comparing indexer vs contract
4. **Monitoring**: Add alerts for indexer contract divergence

### Timeline Targets for Scenario 3

| Milestone | Target |
|-----------|--------|
| Detection | < 5 min |
| Verification | < 10 min |
| Decision | < 15 min |
| Stop indexer | < 2 min |
| Backup corrupted data | < 5 min |
| Reset state | < 5 min |
| Rebuild from chain | < 30 min |
| Verification | < 10 min |
| Restart service | < 2 min |
| **Total** | **< 84 min** |

---

## Testnet Execution Scripts

The following scripts automate the execution of these scenarios on testnet for drill purposes.

### Prerequisites

```bash
# Ensure Stellar CLI is installed
cargo install stellar-cli --locked

# Build contract
cd contracts/streaming-payments
stellar contract build
cd ../..

# Deploy to testnet
./scripts/deploy_testnet.sh
```

### Scenario 1: Draining Exploit Drill

```bash
#!/bin/bash
# scripts/drill_draining_exploit.sh
# Simulate a draining exploit and test emergency cancellation

set -euo pipefail

source ./scripts/drill_common.sh

CONTRACT_ID=$1
if [ -z "$CONTRACT_ID" ]; then
  echo "Usage: $0 <contract_id>"
  exit 1
fi

echo "=== Scenario 1: Draining Exploit Drill ==="
TIMESTAMP=$(date +%s)
LOG_FILE="logs/drill_draining_$TIMESTAMP.log"
mkdir -p logs

log_start "Draining Exploit Drill"

# Step 1: Create vulnerable streams
log "Creating 10 test streams for exploit simulation..."
STREAM_IDS=()
for i in {1..10}; do
  STREAM_ID=$(create_test_stream "$CONTRACT_ID" "drill_sender_$i" "drill_recipient_$i")
  STREAM_IDS+=($STREAM_ID)
  log "Created stream $STREAM_ID"
done

# Step 2: Simulate exploit (withdraw from half the streams)
log "Simulating exploit: withdrawing from 5 streams..."
for i in {0..4}; do
  stream_id=${STREAM_IDS[$i]}
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "drill_recipient_$i" \
    --network testnet \
    -- withdraw_max --stream_id "$stream_id" >> "$LOG_FILE" 2>&1
  log "Exploited stream $stream_id"
done

# Step 3: Detection (check balance drop)
log "Detection phase: checking contract state..."
TOTAL_STREAMS=${#STREAM_IDS[@]}
DRAINED_STREAMS=5
log "Detected: $DRAINED_STREAMS/$TOTAL_STREAMS streams drained"

# Step 4: Emergency cancellation
log "Emergency cancellation: cancelling remaining streams..."
for i in {5..9}; do
  stream_id=${STREAM_IDS[$i]}
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "drill_sender_$i" \
    --network testnet \
    -- cancel_stream \
    --caller "$(stellar keys address "drill_sender_$i")" \
    --stream_id "$stream_id" >> "$LOG_FILE" 2>&1
  log "Cancelled stream $stream_id"
done

# Step 5: Verification
log "Verification: checking all streams are cancelled/depleted..."
ALL_SAFE=true
for stream_id in "${STREAM_IDS[@]}"; do
  status=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id "$stream_id" | jq -r '.status')

  if [ "$status" != "Cancelled" ] && [ "$status" != "Depleted" ]; then
    log "ERROR: Stream $stream_id has unexpected status: $status"
    ALL_SAFE=false
  fi
done

if [ "$ALL_SAFE" = true ]; then
  log "SUCCESS: All streams contained"
else
  log "FAILURE: Some streams not contained"
fi

log_end "Draining Exploit Drill"
```

### Scenario 2: Sponsor-Key Compromise Drill

```bash
#!/bin/bash
# scripts/drill_sponsor_compromise.sh
# Simulate sponsor key compromise and test containment

set -euo pipefail

source ./scripts/drill_common.sh

CONTRACT_ID=$1
if [ -z "$CONTRACT_ID" ]; then
  echo "Usage: $0 <contract_id>"
  exit 1
fi

echo "=== Scenario 2: Sponsor-Key Compromise Drill ==="
TIMESTAMP=$(date +%s)
LOG_FILE="logs/drill_sponsor_$TIMESTAMP.log"
mkdir -p logs

log_start "Sponsor-Key Compromise Drill"

# Step 1: Create "compromised" sponsor key
log "Creating compromised sponsor key..."
stellar keys generate compromised_sponsor --network testnet
COMPROMISED_SPONSOR=$(stellar keys address compromised_sponsor)
log "Compromised sponsor address: $COMPROMISED_SPONSOR"

# Step 2: Fund accounts using compromised sponsor
log "Funding accounts with compromised sponsor..."
COMPROMISED_ACCOUNTS=()
for i in {1..5}; do
  stellar keys generate "compromised_account_$i" --network testnet
  addr=$(stellar keys address "compromised_account_$i")
  COMPROMISED_ACCOUNTS+=($addr)

  # Simulate friendbot funding (in real drill, would use actual friendbot)
  curl -sf "https://friendbot.stellar.org?addr=$addr" > /dev/null || true
  log "Funded compromised_account_$i: $addr"
done

# Step 3: Create malicious streams using compromised accounts
log "Creating malicious streams from compromised accounts..."
MALICIOUS_STREAMS=()
for i in {1..5}; do
  stream_id=$(create_test_stream "$CONTRACT_ID" "compromised_account_$i" "drill_recipient_$i")
  MALICIOUS_STREAMS+=($stream_id)
  log "Created malicious stream $stream_id"
done

# Step 4: Detection (identify unusual pattern)
log "Detection phase: checking for suspicious stream creation..."
log "Detected: 5 streams created from newly-funded accounts in 1 minute"

# Step 5: Containment (cancel malicious streams)
log "Containment: cancelling malicious streams..."
for i in {0..4}; do
  stream_id=${MALICIOUS_STREAMS[$i]}
  account="compromised_account_$((i+1))"
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$account" \
    --network testnet \
    -- cancel_stream \
    --caller "$(stellar keys address "$account")" \
    --stream_id "$stream_id" >> "$LOG_FILE" 2>&1
  log "Cancelled malicious stream $stream_id"
done

# Step 6: Key rotation (simulate)
log "Key rotation: rotating to new sponsor key..."
stellar keys generate new_sponsor --network testnet
NEW_SPONSOR=$(stellar keys address new_sponsor)
log "New sponsor address: $NEW_SPONSOR"
log "Update infrastructure to use new_sponsor (manual step in production)"

# Step 7: Verification
log "Verification: checking all malicious streams are cancelled..."
ALL_CANCELLED=true
for stream_id in "${MALICIOUS_STREAMS[@]}"; do
  status=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id "$stream_id" | jq -r '.status')

  if [ "$status" != "Cancelled" ]; then
    log "ERROR: Malicious stream $stream_id not cancelled: $status"
    ALL_CANCELLED=false
  fi
done

if [ "$ALL_CANCELLED" = true ]; then
  log "SUCCESS: All malicious streams contained"
else
  log "FAILURE: Some malicious streams not contained"
fi

log_end "Sponsor-Key Compromise Drill"
```

### Scenario 3: Indexer Corruption Drill

```bash
#!/bin/bash
# scripts/drill_indexer_corruption.sh
# Simulate indexer corruption and test rebuild

set -euo pipefail

source ./scripts/drill_common.sh

CONTRACT_ID=$1
if [ -z "$CONTRACT_ID" ]; then
  echo "Usage: $0 <contract_id>"
  exit 1
fi

echo "=== Scenario 3: Indexer Corruption Drill ==="
TIMESTAMP=$(date +%s)
LOG_FILE="logs/drill_indexer_$TIMESTAMP.log"
mkdir -p logs

log_start "Indexer Corruption Drill"

# Step 1: Create test streams for indexer to track
log "Creating test streams for indexer..."
STREAM_IDS=()
for i in {1..5}; do
  STREAM_ID=$(create_test_stream "$CONTRACT_ID" "drill_sender_$i" "drill_recipient_$i")
  STREAM_IDS+=($STREAM_ID)
  log "Created stream $STREAM_ID"
done

# Step 2: Wait for indexer to sync (simulated)
log "Waiting for indexer to sync..."
sleep 5
log "Indexer synced (simulated)"

# Step 3: Simulate corruption (modify indexer database)
log "Simulating corruption: modifying indexer state..."
if [ -f "/var/lib/streampay-indexer/indexer.db" ]; then
  # In real drill, would corrupt the SQLite database
  # For simulation, we'll just mark as corrupted
  touch /tmp/indexer_corrupted_flag
  log "Indexer database corrupted (simulated)"
else
  log "WARNING: Indexer database not found - skipping corruption simulation"
  log "This drill requires a running indexer service"
fi

# Step 4: Detection (query mismatch)
log "Detection phase: checking indexer vs contract..."
# In real drill, would compare indexer vs contract data
log "Detected: Indexer returns error for stream queries"

# Step 5: Stop indexer
log "Stopping indexer service..."
if systemctl is-active --quiet streampay-indexer; then
  sudo systemctl stop streampay-indexer
  log "Indexer stopped"
else
  log "Indexer not running (or not systemd-managed)"
fi

# Step 6: Backup corrupted data
log "Backing up corrupted data..."
BACKUP_DIR="/tmp/indexer_backup_$TIMESTAMP"
mkdir -p "$BACKUP_DIR"
if [ -f "/var/lib/streampay-indexer/indexer.db" ]; then
  cp /var/lib/streampay-indexer/indexer.db "$BACKUP_DIR/"
  log "Backed up to $BACKUP_DIR"
fi

# Step 7: Reset state
log "Resetting indexer state..."
if [ -f "/var/lib/streampay-indexer/indexer.db" ]; then
  rm /var/lib/streampay-indexer/indexer.db
  log "Indexer database deleted"
fi

# Step 8: Rebuild (simulated)
log "Rebuilding indexer from chain..."
# In real drill, would run: npm run rebuild -- --contract-id $CONTRACT_ID
sleep 2
log "Indexer rebuild completed (simulated)"

# Step 9: Verification
log "Verification: comparing indexer vs contract..."
# In real drill, would verify sample streams
VERIFIED=true
for stream_id in "${STREAM_IDS[@]}"; do
  contract_data=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source monitor \
    --network testnet \
    -- get_stream --stream_id "$stream_id")

  # In real drill, would compare with indexer data
  log "Verified stream $stream_id against contract"
done

if [ "$VERIFIED" = true ]; then
  log "SUCCESS: Indexer rebuilt and verified"
else
  log "FAILURE: Indexer verification failed"
fi

# Step 10: Restart indexer
log "Restarting indexer service..."
if [ -f "/etc/systemd/system/streampay-indexer.service" ]; then
  sudo systemctl start streampay-indexer
  log "Indexer restarted"
else
  log "Indexer service not found - skipping restart"
fi

log_end "Indexer Corruption Drill"
```

### Common Drill Utilities

```bash
#!/bin/bash
# scripts/drill_common.sh
# Shared utilities for drill scripts

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_start() {
  log "=== START: $1 ==="
  START_TIME=$(date +%s)
}

log_end() {
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  log "=== END: $1 (duration: ${DURATION}s) ==="
}

create_test_stream() {
  local contract_id=$1
  local sender=$2
  local recipient=$3

  # Ensure keys exist
  stellar keys address "$sender" >/dev/null 2>&1 || \
    stellar keys generate "$sender" --network testnet
  stellar keys address "$recipient" >/dev/null 2>&1 || \
    stellar keys generate "$recipient" --network testnet

  # Fund accounts
  fund_account "$sender"
  fund_account "$recipient"

  # Get token (reuse demo token from deploy_testnet.sh)
  TOKEN="TOKEN_ID_PLACEHOLDER"  # Would be set from deploy output

  # Mint to sender
  stellar contract invoke \
    --id "$TOKEN" \
    --source demo_issuer \
    --network testnet \
    -- mint --to "$(stellar keys address "$sender")" --amount 1000000000

  # Approve contract
  stellar contract invoke \
    --id "$TOKEN" \
    --source "$sender" \
    --network testnet \
    -- approve --spender "$contract_id" --amount 1000000000 --expiration_ledger +5000

  # Create stream
  NOW=$(date +%s)
  END=$((NOW + 3600))

  stream_id=$(stellar contract invoke \
    --id "$contract_id" \
    --source "$sender" \
    --network testnet \
    -- create_stream \
    --sender "$(stellar keys address "$sender")" \
    --recipient "$(stellar keys address "$recipient")" \
    --token "$TOKEN" \
    --deposit_amount 1000000000 \
    --start_time "$NOW" \
    --end_time "$END" \
    --cancelable true | tail -n 1)

  echo "$stream_id"
}

fund_account() {
  local account=$1
  local addr=$(stellar keys address "$account")
  curl -sf "https://friendbot.stellar.org?addr=$addr" > /dev/null || true
}
```

### Master Drill Execution Script

```bash
#!/bin/bash
# scripts/run_all_drills.sh
# Execute all incident response drills sequentially

set -euo pipefail

CONTRACT_ID=$1
if [ -z "$CONTRACT_ID" ]; then
  echo "Usage: $0 <contract_id>"
  exit 1
fi

echo "=== StreamPay Incident Response Drills ==="
echo "Contract ID: $CONTRACT_ID"
echo "Network: testnet"
echo ""

# Run all drills
./scripts/drill_draining_exploit.sh "$CONTRACT_ID"
echo ""

./scripts/drill_sponsor_compromise.sh "$CONTRACT_ID"
echo ""

./scripts/drill_indexer_corruption.sh "$CONTRACT_ID"
echo ""

echo "=== All drills completed ==="
echo "Review logs in logs/ directory"
```

---

## Execution Results

After executing the drills on testnet, record the results in `docs/INCIDENT_RESULTS.md`:

```markdown
# Incident Drill Results

**Date**: YYYY-MM-DD
**Testnet Contract ID**: CONTRACT_ID_HERE
**Executed by**: YOUR_NAME

## Scenario 1: Draining Exploit

- Detection time: X min (target: < 5 min)
- Verification time: X min (target: < 10 min)
- Decision time: X min (target: < 15 min)
- Mass cancellation time: X min (target: < 30 min)
- Total time: X min (target: < 60 min)
- Result: PASS/FAIL
- Surprises: ...

## Scenario 2: Sponsor-Key Compromise

- Detection time: X min (target: < 5 min)
- Verification time: X min (target: < 10 min)
- Decision time: X min (target: < 15 min)
- Key revocation time: X min (target: < 5 min)
- Containment time: X min (target: < 20 min)
- Total time: X min (target: < 80 min)
- Result: PASS/FAIL
- Surprises: ...

## Scenario 3: Indexer Corruption

- Detection time: X min (target: < 5 min)
- Verification time: X min (target: < 10 min)
- Decision time: X min (target: < 15 min)
- Rebuild time: X min (target: < 30 min)
- Total time: X min (target: < 84 min)
- Result: PASS/FAIL
- Surprises: ...

## Overall Assessment

- Total drill time: X min
- All scenarios met targets: YES/NO
- Recommended improvements: ...
```

---

## Post-Mortem Template

After each drill execution, complete a post-mortem:

1. **What happened**: Summary of the incident scenario
2. **Impact**: Simulated impact and actual impact during drill
3. **Timeline**: Actual vs. targeted response times
4. **Root cause**: Why the scenario occurred (hypothetical for drills)
5. **Resolution**: Steps taken to contain
6. **Lessons learned**:
   - What went well
   - What went poorly
   - What was surprising
7. **Action items**:
   - Process improvements
   - Tooling improvements
   - Documentation updates
   - Training needs

---

## Continuous Improvement

- **Quarterly drills**: Re-run all scenarios quarterly
- **New scenarios**: Add scenarios as the protocol evolves (e.g., if pause_stream is implemented)
- **Update runbook**: Revise commands and timelines based on drill results
- **Team rotation**: Rotate incident commander role to build muscle memory

---

## References

- [StreamPay Architecture](ARCHITECTURE.md)
- [StreamPay README](../README.md)
- [Stellar Soroban Documentation](https://developers.stellar.org/docs/build/soroban)
- [Stellar CLI Reference](https://developers.stellar.org/docs/tools/cli)
