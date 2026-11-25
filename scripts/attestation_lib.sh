#!/usr/bin/env bash
# Shared helpers for the release-attestation chain: payload construction,
# digesting, Ed25519 sign/verify, and dependency-free JSON field extraction.
#
# Sourced by scripts/attest.sh, scripts/verify_wasm.sh and the tamper audit;
# it also pulls in lib.sh, so callers get say/info/warn/die/require too.
#
# Design notes (see docs/adr/0011-attestation-signing-scheme.md):
#   * The signature covers the EXACT bytes of attestation.json. Nothing is
#     re-canonicalized at verify time, so verification cannot drift from
#     signing because of a jq version, and jq is not required to verify.
#   * Signatures are stored as single-line base64, not raw binary: .gitattributes
#     normalizes text, and a binary .sig would be corrupted by a CRLF checkout.
#   * openssl is the only crypto dependency. It is preinstalled on every CI
#     runner and is already required by scripts/deploy_testnet.sh.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ATT_SCHEMA="streampay.attestation/v1"
ATT_DIR_REL="attestations"
ATT_PUBKEY_REL="attestations/signing-key.pub"
ATT_KEYS_DIR_REL="attestations/keys"
ATT_PAYLOAD_NAME="attestation.json"
ATT_SIG_NAME="attestation.json.sig"

# Portable SHA-256: sha256sum (coreutils), shasum (macOS), then openssl.
att_sha256() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    openssl dgst -sha256 -r "$f" | awk '{print $1}'
  fi
}

# Fingerprint of a public key: sha256 of its DER encoding. This is the value to
# publish out of band so a swapped attestations/signing-key.pub is detectable.
att_fingerprint() {
  openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | att_sha256 /dev/stdin || true
}

# Escape a string for embedding as a JSON string body. Values interpolated into
# the payload include tool-version output, which is not ours to trust.
att_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

# Read a field out of a payload; the key may be dotted ("toolchain.rust_channel").
# jq when present, a tolerant sed extractor otherwise — the verifier has to work
# on a bare deploy host with nothing installed.
att_json_get() {
  local file="$1" key="$2" leaf val
  case "$key" in
    *[!A-Za-z0-9_.]*) return 1 ;;
  esac
  leaf="${key##*.}"
  if command -v jq >/dev/null 2>&1; then
    jq -r ".$key // empty | if type == \"string\" then . else tojson end" "$file" 2>/dev/null || true
  else
    # No `| head` here: a SIGPIPE'd sed under pipefail would abort the caller.
    val="$(sed -n "s/^[[:space:]]*\"$leaf\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" || true)"
    printf '%s' "${val%%$'\n'*}"
  fi
}

# Read a boolean out of a named object. Booleans are unquoted, so the string
# extractor above cannot see them and jq is not guaranteed on a deploy host.
att_json_bool() {
  local file="$1" section="$2" key="$3"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg s "$section" --arg k "$key" '.[$s][$k] // empty' "$file" 2>/dev/null
  else
    awk -v s="\"$section\"" -v k="\"$key\"" '
      index($0, s) { insec = 1 }
      insec && index($0, k) { print ($NF ~ /^true,?$/) ? "true" : "false"; exit }
    ' "$file"
  fi
}

# Resolve the signing key from ATTESTATION_SIGNING_KEY, which may be either a
# path to a PEM file or the PEM text itself (how a CI secret carries it).
# Echoes a readable private PEM path. When the key came from inline text a temp
# file is created and its path is also left in ATT_PRIVATE_KEY_TMP, so the
# caller can shred it on exit without deleting a key it does not own.
ATT_PRIVATE_KEY_TMP=""
att_private_key_path() {
  local src="${ATTESTATION_SIGNING_KEY:-}"
  [ -n "$src" ] || return 1
  if [ -f "$src" ]; then
    printf '%s' "$src"
    return 0
  fi
  case "$src" in
    *BEGIN*PRIVATE*KEY*)
      ATT_PRIVATE_KEY_TMP="$(mktemp)"
      printf '%s\n' "$src" > "$ATT_PRIVATE_KEY_TMP"
      chmod 600 "$ATT_PRIVATE_KEY_TMP"
      printf '%s' "$ATT_PRIVATE_KEY_TMP"
      return 0
      ;;
  esac
  return 1
}

# Sign a payload, writing single-line base64 to <out>.
att_sign() {
  local key="$1" payload="$2" out="$3" bin
  bin="$(mktemp)"
  openssl pkeyutl -sign -inkey "$key" -rawin -in "$payload" -out "$bin" 2>/dev/null \
    || { rm -f "$bin"; return 1; }
  openssl base64 -A -in "$bin" > "$out" || { rm -f "$bin"; return 1; }
  rm -f "$bin"
  printf '\n' >> "$out"
}

# Verify a base64 detached signature over the exact payload bytes.
att_verify_sig() {
  local pubkey="$1" payload="$2" sig="$3" bin
  [ -f "$pubkey" ] || return 2
  [ -f "$payload" ] || return 2
  [ -f "$sig" ] || return 2
  bin="$(mktemp)"
  tr -d ' \t\r\n' < "$sig" | openssl base64 -d -A > "$bin" 2>/dev/null \
    || { rm -f "$bin"; return 1; }
  # An Ed25519 signature is always 64 bytes; reject anything else before
  # handing it to openssl so a truncated or padded blob cannot pass.
  if [ "$(wc -c < "$bin" | tr -d ' ')" != "64" ]; then
    rm -f "$bin"
    return 1
  fi
  openssl pkeyutl -verify -pubin -inkey "$pubkey" -rawin \
    -in "$payload" -sigfile "$bin" >/dev/null 2>&1
  local rc=$?
  rm -f "$bin"
  return $rc
}
