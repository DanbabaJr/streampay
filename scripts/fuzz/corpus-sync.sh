#!/usr/bin/env bash
# Move fuzz corpora between fuzz/corpus/ and the `fuzz-corpus` branch.
#
#   scripts/fuzz/corpus-sync.sh pull     # branch -> fuzz/corpus/  (start of a run)
#   scripts/fuzz/corpus-sync.sh push     # fuzz/corpus/ -> branch  (end of a run)
#
# The branch is an orphan: it shares no history with main, so corpus churn
# never touches main's history or clone size. Layout on the branch:
#   corpus/<target>/        minimised corpus (output of libFuzzer -merge=1)
#   regressions/<target>/   triaged crashers, kept forever
#   reports/<date>.md       campaign reports
#
# Size discipline (enforced here; see docs/FUZZ_CAMPAIGN.md):
#   - only merged corpora are pushed — campaign.sh merges before it exits
#   - each file <= 4 KiB (the campaign's -max_len)
#   - each target <= 20 MiB; push refuses beyond that
set -euo pipefail

BRANCH="${FUZZ_CORPUS_BRANCH:-fuzz-corpus}"
REMOTE="${FUZZ_CORPUS_REMOTE:-origin}"
MAX_TARGET_BYTES=$((20 * 1024 * 1024))
MAX_FILE_BYTES=4096

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FUZZ="$ROOT/fuzz"
WORK="$(mktemp -d)"
# Remove the scratch worktree, and the local branch used to start the orphan
# the first time, so a second run does not trip over a leftover branch.
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || rm -rf "$WORK"
  git -C "$ROOT" branch -D "$BRANCH-new" >/dev/null 2>&1 || true
}
trap cleanup EXIT

checkout() {
  if git -C "$ROOT" fetch --depth 1 "$REMOTE" "$BRANCH" 2>/dev/null; then
    git -C "$ROOT" worktree add --detach "$WORK" FETCH_HEAD >/dev/null
  else
    echo "no $REMOTE/$BRANCH yet; starting it"
    git -C "$ROOT" worktree add --detach "$WORK" >/dev/null
    git -C "$WORK" checkout --orphan "$BRANCH-new" >/dev/null
    git -C "$WORK" rm -rfq . >/dev/null 2>&1 || true
  fi
}

case "${1:-}" in
  pull)
    checkout
    mkdir -p "$FUZZ/corpus"
    for d in "$WORK/corpus"/*/; do
      [[ -d "$d" ]] || continue
      t=$(basename "$d"); mkdir -p "$FUZZ/corpus/$t"
      cp -n "$d"* "$FUZZ/corpus/$t/" 2>/dev/null || true
      echo "pulled $t: $(ls "$FUZZ/corpus/$t" | wc -l) inputs"
    done
    ;;
  push)
    checkout
    for d in "$FUZZ/corpus"/*/; do
      t=$(basename "$d")
      [[ "$t" == *.min ]] && continue
      oversized=$(find "$d" -type f -size +"${MAX_FILE_BYTES}"c | wc -l)
      (( oversized == 0 )) || { echo "refusing $t: $oversized file(s) over ${MAX_FILE_BYTES}B — re-run the merge"; exit 1; }
      bytes=$(du -sb "$d" | cut -f1)
      (( bytes <= MAX_TARGET_BYTES )) || { echo "refusing $t: ${bytes}B over the ${MAX_TARGET_BYTES}B cap"; exit 1; }
      rm -rf "$WORK/corpus/$t"; mkdir -p "$WORK/corpus/$t"; cp "$d"* "$WORK/corpus/$t/" 2>/dev/null || true
    done
    if [[ -d "$FUZZ/regressions" ]]; then mkdir -p "$WORK/regressions"; cp -rn "$FUZZ/regressions/"* "$WORK/regressions/" 2>/dev/null || true; fi
    if [[ -n "${CAMPAIGN_REPORT:-}" && -f "$CAMPAIGN_REPORT" ]]; then
      mkdir -p "$WORK/reports"; cp "$CAMPAIGN_REPORT" "$WORK/reports/$(date -u +%Y-%m-%d).md"
    fi
    git -C "$WORK" add -A
    if git -C "$WORK" diff --cached --quiet; then echo "corpus unchanged"; exit 0; fi
    git -C "$WORK" -c user.name="${GIT_AUTHOR_NAME:-fuzz-campaign}" -c user.email="${GIT_AUTHOR_EMAIL:-fuzz-campaign@users.noreply.github.com}" \
      commit -qm "fuzz: corpus snapshot $(date -u +%FT%TZ)"
    git -C "$WORK" push "$REMOTE" "HEAD:refs/heads/$BRANCH"
    echo "pushed to $REMOTE/$BRANCH"
    ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
