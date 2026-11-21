//! Cross-language conformance: the Rust decoder must reproduce the canonical
//! JSON recorded in every shared vector, byte for byte after parsing.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vectors")
}

fn vector_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = fs::read_dir(vectors_dir())
        .expect("sdks/vectors must exist")
        .map(|entry| entry.expect("readable directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
}

#[test]
fn vectors_are_present() {
    assert!(
        vector_paths().len() >= 5,
        "expected the conformance vector suite, found {:?}",
        vector_paths()
    );
}

#[test]
fn every_vector_decodes_to_its_expected_json() {
    for path in vector_paths() {
        let text = fs::read_to_string(&path).expect("readable vector");
        let vector: Value = serde_json::from_str(&text).expect("valid vector JSON");

        assert_eq!(
            vector["specFingerprint"].as_str(),
            Some(streampay_sdk::SPEC_FINGERPRINT),
            "{} was generated from a different spec fingerprint",
            path.display()
        );

        let decoded = streampay_sdk::vectors::decode_vector(&vector)
            .unwrap_or_else(|error| panic!("{} failed to decode: {error}", path.display()));

        assert_eq!(
            decoded,
            vector["expected"],
            "{}: decoded payload drifted from the recorded expectation",
            path.display()
        );
    }
}

#[test]
fn contract_errors_decode_to_typed_variants() {
    let value = stellar_xdr::ScVal::Error(stellar_xdr::ScError::Contract(5));
    assert_eq!(
        streampay_sdk::StreamError::from_code(5),
        Some(streampay_sdk::StreamError::StreamNotActive)
    );
    assert_eq!(
        streampay_sdk::StreamError::from_code(5).map(|error| error.name()),
        Some("StreamNotActive")
    );
    assert!(matches!(value, stellar_xdr::ScVal::Error(_)));
}
