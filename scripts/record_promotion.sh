#!/usr/bin/env bash
# Record a promotion. Every promotion writes an "immutable-ish" record: an
# append-only line in the promotion log, a per-run runbook file with the gate
# evidence references, and (in CI, when a token is available) a comment on the
# pinned tracking issue and an uploaded release asset. Public-chain history
# cannot be edited, so the record has to live somewhere equally append-only.
#
# Usage:
#   scripts/record_promotion.sh <env> <tag> <digest> <interface-hash> <contract-id> <result> [--out <log>]
#
# Environment (all optional, for CI):
#   PROMOTION_ISSUE  issue number to append a comment to
#   GITHUB_RUN_URL   link to the workflow run
#   EVIDENCE_DIR     directory holding the evidence bundle (default: evidence/)
. "$(dirname "$0")/lib.sh"

env_name="${1:?usage: record_promotion.sh <env> <tag> <digest> <interface-hash> <contract-id> <result> [--out <log>]}"
tag="${2:?}"
digest="${3:?}"
interface_hash="${4:-}"
contract_id="${5:-}"
result="${6:?}"

log="$REPO_ROOT/deployments/promotions.log"
if [ "${7:-}" = "--out" ]; then log="${8:?--out requires a path}"; fi

evidence_dir="${EVIDENCE_DIR:-$REPO_ROOT/evidence}"
mkdir -p "$(dirname "$log")"

stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
actor="${GITHUB_ACTOR:-$(whoami 2>/dev/null || echo local)}"
run_url="${GITHUB_RUN_URL:-local}"
run_id="${stamp//[:]/}-${env_name}"

line="${stamp} | tag=${tag} | env=${env_name} | result=${result} | digest=${digest} | interface=${interface_hash:-none} | contract=${contract_id:-none} | actor=${actor} | run=${run_url}"

# Append-only: never rewrite history, only add a line.
printf '%s\n' "$line" >> "$log"
info "recorded: $line"

# Per-run record with evidence references.
mkdir -p "$REPO_ROOT/deployments/runs"
run_file="$REPO_ROOT/deployments/runs/${run_id}.md"
{
  printf '# Promotion record — %s\n\n' "$env_name"
  printf '| Field | Value |\n|---|---|\n'
  printf '| Timestamp | %s |\n' "$stamp"
  printf '| Release tag | %s |\n' "$tag"
  printf '| Environment | %s |\n' "$env_name"
  printf '| Result | %s |\n' "$result"
  printf '| Wasm digest (SHA-256) | %s |\n' "$digest"
  printf '| Interface hash | %s |\n' "${interface_hash:-n/a}"
  printf '| Contract id | %s |\n' "${contract_id:-n/a}"
  printf '| Actor | %s |\n' "$actor"
  printf '| Workflow run | %s |\n\n' "$run_url"
  printf '## Evidence\n\n'
  if [ -d "$evidence_dir" ]; then
    printf 'Artifacts in `%s`:\n\n' "$evidence_dir"
    for f in $(ls "$evidence_dir" 2>/dev/null | sort); do printf -- '- `%s`\n' "$f"; done
  else
    printf 'No evidence directory was attached.\n'
  fi
} > "$run_file"
info "run record: ${run_file#$REPO_ROOT/}"

# Append-only issue thread (the durable, externally-visible log).
if [ -n "${PROMOTION_ISSUE:-}" ] && command -v gh >/dev/null 2>&1; then
  gh issue comment "$PROMOTION_ISSUE" --body "$(printf '```\n%s\n```' "$line")" >/dev/null \
    && info "appended to promotion issue #$PROMOTION_ISSUE" \
    || warn "could not comment on promotion issue #$PROMOTION_ISSUE"
fi

echo "$run_file"
