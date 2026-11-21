use std::path::PathBuf;

use serde_json::Value;
use stellar_xdr::{
    HostFunction, Limits, OperationBody, ReadXdr, ScVal, TransactionEnvelope,
};
use streampay_sdk::{
    decode_contract_error, decode_get_stream_result, get_stream_args, StreamError, GET_STREAM,
    SPEC_FINGERPRINT,
};

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vectors")
        .join(format!("{name}.json"));
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&raw).expect("vector is valid JSON")
}

fn result_scval(vector: &Value) -> ScVal {
    let encoded = vector["resultXdr"].as_str().expect("resultXdr is a string");
    ScVal::from_xdr_base64(encoded, Limits::none()).expect("resultXdr decodes")
}

fn expected_string<'a>(value: &'a Value, path: &str) -> &'a str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected {path} to be a string"))
}

#[test]
fn read_vectors_decode_to_the_canonical_stream() {
    for name in ["get-stream-active", "get-stream-cancelled"] {
        let vector = load(name);
        assert_eq!(
            vector["specFingerprint"].as_str(),
            Some(SPEC_FINGERPRINT),
            "{name} was built from a different spec; regenerate the vectors"
        );

        let stream = decode_get_stream_result(&result_scval(&vector))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let expected = &vector["expected"]["result"]["ok"];

        assert_eq!(stream.id.to_string(), expected_string(&expected["id"], "id"), "{name}");
        assert_eq!(stream.sender, expected_string(&expected["sender"], "sender"), "{name}");
        assert_eq!(
            stream.recipient,
            expected_string(&expected["recipient"], "recipient"),
            "{name}"
        );
        assert_eq!(stream.token, expected_string(&expected["token"], "token"), "{name}");
        assert_eq!(
            stream.deposit.to_string(),
            expected_string(&expected["deposit"], "deposit"),
            "{name}"
        );
        assert_eq!(
            stream.withdrawn.to_string(),
            expected_string(&expected["withdrawn"], "withdrawn"),
            "{name}"
        );
        assert_eq!(
            stream.start_time.to_string(),
            expected_string(&expected["start_time"], "start_time"),
            "{name}"
        );
        assert_eq!(
            stream.end_time.to_string(),
            expected_string(&expected["end_time"], "end_time"),
            "{name}"
        );
        assert_eq!(
            stream.cancelable,
            expected["cancelable"].as_bool().expect("cancelable"),
            "{name}"
        );
        assert_eq!(
            stream.status.name(),
            expected_string(&expected["status"], "status"),
            "{name}"
        );
        assert_eq!(
            stream.use_oracle,
            expected["use_oracle"].as_bool(),
            "{name} use_oracle"
        );
    }
}

#[test]
fn error_vector_maps_to_the_generated_error_enum() {
    let vector = load("error-not-active");
    assert_eq!(
        vector["specFingerprint"].as_str(),
        Some(SPEC_FINGERPRINT),
        "error-not-active was built from a different spec"
    );

    let value = result_scval(&vector);
    let expected = &vector["expected"]["result"]["error"];
    let code = expected["code"].as_u64().expect("error code") as u32;

    match decode_contract_error(&value) {
        Some(Ok(error)) => {
            assert_eq!(error, StreamError::StreamNotActive);
            assert_eq!(error.code(), code);
            assert_eq!(
                error.name(),
                expected_string(&expected["name"], "error name")
            );
        }
        other => panic!("expected a known contract error, got {other:?}"),
    }

    // An error payload must never be decoded as a successful stream.
    assert!(decode_get_stream_result(&value).is_err());
}

#[test]
fn read_request_args_match_the_vector_envelope() {
    let vector = load("get-stream-active");
    let encoded = vector["transactionEnvelopeXdr"]
        .as_str()
        .expect("transactionEnvelopeXdr is a string");
    let envelope = TransactionEnvelope::from_xdr_base64(encoded, Limits::none())
        .expect("transactionEnvelopeXdr decodes");

    let transaction = match &envelope {
        TransactionEnvelope::Tx(v1) => &v1.tx,
        other => panic!("expected a v1 envelope, got {other:?}"),
    };
    let invoke = match &transaction.operations[0].body {
        OperationBody::InvokeHostFunction(op) => match &op.host_function {
            HostFunction::InvokeContract(args) => args,
            other => panic!("expected invokeContract, got {other:?}"),
        },
        other => panic!("expected invokeHostFunction, got {other:?}"),
    };

    assert_eq!(
        invoke.function_name.0.to_utf8_string_lossy(),
        GET_STREAM,
        "the vector calls a different method"
    );
    assert_eq!(
        invoke.args.iter().cloned().collect::<Vec<_>>(),
        get_stream_args(1).expect("get_stream args encode"),
        "generated request builder does not match the signed envelope"
    );
}
