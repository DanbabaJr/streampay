#!/usr/bin/env bash
# Re-bless schema/fingerprint.json from the current contract source.
#
# Runs only the schema guard test with STREAMPAY_SCHEMA_BLESS=1, which rewrites
# the committed fingerprint instead of comparing against it. Review the diff and
# explain any wire-visible change in the PR before committing it.
#
# Usage: npm run schema:bless   (or: bash scripts/schema_bless.sh)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STREAMPAY_SCHEMA_BLESS=1 cargo test -p streampay-contract --locked --lib schema_fingerprint_matches_stored -- --nocapture
