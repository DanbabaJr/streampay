# Gitpod workspace image for StreamPay.
# Provides: Rust stable + wasm32v1-none, Node 22, Docker (for stellar quickstart).
FROM gitpod/workspace-full:latest

# Node 22 via nvm (gitpod/workspace-full ships nvm).
RUN bash -c "source /home/gitpod/.nvm/nvm.sh \
  && nvm install 22 \
  && nvm alias default 22 \
  && nvm use default"

# Rust stable with the wasm target the contract build requires.
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
  && . "$HOME/.cargo/env" \
  && rustup target add wasm32v1-none \
  && rustup component add rustfmt clippy
