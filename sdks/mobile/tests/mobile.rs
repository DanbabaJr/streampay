//! Mobile SDK tests: UniFFI error mapping, typed decoding, and one transport
//! round trip. These run on the host (`cargo test`), not on a device.

use std::path::PathBuf;

use stellar_xdr::{Limits, ReadXdr, ScError, ScVal, WriteXdr};
use streampay_mobile::{RpcReadTransport, StreamPayError, StreamPayMobile, StreamStatus};

fn vector(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("readable vector"))
        .expect("valid vector JSON")
}

struct StaticTransport(String);

impl RpcReadTransport for StaticTransport {
    fn simulate(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> Result<String, StreamPayError> {
        Ok(self.0.clone())
    }
}

fn client(result_xdr: String) -> StreamPayMobile {
    StreamPayMobile::new("C...".to_string(), Box::new(StaticTransport(result_xdr)))
}

#[test]
fn every_catalog_code_maps_to_one_variant_and_back() {
    let catalog = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("frontend")
            .join("lib")
            .join("errors.ts"),
    )
    .expect("canonical error catalog");
    let mut seen = 0;
    for line in catalog.lines() {
        let Some((code, name)) = parse_catalog_line(line) else {
            continue;
        };
        seen += 1;
        let error = StreamPayError::from_code(code);
        assert_eq!(error.name(), name, "code {code}");
        assert_eq!(error.code(), Some(code), "code {code}");
    }
    assert_eq!(seen, 99, "the mobile SDK must map the full catalog");
    assert_eq!(StreamPayError::from_code(9_999), StreamPayError::Unknown);
    assert_eq!(StreamPayError::Transport.code(), None);
}

fn parse_catalog_line(line: &str) -> Option<(u16, &str)> {
    let line = line.trim();
    let (code, rest) = line.split_once(": {")?;
    let code: u16 = code.parse().ok()?;
    let rest = rest.trim_start();
    if !rest.starts_with("code:") {
        return None;
    }
    let name = rest.split_once("name: \"")?.1.split_once('"')?.0;
    Some((code, name))
}

#[test]
fn transport_contract_errors_become_typed_exceptions() {
    let encoded =
        ScVal::Error(ScError::Contract(5)).to_xdr_base64(Limits::none()).unwrap();
    let error = client(encoded).get_stream(1).unwrap_err();
    assert_eq!(error, StreamPayError::StreamNotActive);
    assert_eq!(error.code(), Some(5));
}

#[test]
fn get_stream_decodes_the_recorded_vector() {
    let vector = vector("get-stream-active.json");
    let view = client(String::new())
        .decode_get_stream(vector["resultXdr"].as_str().unwrap().to_string())
        .expect("vector decodes");
    let expected = &vector["expected"]["result"]["ok"];
    assert_eq!(
        serde_json::to_value(view.to_json()).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(view.status, StreamStatus::Active);
    assert_eq!(view.deposit, "340282366920938463463374607431768211");
    assert_eq!(view.withdrawn, "0");
    assert_eq!(view.use_oracle, Some(false));
}

#[test]
fn available_returns_a_decimal_string() {
    let value = ScVal::I128(stellar_xdr::Int128Parts { hi: 0, lo: 42 });
    let encoded = value.to_xdr_base64(Limits::none()).unwrap();
    let amount = client(encoded).available(1).expect("available decodes");
    assert_eq!(amount, "42");
}

#[test]
fn transport_failure_is_reported_without_panicking() {
    struct Failing;
    impl RpcReadTransport for Failing {
        fn simulate(
            &self,
            _: String,
            _: String,
            _: String,
        ) -> Result<String, StreamPayError> {
            Err(StreamPayError::Transport)
        }
    }
    let client = StreamPayMobile::new("C...".to_string(), Box::new(Failing));
    assert_eq!(client.get_stream(1).unwrap_err(), StreamPayError::Transport);
}

#[test]
fn fingerprint_matches_the_checked_in_spec() {
    let fingerprint = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("spec")
            .join("FINGERPRINT"),
    )
    .expect("spec fingerprint");
    assert_eq!(streampay_mobile::spec_fingerprint(), fingerprint.trim());
}
