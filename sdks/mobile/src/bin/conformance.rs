//! Host-side conformance runner for the mobile SDK.
//!
//! Decodes every shared vector with the same Rust decoders the mobile crate
//! exposes, and additionally requires `decode_get_stream` to reproduce the
//! recorded `get_stream` result. It prints the cross-language envelope:
//!
//!   streampay-mobile-conformance [vectors-dir]
//!
//! The default directory is `sdks/vectors` relative to the crate.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{json, Value};
use streampay_mobile::{spec_fingerprint, StreamPayMobile};

struct UnreachableTransport;

impl streampay_mobile::RpcReadTransport for UnreachableTransport {
    fn simulate(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> Result<String, streampay_mobile::StreamPayError> {
        Err(streampay_mobile::StreamPayError::Transport)
    }
}

fn vectors_dir() -> PathBuf {
    let args: Vec<String> = env::args().collect();
    match args.get(1) {
        Some(path) => PathBuf::from(path),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("vectors"),
    }
}

fn main() -> ExitCode {
    let directory = vectors_dir();
    let client = StreamPayMobile::new("C...".to_string(), Box::new(UnreachableTransport));
    let mut vectors = serde_json::Map::new();
    let mut failures = Vec::new();

    let mut paths: Vec<PathBuf> = match fs::read_dir(&directory) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
            .collect(),
        Err(error) => {
            eprintln!("cannot read {}: {error}", directory.display());
            return ExitCode::from(2);
        }
    };
    paths.sort();

    for path in paths {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("{}: {error}", path.display());
                return ExitCode::from(2);
            }
        };
        let vector: Value = match serde_json::from_str(&text) {
            Ok(vector) => vector,
            Err(error) => {
                eprintln!("{}: invalid JSON: {error}", path.display());
                return ExitCode::from(2);
            }
        };
        let name = vector["name"].as_str().unwrap_or("<unnamed>").to_string();
        let decoded = match streampay_sdk::vectors::decode_vector(&vector) {
            Ok(decoded) => decoded,
            Err(error) => {
                failures.push(format!("{name}: {error}"));
                continue;
            }
        };
        if decoded != vector["expected"] {
            failures.push(format!(
                "{name}: decoded payload differs from the recorded expectation"
            ));
        }
        if name.starts_with("get-stream") {
            let result_xdr = vector["resultXdr"].as_str().unwrap_or_default();
            match client.decode_get_stream(result_xdr.to_string()) {
                Ok(view) => {
                    let expected = &vector["expected"]["result"]["ok"];
                    if &view.to_json() != expected {
                        failures.push(format!(
                            "{name}: mobile StreamView differs from the expected result"
                        ));
                    }
                }
                Err(error) => failures.push(format!("{name}: mobile decode failed: {error}")),
            }
        }
        vectors.insert(name, decoded);
    }

    if !failures.is_empty() {
        for failure in &failures {
            eprintln!("{failure}");
        }
        return ExitCode::from(1);
    }
    println!(
        "{}",
        json!({
            "sdk": "mobile",
            "specFingerprint": spec_fingerprint(),
            "vectors": vectors,
        })
    );
    ExitCode::SUCCESS
}
