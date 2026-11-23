#!/usr/bin/env bash
# Generates Kotlin bindings from the checked-in UDL and compiles the smoke file.
# Requires: cargo, uniffi-bindgen (built from this crate), kotlinc, curl.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE="$(cd "$HERE/.." && pwd)"
OUT="${1:-$MOBILE/build/kotlin}"
JNA_VERSION="${JNA_VERSION:-5.14.0}"
JNA_JAR="$MOBILE/build/jna-$JNA_VERSION.jar"

(cd "$MOBILE" && cargo build --quiet --lib)
mkdir -p "$OUT" "$MOBILE/build"
(cd "$MOBILE" && cargo run --quiet --bin uniffi-bindgen -- generate \
    --library "target/debug/libstreampay_mobile.so" \
    --language kotlin --out-dir "$OUT")

if [ ! -f "$JNA_JAR" ]; then
    curl -fsSL "https://repo1.maven.org/maven2/net/java/dev/jna/jna/$JNA_VERSION/jna-$JNA_VERSION.jar" -o "$JNA_JAR"
fi

find "$OUT" -name '*.kt' -print0 | xargs -0 kotlinc \
    -classpath "$JNA_JAR" \
    -d "$OUT/classes" \
    "$HERE/../smoke/kotlin/StreamPaySmoke.kt"
echo "Kotlin bindings compile against the smoke file"
