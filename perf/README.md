# ⚡ StreamPay Performance Budgets & Regression Defense

Performance defense gates in CI preventing regressions across:
1. **Indexer Catch-Up Replay Timing**: Ingestion latency and throughput over deterministic 500-event archive fixtures.
2. **Soroban RPC Reads Waterfall**: Enforcing exact upper bounds on `simulateTransaction` calls per frontend flow according to [`docs/FRONTEND_DATA_ARCHITECTURE.md`](../docs/FRONTEND_DATA_ARCHITECTURE.md).
3. **Frontend Bundle Size & Lighthouse Timings**: Pinned slow-4G and 4x CPU emulation thresholds for FCP, TTI, and hydration.

---

## Baselines & Budgets

Baselines are stored in `perf/baselines/`:
- `perf/baselines/indexer.json`
- `perf/baselines/rpc_reads.json`
- `perf/baselines/frontend.json`

Every budget specifies:
- `budget`: The hard upper threshold. Any PR whose measured value exceeds `budget * (1 + tolerance_percent/100)` fails the CI gate.
- `baseline`: The previous established benchmark.
- `tolerance_percent`: Flake tolerance band to protect against noisy runner environments.

---

## Noise Policy & Emulation Parameters

- **Median-of-3 Runs**: Indexer replay benchmarks execute 3 full runs against ephemeral SQLite databases and use the median value.
- **Pinned Network Throttling**:
  - Profile: `slow-4G`
  - RTT: $150\text{ ms}$
  - Throughput: $1{,}638.4\text{ Kbps}$
  - CPU Slowdown: $4\times$ multiplier

---

## Ratchet Mode

When `RATCHET=1` (or on automated merges without justification comments), the performance harness compares measured values against current baselines. If a merge introduces an improvement, the baseline is automatically tightened:

```bash
RATCHET=1 node perf/harness/check_budgets.mjs
```

---

## Moving a Bound Deliberately (Governance Procedure)

If a new architectural requirement legitimately increases RPC calls or indexer processing requirements:
1. **Justify in PR Description**: The PR author must state the reason for the increase under a dedicated `## Performance Impact & Justification` section.
2. **Maintainer Approval**: Requires review and approval from a designated maintainer (`.github/CODEOWNERS`).
3. **Update Baseline File**: Commit the modified `budget` in `perf/baselines/*.json` referencing the issue/PR number.

---

## Emergency Merge Bypass

For emergency hotfixes where performance audit must be deferred:
- Pass environment variable `PERF_BYPASS=1` or attach the `perf-bypass` PR label.
- The gate emits a high-priority warning to the PR log and health surface, allowing CI to pass while recording the violation in `perf/trend.json`.
