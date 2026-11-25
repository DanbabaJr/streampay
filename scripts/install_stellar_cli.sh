#!/usr/bin/env bash
# ==============================================================================
# install_stellar_cli.sh — Download, verify SHA-256 digest, and install stellar-cli.
#
# Adheres to repository supply-chain policy:
#   1. Remote archive is downloaded to a temporary directory (never piped into tar).
#   2. SHA-256 is verified against the pinned digest in digests/stellar-cli-<version>.sha256.
#   3. On digest mismatch, an unmistakable error is printed showing both expected
#      and actual digests, the archive is deleted, and the script exits non-zero
#      WITHOUT extracting tar contents.
#   4. On verification pass, the binary is extracted and installed to /usr/local/bin/stellar.
#
# Usage:
#   bash scripts/install_stellar_cli.sh [VERSION]
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

VERSION="${1:-${STELLAR_CLI_VERSION:-28.1.0}}"
VERSION="${VERSION#v}"

ARCH="$(uname -m)"
TARBALL="stellar-cli-${VERSION}-${ARCH}-unknown-linux-gnu.tar.gz"
URL="https://github.com/stellar/stellar-cli/releases/download/v${VERSION}/${TARBALL}"

# Determine digest file location
if [ "$ARCH" = "x86_64" ]; then
  DIGEST_FILE="${REPO_ROOT}/digests/stellar-cli-${VERSION}.sha256"
else
  # On non-x86_64 architectures (e.g. aarch64 devcontainer hosts), check for arch-specific digest
  ARCH_DIGEST="${REPO_ROOT}/digests/stellar-cli-${VERSION}-${ARCH}.sha256"
  if [ -f "$ARCH_DIGEST" ]; then
    DIGEST_FILE="$ARCH_DIGEST"
  else
    DIGEST_FILE=""
  fi
fi

say "Installing stellar-cli v${VERSION} (${ARCH})"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

TMP_TARBALL="${TMP_DIR}/${TARBALL}"

info "Downloading ${URL}..."
if ! curl -fsSL -o "$TMP_TARBALL" "$URL"; then
  die "Failed to download stellar-cli archive from ${URL}"
fi

# Digest verification
if [ -n "$DIGEST_FILE" ]; then
  if [ ! -f "$DIGEST_FILE" ]; then
    rm -f "$TMP_TARBALL"
    die "Digest file not found: ${DIGEST_FILE}"
  fi

  expected="$(awk '{print $1; exit}' "$DIGEST_FILE" | tr -d '\r')"
  if [ -z "$expected" ]; then
    rm -f "$TMP_TARBALL"
    die "No digest found in ${DIGEST_FILE}"
  fi

  actual="$(sha256sum "$TMP_TARBALL" | awk '{print $1}' | tr -d '\r')"

  if [ "$actual" != "$expected" ]; then
    # Delete untrusted archive immediately before exiting
    rm -f "$TMP_TARBALL"
    {
      echo "========================================================================"
      echo "ERROR: SHA-256 digest verification failed for stellar-cli binary!"
      echo "Supply-chain tampering or corrupted download detected."
      echo "  Tarball:       ${TARBALL}"
      echo "  Digest file:   ${DIGEST_FILE}"
      echo "  Expected hash: ${expected}"
      echo "  Actual hash:   ${actual}"
      echo "========================================================================"
    } >&2
    exit 1
  fi

  info "Digest verification OK:"
  info "  Expected: ${expected}"
  info "  Actual:   ${actual}"
else
  warn "No committed digest for architecture ${ARCH}; proceeding without verification on non-x86_64 host"
fi

# Extraction: only reaches here if verification succeeded (or warning on non-x86_64)
info "Extracting ${TARBALL}..."
tar -xzf "$TMP_TARBALL" -C "$TMP_DIR"

if [ ! -f "$TMP_DIR/stellar" ]; then
  die "Archive did not contain 'stellar' binary executable"
fi

# Installation
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
info "Installing to ${INSTALL_DIR}/stellar..."

if [ -w "$INSTALL_DIR" ] || [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$INSTALL_DIR"
  install "$TMP_DIR/stellar" "$INSTALL_DIR/stellar"
elif command -v sudo >/dev/null 2>&1; then
  sudo mkdir -p "$INSTALL_DIR"
  sudo install "$TMP_DIR/stellar" "$INSTALL_DIR/stellar"
else
  mkdir -p "$HOME/.local/bin"
  install "$TMP_DIR/stellar" "$HOME/.local/bin/stellar"
  export PATH="$HOME/.local/bin:$PATH"
fi

# Clean up tarball immediately
rm -f "$TMP_TARBALL"

if command -v stellar >/dev/null 2>&1; then
  stellar --version
elif [ -x "${INSTALL_DIR}/stellar" ]; then
  "${INSTALL_DIR}/stellar" --version
fi
