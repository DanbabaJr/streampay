# Hermetic Docker build environment for reproducible StreamPay Wasm builds.
# Pins the exact toolchain triad:
# 1. stellar-cli version
# 2. rustc / cargo toolchain version & wasm32v1-none target
# 3. build host environment (Ubuntu Linux x86_64)

FROM ubuntu:24.04

ARG RUST_VERSION=1.99.1
ARG STELLAR_CLI_VERSION=28.1.0
ARG STELLAR_CLI_SHA256=c1680deee94301d33ada7a17f98411e642a4248c727afbd2e43050d345746462

ENV DEBIAN_FRONTEND=noninteractive
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}"

# Install minimal host prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pinned Rust toolchain and wasm32v1-none target
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain "${RUST_VERSION}" \
    --profile minimal \
    --target wasm32v1-none \
    && chmod -R a+rwX "${CARGO_HOME}" "${RUSTUP_HOME}"

# Install pinned stellar-cli binary with digest verification before extraction
RUN set -eu; \
    tarball="stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz"; \
    url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/${tarball}"; \
    curl -fsSL -o "${tarball}" "${url}"; \
    actual="$(sha256sum "${tarball}" | awk '{print $1}')"; \
    if [ "${actual}" != "${STELLAR_CLI_SHA256}" ]; then \
      rm -f "${tarball}"; \
      echo "ERROR: SHA-256 digest verification failed for stellar-cli binary!" >&2; \
      echo "  Expected: ${STELLAR_CLI_SHA256}" >&2; \
      echo "  Actual:   ${actual}" >&2; \
      exit 1; \
    fi; \
    tar -xzf "${tarball}"; \
    install stellar /usr/local/bin/stellar; \
    rm -f stellar "${tarball}"

WORKDIR /workspace

# Verify installed versions on container build
RUN rustc --version && stellar --version

ENTRYPOINT ["/bin/bash", "-c"]
CMD ["cd contracts/streaming-payments && stellar contract build"]
