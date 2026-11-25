#!/usr/bin/env bash
# ==============================================================================
# migrate_audit.sh — run StreamPay's off-chain storage-migration planner.
# ==============================================================================
# Wraps scripts/migrate_audit.ts. Two jobs:
#
#   bash scripts/migrate_audit.sh --check      regenerate docs/MIGRATION_AUDIT.md
#                                              from tests/migration-audit/records.json
#                                              and fail on drift (CI gate)
#   bash scripts/migrate_audit.sh --generate   rewrite the golden report
#   bash scripts/migrate_audit.sh <args...>    pass straight through to the
#                                              planner, e.g. a live index walk:
#
#      bash scripts/migrate_audit.sh --contract C... --owner G... --format md
#
# Snapshot mode needs no network, no keys and no node_modules: the layout
# classifier is dependency-free, so `--check` runs in any CI job that has node.
# Live mode resolves `@stellar/stellar-sdk` from scripts/, so run it after
# `npm install` in scripts/.
# ==============================================================================
set -euo pipefail

. "$(dirname "$0")/lib.sh"

SCRIPT="$REPO_ROOT/scripts/migrate_audit.ts"
SNAPSHOT="$REPO_ROOT/tests/migration-audit/records.json"
GOLDEN="$REPO_ROOT/docs/MIGRATION_AUDIT.md"

# Node >= 22.6 strips the types itself; older runtimes are told to upgrade
# rather than silently running a different transpiler with different semantics.
node_run() {
  local flags=(--no-warnings --experimental-strip-types)
  if ! node "${flags[@]}" "$@"; then
    die "migrate_audit.ts failed to run — needs Node >= 22.6 (node $(node -v 2>/dev/null || echo missing))"
  fi
}

case "${1:-}" in
  --check)
    [ -f "$GOLDEN" ] || die "golden report missing: docs/MIGRATION_AUDIT.md (run 'bash scripts/migrate_audit.sh --generate' and commit it)"
    tmp="$(mktemp)"
    node_run "$SCRIPT" --snapshot "$SNAPSHOT" --format md --out "$tmp"
    if ! diff -u "$GOLDEN" "$tmp"; then
      rm -f "$tmp"
      die "docs/MIGRATION_AUDIT.md is out of date — regenerate it and commit:
      bash scripts/migrate_audit.sh --generate
      git add docs/MIGRATION_AUDIT.md"
    fi
    rm -f "$tmp"
    say "docs/MIGRATION_AUDIT.md matches tests/migration-audit/records.json"
    ;;
  --generate)
    node_run "$SCRIPT" --snapshot "$SNAPSHOT" --format md --out "$GOLDEN"
    say "wrote $GOLDEN"
    ;;
  *)
    node_run "$SCRIPT" "$@"
    ;;
esac
