//! Prints the canonical decoding of every vector, for the cross-language
//! conformance runner:
//!
//! ```text
//! cargo run --quiet --example conformance -- ../vectors
//! ```

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vectors"));

    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", dir.display()))
        .map(|entry| entry.expect("readable entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();

    let mut vectors = Map::new();
    for path in paths {
        let text = fs::read_to_string(&path).expect("readable vector");
        let vector: Value = serde_json::from_str(&text).expect("valid vector JSON");
        let name = vector["name"]
            .as_str()
            .unwrap_or_else(|| path.file_stem().unwrap().to_str().unwrap())
            .to_string();
        let decoded = streampay_sdk::vectors::decode_vector(&vector)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        vectors.insert(name, decoded);
    }

    let output = json!({
        "sdk": "rust",
        "specFingerprint": streampay_sdk::SPEC_FINGERPRINT,
        "vectors": vectors,
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
