#!/usr/bin/env bash
# ==============================================================================
# check_line_endings.sh — fail if any tracked file is *committed* with CRLF.
# ==============================================================================
# Why this exists: rustfmt emits LF, so a file committed with CRLF fails
# `cargo fmt --all -- --check` with a diff of every single line — which reads to
# a contributor as "CI hates my whole file" when the actual problem is that
# their editor (or `core.autocrlf=true`) wrote carriage returns into the commit.
# It also silently breaks anything that hashes file bytes (the error catalog's
# schema fingerprint), and it is invisible on the Linux CI checkout until the
# gate fires.
#
# The check looks at the index (what is committed), not the working tree, so it
# measures the thing CI actually builds instead of the contributor's local
# autocrlf setting.
#
# Usage:  bash scripts/check_line_endings.sh
# Fix:    git add --renormalize . && git commit
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# `git ls-files --eol` reports one line per tracked file:
#   i/<attr>  w/<attr>  attr/<gitattributes>   <path>
# i/crlf and i/mixed mean the committed blob contains carriage returns.
offenders="$(git ls-files --eol | awk '$1 == "i/crlf" || $1 == "i/mixed" { print $NF }' | sort)"

if [ -n "$offenders" ]; then
  count="$(printf '%s\n' "$offenders" | wc -l | tr -d ' ')"
  printf '\033[1;31mERROR: %s tracked file(s) are committed with CRLF line endings.\033[0m\n\n' "$count"
  printf '%s\n' "$offenders" | sed 's/^/    /'
  cat <<'FIX'

Fix it in one step — this re-stages every tracked file through git's text
normalization (.gitattributes), storing LF, without touching your changes:

    git add --renormalize .
    git commit -m "chore: normalize line endings to LF"

If a file genuinely must keep CRLF (it does not, for anything in this repo),
say so in .gitattributes instead of committing the carriage returns.
FIX
  exit 1
fi

printf 'OK: every tracked file is stored with LF in the index.\n'
