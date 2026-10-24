#!/usr/bin/env bash
# Standalone CLI wrapper to rebuild the StreamPay contract Wasm and verify
# byte-equality against a published release digest.
#
# Usage:
#   scripts/verify_reproducible_build.sh <tag> <expected_digest>
#   scripts/verify_reproducible_build.sh --current <expected_digest>
#
# Environment variables:
#   USE_DOCKER=auto|true|false (default: auto)
#
# Exit status:
#   0 on matching digest
#   1 on mismatch or build failure

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION_PATH="${REPO_ROOT}/.github/actions/verify-reproducible-build"

if [ "${1:-}" = "--current" ]; then
  tag=""
  expected="${2:?usage: scripts/verify_reproducible_build.sh --current <expected_digest>}"
else
  tag="${1:?usage: scripts/verify_reproducible_build.sh <tag> <expected_digest>}"
  expected="${2:?usage: scripts/verify_reproducible_build.sh <tag> <expected_digest>}"
fi

export TAG="$tag"
export EXPECTED_DIGEST="$expected"
export ACTION_PATH="$ACTION_PATH"

exec bash "${ACTION_PATH}/verify.sh"
