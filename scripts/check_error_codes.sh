#!/usr/bin/env bash
# check_error_codes.sh — guard the StreamError numeric contract.
#
# Every StreamError variant carries a numeric code that is part of the public,
# on-chain interface: clients branch on it, so a code is never renumbered,
# reused, or removed — new variants are appended with the next free code, and a
# variant that becomes unreachable is *retired* (kept in the enum) rather than
# deleted. The same holds for the registry in `surface.rs`, which maps every
# rejection branch to the code it returns. What this checks, in milliseconds and
# with no Rust toolchain — instead of minutes of cargo producing an opaque build
# log (`E0081: discriminant value assigned to multiple variants`,
# `no variant named ...`) or, worse, a silent wire-protocol break:
#
#   1. a duplicated numeric code — the classic case is two contributor PRs that
#      each append "the next free code" against the same main and collide after
#      one of them merges. CI runs this on the PR *merge* ref, so both sides of
#      the collision are already in the same file;
#   2. a missing code (a gap in 1..max) — the signature of a variant that was
#      deleted or renumbered, which silently invalidates existing clients;
#   3. `Branch::X` referenced by the mapping but never declared in `enum Branch`
#      — the mistake a merge produces when one side adds arms and the other
#      does not have the variants;
#   4. a StreamError code that no branch returns and that is not retired — the
#      contract's matrix test asserts this too, after a full wasm build.
#
# It also answers the question every contributor asks when 1 fires: *which code
# should I use instead?* That number is resolved against the base branch's enum
# when the base is reachable, never against the working tree alone — see
# "where does the next free code come from" below. Resolving the base is always
# best effort: if it cannot be done, the advice is still printed, labelled for
# what it is, and the gate's verdict is unchanged.
#
# Exit 0 = codes unique, gapless and wired; 1 = duplicate/invalid/unwired
# (blocking); gaps are reported as warnings because a defensive skip is ugly,
# not breaking.
#
# Usage: bash scripts/check_error_codes.sh   (from anywhere; paths are repo-rooted)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2
ENUM="contracts/streaming-payments/src/errors.rs"

if [ ! -f "$ENUM" ]; then
  echo "::error::${ENUM} not found — the error-code gate cannot run."
  exit 1
fi

# Emit "<line> <VariantName> <code>" for each `Name = 12,` inside the enum body
# (comments stripped, so doc comments can never be mistaken for variants).
body="$(awk '
  /^pub enum StreamError[ \t]*\{/ {inen=1; next}
  inen && /^\}/                  {inen=0}
  inen {
    line=$0
    sub(/\/\/.*/, "", line)
    if (match(line, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*[0-9]+[ \t]*,?$/)) {
      n=line; gsub(/[ \t,]/, "", n)
      split(n, a, "=")
      print NR" "a[1]" "a[2]
    }
  }
' "$ENUM")"

if [ -z "$body" ]; then
  echo "::error::no discriminants parsed from ${ENUM} — the enum shape changed. Update this gate to match; do not drop it."
  exit 1
fi

count="$(printf '%s\n' "$body" | wc -l | tr -d ' ')"
min="$(printf '%s\n' "$body" | awk '{print $3}' | sort -n | head -1)"
max="$(printf '%s\n' "$body" | awk '{print $3}' | sort -n | tail -1)"

# ---------------------------------------------------------------------------
# Where does the next free code come from?
#
# `StreamError` is append-only *shared mutable state with no allocator*. Two PRs
# that each pick "the highest code in my tree plus one" collide the moment they
# both merge. So the number this gate advises must be the base branch's, not the
# working tree's: a contributor running `npm run codes:check` on their own branch
# (which CONTRIBUTING tells them to do) sees only their branch's codes, and
# telling them "use 31" while the base already owns 1–63 manufactures exactly the
# collision the duplicate check below then rejects. On CI's merge ref the two
# numbers usually agree — which is precisely why deriving it has to be explicit
# rather than incidental.
#
# Resolving the base is best effort and can never fail the gate: a shallow CI
# checkout, a missing remote, an offline run or a detached archive all fall back
# to this tree's max, and the message says so instead of posing as authority.
# ---------------------------------------------------------------------------
base_ref=""
base_max=""
stale_base=0

# Print the discriminants of `pub enum StreamError` in <rev>:<file>, one per line.
base_enum_codes() {
  git show "$1:$ENUM" 2>/dev/null | awk '
    /^pub enum StreamError[ \t]*\{/ {inen=1; next}
    inen && /^\}/                  {inen=0}
    inen {
      line=$0
      sub(/\/\/.*/, "", line)
      if (match(line, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*[0-9]+[ \t]*,?$/)) {
        n=line; gsub(/[ \t,]/, "", n); split(n, a, "="); print a[2]
      }
    }'
}

# Set base_max from rev $1 if that rev carries a parsable enum.
try_base() {
  local codes
  codes="$(base_enum_codes "$1")"
  if [ -n "$(printf '%s' "$codes" | tr -d '[:space:]')" ]; then
    base_max="$(printf '%s\n' "$codes" | sort -n | tail -1)"
    base_ref="$1"
    return 0
  fi
  return 1
}

if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  want_base="${GITHUB_BASE_REF:-main}"
  for cand in "origin/$want_base" "$want_base" origin/main main; do
    git rev-parse --verify -q "$cand" >/dev/null 2>&1 || continue
    try_base "$cand" && break
  done
  if [ -z "$base_ref" ]; then
    # A pull_request checkout is depth-1 on the merge commit: no main ref at all.
    # One cheap fetch, and if the runner cannot authorise it, we just carry on.
    if git fetch --no-tags --quiet --depth=1 origin "$want_base" >/dev/null 2>&1; then
      try_base FETCH_HEAD || try_base "origin/$want_base"
      [ "$base_ref" = "FETCH_HEAD" ] && base_ref="origin/$want_base (fetched)"
    fi
  fi
fi

if [ -n "$base_max" ]; then
  highest="$max"
  [ "$base_max" -gt "$max" ] && highest="$base_max"
  next_free=$((highest + 1))
  free_note="the base branch (${base_ref}) owns codes up to ${base_max}, this tree up to ${max}"
  if [ "$base_max" -gt "$max" ]; then
    stale_base=1
  fi
else
  next_free=$((max + 1))
  free_note="highest code in this tree is ${max}; the base branch (${GITHUB_BASE_REF:-main}) could not be read from here, so confirm against it before you pick"
fi

errors=0
has_gaps=0
# Annotations carry a file so GitHub points at the offending line in the Files
# tab; the plain echo keeps the raw log readable for `gh run download` users.
warn() { echo "::warning file=$1::$2"; echo "WARNING $1: $2"; }
fail() { echo "::error file=$1,line=$2::$3"; echo "ERROR $1:$2: $3"; errors=$((errors + 1)); }

# A branch whose enum stops below the base's highest code is not invalid — its
# own codes are unique, so no check below would mention it — but it is about to
# allocate a number the wire already has. Advisory only: being behind is a
# rebase-away problem, and failing CI for it would strand a correct branch.
if [ "$stale_base" = "1" ]; then
  warn "$ENUM" "This branch's enum stops at ${max} but ${base_ref} already owns codes up to ${base_max} — the branch is behind. Merge the base before you allocate: new codes start at ${next_free}, and a code you pick below ${base_max} is already someone else's on the wire."
fi

# 1. duplicated numeric codes (blocking)
for code in $(printf '%s\n' "$body" | awk '{print $3}' | sort -n | uniq -d); do
  first_line="$(printf '%s\n' "$body" | awk -v c="$code" '$3 == c {print $1; exit}')"
  owners="$(printf '%s\n' "$body" | awk -v c="$code" '$3 == c {printf "%s (line %s), ", $2, $1}' | sed 's/, $//')"
  fail "$ENUM" "$first_line" "Duplicate StreamError code ${code}: ${owners}. Codes are the wire contract — keep the variant that already owns ${code} and move the other to ${next_free} or higher (${free_note}), then regenerate the artifacts ('npm run generated:check')."
done

# 2. duplicated variant names (blocking; Rust would not compile, but the
#    message beats an E0255 in a 4-minute build log)
for name in $(printf '%s\n' "$body" | awk '{print $2}' | sort | uniq -d); do
  first_line="$(printf '%s\n' "$body" | awk -v n="$name" '$2 == n {print $1; exit}')"
  fail "$ENUM" "$first_line" "Duplicate StreamError variant name '${name}'."
done

# 3. code 0 is not a valid Soroban error code (blocking)
while read -r line name code; do
  [ "${code:-}" = "0" ] && fail "$ENUM" "$line" "StreamError::${name} = 0 — Soroban contract error codes start at 1."
done <<< "$(printf '%s\n' "$body" | awk '$3 == 0')"

# 4. gaps in 1..max (warning): every retired variant stays, so the set must be
#    contiguous. A gap means a code was deleted or skipped.
gaps="$(printf '%s\n' "$body" | awk '{print $3}' | sort -n | awk '
  NR > 1 && $1 != prev + 1 { if ($1 > prev + 1) printf "%s..%s ", prev + 1, $1 - 1 }
  { prev = $1 }')"
if [ -n "$(printf '%s' "$gaps" | tr -d ' ')" ]; then
  has_gaps=1
  warn "$ENUM" "Codes in use run ${min}–${max} but ${count} variants leave gaps (${gaps}). A code is never reused or deleted: an unreachable variant is retired in place. If nothing was removed, renumber your new variant into the gap and use ${next_free} for the rest."
fi

# ---------------------------------------------------------------------------
# Registry wiring: the two mistakes that show up as a red *wasm build* rather
# than a red format check, both caught here without installing a toolchain.
# `surface.rs` is the mapping (entrypoint, condition) -> StreamError; every code
# has to be reachable through it (or retired), and every branch the mapping
# mentions has to be declared by the enum.
# ---------------------------------------------------------------------------
SURFACE="contracts/streaming-payments/src/surface.rs"

if [ ! -f "$SURFACE" ]; then
  warn "$SURFACE" "${SURFACE} not found — skipped the registry-wiring checks, which normally run as part of this gate."
else
  # Declared Branch variants: bare `Name,` lines inside `pub enum Branch { ... }`.
  declared="$(awk '
    /^pub enum Branch[ \t]*\{/ {b=1; next}
    b && /^\}/                {b=0}
    b {
      line=$0; sub(/\/\/.*/, "", line)
      if (match(line, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*,?[ \t]*$/)) {
        gsub(/[ \t,]/, "", line); print NR" "line
      }
    }
  ' "$SURFACE")"
  # Names referenced as `Branch::Name` in *code*, each paired with its first
  # occurrence. Comments are stripped first so a prose mention in a doc comment
  # can never fail a PR (the parse keeps line numbers: sed does not drop lines).
  referenced="$(sed 's://.*::' "$SURFACE" | grep -n -o 'Branch::[A-Za-z0-9_]\+' \
    | sed 's/:Branch::/ /' | awk '!seen[$2]++')"
  declared_count="$(printf '%s\n' "$declared" | grep -c . || true)"

  if [ "$declared_count" -gt 0 ]; then
    names_only="$(printf '%s\n' "$declared" | awk '{print $2}')"
    # 5. a branch the mapping mentions but the enum never declares.
    while read -r rline rname; do
      [ -z "${rname:-}" ] && continue
      if ! printf '%s\n' "$names_only" | grep -qx -- "$rname"; then
        fail "$SURFACE" "$rline" "surface.rs references Branch::${rname} but 'pub enum Branch' never declares it — the wasm build fails here with 'no variant named ${rname}'. Add the variant to 'pub enum Branch' and give it an arm in 'Branch::error()' returning the StreamError code it rejects with."
      fi
    done <<< "$(printf '%s\n' "$referenced")"
    # 6. the same branch declared twice (a merge artifact; Rust rejects it).
    for dup in $(printf '%s\n' "$names_only" | sort | uniq -d); do
      dup_line="$(printf '%s\n' "$declared" | awk -v n="$dup" '$2 == n {print $1; exit}')"
      fail "$SURFACE" "$dup_line" "Duplicate Branch variant '${dup}' in 'pub enum Branch' — keep one declaration and merge the arms that point at it."
    done
  else
    warn "$SURFACE" "no Branch variants parsed — the enum shape changed; this gate reported nothing about registry wiring rather than guess."
  fi

  # 7. every StreamError code is reachable through a branch or retired. Looser
  #    than the matrix test (a mention in a doc comment counts here), so it only
  #    reports codes that are missing from the registry entirely.
  while read -r vline vname vcode; do
    [ -z "${vname:-}" ] && continue
    if ! grep -Eq "StreamError::${vname}([^A-Za-z0-9_]|$)" "$SURFACE"; then
      fail "$ENUM" "$vline" "StreamError::${vname} (${vcode}) is not wired into the registry: no Branch maps to it in surface.rs and it is not in RETIRED_CODES. Add the rejection branch that returns it to 'pub enum Branch' + 'Branch::error()' — the contract's matrix test (every_error_code_is_produced_or_retired) fails the same way, minutes later after a full wasm build."
    fi
  done <<< "$body"
fi

if [ "$errors" -gt 0 ]; then
  echo
  echo "Found ${errors} problem(s) in ${ENUM} / ${SURFACE} (${count} variants, codes ${min}–${max}, ${declared_count:-0} registry branches)."
  echo "New variants take code ${next_free} at the bottom of the enum, and need a Branch that returns them (${free_note})."
  echo "After fixing, regenerate everything that reads this enum:"
  echo "    npm run generated:check   # error-surface table, catalog, frontend/lib/errors.ts"
  exit 1
fi

if [ "$has_gaps" = "1" ]; then
  echo "StreamError: ${count} variants, codes ${min}–${max}, unique but not contiguous (see the gap warning above). Next free code: ${next_free} — ${free_note}."
else
  echo "StreamError: ${count} variants, codes ${min}–${max}, unique and contiguous. Next free code: ${next_free} — ${free_note}."
fi
if [ -f "$SURFACE" ]; then
  echo "Error registry: ${declared_count:-0} branches in $(basename "$SURFACE"), every code mapped or retired, no undeclared branch referenced."
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Error-code registry"
    echo ""
    echo "| Variants | Codes in use | Registry branches | Next free code | Derived from |"
    echo "| --- | --- | --- | --- | --- |"
    echo "| ${count} | ${min}–${max} | ${declared_count:-0} | ${next_free} | $( [ -n "$base_ref" ] && printf '`%s` + this tree' "$base_ref" || printf 'this tree only (base unreadable here)' ) |"
    echo ""
    echo "Every code is unique, reachable through a declared \`Branch\` (or retired in \`RETIRED_CODES\`), and no \`Branch::\` name is used without being declared."
    echo ""
    echo "New variants take the **next free code** above the highest code the base branch owns — not merely above the highest code in a contributor's branch. Codes are append-only shared state: two branches that each pick \"my local max + 1\" collide as soon as both merge."
  } >> "$GITHUB_STEP_SUMMARY"
fi
