#!/usr/bin/env bash
# merge_preview.sh — merge every open pull request into main *in one tree* and
# run the fast gates there.
#
# Why this exists
# ---------------
# GitHub's PR checks answer "is this PR good?". Nothing in the repo has ever
# answered the question that actually decides whether main is healthy here:
# "is this *set* of PRs good, merged back to back?". Every red main since
# October is a case where the answer was no and the individual checks all said
# yes:
#
#   * b48a94be (the 2026-11 bulk merge): #626's modules referenced 19
#     `Branch::` arms that its own `enum Branch` never declared, and #677
#     re-landed #660's session keys under three identical method names
#     (`E0081`/`E0592`). Both PRs were green against the main they were opened
#     on; together they did not compile.
#   * 94f80e3: #156 replaced the dashboard's error state with the toast API
#     while #144's create handler still called the removed `setError`. Same
#     shape, frontend this time.
#
# The bulk merge is done by a human clicking buttons, and a merge queue needs
# branch protection this repo does not use. So the preview runs on a schedule:
# it answers the question before the clicks, not after.
#
# What it does
# ------------
#   1. fetches every open, non-draft PR head (`gh`, or refs the caller fetched)
#   2. merges them into origin/main in ascending PR order in a scratch worktree,
#      recording any PR that conflicts
#   3. after *each* successful merge runs the fast gates on the accumulated
#      tree, so a failure is attributed to the PR that made the union bad
#   4. optionally (`--cargo-check`, `--frontend-check`) compiles the final
#      union, which is the only way to see the collisions the static gates
#      cannot model
#   5. writes a markdown report to --report and $GITHUB_STEP_SUMMARY
#
# Exit status is 0 whenever a report was produced: this job informs, it does
# not gate, because a scheduled red check trains people to ignore red checks.
# A run that could not build a report exits 2.
#
# Usage: bash scripts/merge_preview.sh [--repo DIR] [--report FILE]
#                                      [--cargo-check] [--frontend-check]
#                                      [--prs "696 699"] [--base REF]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT=""
CARGO_CHECK=0
FRONTEND_CHECK=0
PR_LIST=""
BASE_REF="${BASE_REF:-origin/main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_ROOT="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    --cargo-check) CARGO_CHECK=1; shift ;;
    --frontend-check) FRONTEND_CHECK=1; shift ;;
    --prs) PR_LIST="$2"; shift 2 ;;
    --base) BASE_REF="$2"; shift 2 ;;
    *) echo "merge_preview: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$REPORT" ]; then
  REPORT="$(mktemp -t merge-preview-XXXXXX).md"
fi
SUMMARY="${GITHUB_STEP_SUMMARY:-}"
SCRATCH_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
WT="$SCRATCH_ROOT/merge-preview-tree"
BRANCH="merge-preview"

log() { printf '%s\n' "$*"; }

# A linked worktree has .git as a *file*, so the check is git's own.
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "merge_preview: $REPO_ROOT is not a git checkout" >&2; exit 2; }
git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF" >/dev/null 2>&1 || {
  echo "merge_preview: $BASE_REF not found (fetch it first)" >&2; exit 2; }

# --- 1. the PR set ----------------------------------------------------------
if [ -z "$PR_LIST" ]; then
  if command -v gh >/dev/null 2>&1 && [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]; then
    PR_LIST=$(gh pr list --repo "${GITHUB_REPOSITORY:-Neziahtech/streampay}" --state open \
      --json number,isDraft --jq '[.[] | select(.isDraft|not) | .number] | sort | map(tostring) | join(" ")' 2>/dev/null)
  fi
fi
if [ -z "${PR_LIST:-}" ]; then
  # Fall back to refs already present (a plain `git fetch origin +refs/pull/*/head`
  # layout), so the script is usable without the API.
  PR_LIST=$(git -C "$REPO_ROOT" for-each-ref --format='%(refname:short)' 'refs/remotes/origin/pull/*/head' 2>/dev/null \
    | sed -E 's#.*pull/([0-9]+)/head#\1#' | sort -n | tr '\n' ' ')
fi
if [ -z "${PR_LIST// /}" ]; then
  log "No pull requests resolved (set GITHUB_TOKEN, or fetch refs/pull/*/head, or pass --prs)."
  printf '%s\n' "## Merge preview" "" "No open pull requests were available to preview." > "$REPORT"
  [ -n "$SUMMARY" ] && cat "$REPORT" >> "$SUMMARY"
  exit 0
fi
log "Preview PRs (ascending): $PR_LIST"

# --- 2. scratch tree -------------------------------------------------------
git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
rm -rf "$WT"
git -C "$REPO_ROOT" worktree add --detach "$WT" "$BASE_REF" >/dev/null 2>&1 || {
  echo "merge_preview: could not create scratch worktree" >&2; exit 2; }
git -C "$WT" checkout -q -B "$BRANCH" "$BASE_REF" || { echo "merge_preview: checkout failed" >&2; exit 2; }
cleanup() {
  [ -n "${KEEP_TREE:-}" ] && { echo "preview tree kept at $WT ($BRANCH)"; return; }
  git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The gates are self-locating (they derive the repo root from their own path),
# so they must run from the scratch tree with *this* revision of `scripts/`
# copied in: a first run, before the collision gate is on main, would otherwise
# report every merge as breaking simply because the file did not exist yet.
cp -a "$REPO_ROOT/scripts/." "$WT/scripts/" 2>/dev/null || true

# --- 3. gates --------------------------------------------------------------
# Every gate's findings are collected as text, not just an exit code. A preview
# has to answer "did *this merge* make the union bad?", and main is not always
# pristine when the question is asked - so a merge is only blamed for lines the
# baseline did not already have.
gate_findings() {
  {
    (cd "$WT" && python3 scripts/cross_pr_collision.py --root . 2>&1 | grep -E '^x |^::error::' | sed 's/^/collision: /')
    (cd "$WT" && bash scripts/check_error_codes.sh 2>&1 | grep -E '^(ERROR|✗|x |::error::|  - )' | sed 's/^/error_codes: /')
    (cd "$WT" && node scripts/check_duplicate_json_keys.mjs 2>&1 | grep -E '^(ERROR|✗|x |::error::|  - )' | sed 's/^/json_keys: /')
  } | sort
}

declare -a MERGED=() CONFLICTED=() BROKEN=()
BASELINE=$(gate_findings)
log "Baseline findings: $(printf '%s\n' "$BASELINE" | grep -c . ) line(s)"

{
  printf '%s\n' "## Merge preview" ""
  printf '%s\n' "Baseline \`$BASE_REF\` ($(git -C "$WT" rev-parse --short HEAD)), $(printf '%s\n' "$PR_LIST" | wc -w) open PRs, merged in ascending order into one tree."
  printf '%s\n' "Baseline gate findings: $(printf '%s\n' "$BASELINE" | grep -c . ) (pre-existing, not attributed to any PR)."
  printf '%s\n' ""
} > "$REPORT"

for n in $PR_LIST; do
  REF="refs/remotes/origin/pull/$n/head"
  if ! git -C "$REPO_ROOT" rev-parse --verify "$REF" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" fetch -q origin "+refs/pull/$n/head:refs/remotes/origin/pull/$n/head" 2>/dev/null || true
  fi
  if ! git -C "$REPO_ROOT" rev-parse --verify "$REF" >/dev/null 2>&1; then
    printf -- '- **#%s** — head ref unavailable, skipped\n' "$n" >> "$REPORT"
    continue
  fi
  TITLE=$(git -C "$REPO_ROOT" log -1 --format=%s "$REF" | cut -c1-80)
  if ! git -C "$WT" merge -q --no-ff --no-edit -m "preview: merge #$n" "$REF" >/dev/null 2>&1; then
    git -C "$WT" merge --abort >/dev/null 2>&1
    CONFLICTED+=("$n")
    printf -- '- **#%s** — *conflicts* (`%s`)\n' "$n" "$TITLE" >> "$REPORT"
    continue
  fi
  MERGED+=("$n")
  CUR=$(gate_findings)
  NEW=$(printf '%s\n' "$CUR" | grep -F -x -v -f <(printf '%s\n' "$BASELINE") | grep . || true)
  if [ -z "$NEW" ]; then
    printf -- '- **#%s** — merged, no new gate findings (`%s`)\n' "$n" "$TITLE" >> "$REPORT"
  else
    BROKEN+=("$n")
    printf -- '- **#%s** — merged, **newly breaks the union** (`%s`)\n' "$n" "$TITLE" >> "$REPORT"
    printf -- '  ```\n%s\n  ```\n' "$(printf '%s\n' "$NEW" | head -20)" >> "$REPORT"
  fi
done

# --- 4. the definitive compile of the union --------------------------------
# The static gates above catch the contract's merge collisions. A type error in
# the frontend (#156 over #144: one PR deleted the state the other's handler
# still called) is only visible to `tsc`, and the union's Wasm size is only
# visible to a build. Both are opt-in because both cost minutes.
if [ "$CARGO_CHECK" = "1" ] && [ ${#MERGED[@]} -gt 0 ]; then
  log "cargo check on the union tree (${#MERGED[@]} merges)"
  if (cd "$WT" && cargo check -q -p streampay-contract --all-targets > "$SCRATCH_ROOT/merge-preview-cargo.log" 2>&1); then
    printf '%s\n' "" "### Union compile (contract)" "" "PASS — \`cargo check -p streampay-contract --all-targets\` on the full union tree." >> "$REPORT"
  else
    printf '%s\n' "" "### Union compile (contract)" "" "FAIL — the tree formed by merging these PRs together does not compile. First errors:" "" '```' >> "$REPORT"
    grep -E "^(error|warning: unused)" "$SCRATCH_ROOT/merge-preview-cargo.log" | head -20 >> "$REPORT"
    printf '%s\n' '```' >> "$REPORT"
  fi
fi

if [ "$FRONTEND_CHECK" = "1" ] && [ ${#MERGED[@]} -gt 0 ]; then
  log "frontend typecheck on the union tree"
  LOGF="$SCRATCH_ROOT/merge-preview-frontend.log"
  if ! (cd "$WT/frontend" && npm ci --no-audit --no-fund > "$LOGF" 2>&1); then
    printf '%s\n' "" "### Union compile (frontend)" "" "FAIL — \`npm ci\` on the union tree, which is what a lockfile a PR forgot to regenerate looks like:" "" '```' >> "$REPORT"
    grep -E "npm (error|warn) ERESOLVE|Missing:|Invalid:|ERESOLVE" "$LOGF" | head -12 >> "$REPORT"
    printf '%s\n' '```' >> "$REPORT"
  elif ! (cd "$WT/frontend" && npx tsc --noEmit >> "$LOGF" 2>&1); then
    printf '%s\n' "" "### Union compile (frontend)" "" "FAIL — \`tsc --noEmit\` on the union tree. First errors:" "" '```' >> "$REPORT"
    grep -E "error TS" "$LOGF" | head -20 >> "$REPORT"
    printf '%s\n' '```' >> "$REPORT"
  else
    printf '%s\n' "" "### Union compile (frontend)" "" "PASS — install and typecheck clean on the full union tree." >> "$REPORT"
  fi
fi

# --- 5. verdict ------------------------------------------------------------
{
  printf '%s\n' "" "### Verdict"
  printf -- '- merged cleanly: %s\n' "${#MERGED[@]}"
  printf -- '- conflicting: %s\n' "${#CONFLICTED[@]}"
  printf -- '- broke the union: %s\n' "${#BROKEN[@]}"
  if [ ${#CONFLICTED[@]} -eq 0 ] && [ ${#BROKEN[@]} -eq 0 ]; then
    printf '%s\n' "- the whole set can be merged back to back without leaving main broken"
  fi
} >> "$REPORT"

[ -n "$SUMMARY" ] && cat "$REPORT" >> "$SUMMARY"
log "Report written to $REPORT (${#MERGED[@]} merged, ${#CONFLICTED[@]} conflicted, ${#BROKEN[@]} breaking)"
exit 0
