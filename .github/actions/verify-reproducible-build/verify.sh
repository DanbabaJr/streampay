#!/usr/bin/env bash
# Verification logic for reproducible StreamPay contract builds.
# Supports both hermetic Docker builds and native builds with version mismatch detection.

set -euo pipefail

TAG="${TAG:-${1:-}}"
EXPECTED_DIGEST="${EXPECTED_DIGEST:-${2:-}}"
USE_DOCKER="${USE_DOCKER:-auto}"
ACTION_PATH="${ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_ROOT="$(pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$EXPECTED_DIGEST" ] || die "expected_digest must be specified"

say "Verifying reproducible build for StreamPay contract"
info "Target tag:        ${TAG:-<current commit>}"
info "Expected SHA-256:  ${EXPECTED_DIGEST}"
info "Docker mode:       ${USE_DOCKER}"

# 1. Read pinned toolchain from rust-toolchain.toml
pinned_rust_channel="1.99.1"
if [ -f "${REPO_ROOT}/rust-toolchain.toml" ]; then
  parsed_channel=$(grep -E '^\s*channel\s*=' "${REPO_ROOT}/rust-toolchain.toml" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  if [ -n "$parsed_channel" ]; then
    pinned_rust_channel="$parsed_channel"
  fi
fi
info "Pinned rust toolchain: ${pinned_rust_channel}"

# 2. Extract pinned stellar-cli & rustc from release-metadata.json if available
stellar_cli_version="28.1.0"
rustc_version="${pinned_rust_channel}"

metadata_file=""
if [ -f "${REPO_ROOT}/release-metadata.json" ]; then
  metadata_file="${REPO_ROOT}/release-metadata.json"
elif [ -n "$TAG" ]; then
  tmp_meta="$(mktemp -d)"
  if command -v gh >/dev/null 2>&1 && gh release download "$TAG" --pattern 'release-metadata.json' --dir "$tmp_meta" 2>/dev/null; then
    metadata_file="$tmp_meta/release-metadata.json"
  elif curl -fsSL "https://github.com/${GITHUB_REPOSITORY:-Neziahtech/streampay}/releases/download/${TAG}/release-metadata.json" -o "$tmp_meta/release-metadata.json" 2>/dev/null; then
    metadata_file="$tmp_meta/release-metadata.json"
  fi
fi

if [ -n "$metadata_file" ] && [ -f "$metadata_file" ]; then
  info "Found release metadata at ${metadata_file}"
  parsed_stellar=$(jq -r '.stellar_cli_version // empty' "$metadata_file" 2>/dev/null || grep -o '"stellar_cli_version": *"[^"]*"' "$metadata_file" | sed 's/.*: *"//;s/"//' || true)
  parsed_rustc=$(jq -r '.rustc_version // empty' "$metadata_file" 2>/dev/null || grep -o '"rustc_version": *"[^"]*"' "$metadata_file" | sed 's/.*: *"//;s/"//' || true)
  if [ -n "$parsed_stellar" ]; then
    stellar_cli_version="$parsed_stellar"
  fi
  if [ -n "$parsed_rustc" ]; then
    rustc_version="$parsed_rustc"
  fi
fi

info "Target stellar-cli version: ${stellar_cli_version}"
info "Target rustc version:       ${rustc_version}"

# 3. Determine build path: Docker (hermetic) vs Native
has_docker=false
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    has_docker=true
  fi
fi

build_path="native"
if [ "$USE_DOCKER" = "true" ]; then
  [ "$has_docker" = "true" ] || die "Docker path requested (use_docker=true), but Docker daemon is not available"
  build_path="docker"
elif [ "$USE_DOCKER" = "auto" ] && [ "$has_docker" = "true" ]; then
  build_path="docker"
fi

# 4. Execute build
wasm_rel="target/wasm32v1-none/release/streampay_contract.wasm"

if [ "$build_path" = "docker" ]; then
  say "Executing Hermetic Build via Docker"
  dockerfile_path="${ACTION_PATH}/Dockerfile"
  [ -f "$dockerfile_path" ] || dockerfile_path="${REPO_ROOT}/.github/actions/verify-reproducible-build/Dockerfile"
  [ -f "$dockerfile_path" ] || die "Dockerfile not found at $dockerfile_path"

  image_tag="streampay-verifier:${TAG:-latest}"
  info "Building hermetic verification image: ${image_tag}"
  docker build \
    --build-arg "RUST_VERSION=${pinned_rust_channel}" \
    --build-arg "STELLAR_CLI_VERSION=${stellar_cli_version}" \
    -t "${image_tag}" \
    "$(dirname "$dockerfile_path")"

  info "Running build inside hermetic container..."
  docker run --rm \
    -v "${REPO_ROOT}:/workspace" \
    -w /workspace \
    "${image_tag}" \
    bash -c "cd contracts/streaming-payments && stellar contract build"
else
  say "Executing Native Build (Docker unavailable or disabled)"

  # Check installed rustc version against pinned
  if command -v rustc >/dev/null 2>&1; then
    actual_rustc=$(rustc --version | head -n1 | awk '{print $2}')
    info "Host rustc version: ${actual_rustc}"
    if [ "$actual_rustc" != "$rustc_version" ] && [ "$actual_rustc" != "$pinned_rust_channel" ]; then
      warn "rustc version mismatch: installed $actual_rustc != pinned ${rustc_version}"
      echo "::error::rustc version mismatch: installed $actual_rustc != pinned ${rustc_version}" >&2
      echo "WARNING: Building with an unpinned rustc compiler may result in byte differences." >&2
    fi
  else
    warn "rustc is not detected on PATH"
    echo "::error::rustc is not detected on PATH" >&2
  fi

  # Check and ensure stellar-cli version
  actual_stellar=""
  if command -v stellar >/dev/null 2>&1; then
    actual_stellar=$(stellar --version | head -n1 | awk '{print $2}')
    info "Host stellar-cli version: ${actual_stellar}"
  fi

  if [ "$actual_stellar" != "$stellar_cli_version" ]; then
    if [ -n "$actual_stellar" ]; then
      warn "stellar-cli version mismatch: installed $actual_stellar != pinned ${stellar_cli_version}"
      echo "::error::stellar-cli version mismatch: installed $actual_stellar != pinned ${stellar_cli_version}" >&2
    fi

    # Attempt to install exact pinned version if on Linux x86_64
    os_kernel=$(uname -s 2>/dev/null || echo "unknown")
    arch_type=$(uname -m 2>/dev/null || echo "unknown")
    if [ "$os_kernel" = "Linux" ] && [ "$arch_type" = "x86_64" ]; then
      info "Attempting to install pinned stellar-cli ${stellar_cli_version}..."
      curl -fsSL "https://github.com/stellar/stellar-cli/releases/download/v${stellar_cli_version}/stellar-cli-${stellar_cli_version}-x86_64-unknown-linux-gnu.tar.gz" | tar xz
      if [ -w "/usr/local/bin" ] || [ "$(id -u)" -eq 0 ]; then
        sudo install stellar /usr/local/bin/stellar 2>/dev/null || install stellar /usr/local/bin/stellar
      else
        mkdir -p "$HOME/.local/bin"
        install stellar "$HOME/.local/bin/stellar"
        export PATH="$HOME/.local/bin:$PATH"
      fi
      rm -f stellar
    fi
  fi

  info "Building Wasm via stellar contract build..."
  (cd "${REPO_ROOT}/contracts/streaming-payments" && stellar contract build)
fi

# 5. Compute SHA-256 of rebuilt Wasm
wasm_path="${REPO_ROOT}/${wasm_rel}"
[ -f "$wasm_path" ] || die "Expected Wasm artifact not found at ${wasm_rel}"

computed_digest=""
if command -v sha256sum >/dev/null 2>&1; then
  computed_digest=$(sha256sum "$wasm_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  computed_digest=$(shasum -a 256 "$wasm_path" | awk '{print $1}')
else
  computed_digest=$(certutil -hashfile "$wasm_path" SHA256 2>/dev/null | grep -E '^[0-9a-fA-F]{64}$' | tr -d ' \r\n' | tr '[:upper:]' '[:lower:]' || true)
fi

[ -n "$computed_digest" ] || die "Failed to compute SHA-256 digest of rebuilt Wasm"

say "Digest Comparison"
info "Rebuilt SHA-256:  ${computed_digest}"
info "Expected SHA-256: ${EXPECTED_DIGEST}"

# Normalize hashes for comparison
norm_computed=$(echo "$computed_digest" | tr -d ' \r\n' | tr '[:upper:]' '[:lower:]')
norm_expected=$(echo "$EXPECTED_DIGEST" | tr -d ' \r\n' | tr '[:upper:]' '[:lower:]')

# Emit outputs for GitHub Actions if available
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "computed_digest=${norm_computed}" >> "$GITHUB_OUTPUT"
fi

if [ "$norm_computed" = "$norm_expected" ]; then
  say "SUCCESS: Rebuilt Wasm digest matches expected release digest byte-for-byte!"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "match=true" >> "$GITHUB_OUTPUT"
  fi
  exit 0
else
  echo "::error::Reproducible build verification failed! Computed digest ${norm_computed} does not match expected ${norm_expected}"
  echo "========================================================================" >&2
  echo "REPRODUCIBLE BUILD VERIFICATION FAILED" >&2
  echo "Computed: ${norm_computed}" >&2
  echo "Expected: ${norm_expected}" >&2
  echo "The rebuilt Wasm differs from the expected release digest." >&2
  echo "========================================================================" >&2
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "match=false" >> "$GITHUB_OUTPUT"
  fi
  exit 1
fi
