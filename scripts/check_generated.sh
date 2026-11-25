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
#   bash scripts/check_generated.sh openapi    # docs/openapi.json, frontend/public/openapi.json
#   bash scripts/check_generated.sh openapi --self-test
#                                              # ... plus the self-test below
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
SELF_TEST=0
if [ "${2:-}" = "--self-test" ]; then
  SELF_TEST=1
elif [ -n "${2:-}" ]; then
  die "unknown argument '$2' (expected: --self-test)"
  exit 2
fi

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

run_openapi() {
  say "OpenAPI spec (frontend/scripts/generate-openapi.ts)"
  command -v node >/dev/null 2>&1 || { echo "    node not found — skipping openapi area"; return 0; }
  # Stock Node type stripping runs the generator with no install and no
  # network fetch: the script imports `../lib/openapi.ts` with an explicit
  # extension for exactly this reason (plain `node` cannot resolve the
  # extensionless import `tsx` used to paper over). The route handler
  # (frontend/app/openapi.json/route.ts) serves the same `generateOpenApiSpec()`
  # at runtime, so a stale committed copy means the docs lie about the API.
  node --experimental-strip-types frontend/scripts/generate-openapi.ts
  # Normalize line endings before comparing. The generator already writes LF
  # only, but the comparison must be about spec content, not about whether
  # the checkout normalized `*.json` to CRLF (see `a3af379` and
  # scripts/check_line_endings.sh): strip any carriage returns from the
  # regenerated files so a CRLF working tree cannot report drift that
  # re-running the generator can never clear.
  node -e '
    const fs = require("node:fs");
    for (const f of ["docs/openapi.json", "frontend/public/openapi.json"]) {
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\r\n?/g, "\n"));
    }
  '
  check_drift "docs/openapi.json + frontend/public/openapi.json" \
    docs/openapi.json frontend/public/openapi.json
}

# run_openapi_self_test — prove the gate still *catches* a stale spec.
#
# A gate that regenerates and diffs can silently stop failing (a broken
# generator that writes the stale file back, a comparison that never runs),
# and then it reports "fresh" forever — which is worse than no gate because
# it looks like coverage. These cases pin both directions, the way
# `node scripts/check_duplicate_json_keys.mjs --self-test` does for its
# scanner: a deliberately stale *committed* spec in each artifact must fail
# the gate, and a CRLF copy of the committed spec must still pass it.
#
# "Committed" matters: the gate regenerates in place, so doctoring the
# working tree alone proves nothing — regeneration overwrites it and the
# gate passes. The stale fixture is therefore staged into the index with
# `git add` (the exact state a PR with a stale committed spec is in), and
# the pre-test index entries are recorded first so the trap below restores
# them byte-for-byte, including any staged changes the contributor already
# had. The working-tree backups do the same for uncommitted edits.
run_openapi_self_test() {
  say "OpenAPI gate self-test (a stale fixture must fail the gate)"
  command -v node >/dev/null 2>&1 || { echo "    node not found — skipping openapi self-test"; return 0; }
  # Deliberately not `local`: the EXIT trap below runs as the shell exits
  # and must still see the backups.
  tmpdir="$(mktemp -d)"
  cp docs/openapi.json "$tmpdir/docs-openapi.json"
  cp frontend/public/openapi.json "$tmpdir/public-openapi.json"
  # `ls-files --format` emits exactly the `<mode>,<sha>,<path>` triple
  # `update-index --cacheinfo` consumes (plain `ls-files -s` inserts a
  # stage number between the sha and the path, which --cacheinfo rejects).
  docs_index="$(git ls-files --format='%(objectmode),%(objectname),%(path)' -- docs/openapi.json)"
  public_index="$(git ls-files --format='%(objectmode),%(objectname),%(path)' -- frontend/public/openapi.json)"
  # Restore the pre-test files and index entries whatever happens next; the
  # gate itself regenerates the working tree, so on the expected path the
  # file restore is a no-op copy. Idempotent by design (it is called after
  # each case and again at the end); only the final step removes $tmpdir.
  restore_self_test() {
    cp "$tmpdir/docs-openapi.json" docs/openapi.json
    cp "$tmpdir/public-openapi.json" frontend/public/openapi.json
    for entry in "$docs_index" "$public_index"; do
      [ -n "$entry" ] || continue
      git update-index --cacheinfo "$entry"
    done
  }
  trap 'restore_self_test' EXIT

  local failed=0

  # Case 1: a stale committed docs/openapi.json must fail.
  node -e '
    const fs = require("node:fs");
    const spec = JSON.parse(fs.readFileSync("docs/openapi.json", "utf8"));
    spec.info.version = "0.0.0-stale-self-test";
    fs.writeFileSync("docs/openapi.json", JSON.stringify(spec, null, 2) + "\n");
  '
  git add docs/openapi.json
  if ( run_openapi ) >/dev/null 2>&1; then
    printf '    FAIL stale docs/openapi.json: gate passed on a stale spec\n'
    failed=1
  else
    printf '    ok   stale docs/openapi.json fails the gate\n'
  fi
  restore_self_test

  # Case 2: a stale committed frontend/public/openapi.json must fail too.
  node -e '
    const fs = require("node:fs");
    const spec = JSON.parse(fs.readFileSync("frontend/public/openapi.json", "utf8"));
    spec.info.version = "0.0.0-stale-self-test";
    fs.writeFileSync("frontend/public/openapi.json", JSON.stringify(spec, null, 2) + "\n");
  '
  git add frontend/public/openapi.json
  if ( run_openapi ) >/dev/null 2>&1; then
    printf '    FAIL stale frontend/public/openapi.json: gate passed on a stale spec\n'
    failed=1
  else
    printf '    ok   stale frontend/public/openapi.json fails the gate\n'
  fi
  restore_self_test

  # Case 3: CRLF line endings in the committed spec must NOT fail the gate —
  # the comparison is about spec content, and a Windows checkout must not
  # report drift that re-running the generator can never clear.
  node -e '
    const fs = require("node:fs");
    fs.writeFileSync("docs/openapi.json",
      fs.readFileSync("docs/openapi.json", "utf8").replace(/\n/g, "\r\n"));
  '
  if ( run_openapi ) >/dev/null 2>&1; then
    printf '    ok   CRLF docs/openapi.json still passes the gate\n'
  else
    printf '    FAIL CRLF docs/openapi.json: gate reported drift on line endings alone\n'
    failed=1
  fi

  trap - EXIT
  restore_self_test
  rm -rf "$tmpdir"
  if [ "$failed" -ne 0 ]; then
    die "openapi self-test failed — the gate no longer measures what it claims."
    exit 1
  fi
  printf '    self-test: 3/3 cases behaved as specified.\n'
}

case "$AREA" in
  surface) run_surface ;;
  catalog) run_catalog ;;
  vectors) run_vectors ;;
  events) run_events ;;
  openapi)
    if [ "$SELF_TEST" -eq 1 ]; then run_openapi_self_test; fi
    run_openapi
    ;;
  all)
    run_surface
    run_catalog
    run_vectors
    run_events
    run_openapi
    ;;
  *)
    die "unknown area '$AREA' (expected: surface | catalog | vectors | events | openapi | all)"
    exit 2
    ;;
esac

say "all generated artifacts match their sources ($AREA)"
