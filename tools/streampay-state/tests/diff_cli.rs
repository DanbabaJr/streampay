//! Contract tests for `streampay-state diff`: exit codes, determinism, the
//! shape of the JSON report and the handling of corrupt input.

use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::Value;

fn fixture(name: &str) -> String {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/diff");
    // Deliberately-unparseable fixtures are stored as `.txt`: the repo gate
    // that every tracked `.json` must parse cannot carry known-invalid JSON.
    let json = dir.join(format!("{name}.json"));
    let path = if json.exists() { json } else { dir.join(format!("{name}.txt")) };
    path.to_string_lossy().into_owned()
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_streampay-state"))
        .arg("diff")
        .args(args)
        .output()
        .expect("streampay-state runs")
}

fn diff(a: &str, b: &str, extra: &[&str]) -> Output {
    let (a, b) = (fixture(a), fixture(b));
    let mut args = vec!["--a", a.as_str(), "--b", b.as_str()];
    args.extend_from_slice(extra);
    run(&args)
}

fn code(o: &Output) -> i32 {
    o.status.code().expect("exit code")
}

fn json(a: &str, b: &str, extra: &[&str]) -> (Value, i32) {
    let mut args = vec!["--format", "json"];
    args.extend_from_slice(extra);
    let o = diff(a, b, &args);
    let v = serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("diff {a} {b}: stdout is not JSON: {e}"));
    (v, code(&o))
}

fn changes(v: &Value) -> Vec<(String, String, String)> {
    v["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["family"].as_str().unwrap().to_string(),
                c["change"].as_str().unwrap().to_string(),
                c["key"].to_string(),
            )
        })
        .collect()
}

// ── Exit codes: 0 identical / 1 differences / 2 error ────────────────────────

#[test]
fn identical_snapshots_exit_0() {
    let o = diff("base", "base", &[]);
    assert_eq!(code(&o), 0);
    let text = String::from_utf8(o.stdout).unwrap();
    assert!(text.starts_with("Snapshots are identical."), "{text}");

    let (v, c) = json("base", "base", &[]);
    assert_eq!(c, 0);
    assert_eq!(v["identical"], true);
    assert!(v["changes"].as_array().unwrap().is_empty());
}

#[test]
fn differences_exit_1() {
    for other in ["added", "changed", "state-header"] {
        let o = diff("base", other, &[]);
        assert_eq!(code(&o), 1, "base vs {other}");
        assert!(String::from_utf8(o.stdout)
            .unwrap()
            .starts_with("Snapshots differ."));
    }
}

#[test]
fn errors_exit_2_with_nothing_on_stdout() {
    for bad in [
        "corrupt-garbage",
        "corrupt-truncated",
        "corrupt-missing-field",
        "corrupt-wrong-type",
        "corrupt-duplicate-keys",
    ] {
        for (a, b) in [("base", bad), (bad, "base")] {
            for format in ["text", "json"] {
                let o = diff(a, b, &["--format", format]);
                assert_eq!(code(&o), 2, "{a} vs {b} ({format})");
                assert!(
                    o.stdout.is_empty(),
                    "{a} vs {b}: no partial report on error"
                );
                assert!(String::from_utf8(o.stderr).unwrap().starts_with("error: "));
            }
        }
    }
}

#[test]
fn error_messages_name_the_side_and_the_cause() {
    let stderr = |o: Output| String::from_utf8(o.stderr).unwrap();

    let e = stderr(diff("base", "corrupt-garbage", &[]));
    assert!(e.contains("cannot parse snapshot B"), "{e}");
    let e = stderr(diff("corrupt-truncated", "base", &[]));
    assert!(e.contains("cannot parse snapshot A"), "{e}");
    let e = stderr(diff("base", "corrupt-missing-field", &[]));
    assert!(e.contains("missing field `streams`"), "{e}");
    let e = stderr(diff("base", "corrupt-duplicate-keys", &[]));
    assert!(
        e.contains("duplicate streams key 1") && e.contains("verify"),
        "{e}"
    );

    let o = run(&["--a", "/no/such/snapshot.json", "--b", &fixture("base")]);
    assert_eq!(code(&o), 2);
    let e = stderr(o);
    assert!(
        e.contains("cannot read snapshot A") && e.contains("/no/such/snapshot.json"),
        "{e}"
    );
}

#[test]
fn usage_errors_exit_2() {
    assert_eq!(code(&run(&["--a", &fixture("base")])), 2, "--b is required");
    assert_eq!(code(&run(&[])), 2);
    assert_eq!(
        code(&run(&[
            "--a",
            &fixture("base"),
            "--b",
            &fixture("base"),
            "--format",
            "xml"
        ])),
        2
    );
}

// ── What is reported ─────────────────────────────────────────────────────────

#[test]
fn added_records_are_listed_per_family_in_key_order() {
    let (v, c) = json("base", "added", &[]);
    assert_eq!(c, 1);
    assert_eq!(v["identical"], false);
    let got = changes(&v);
    let families: Vec<&str> = got.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(
        families,
        [
            "streams",
            "scheduled_intents",
            "treasuries",
            "stream_fees",
            "sender_indexes"
        ]
    );
    assert!(got.iter().all(|c| c.1 == "added"));
    assert_eq!(got[0].2, "5");
    // A fee record is identified by stream *and* token.
    let fee = &v["changes"][3];
    assert_eq!(fee["key"]["stream_id"], 5);
    assert!(fee["key"]["token"].as_str().unwrap().starts_with('C'));
    assert_eq!(fee["record"]["amount"], "2");
    // The added record is shown in full.
    assert_eq!(v["changes"][0]["record"]["status"], "Active");
    assert_eq!(v["summary"]["families"]["streams"]["added"], 1);
    assert_eq!(v["summary"]["families"]["streams"]["removed"], 0);
}

#[test]
fn swapping_the_inputs_turns_added_into_removed() {
    let (v, c) = json("added", "base", &[]);
    assert_eq!(c, 1);
    assert!(changes(&v).iter().all(|c| c.1 == "removed"));
    assert_eq!(changes(&v).len(), 5);
    assert_eq!(v["summary"]["families"]["streams"]["removed"], 1);
    assert_eq!(v["changes"][0]["record"]["deposit"], "250");
}

#[test]
fn changed_fields_are_reported_as_field_level_deltas() {
    let (v, c) = json("base", "changed", &[]);
    assert_eq!(c, 1);
    let all = changes(&v);
    assert!(all.iter().all(|c| c.1 == "changed"));
    assert_eq!(all.len(), 5, "{all:?}");

    let stream1 = &v["changes"][0];
    assert_eq!(
        (stream1["family"].as_str(), stream1["key"].as_u64()),
        (Some("streams"), Some(1))
    );
    let fields = stream1["fields"].as_array().unwrap();
    // Only fields that differ, in model declaration order; amounts are
    // decimal strings (these exceed 2^53).
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0]["field"], "deposit");
    assert_eq!(fields[0]["from"], "9007199254740993000");
    assert_eq!(fields[0]["to"], "9007199254740993001");
    assert_eq!(fields[1]["field"], "withdrawn");
    assert_eq!(
        (fields[1]["from"].as_str(), fields[1]["to"].as_str()),
        (Some("1000"), Some("2000"))
    );

    let stream3 = &v["changes"][1];
    assert_eq!(stream3["fields"][0]["field"], "status");
    assert_eq!(stream3["fields"][0]["from"], "Active");
    assert_eq!(stream3["fields"][0]["to"], "Cancelled");

    // Append-only index lists compare as ordered lists.
    let idx = v["changes"].as_array().unwrap().last().unwrap();
    assert_eq!(idx["family"], "sender_indexes");
    assert_eq!(idx["fields"][0]["to"], serde_json::json!([1, 2, 3, 4, 5]));
}

#[test]
fn text_summary_lists_counts_and_deltas() {
    let o = diff("base", "changed", &[]);
    let text = String::from_utf8(o.stdout).unwrap();
    assert!(
        text.contains("streams: 0 added, 0 removed, 2 changed"),
        "{text}"
    );
    assert!(text.contains("~ streams 1"), "{text}");
    assert!(
        text.contains("deposit: 9007199254740993000 -> 9007199254740993001"),
        "{text}"
    );
    assert!(text.contains("status: Active -> Cancelled"), "{text}");

    let o = diff("base", "added", &[]);
    let text = String::from_utf8(o.stdout).unwrap();
    assert!(text.contains("+ streams 5"), "{text}");
    assert!(
        text.contains("streams: 1 added, 0 removed, 0 changed"),
        "{text}"
    );
}

// ── Provenance and header ────────────────────────────────────────────────────

#[test]
fn provenance_is_reported_but_not_counted_by_default() {
    let o = diff("base", "provenance", &[]);
    assert_eq!(code(&o), 0, "two exports of the same state are identical");
    let text = String::from_utf8(o.stdout).unwrap();
    assert!(
        text.contains("rpc_url:") && text.contains("(provenance, ignored)"),
        "{text}"
    );

    let (v, c) = json("base", "provenance", &[]);
    assert_eq!((c, &v["identical"]), (0, &Value::Bool(true)));
    assert_eq!(v["summary"]["header"]["provenance_changed"], 3);
    assert_eq!(v["summary"]["header"]["state_changed"], 0);
    let kinds: Vec<&str> = v["header"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["provenance"; 3]);
}

#[test]
fn include_provenance_makes_provenance_count() {
    let o = diff("base", "provenance", &["--include-provenance"]);
    assert_eq!(code(&o), 1);
    let (v, c) = json("base", "provenance", &["--include-provenance"]);
    assert_eq!(
        (c, &v["identical"], &v["include_provenance"]),
        (1, &Value::Bool(false), &Value::Bool(true))
    );
}

#[test]
fn state_header_changes_always_count() {
    let (v, c) = json("base", "state-header", &[]);
    assert_eq!(c, 1);
    let fields: Vec<&str> = v["header"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["field"].as_str().unwrap())
        .collect();
    assert_eq!(fields, ["contract_frozen", "governor"]);
    assert_eq!(v["header"][0]["from"], false);
    assert_eq!(v["header"][0]["to"], true);
    assert!(v["changes"].as_array().unwrap().is_empty());
}

// ── Determinism ──────────────────────────────────────────────────────────────

#[test]
fn output_is_byte_identical_across_runs() {
    for format in ["text", "json"] {
        for other in ["added", "changed", "provenance"] {
            let first = diff("base", other, &["--format", format]).stdout;
            let second = diff("base", other, &["--format", format]).stdout;
            assert_eq!(first, second, "{other} ({format})");
        }
    }
}

#[test]
fn record_order_in_the_file_does_not_matter() {
    // `added.json` lists its streams in reverse order; sorting by key must make
    // that invisible, so the report is ordered by key regardless.
    let (v, _) = json("base", "added", &[]);
    assert_eq!(v["changes"][0]["key"], 5);

    let dir =
        std::env::temp_dir().join(format!("streampay-state-diff-order-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut snap: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("base")).unwrap()).unwrap();
    for family in ["streams", "stream_fees", "treasuries"] {
        snap[family].as_array_mut().unwrap().reverse();
    }
    let shuffled = dir.join("shuffled.json");
    std::fs::write(&shuffled, serde_json::to_string(&snap).unwrap()).unwrap();
    let o = run(&["--a", &fixture("base"), "--b", shuffled.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "same records in another order are identical");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn json_report_has_a_stable_top_level_shape() {
    // serde_json's map is sorted, so check the *emitted* order on the raw text.
    let raw = String::from_utf8(diff("base", "changed", &["--format", "json"]).stdout).unwrap();
    let positions = |names: &[&str]| -> Vec<usize> {
        names
            .iter()
            .map(|n| {
                raw.find(&format!("\n  \"{n}\":"))
                    .unwrap_or_else(|| panic!("{n} missing"))
            })
            .collect()
    };
    let top = positions(&[
        "report_version",
        "identical",
        "include_provenance",
        "inputs",
        "summary",
        "header",
        "changes",
    ]);
    assert!(
        top.windows(2).all(|w| w[0] < w[1]),
        "top-level keys out of order: {top:?}"
    );

    let families = [
        "streams",
        "scheduled_intents",
        "treasuries",
        "stream_fees",
        "sender_indexes",
        "recipient_indexes",
    ];
    let summary = &raw[raw.find("\"families\"").unwrap()..raw.find("\"header\": [").unwrap()];
    let at: Vec<usize> = families
        .iter()
        .map(|f| summary.find(&format!("\"{f}\":")).unwrap())
        .collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "family order: {at:?}");

    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["report_version"], 1);
    assert_eq!(
        v["summary"]["families"].as_object().unwrap().len(),
        families.len()
    );
}

// ── Scale ────────────────────────────────────────────────────────────────────

#[test]
fn large_snapshots_diff_correctly() {
    const N: u64 = 30_000;
    let dir =
        std::env::temp_dir().join(format!("streampay-state-diff-large-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut snap: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("base")).unwrap()).unwrap();
    let template = snap["streams"][3].clone();
    let streams = snap["streams"].as_array_mut().unwrap();
    streams.clear();
    for id in 1..=N {
        let mut s = template.clone();
        s["id"] = id.into();
        streams.push(s);
    }
    snap["sender_indexes"] = Value::Array(vec![]);
    snap["recipient_indexes"] = Value::Array(vec![]);
    snap["stream_fees"] = Value::Array(vec![]);
    snap["treasuries"] = Value::Array(vec![]);
    snap["scheduled_intents"] = Value::Array(vec![]);
    let a = dir.join("a.json");
    std::fs::write(&a, serde_json::to_string(&snap).unwrap()).unwrap();

    let streams = snap["streams"].as_array_mut().unwrap();
    streams[0]["withdrawn"] = 7.into();
    streams[(N / 2) as usize]["status"] = "Cancelled".into();
    streams.pop();
    streams.push({
        let mut s = template.clone();
        s["id"] = (N + 1).into();
        s
    });
    let b = dir.join("b.json");
    std::fs::write(&b, serde_json::to_string(&snap).unwrap()).unwrap();

    let o = run(&[
        "--a",
        a.to_str().unwrap(),
        "--b",
        b.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert_eq!(code(&o), 1);
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    let streams = &v["summary"]["families"]["streams"];
    assert_eq!(
        (
            streams["added"].as_u64(),
            streams["removed"].as_u64(),
            streams["changed"].as_u64()
        ),
        (Some(1), Some(1), Some(2))
    );
    assert_eq!(v["changes"].as_array().unwrap().len(), 4);
    assert_eq!(
        code(&run(&[
            "--a",
            a.to_str().unwrap(),
            "--b",
            a.to_str().unwrap()
        ])),
        0
    );
    std::fs::remove_dir_all(&dir).ok();
}
