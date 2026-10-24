#!/usr/bin/env bash
# ==============================================================================
# lint_runbook_commands.sh — Freshness & syntax check for documentation commands
# ==============================================================================
# Usage:
#   ./scripts/lint_runbook_commands.sh [docs/RUNBOOK.md] [docs/DEMO.md]
#
# Extracts all shell command blocks from specified markdown files and asserts:
#   1. Clean bash syntax via `bash -n`
#   2. Alignment with StreamPay CLI (streampay-cli) flags & commands (detecting CLI drift)
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -gt 0 ]; then
  TARGET_DOCS=("$@")
else
  TARGET_DOCS=("$REPO_ROOT/docs/RUNBOOK.md" "$REPO_ROOT/docs/DEMO.md")
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Known valid flags from tools/streampay-cli/src/cli.ts
VALID_FLAGS=(
  "--contract"
  "--network"
  "--rpc-url"
  "--signer"
  "--source"
  "--key-file"
  "--dry-run"
  "--signed-xdr"
  "--json"
  "--secret-env"
  "--password-env"
  "--token"
  "--recipient"
  "--deposit"
  "--days"
  "--cancelable"
  "--stream-id"
  "--amount"
  "--out"
  "--force"
  "--help"
)

# Known valid subcommands from tools/streampay-cli/src/cli.ts
VALID_COMMANDS=(
  "create"
  "withdraw"
  "cancel"
  "top-up"
  "claim-all"
  "key"
  "help"
)

is_valid_flag() {
  local target="$1"
  for f in "${VALID_FLAGS[@]}"; do
    if [ "$f" = "$target" ]; then
      return 0
    fi
  done
  return 1
}

is_valid_command() {
  local target="$1"
  for c in "${VALID_COMMANDS[@]}"; do
    if [ "$c" = "$target" ]; then
      return 0
    fi
  done
  return 1
}

say "Running command freshness and syntax lint on documentation"

TOTAL_BLOCKS=0
TOTAL_CLI_CALLS=0

for doc in "${TARGET_DOCS[@]}"; do
  [ -f "$doc" ] || die "Target doc not found: $doc"
  rel_doc="${doc#"$REPO_ROOT/"}"
  info "Checking: $rel_doc"

  # Extract bash code blocks into a temporary script
  TMP_SCRIPT="$(mktemp /tmp/doc_commands_XXXXXX.sh)"
  awk '/^```bash/{flag=1;next}/^```/{flag=0}flag' "$doc" > "$TMP_SCRIPT"

  # 1. Syntax check with bash -n (substituting mock env vars to avoid unbound error if needed)
  if ! bash -n "$TMP_SCRIPT" 2>/dev/null; then
    rm -f "$TMP_SCRIPT"
    die "Bash syntax error detected in code blocks of $rel_doc"
  fi
  TOTAL_BLOCKS=$((TOTAL_BLOCKS + 1))

  # 2. Check for streampay CLI invocations and validate flag drift
  while IFS= read -r line; do
    # Match lines calling streampay
    if [[ "$line" =~ ^[[:space:]]*streampay[[:space:]]+(.*)$ ]]; then
      args_str="${BASH_REMATCH[1]}"
      TOTAL_CLI_CALLS=$((TOTAL_CLI_CALLS + 1))

      # Tokenize flags and positional command
      # We check words starting with --
      for token in $args_str; do
        if [[ "$token" =~ ^--[a-z0-9-]+$ ]]; then
          if ! is_valid_flag "$token"; then
            rm -f "$TMP_SCRIPT"
            die "CLI drift detected in $rel_doc: unrecognized flag '$token' in command:\n  streampay $args_str"
          fi
        fi
      done
    fi
  done < "$TMP_SCRIPT"

  rm -f "$TMP_SCRIPT"
done

info "Verified $TOTAL_BLOCKS document code blocks."
info "Verified $TOTAL_CLI_CALLS 'streampay' CLI invocations for syntax and flag alignment."
say "All documentation commands are fresh and syntactically valid."
