#!/usr/bin/env bash
# ==============================================================================
# check_generated.sh — regenerate every generated artifact and fail on drift.
# ==============================================================================
# Usage:
#   bash scripts/check_generated.sh            # all areas
#   bash scripts/check_generated.sh surface    # docs/ERROR_SURFACE.md
#   bash scripts/check_generated.sh catalog    # docs/errors.md, docs/errors/*, frontend/lib/errors.ts
#   bash scripts/check_generated.sh vectors    # tests/vectors/accrual_vectors.json
#   bash scripts/check_generated.sh events     # schemas/events/, docs/EVENTS.md, generated TS
#
# This is the single source of truth for the "generated files are fresh" gates:
# CI calls it per area (in the job that already has the right toolchain) and
# contributors call it locally via `npm run generated:check`. Because both paths
# run the same code, a green local run means a green CI gate — the failure mode
# this replaces was contributors discovering the three gates one CI run at a
# time, after pushing.
#
# The generators write their outputs in place, so a *failing* run has already
# regenerated the files: `git add` the printed paths and amend, exactly as the
# instructions below say.
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

AREA="${1:-all}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; }

# check_drift <area-name> <path...> — fail if regeneration changed anything,
# including files the generator newly created (untracked).
check_drift() {
  local label="$1"
  shift
  if ! git diff --quiet -- "$@"; then
    die "generated '${label}' is out of date — the files have just been regenerated in place.
    Review and commit them:
        git add $*
        git commit --amend --no-edit   (or a follow-up commit)
    Diff that caused this:"
    git --no-pager diff --stat -- "$@"
    git --no-pager diff -- "$@" | head -n 40
    exit 1
  fi
  # A brand-new artifact (e.g. docs/errors/<new code>.md) is untracked, and
  # `git diff` cannot see it. Catch it explicitly.
  local untracked
  untracked="$(git status --porcelain --untracked-files=all -- "$@" | sed -n '/^?? /p')"
  if [ -n "$untracked" ]; then
    die "generated '${label}' produced files that are not committed yet:$untracked
    Commit them:
        git add $*"
    exit 1
  fi
  printf '    fresh: %s\n' "$label"
}

run_surface() {
  say "error-surface table (cargo example)"
  command -v cargo >/dev/null 2>&1 || { echo "    cargo not found — skipping surface area"; return 0; }
  cargo run -q -p streampay-contract --example error_surface_doc
  check_drift "docs/ERROR_SURFACE.md" docs/ERROR_SURFACE.md
}

run_catalog() {
  say "error catalog (tooling/generate-error-catalog.mjs)"
  command -v node >/dev/null 2>&1 || { echo "    node not found — skipping catalog area"; return 0; }
  node tooling/generate-error-catalog.mjs
  check_drift "docs/errors.md + docs/errors/ + frontend/lib/errors.ts" \
    docs/errors.md docs/errors frontend/lib/errors.ts
}

run_vectors() {
  say "differential vectors (scripts/generate-vectors.mjs)"
  command -v node >/dev/null 2>&1 || { echo "    node not found — skipping vectors area"; return 0; }
  node scripts/generate-vectors.mjs
  check_drift "tests/vectors" tests/vectors
}

run_events() {
  say "event schema registry (in-crate generator + scripts/generate_event_types.mjs)"
  command -v cargo >/dev/null 2>&1 || { echo "    cargo not found — skipping events area"; return 0; }
  command -v node >/dev/null 2>&1 || { echo "    node not found — skipping events area"; return 0; }
  # The generator is an #[ignore]d test in the contract crate (the same
  # test-as-generator shape as the error-surface table): it parses the
  # #[contractevent] structs out of src/ and writes schemas/events/.
  cargo test -q -p streampay-contract --lib --locked event_registry::generate -- --ignored
  node scripts/generate_event_types.mjs
  # Only the generated files: schemas/events/README.md and CHANGELOG.md are
  # hand-written prose that lives in the same directory.
  check_drift "schemas/events + docs/EVENTS.md + generated TS" \
    schemas/events/registry.json schemas/events/v1 docs/EVENTS.md \
    indexer/src/generated frontend/lib/generated
}

case "$AREA" in
  surface) run_surface ;;
  catalog) run_catalog ;;
  vectors) run_vectors ;;
  events) run_events ;;
  all)
    run_surface
    run_catalog
    run_vectors
    run_events
    ;;
  *)
    die "unknown area '$AREA' (expected: surface | catalog | vectors | events | all)"
    exit 2
    ;;
esac

say "all generated artifacts match their sources ($AREA)"
