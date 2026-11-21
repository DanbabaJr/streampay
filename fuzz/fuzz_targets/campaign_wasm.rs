//! The same campaign as `campaign`, against the release wasm in the Soroban VM.
//!
//! Built only with `--features wasm`, and needs `STREAMPAY_WASM` at build time
//! pointing at the artifact produced by
//! `cargo build -p streampay-contract --target wasm32v1-none --release`.
//! Coverage feedback comes from the harness and the host, not from inside the
//! VM, so this target leans on the corpus `campaign` grows — the campaign
//! runner seeds it from there.

#![no_main]

use libfuzzer_sys::fuzz_target;
use streampay_fuzz::campaign::{decode, trace, Backend, Campaign};

static WASM: &[u8] = include_bytes!(env!("STREAMPAY_WASM"));

fuzz_target!(|data: &[u8]| {
    if std::env::var_os("STREAMPAY_FUZZ_TRACE").is_some() {
        eprint!("{}", trace(data));
    }
    let ops = decode(data);
    if ops.is_empty() {
        return;
    }
    Campaign::new(Backend::Wasm(WASM)).run(&ops);
});
