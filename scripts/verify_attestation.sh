#!/usr/bin/env bash
#
# Verify that a local document matches a hash attested on-chain.
#
# StreamPay's `attach_metadata` records a 32-byte content hash (e.g. SHA-256)
# plus a short tag against a stream. This script recomputes the hash of a local
# file and compares it to a value you provide — typically the `content_hash` you
# read back from a `MetadataAttached` event or `stream_attestations` call.
#
# Usage:
#   scripts/verify_attestation.sh <file> <expected-sha256-hex>
#
# The expected hash is case-insensitive and may carry a leading `0x`.
# Exit status: 0 on match, 1 on mismatch, 2 on usage error.
#
# To fetch the on-chain hash first (Stellar CLI), see
# docs/VERIFYING_ATTESTATIONS.md:
#
#   stellar contract invoke --id <CONTRACT_ID> --network testnet \
#     -- stream_attestations --stream_id <ID> --offset 0 --limit 50
#
set -euo pipefail

usage() {
  echo "usage: $0 <file> <expected-sha256-hex>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage

file="$1"
expected_raw="$2"

if [ ! -f "$file" ]; then
  echo "error: no such file: $file" >&2
  exit 1
fi

# Normalize: strip optional 0x, lower-case, and require 64 hex characters.
expected="$(printf '%s' "$expected_raw" | tr 'A-F' 'a-f' | sed 's/^0x//')"
if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "error: expected hash must be 64 hex characters (32 bytes), got: $expected_raw" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$file" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
else
  echo "error: need sha256sum (coreutils) or shasum (perl) to hash the file" >&2
  exit 2
fi

echo "file:     $file"
echo "expected: $expected"
echo "actual:   $actual"

if [ "$actual" = "$expected" ]; then
  echo "MATCH: the document's SHA-256 equals the attested hash."
  exit 0
fi

echo "MISMATCH: the document's SHA-256 does NOT equal the attested hash." >&2
exit 1
