#!/usr/bin/env bash
# Re-bless model/goldens/seed_expansion.txt from the current seed expansion.
#
# Runs only the model determinism test with STREAMPAY_SEED_GOLDEN_BLESS=1,
# which rewrites the golden document instead of comparing it.
#
# Blessing is only correct for an intentional change to the frozen contract:
# bump SEED_EXPANSION_VERSION, update model/SEED_EXPANSION.md, and explain the
# change in the PR. CI never blesses.
#
# Usage: npm run seed:golden:bless
set -euo pipefail
cd "$(dirname "$0")/.."

STREAMPAY_SEED_GOLDEN_BLESS=1 cargo test -p streampay-model --locked \
  --test seed_determinism seed_expansion_goldens_match -- --nocapture
