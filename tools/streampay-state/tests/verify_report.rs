//! Contract tests for `streampay-state verify --format json`.
//!
//! Every report the binary emits for the fixtures in `tests/fixtures/` is
//! validated against the published schema (`json-schema-v1.json`), and the
//! schema itself is checked to be valid JSON Schema draft 2020-12.

use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::{json, Value};

const DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";
const FIXTURES: [&str; 3] = ["empty", "valid", "all-violations"];

/// Every `check` identifier the v1 report can carry. Mirrors `verify::check`;
/// the `all-violations` fixture must trigger each one.
const CHECKS: [&str; 7] = [
    "schema_fingerprint",
    "stream_arithmetic",
    "duplicate_stream_ids",
    "treasury_invariant",
    "index_completeness",
    "orphan_fee",
    "intent_arithmetic",
];

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn schema() -> Value {
    let raw = std::fs::read_to_string(crate_dir().join("json-schema-v1.json"))
        .expect("json-schema-v1.json is readable");
    serde_json::from_str(&raw).expect("json-schema-v1.json is valid JSON")
}

fn fixture_path(name: &str) -> PathBuf {
    crate_dir()
        .join("tests/fixtures")
        .join(format!("{name}.json"))
}

fn verify(name: &str, format: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_streampay-state"))
        .args(["verify", "--snapshot"])
        .arg(fixture_path(name))
        .args(["--format", format])
        .output()
        .expect("streampay-state runs")
}

fn report(name: &str) -> (Value, i32) {
    let out = verify(name, "json");
    let value: Value = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("stdout for {name} is not JSON: {e}"));
    (value, out.status.code().expect("exit code"))
}

fn errors(schema: &Value, instance: &Value) -> Vec<String> {
    let validator = jsonschema::draft202012::new(schema).expect("schema compiles");
    validator
        .iter_errors(instance)
        .map(|e| format!("{} at {}", e, e.instance_path))
        .collect()
}

#[test]
fn schema_is_valid_json_schema_draft_2020_12() {
    let schema = schema();
    assert_eq!(
        schema["$schema"], DRAFT_2020_12,
        "must declare draft 2020-12"
    );
    jsonschema::meta::validate(&schema).expect("schema is valid against the 2020-12 meta-schema");
    assert!(jsonschema::draft202012::new(&schema).is_ok());
    assert_eq!(schema["properties"]["report_version"]["const"], 1);
}

#[test]
fn every_fixture_report_validates_against_the_schema() {
    let schema = schema();
    for name in FIXTURES {
        let (value, _) = report(name);
        let errs = errors(&schema, &value);
        assert!(
            errs.is_empty(),
            "{name}: report violates the schema: {errs:#?}"
        );
    }
}

#[test]
fn exit_code_and_ok_agree() {
    for (name, ok) in [("empty", true), ("valid", true), ("all-violations", false)] {
        let (value, code) = report(name);
        assert_eq!(value["ok"], ok, "{name}");
        assert_eq!(code == 0, ok, "{name}: exit code {code}");
        assert_eq!(
            value["violations"].as_array().unwrap().is_empty(),
            ok,
            "{name}"
        );
    }
}

#[test]
fn valid_fixture_reports_counts_and_balances() {
    let (value, _) = report("valid");
    assert_eq!(value["report_version"], 1);
    assert_eq!(
        value["counts"],
        json!({"streams": 4, "scheduled_intents": 1, "treasuries": 2, "stream_fees": 2})
    );
    assert_eq!(
        value["snapshot"]["schema_fingerprint"],
        value["snapshot"]["expected_schema_fingerprint"]
    );

    let balances = value["unclaimed_by_token"].as_array().unwrap();
    let tokens: Vec<&str> = balances
        .iter()
        .map(|b| b["token"].as_str().unwrap())
        .collect();
    let mut sorted = tokens.clone();
    sorted.sort_unstable();
    assert_eq!(tokens, sorted, "unclaimed_by_token is sorted by token");
    // Above 2^53: this is why amounts are decimal strings, not JSON numbers.
    assert_eq!(balances[0]["unclaimed"], "9007199254740992000");
    assert_eq!(balances[1]["unclaimed"], "100");
}

#[test]
fn violations_fixture_triggers_every_check_identifier() {
    let (value, _) = report("all-violations");
    let mut seen: Vec<&str> = value["violations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["check"].as_str().unwrap())
        .collect();
    seen.sort_unstable();
    seen.dedup();
    let mut expected = CHECKS.to_vec();
    expected.sort_unstable();
    assert_eq!(seen, expected);
    for v in value["violations"].as_array().unwrap() {
        assert!(!v["message"].as_str().unwrap().is_empty());
    }
}

#[test]
fn default_format_is_still_the_human_readable_text() {
    let ok = verify("valid", "text");
    assert!(ok.status.success());
    let stdout = String::from_utf8(ok.stdout).unwrap();
    assert!(
        stdout.starts_with("✓ Snapshot verified: no violations found."),
        "{stdout}"
    );
    assert!(
        serde_json::from_str::<Value>(&stdout).is_err(),
        "text output is not JSON"
    );

    let bad = verify("all-violations", "text");
    assert_eq!(bad.status.code(), Some(1));
    assert!(String::from_utf8(bad.stderr)
        .unwrap()
        .contains("Snapshot verification FAILED (13 violations)"));
}

#[test]
fn unreadable_snapshot_is_an_error_with_no_report() {
    let out = Command::new(env!("CARGO_BIN_EXE_streampay-state"))
        .args([
            "verify",
            "--snapshot",
            "tests/fixtures/does-not-exist.json",
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stdout.is_empty(),
        "no report is printed when the snapshot cannot be read"
    );
    assert!(String::from_utf8(out.stderr)
        .unwrap()
        .contains("cannot read snapshot"));
}

#[test]
fn the_schema_rejects_malformed_reports() {
    let schema = schema();
    let (good, _) = report("valid");
    assert!(errors(&schema, &good).is_empty());

    let mut missing = good.clone();
    missing.as_object_mut().unwrap().remove("counts");
    assert!(
        !errors(&schema, &missing).is_empty(),
        "missing required field"
    );

    let mut wrong_version = good.clone();
    wrong_version["report_version"] = json!(2);
    assert!(
        !errors(&schema, &wrong_version).is_empty(),
        "report_version must be 1"
    );

    let mut numeric_amount = good.clone();
    numeric_amount["unclaimed_by_token"][0]["unclaimed"] = json!(100);
    assert!(
        !errors(&schema, &numeric_amount).is_empty(),
        "amounts are strings"
    );

    let mut ok_with_violation = good.clone();
    ok_with_violation["violations"] = json!([{"check": "orphan_fee", "message": "x"}]);
    assert!(
        !errors(&schema, &ok_with_violation).is_empty(),
        "ok=true forbids violations"
    );

    let (bad, _) = report("all-violations");
    let mut not_ok_without = bad.clone();
    not_ok_without["violations"] = json!([]);
    assert!(
        !errors(&schema, &not_ok_without).is_empty(),
        "ok=false needs a violation"
    );
}

#[test]
fn additive_fields_are_tolerated_within_v1() {
    let schema = schema();
    let (mut value, _) = report("valid");
    value["a_future_field"] = json!({"anything": true});
    value["counts"]["future_count"] = json!(3);
    value["violations"] = json!([]);
    assert!(errors(&schema, &value).is_empty());

    let (mut bad, _) = report("all-violations");
    bad["violations"][0]["check"] = json!("a_check_added_in_a_later_minor_release");
    assert!(
        errors(&schema, &bad).is_empty(),
        "unknown check ids must not break v1 consumers"
    );
}
