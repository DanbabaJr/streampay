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

# UniFFI emits the Swift wrapper plus the C declarations it binds to
# (`RustBuffer`, `RustCallStatus`, every `uniffi_*` symbol) in a bridging header.
# The wrapper imports them from a separate Clang module when one is reachable
# (`#if canImport(<ns>FFI)`) and otherwise expects them to be compiled into the
# same module. A bare `swiftc -typecheck` loads neither, so the header is fed in
# as the module's bridging header — the same wiring an Xcode target does.
header="$(find "$OUT" -maxdepth 1 -name '*FFI.h' | sort | head -n 1)"
if [ -z "$header" ]; then
    echo "no UniFFI bridging header in $OUT:" >&2
    ls -l "$OUT" >&2
    exit 1
fi

swiftc -typecheck -I "$OUT" -import-objc-header "$header" \
    "$OUT/streampay.swift" \
    "$HERE/../smoke/swift/StreamPaySmoke.swift"
echo "Swift bindings typecheck against the smoke file"
