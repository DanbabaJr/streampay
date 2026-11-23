#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FIXTURE="$ROOT/test_fixtures/webhook-signature.json"

SECRET=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).secret)' "$FIXTURE")
TIMESTAMP=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).timestamp)' "$FIXTURE")
RAW_BODY=$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).raw_body)' "$FIXTURE")
HEADER=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).header)' "$FIXTURE")

EXPECTED=$(printf '%s' "${TIMESTAMP}.${RAW_BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
PROVIDED=$(printf '%s' "$HEADER" | sed -n 's/^.*v1=\([0-9a-fA-F][0-9a-fA-F]*\).*$/\1/p')

if [ "$EXPECTED" != "$PROVIDED" ]; then
  echo "curl/openssl fixture verification failed" >&2
  exit 1
fi

echo "curl/openssl fixture verification passed"
