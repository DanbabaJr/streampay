#!/usr/bin/env bash
# Benchmark storage reads, writes, and layout options for StreamPay.
#
# Runs the reproducible contract storage benchmark harness in
# contracts/streaming-payments/examples/storage_benchmark.rs to profile CPU
# instruction budget, memory bytes, and storage footprint across the full
# stream lifecycle (creation, reads, partial/max withdrawals, cancel, top-up)
# and evaluates monolithic vs split (hot/cold) storage layout.
#
# Usage:
#   scripts/benchmark_storage.sh
#   cargo run -p streampay-contract --example storage_benchmark
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Running StreamPay Storage Read & Layout Benchmark ==="
cargo run -p streampay-contract --example storage_benchmark
