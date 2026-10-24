#!/usr/bin/env bash
# Triage new fuzz crashers into repro-ready bundles.
#
#   scripts/fuzz/triage.sh                 # every target's fuzz/artifacts/
#   scripts/fuzz/triage.sh campaign        # one target
#
# For each crasher not seen before, writes fuzz/triage/<target>-<sig>/:
#   seed.bin      the minimised input (libFuzzer -minimize_crash)
#   seed.b64      the same, base64 — paste-able into an issue
#   repro.sh      one command that reproduces it from a clean checkout
#   trace.txt     the decoded op sequence (campaign targets) and the panic
#   ISSUE.md      a ready-to-file issue body with all of the above
# Crashers are deduplicated by signature: the panic message with numbers
# stripped, so "step 4 ... 1000" and "step 9 ... 77" of one bug are one entry.
# fuzz/triage/INDEX.json records every signature and its status
# (new | filed #N | fixed | known KD-N), which the campaign report reads.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FUZZ="$ROOT/fuzz"
BIN_DIR="$FUZZ/target/x86_64-unknown-linux-gnu/release"
TRIAGE="$FUZZ/triage"
INDEX="$TRIAGE/INDEX.json"
mkdir -p "$TRIAGE"
[[ -f "$INDEX" ]] || echo '{}' > "$INDEX"

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  mapfile -t targets < <(ls "$FUZZ/artifacts" 2>/dev/null)
fi

new=0
for t in "${targets[@]}"; do
  [[ -x "$BIN_DIR/$t" ]] || { echo "skip $t: not built (cargo fuzz build -O $t)"; continue; }
  for crash in "$FUZZ/artifacts/$t"/crash-* "$FUZZ/artifacts/$t"/timeout-* "$FUZZ/artifacts/$t"/oom-*; do
    [[ -f "$crash" ]] || continue

    # The panic message is the signature: it names the operation and the
    # observable that diverged. Numbers are stripped so one bug is one entry.
    message=$(STREAMPAY_FUZZ_TRACE= "$BIN_DIR/$t" "$crash" 2>&1 \
      | grep -m1 -A1 "panicked at" | tail -1 | sed 's/^[[:space:]]*//' || true)
    [[ -n "$message" ]] || message="$(basename "$crash" | cut -d- -f1) without a panic message"
    sig=$(printf '%s:%s' "$t" "$message" | sed -E 's/[0-9]+/N/g' | sha256sum | cut -c1-12)
    dir="$TRIAGE/$t-$sig"

    if python3 -c "import json,sys; sys.exit(0 if '$sig' in json.load(open('$INDEX')) else 1)"; then
      echo "known  $t-$sig  ($(basename "$crash"))"
      continue
    fi

    mkdir -p "$dir"
    cp "$crash" "$dir/original.bin"
    # Shrink it. -minimize_crash keeps the input crashing while removing bytes.
    "$BIN_DIR/$t" "$crash" -minimize_crash=1 -max_total_time=120 \
      -exact_artifact_path="$dir/seed.bin" > "$dir/minimize.log" 2>&1 || true
    [[ -s "$dir/seed.bin" ]] || cp "$crash" "$dir/seed.bin"
    base64 -w0 "$dir/seed.bin" > "$dir/seed.b64"

    { echo "# $t — $(basename "$crash")"; echo
      echo "## Panic"; echo "$message"; echo
      echo "## Decoded op sequence (minimised seed)"
      STREAMPAY_FUZZ_TRACE=1 "$BIN_DIR/$t" "$dir/seed.bin" 2>&1 | grep -E '^ +[0-9]+: ' || echo "(not a campaign target)"
    } > "$dir/trace.txt"

    cat > "$dir/repro.sh" <<EOF
#!/usr/bin/env bash
# Reproduces $t-$sig from a clean checkout of $(git -C "$ROOT" rev-parse --short HEAD).
set -euo pipefail
cd "\$(git rev-parse --show-toplevel)/fuzz"
echo '$(cat "$dir/seed.b64")' | base64 -d > /tmp/$t-$sig.bin
STREAMPAY_FUZZ_TRACE=1 cargo fuzz run $t /tmp/$t-$sig.bin
EOF
    chmod +x "$dir/repro.sh"

    cat > "$dir/ISSUE.md" <<EOF
**Fuzz campaign crasher** \`$t-$sig\` — found by \`$t\` at commit \`$(git -C "$ROOT" rev-parse --short HEAD)\`.

**Panic**
\`\`\`
$message
\`\`\`

**Reproduce** (seed attached inline, $(stat -c %s "$dir/seed.bin") bytes after minimisation):
\`\`\`sh
cd fuzz
echo '$(cat "$dir/seed.b64")' | base64 -d > seed.bin
STREAMPAY_FUZZ_TRACE=1 cargo fuzz run $t seed.bin
\`\`\`

**Decoded sequence**
\`\`\`
$(grep -E '^ +[0-9]+: ' "$dir/trace.txt" || echo "(not a campaign target)")
\`\`\`

Once fixed, add \`seed.bin\` to \`fuzz/regressions/$t/\` so CI replays it forever.
EOF

    python3 - "$INDEX" "$sig" "$t" "$message" "$dir" <<'PY'
import json, sys, os
path, sig, target, message, d = sys.argv[1:]
index = json.load(open(path))
index[sig] = {"target": target, "message": message, "status": "new",
              "dir": os.path.relpath(d, os.path.dirname(os.path.dirname(path)))}
json.dump(index, open(path, "w"), indent=2, sort_keys=True)
PY
    echo "NEW    $t-$sig  -> $dir"
    new=$((new + 1))
  done
done
echo "$new new crasher(s). File each from its ISSUE.md, then set its status in $INDEX."
