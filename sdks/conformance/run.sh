#!/usr/bin/env bash
# Cross-SDK conformance entry point.
#
#   ./sdks/conformance/run.sh [--live] [extra orchestrator flags]
#
# Offline (default): builds the TypeScript client, runs the Rust and Python
# decoders, and requires all three to reproduce every `sdks/vectors/*.json`
# expectation and each other.
#
# Live: additionally requires --sandbox, e.g.
#   ./sdks/conformance/run.sh --live \
#     --sandbox "python3 sdks/conformance/sandbox.py"
#
# Requires: node/npm deps in sdks/typescript, cargo, Python 3.10+.
set -euo pipefail

SDKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$SDKS_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Build TypeScript client"
(cd "$SDKS_DIR/typescript" && npm run --silent build)

echo "==> Orchestrate conformance"
exec python3 "$SDKS_DIR/conformance/orchestrator.py" "$@"
