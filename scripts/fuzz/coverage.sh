#!/usr/bin/env bash
# Source-level coverage of the contract reached by each target's corpus.
#
#   scripts/fuzz/coverage.sh <campaign-dir> [target ...]
#
# Needs a toolchain with llvm-tools (`rustup component add llvm-tools-preview`
# on nightly) — the weekly CI job has it. Writes <campaign-dir>/coverage-summary.json,
# which report.py renders, and an HTML report per target under
# <campaign-dir>/coverage/<target>/. Edge coverage, which needs none of this,
# is in every campaign report regardless.
set -euo pipefail

OUT="${1:?campaign directory}"; shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FUZZ="$ROOT/fuzz"
targets=("$@"); [[ ${#targets[@]} -gt 0 ]] || targets=(campaign differential conservation rate_schedule streamed_at)

SYSROOT="$(rustc --print sysroot)"
LLVM_COV="$(find "$SYSROOT" -name llvm-cov -type f | head -1)"
LLVM_PROFDATA="$(find "$SYSROOT" -name llvm-profdata -type f | head -1)"
if [[ -z "$LLVM_COV" || -z "$LLVM_PROFDATA" ]]; then
  echo "llvm-tools not installed for $(rustc --version); skipping source coverage" >&2
  exit 0
fi

summary="{}"
for t in "${targets[@]}"; do
  [[ -d "$FUZZ/corpus/$t" ]] || continue
  (cd "$FUZZ" && cargo fuzz coverage "$t" "corpus/$t" >/dev/null)
  bin="$FUZZ/target/x86_64-unknown-linux-gnu/coverage/x86_64-unknown-linux-gnu/release/$t"
  prof="$FUZZ/coverage/$t/coverage.profdata"
  # Only the contract's own source: the host and the SDK are not under test.
  filter=(--ignore-filename-regex='(\.cargo|rustc|/fuzz/|/model/)')
  json=$("$LLVM_COV" export -summary-only -instr-profile="$prof" "$bin" "${filter[@]}")
  mkdir -p "$OUT/coverage/$t"
  "$LLVM_COV" show -format=html -instr-profile="$prof" "$bin" "${filter[@]}" -output-dir="$OUT/coverage/$t" >/dev/null
  summary=$(python3 - "$t" "$json" "$summary" <<'PY'
import json, sys
t, data, acc = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
tot = data["data"][0]["totals"]
fmt = lambda k: f"{tot[k]['covered']}/{tot[k]['count']} ({tot[k]['percent']:.1f}%)"
acc[t] = {"lines": fmt("lines"), "functions": fmt("functions"), "regions": fmt("regions")}
print(json.dumps(acc))
PY
)
done
echo "$summary" > "$OUT/coverage-summary.json"
echo "wrote $OUT/coverage-summary.json"
