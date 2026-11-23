#!/usr/bin/env bash
# Generates Swift bindings from the checked-in UDL and typechecks the smoke file.
# Requires: cargo, uniffi-bindgen (built from this crate), swiftc.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE="$(cd "$HERE/.." && pwd)"
OUT="${1:-$MOBILE/build/swift}"

(cd "$MOBILE" && cargo build --quiet --lib)
mkdir -p "$OUT"
(cd "$MOBILE" && cargo run --quiet --bin uniffi-bindgen -- generate \
    --library "target/debug/libstreampay_mobile.so" \
    --language swift --out-dir "$OUT")

swiftc -typecheck -I "$OUT" \
    "$OUT/streampay.swift" \
    "$HERE/../smoke/swift/StreamPaySmoke.swift"
echo "Swift bindings typecheck against the smoke file"
