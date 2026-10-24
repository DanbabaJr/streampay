# Hermetic Docker build environment for reproducible StreamPay Wasm builds.
# Pins the exact toolchain triad:
# 1. stellar-cli version
# 2. rustc / cargo toolchain version & wasm32v1-none target
# 3. build host environment (Ubuntu Linux x86_64)

FROM ubuntu:24.04

ARG RUST_VERSION=1.99.1
ARG STELLAR_CLI_VERSION=28.1.0

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

# Install pinned stellar-cli binary
RUN curl -fsSL "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz \
    && install stellar /usr/local/bin/stellar \
    && rm -f stellar

WORKDIR /workspace

# Verify installed versions on container build
RUN rustc --version && stellar --version

ENTRYPOINT ["/bin/bash", "-c"]
CMD ["cd contracts/streaming-payments && stellar contract build"]
