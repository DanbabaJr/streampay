#!/bin/bash
# run_all_drills.sh - Master script to execute all incident response drills
#
# This script runs all three incident response scenarios sequentially:
# 1. Draining Exploit
# 2. Sponsor-Key Compromise
# 3. Indexer Corruption
#
# Usage: ./scripts/run_all_drills.sh <contract_id> <token_id>

set -euo pipefail

# Validate arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 <contract_id> <token_id>"
  echo "  contract_id: The StreamPay contract ID on testnet"
  echo "  token_id: The token contract ID to use for the drills"
  exit 1
fi

CONTRACT_ID="$1"
TOKEN_ID="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        StreamPay Incident Response Drills - Full Suite        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Contract ID: $CONTRACT_ID"
echo "Token ID: $TOKEN_ID"
echo "Network: testnet"
echo "Start time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Track overall results
TOTAL_DRILLS=3
PASSED_DRILLS=0
FAILED_DRILLS=0
DRILL_RESULTS=()

# Run Scenario 1: Draining Exploit
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Scenario 1: Draining Exploit"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if "$SCRIPT_DIR/drill_draining_exploit.sh" "$CONTRACT_ID" "$TOKEN_ID"; then
  PASSED_DRILLS=$((PASSED_DRILLS + 1))
  DRILL_RESULTS+=("Scenario 1 (Draining Exploit): PASS")
else
  FAILED_DRILLS=$((FAILED_DRILLS + 1))
  DRILL_RESULTS+=("Scenario 1 (Draining Exploit): FAIL")
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Run Scenario 2: Sponsor-Key Compromise
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Scenario 2: Sponsor-Key Compromise"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if "$SCRIPT_DIR/drill_sponsor_compromise.sh" "$CONTRACT_ID" "$TOKEN_ID"; then
  PASSED_DRILLS=$((PASSED_DRILLS + 1))
  DRILL_RESULTS+=("Scenario 2 (Sponsor-Key Compromise): PASS")
else
  FAILED_DRILLS=$((FAILED_DRILLS + 1))
  DRILL_RESULTS+=("Scenario 2 (Sponsor-Key Compromise): FAIL")
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Run Scenario 3: Indexer Corruption
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Scenario 3: Indexer Corruption"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Use a temporary path for the mock indexer database
INDEXER_DB="/tmp/streampay_indexer_drill_$$.db"

if "$SCRIPT_DIR/drill_indexer_corruption.sh" "$CONTRACT_ID" "$TOKEN_ID" "$INDEXER_DB"; then
  PASSED_DRILLS=$((PASSED_DRILLS + 1))
  DRILL_RESULTS+=("Scenario 3 (Indexer Corruption): PASS")
else
  FAILED_DRILLS=$((FAILED_DRILLS + 1))
  DRILL_RESULTS+=("Scenario 3 (Indexer Corruption): FAIL")
fi

# Cleanup temporary indexer database
rm -f "$INDEXER_DB"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Print overall summary
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Overall Drill Summary                        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Total drills: $TOTAL_DRILLS"
echo "Passed: $PASSED_DRILLS"
echo "Failed: $FAILED_DRILLS"
echo "End time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "Results:"
for result in "${DRILL_RESULTS[@]}"; do
  echo "  • $result"
done
echo ""

# Check if all drills passed
if [ $FAILED_DRILLS -eq 0 ]; then
  echo "✓ All drills passed successfully!"
  echo ""
  echo "Next steps:"
  echo "  1. Review logs in the logs/ directory"
  echo "  2. Document any surprises or issues in docs/INCIDENT_RESULTS.md"
  echo "  3. Update runbook based on findings"
  exit 0
else
  echo "✗ Some drills failed. Review logs and investigate."
  echo ""
  echo "Next steps:"
  echo "  1. Review logs in the logs/ directory for failed drills"
  echo "  2. Identify root causes of failures"
  echo "  3. Fix issues and re-run failed drills"
  exit 1
fi
