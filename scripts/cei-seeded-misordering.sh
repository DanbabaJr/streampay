#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
scratch=$(mktemp -d)
worktree="$scratch/worktree"
output="$scratch/test-output.log"

cleanup() {
    git -C "$root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$worktree" HEAD >/dev/null
git -C "$root" diff --binary HEAD | git -C "$worktree" apply -
while IFS= read -r -d '' path; do
    mkdir -p "$worktree/$(dirname "$path")"
    cp "$root/$path" "$worktree/$path"
done < <(git -C "$root" ls-files --others --exclude-standard -z)

# Move the stream write after the token interaction in the throwaway worktree.
perl -0pi -e '
    s/\n        stream::put_stream\(env, s\);\n/\n/ == 1 or die "expected one stream write to move\n";
    s/\n        push\(\n            env,\n            &s\.token,\n            &stream::muxed\(&s\.recipient\),\n            amount,\n            Branch::RecipientPayoutFailed,\n        \)\n    \}/\n        let payout = push(\n            env,\n            &s.token,\n            &stream::muxed(&s.recipient),\n            amount,\n            Branch::RecipientPayoutFailed,\n        );\n        stream::put_stream(env, s);\n        payout\n    }/s == 1 or die "expected one payout call to move\n";
' "$worktree/contracts/streaming-payments/src/lib.rs"

if CARGO_TARGET_DIR="$scratch/target" cargo test \
    --manifest-path "$worktree/Cargo.toml" \
    -p streampay-contract --lib withdraw_operation_order_matches_golden \
    --locked >"$output" 2>&1; then
    cat "$output"
    echo "ERROR: seeded CEI misordering unexpectedly passed the golden gate" >&2
    exit 1
fi

if ! grep -q 'assertion `left == right` failed' "$output"; then
    cat "$output"
    echo "ERROR: test failed for a reason other than the ordering mismatch" >&2
    exit 1
fi

printf '%s\n' "OK: CEI golden gate rejected the seeded write-after-transfer regression."
