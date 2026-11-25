#!/usr/bin/env bash
# Extract StreamPay's public contract interface from a built Wasm, canonicalize
# it, and record its SHA-256. The interface — exported entrypoints and their
# Soroban types, error enums, event structs — is the contract's "schema": it is
# what clients bind to and it may only be appended to, so a change must pass the
# schema-diff approval gate before it is promoted.
#
# Usage: scripts/contract_interface_hash.sh <wasm> <outdir> [label]
# Prints the hash on stdout (last line) and writes:
#   <outdir>/interface.json         raw interface as the CLI emits it
#   <outdir>/interface.canon.json   canonicalized JSON (what is hashed)
#   <outdir>/interface.sha256       the hash
. "$(dirname "$0")/lib.sh"

wasm="${1:?usage: contract_interface_hash.sh <wasm> <outdir> [label]}"
out="${2:?usage: contract_interface_hash.sh <wasm> <outdir> [label]}"
label="${3:-current}"

require stellar
[ -f "$wasm" ] || die "wasm not found: $wasm"
mkdir -p "$out"

say "Extracting contract interface ($label)"
stellar contract info interface --wasm "$wasm" --output json > "$out/interface.json" \
  || die "stellar contract info interface failed — check the stellar-cli version"

canonicalize_json "$out/interface.json" "$out/interface.canon.json"
hash="$(sha256sum "$out/interface.canon.json" | awk '{print $1}')"
printf '%s\n' "$hash" > "$out/interface.sha256"

info "interface hash ($label): $hash"
echo "$hash"
