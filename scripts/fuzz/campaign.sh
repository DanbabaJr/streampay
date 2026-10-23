#!/usr/bin/env bash
# Persistent fuzz campaign runner.
#
# Round-robins time slices across fuzz targets for a total budget (hours, not
# the minutes CI targets get), with N parallel workers per slice sharing one
# corpus per target. Corpora persist between runs in fuzz/corpus/<target>/ and
# are synced to the `fuzz-corpus` branch by scripts/fuzz/corpus-sync.sh. Every
# slice's libFuzzer stats are appended to <out>/runs.jsonl, which
# scripts/fuzz/report.py turns into the campaign report.
#
#   scripts/fuzz/campaign.sh --hours 8 --jobs 4
#   scripts/fuzz/campaign.sh --hours 0.5 --targets campaign,differential --slice-min 5
#
# Crashers land in fuzz/artifacts/<target>/; run scripts/fuzz/triage.sh after.
set -euo pipefail

HOURS=8
JOBS=$(nproc 2>/dev/null || echo 2)
TARGETS="campaign,differential,conservation,rate_schedule,streamed_at"
SLICE_MIN=30
OUT=""
SANITIZER=none   # coverage-guided without ASan: these targets are safe Rust

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --targets) TARGETS="$2"; shift 2 ;;
    --slice-min) SLICE_MIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --sanitizer) SANITIZER="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FUZZ="$ROOT/fuzz"
OUT="${OUT:-$ROOT/fuzz/campaign/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT/logs"
IFS=',' read -r -a TARGET_LIST <<< "$TARGETS"

BUDGET_S=$(python3 -c "print(int(float('$HOURS') * 3600))")
SLICE_S=$((SLICE_MIN * 60))
DEADLINE=$(( $(date +%s) + BUDGET_S ))

# Build every target once, up front: a build failure should stop the campaign
# before it has spent any of its budget.
FEATURES=()
for t in "${TARGET_LIST[@]}"; do
  if [[ "$t" == "campaign_wasm" ]]; then
    : "${STREAMPAY_WASM:?campaign_wasm needs STREAMPAY_WASM pointing at the release wasm}"
    FEATURES=(--features wasm)
  fi
done
(cd "$FUZZ" && cargo fuzz build --sanitizer "$SANITIZER" -O "${FEATURES[@]}")
BIN_DIR="$FUZZ/target/x86_64-unknown-linux-gnu/release"

# campaign_wasm gets no coverage feedback from inside the VM, so it starts
# from whatever the native campaign has learned.
if [[ " ${TARGET_LIST[*]} " == *" campaign_wasm "* && -d "$FUZZ/corpus/campaign" ]]; then
  mkdir -p "$FUZZ/corpus/campaign_wasm"
  cp -n "$FUZZ/corpus/campaign/"* "$FUZZ/corpus/campaign_wasm/" 2>/dev/null || true
fi

echo "campaign: ${HOURS}h over ${TARGETS} (${SLICE_MIN}min slices, ${JOBS} workers) -> $OUT"
cat > "$OUT/meta.json" <<EOF
{"started": "$(date -u +%FT%TZ)", "hours": $HOURS, "jobs": $JOBS, "slice_min": $SLICE_MIN,
 "targets": "$TARGETS", "commit": "$(git -C "$ROOT" rev-parse HEAD)", "host": "$(uname -srm)",
 "cores": $(nproc 2>/dev/null || echo 0), "rustc": "$(rustc --version)"}
EOF

slice=0
while (( $(date +%s) < DEADLINE )); do
  t="${TARGET_LIST[$((slice % ${#TARGET_LIST[@]}))]}"
  remaining=$(( DEADLINE - $(date +%s) ))
  secs=$(( remaining < SLICE_S ? remaining : SLICE_S ))
  (( secs < 10 )) && break
  mkdir -p "$FUZZ/corpus/$t" "$FUZZ/artifacts/$t"
  before=$(ls "$FUZZ/artifacts/$t" | wc -l)
  echo "slice $slice: $t for ${secs}s"

  pids=()
  for w in $(seq 1 "$JOBS"); do
    log="$OUT/logs/slice${slice}-${t}-w${w}.log"
    # Each worker is its own process on the shared corpus (-reload picks up
    # what the others find). -max_len bounds a single sequence's cost.
    "$BIN_DIR/$t" "$FUZZ/corpus/$t" \
      -max_total_time="$secs" -max_len=4096 -rss_limit_mb=4096 \
      -print_final_stats=1 -reload=30 -seed=$((slice * 1000 + w)) \
      -artifact_prefix="$FUZZ/artifacts/$t/" > "$log" 2>&1 &
    pids+=("$!")
  done
  for p in "${pids[@]}"; do wait "$p" || true; done

  # A crash stops that worker early; the slice still counts what it ran.
  python3 "$ROOT/scripts/fuzz/report.py" slice \
    --target "$t" --slice "$slice" --seconds "$secs" \
    --logs "$OUT/logs/slice${slice}-${t}-w"*.log \
    --new-crashes $(( $(ls "$FUZZ/artifacts/$t" | wc -l) - before )) >> "$OUT/runs.jsonl"
  slice=$((slice + 1))
done

# Keep corpora small enough to version: merge each down to its minimal set.
for t in "${TARGET_LIST[@]}"; do
  [[ -d "$FUZZ/corpus/$t" ]] || continue
  mkdir -p "$FUZZ/corpus/$t.min"
  "$BIN_DIR/$t" -merge=1 -max_len=4096 "$FUZZ/corpus/$t.min" "$FUZZ/corpus/$t" > "$OUT/logs/cmin-$t.log" 2>&1 || true
  rm -rf "$FUZZ/corpus/$t" && mv "$FUZZ/corpus/$t.min" "$FUZZ/corpus/$t"
done

echo "{\"finished\": \"$(date -u +%FT%TZ)\"}" > "$OUT/finished.json"
python3 "$ROOT/scripts/fuzz/report.py" render --campaign "$OUT" --fuzz "$FUZZ" > "$OUT/REPORT.md"
echo "report: $OUT/REPORT.md"
