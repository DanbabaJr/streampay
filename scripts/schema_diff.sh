#!/usr/bin/env bash
# Schema-diff gate: compare a newly built contract interface hash against the
# hash currently promoted to an environment. An unchanged interface passes; a
# changed one is a *governed event* and requires explicit acknowledgement
# (SCHEMA_CHANGE_ACK=1, wired to the `schema_change_ack` workflow input).
#
# Usage: scripts/schema_diff.sh <new-hash-file> <env>
#
# Baselines live in deployments/interface/<env>.sha256 (+ .json for a readable
# diff). They are updated by the promotion record step only after approval.
. "$(dirname "$0")/lib.sh"

new_file="${1:?usage: schema_diff.sh <new-hash-file> <env>}"
env_name="${2:?usage: schema_diff.sh <new-hash-file> <env>}"
[ -f "$new_file" ] || die "hash file not found: $new_file"

new="$(cat "$new_file")"
prev_file="$REPO_ROOT/deployments/interface/${env_name}.sha256"

echo "schema-diff ($env_name)"
echo "  previous: $([ -f "$prev_file" ] && cat "$prev_file" || echo "<none>")"
echo "  current : $new"

if [ ! -f "$prev_file" ]; then
  echo "schema-diff: first promotion for '$env_name' — no baseline to compare"
  exit 0
fi

prev="$(cat "$prev_file")"
if [ "$prev" = "$new" ]; then
  echo "schema-diff: unchanged"
  exit 0
fi

echo "schema-diff: CONTRACT INTERFACE CHANGED"
prev_json="$REPO_ROOT/deployments/interface/${env_name}.json"
if [ -f "$prev_json" ] && command -v jq >/dev/null 2>&1; then
  new_json="$(dirname "$new_file")/interface.canon.json"
  if [ -f "$new_json" ]; then
    echo "--- interface diff (previous -> current) ---"
    jq -S . "$prev_json" > "/tmp/schema-prev.canon.json" 2>/dev/null || true
    diff -u "/tmp/schema-prev.canon.json" "$new_json" | head -n 100 || true
    echo "--- end diff (truncated to 100 lines) ---"
  fi
fi

if [ "${SCHEMA_CHANGE_ACK:-0}" != "1" ]; then
  die "interface change is unacknowledged — review the diff, then re-run with schema_change_ack=true"
fi
echo "schema-diff: change acknowledged (schema_change_ack=true)"
