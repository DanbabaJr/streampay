//! Prints the canonical decoding of every vector, for the cross-language
//! conformance runner:
//!
//! ```text
//! cargo run --quiet --example conformance -- ../vectors
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use streampay_sdk::vectors::{decode_vector, Spec};

fn spec_path(vectors_dir: &Path) -> PathBuf {
    let beside = vectors_dir.join("..").join("spec").join("streampay.spec.json");
    if beside.exists() {
        beside
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("spec")
            .join("streampay.spec.json")
    }
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vectors"));
    let spec = Spec::load(&spec_path(&dir)).unwrap_or_else(|error| panic!("{error}"));

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
        let decoded = decode_vector(&vector, &spec)
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
