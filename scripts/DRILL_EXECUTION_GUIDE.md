# Drill Execution Guide

This guide explains how to execute the incident response drills on testnet.

## Prerequisites

1. **Stellar CLI installed**: `cargo install stellar-cli --locked`
2. **Contract deployed**: Run `./scripts/deploy_testnet.sh` to deploy to testnet
3. **Note contract and token IDs**: The deploy script will output:
   - Contract ID (e.g., `CB...`)
   - Token ID (e.g., `CD...`)

## Quick Start

After deploying the contract, run all drills:

```bash
./scripts/run_all_drills.sh <contract_id> <token_id>
```

Example:
```bash
./scripts/run_all_drills.sh CB7VNBM4SYB3J5H3D4Z6Y7X8W9Q0R1S2T3U4V5W6X7Y8Z9A0B CD7VNBM4SYB3J5H3D4Z6Y7X8W9Q0R1S2T3U4V5W6X7Y8Z9A0B
```

## Individual Drill Execution

### Scenario 1: Draining Exploit

```bash
./scripts/drill_draining_exploit.sh <contract_id> <token_id>
```

This drill:
- Creates 10 test streams
- Simulates a draining exploit by withdrawing from 5 streams
- Triggers emergency cancellation of remaining streams
- Verifies all streams are contained (cancelled or depleted)

### Scenario 2: Sponsor-Key Compromise

```bash
./scripts/drill_sponsor_compromise.sh <contract_id> <token_id>
```

This drill:
- Creates a "compromised" sponsor key
- Funds accounts using the compromised key
- Creates malicious streams from those accounts
- Detects suspicious activity
- Cancels malicious streams
- Rotates to a new sponsor key
- Verifies containment

### Scenario 3: Indexer Corruption

```bash
./scripts/drill_indexer_corruption.sh <contract_id> <token_id> [indexer_db_path]
```

This drill:
- Creates test streams
- Simulates indexer sync
- Corrupts the indexer database
- Detects discrepancies between indexer and contract
- Stops indexer service
- Backs up corrupted data
- Resets and rebuilds from chain
- Verifies rebuild integrity
- Restarts indexer service

**Note**: The indexer corruption drill uses a mock SQLite database for simulation. Provide a custom path via the third argument if you have a real indexer instance.

### Scenario 4: Key Rotation Drill

```bash
cd scripts && npm install && npm run drill:key-rotation
```

Unlike scenarios 1–3, this drill needs no `<contract_id>` or `<token_id>`: it
builds the Wasm, deploys a **fresh** contract to testnet, rotates the treasury
governor and policy admin via the two-step handoffs, and asserts that no
privileged operation survives an old key. It prints a pass/fail matrix and
writes it to `logs/key_rotation_matrix_<timestamp>.json`. See
[docs/rotation-runbook.md](../docs/rotation-runbook.md) for what each row
means and [`.github/workflows/key-rotation-drill.yml`](../.github/workflows/key-rotation-drill.yml)
for the quarterly schedule. All keys are generated in-memory and funded by
friendbot; nothing secret is written anywhere.

## Execution Notes

### Network Issues

If you encounter network errors (e.g., `502 Bad Gateway`) during deployment:

1. Wait a few minutes and retry
2. Check Stellar testnet status: https://status.stellar.org/
3. Ensure you have internet connectivity

### Key Management

The drill scripts generate temporary keys for simulation:
- `drill_sender_1`, `drill_sender_2`, etc.
- `drill_recipient_1`, `drill_recipient_2`, etc.
- `compromised_sponsor`, `new_sponsor`
- `compromised_account_1`, etc.

These keys are stored in `~/.config/stellar/identity/` and can be safely deleted after drills:

```bash
rm ~/.config/stellar/identity/drill_*
rm ~/.config/stellar/identity/compromised_*
rm ~/.config/stellar/identity/new_sponsor.toml
```

### Log Files

All drill logs are saved to the `logs/` directory:
- `logs/drill_draining_<timestamp>.log`
- `logs/drill_sponsor_<timestamp>.log`
- `logs/drill_indexer_<timestamp>.log`

Review these logs for detailed execution information.

### Cleanup

After completing drills, clean up temporary data:

```bash
# Remove logs (optional)
rm -rf logs/

# Remove drill keys
rm ~/.config/stellar/identity/drill_*
rm ~/.config/stellar/identity/compromised_*
rm ~/.config/stellar/identity/new_sponsor.toml

# Remove temporary indexer databases
rm /tmp/streampay_indexer_*.db
```

## Troubleshooting

### "stellar: command not found"

Install Stellar CLI:
```bash
cargo install stellar-cli --locked
```

### "Account not found"

Ensure friendbot is funding accounts. The drill scripts call friendbot automatically, but if it fails:

```bash
curl -sf "https://friendbot.stellar.org?addr=<address>"
```

### "Token not found"

Ensure the token ID from `deploy_testnet.sh` is correct. The drill scripts need a valid token contract to create streams.

### "Permission denied" on scripts

Make scripts executable:
```bash
chmod +x scripts/*.sh
```

## Interpreting Results

Each drill outputs:
- **Result**: PASS or FAIL
- **Summary statistics**: Streams created, cancelled, verified
- **Log file location**: For detailed review

A drill passes if:
- All streams are successfully contained (cancelled or depleted)
- No unexpected errors occur
- Verification steps succeed

Review logs if a drill fails to identify the root cause.

## Next Steps After Drills

1. **Review logs**: Check `logs/` directory for detailed execution information
2. **Document results**: Update `docs/INCIDENT_RESULTS.md` with actual timings and findings
3. **Identify improvements**: Note any issues or surprises
4. **Update runbook**: Revise `docs/INCIDENT_RUNBOOK.md` based on findings
5. **Schedule next drills**: Plan quarterly drills for continuous improvement

## Example Execution Session

```bash
# 1. Deploy contract
./scripts/deploy_testnet.sh
# Output: Contract id: CB7VNBM4SYB3J5H3D4Z6Y7X8W9Q0R1S2T3U4V5W6X7Y8Z9A0B
# Output: demo token id: CD7VNBM4SYB3J5H3D4Z6Y7X8W9Q0R1S2T3U4V5W6X7Y8Z9A0B

# 2. Run all drills
./scripts/run_all_drills.sh \
  CB7VNBM4SYB3J5H3D4Z6Y7X8W9Q0R1S2T3U4V5W6X7Y8Z9A0B \
  CD7VNBM4SYB3J5H3D4Z6Y7X8W9Q0R1S2T3U4V5W6X7Y8Z9A0B

# 3. Review results
cat logs/drill_draining_*.log
cat logs/drill_sponsor_*.log
cat logs/drill_indexer_*.log

# 4. Update documentation
# Edit docs/INCIDENT_RESULTS.md with actual timings and findings

# 5. Cleanup (optional)
rm -rf logs/
rm ~/.config/stellar/identity/drill_*
rm ~/.config/stellar/identity/compromised_*
rm ~/.config/stellar/identity/new_sponsor.toml
```

## References

- [Incident Runbook](../docs/INCIDENT_RUNBOOK.md)
- [Incident Results](../docs/INCIDENT_RESULTS.md)
- [Deploy Testnet Script](./deploy_testnet.sh)
- [Stellar CLI Documentation](https://developers.stellar.org/docs/tools/cli)
