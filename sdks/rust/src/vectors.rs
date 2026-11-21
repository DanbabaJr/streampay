//! Decodes the shared conformance vectors (`sdks/vectors/*.json`).
//!
//! This module is the Rust half of the cross-language conformance suite: it
//! turns a signed envelope, contract events and a result `ScVal` into the same
//! canonical JSON every other SDK must produce. The event topic names and
//! function argument names come from the one shared spec, never from a
//! hand-maintained table here.

use std::path::Path;

use serde_json::{json, Map, Value};
use stellar_strkey::{ed25519, Strkey};
use stellar_xdr::{
    ContractEvent, ContractEventBody, Hash, HostFunction, Limits, MuxedAccount, OperationBody,
    ReadXdr, ScAddress, ScVal, TransactionEnvelope, Uint256,
};

use crate::{address_from_scval, decode_contract_error, DecodeError};

/// The parts of `sdks/spec/streampay.spec.json` the vector decoder needs.
pub struct Spec {
    events: Vec<SpecEvent>,
    functions: Vec<SpecFunction>,
}

struct SpecEvent {
    name: String,
    topic: String,
    topic_fields: Vec<String>,
}

struct SpecFunction {
    name: String,
    arg_names: Vec<String>,
}

impl Spec {
    /// Reads the spec from disk.
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
        Self::from_json(&value)
    }

    /// Builds the decoder view from an already parsed spec.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let events = value["events"]
            .as_array()
            .ok_or_else(|| "spec has no events array".to_string())?
            .iter()
            .map(|event| SpecEvent {
                name: string_field(event, "name")?,
                topic: string_field(event, "topic")?,
                topic_fields: event["topicFields"]
                    .as_array()
                    .ok_or_else(|| "event has no topicFields".to_string())?
                    .iter()
                    .map(|field| string_field(field, "name"))
                    .collect::<Result<Vec<_>, _>>()?,
            })
            .collect();
        let functions = value["functions"]
            .as_array()
            .ok_or_else(|| "spec has no functions array".to_string())?
            .iter()
            .map(|function| SpecFunction {
                name: string_field(function, "name")?,
                arg_names: function["args"]
                    .as_array()
                    .ok_or_else(|| "function has no args".to_string())?
                    .iter()
                    .map(|arg| string_field(arg, "name"))
                    .collect::<Result<Vec<_>, _>>()?,
            })
            .collect();
        Ok(Self { events, functions })
    }

    fn event(&self, topic: &str) -> Option<&SpecEvent> {
        self.events.iter().find(|event| event.topic == topic)
    }

    fn function(&self, name: &str) -> Option<&SpecFunction> {
        self.functions.iter().find(|function| function.name == name)
    }
}

fn string_field(value: &Value, key: &str) -> Result<String, String> {
    value[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("spec entry is missing string `{key}`"))
}

fn xdr_error(error: stellar_xdr::Error) -> DecodeError {
    DecodeError::MissingField {
        context: format!("invalid XDR: {error}"),
    }
}

fn vector_field<'a>(vector: &'a Value, key: &str) -> Result<&'a str, DecodeError> {
    vector[key]
        .as_str()
        .ok_or_else(|| DecodeError::MissingField {
            context: format!("vector is missing string `{key}`"),
        })
}

/// Decodes one vector into `{ transaction, result, events }`.
pub fn decode_vector(vector: &Value, spec: &Spec) -> Result<Value, DecodeError> {
    let transaction = decode_transaction(vector_field(vector, "transactionEnvelopeXdr")?, spec)?;
    let result = decode_result(vector_field(vector, "resultXdr")?)?;

    let mut events = Vec::new();
    for item in vector["eventsXdr"].as_array().into_iter().flatten() {
        let encoded = item.as_str().ok_or_else(|| DecodeError::MissingField {
            context: "eventsXdr must contain base64 strings".into(),
        })?;
        events.push(decode_event(encoded, spec)?);
    }

    Ok(json!({
        "transaction": transaction,
        "result": result,
        "events": events,
    }))
}

fn address_string(address: &ScAddress) -> Result<String, DecodeError> {
    address_from_scval(&ScVal::Address(address.clone()), "vector address")
}

fn muxed_string(account: &MuxedAccount) -> Result<String, DecodeError> {
    let bytes = match account {
        MuxedAccount::Ed25519(Uint256(bytes)) => *bytes,
        MuxedAccount::MuxedEd25519(muxed) => {
            let Uint256(bytes) = &muxed.ed25519;
            *bytes
        }
    };
    Ok(Strkey::PublicKeyEd25519(ed25519::PublicKey(bytes))
        .to_string()
        .to_string())
}

fn decode_transaction(encoded: &str, spec: &Spec) -> Result<Value, DecodeError> {
    let envelope = TransactionEnvelope::from_xdr_base64(encoded, Limits::none())
        .map_err(xdr_error)?;
    let envelope = match envelope {
        TransactionEnvelope::Tx(envelope) => envelope,
        _ => {
            return Err(DecodeError::MissingField {
                context: "only v1 transaction envelopes are supported".into(),
            })
        }
    };
    let operation = envelope.tx.operations.first().ok_or_else(|| {
        DecodeError::MissingField {
            context: "transaction has no operations".into(),
        }
    })?;
    let invoke = match &operation.body {
        OperationBody::InvokeHostFunction(invoke) => invoke,
        _ => {
            return Err(DecodeError::MissingField {
                context: "expected an invokeHostFunction operation".into(),
            })
        }
    };
    let call = match &invoke.host_function {
        HostFunction::InvokeContract(call) => call,
        _ => {
            return Err(DecodeError::MissingField {
                context: "expected an invokeContract host function".into(),
            })
        }
    };

    let function_name = call.function_name.0.to_utf8_string_lossy();
    let function = spec.function(&function_name).ok_or_else(|| {
        DecodeError::MissingField {
            context: format!("function `{function_name}` is not part of the spec"),
        }
    })?;

    let mut args = Map::new();
    for (index, name) in function.arg_names.iter().enumerate() {
        let value = call.args.get(index).ok_or_else(|| DecodeError::MissingField {
            context: format!("`{function_name}` is missing argument #{index}"),
        })?;
        args.insert(
            name.clone(),
            canonical(value, &format!("{function_name}.{name}"))?,
        );
    }

    let transaction = json!({
        "contract": address_string(&call.contract_address)?,
        "function": function_name,
        "args": args,
        "source": muxed_string(&envelope.tx.source_account)?,
        "fee": envelope.tx.fee.to_string(),
        "sequence": envelope.tx.seq_num.0.to_string(),
        "signatures": envelope.signatures.len(),
    });
    Ok(transaction)
}

fn decode_result(encoded: &str) -> Result<Value, DecodeError> {
    let value = ScVal::from_xdr_base64(encoded, Limits::none()).map_err(xdr_error)?;
    if let Some(error) = decode_contract_error(&value) {
        let (name, code) = match error {
            Ok(error) => (error.name().to_string(), error.code()),
            Err(code) => ("UnknownStreamError".to_string(), code),
        };
        return Ok(json!({ "error": { "name": name, "code": code } }));
    }
    Ok(json!({ "ok": canonical(&value, "result")? }))
}

fn decode_event(encoded: &str, spec: &Spec) -> Result<Value, DecodeError> {
    let event =
        ContractEvent::from_xdr_base64(encoded, Limits::none()).map_err(xdr_error)?;
    let contract = match &event.contract_id {
        Some(stellar_xdr::ContractId(Hash(bytes))) => {
            Strkey::Contract(stellar_strkey::Contract(*bytes))
                .to_string()
                .to_string()
        }
        None => {
            return Err(DecodeError::MissingField {
                context: "event has no contract id".into(),
            })
        }
    };
    let body = match &event.body {
        ContractEventBody::V0(body) => body,
        #[allow(unreachable_patterns)]
        other => {
            return Err(DecodeError::MissingField {
                context: format!("unsupported contract event body {other:?}"),
            })
        }
    };
    let topics = &body.topics;
    let topic_symbol = match topics.first() {
        Some(ScVal::Symbol(symbol)) => symbol.0.to_utf8_string_lossy(),
        _ => {
            return Err(DecodeError::MissingField {
                context: "event has no symbol topic-0".into(),
            })
        }
    };
    let spec_event = spec.event(&topic_symbol).ok_or_else(|| {
        DecodeError::MissingField {
            context: format!("event `{topic_symbol}` is not part of the spec"),
        }
    })?;
    if topics.len() - 1 != spec_event.topic_fields.len() {
        return Err(DecodeError::UnionArity {
            context: format!("event `{topic_symbol}` topics"),
            expected: spec_event.topic_fields.len() + 1,
            found: topics.len(),
        });
    }
    let mut topic_map = Map::new();
    for (index, field) in spec_event.topic_fields.iter().enumerate() {
        topic_map.insert(
            field.clone(),
            canonical(&topics[index + 1], &format!("{}.{field}", spec_event.name))?,
        );
    }
    let data = match canonical(&body.data, &format!("{}.data", spec_event.name))? {
        Value::Object(map) => Value::Object(map),
        _ => {
            return Err(DecodeError::MissingField {
                context: format!("event `{topic_symbol}` data is not a map"),
            })
        }
    };
    Ok(json!({
        "contract": contract,
        "name": spec_event.name,
        "topics": topic_map,
        "data": data,
    }))
}

/// Canonical JSON for a Soroban scalar: integers become decimal strings,
/// addresses become StrKeys, unit enums become their case name and maps become
/// objects (event payloads are maps with symbol keys).
fn canonical(value: &ScVal, context: &str) -> Result<Value, DecodeError> {
    let out = match value {
        ScVal::Void => Value::Null,
        ScVal::Bool(inner) => Value::Bool(*inner),
        ScVal::U32(inner) => json!(inner.to_string()),
        ScVal::I32(inner) => json!(inner.to_string()),
        ScVal::U64(inner) => json!(inner.to_string()),
        ScVal::I64(inner) => json!(inner.to_string()),
        ScVal::U128(parts) => {
            json!(((u128::from(parts.hi) << 64) | u128::from(parts.lo)).to_string())
        }
        ScVal::I128(parts) => {
            json!((((parts.hi as i128) << 64) | (parts.lo as i128)).to_string())
        }
        ScVal::Bytes(bytes) => {
            let mut encoded = String::with_capacity(bytes.len() * 2);
            for byte in bytes.as_slice() {
                encoded.push_str(&format!("{byte:02x}"));
            }
            Value::String(encoded)
        }
        ScVal::String(inner) => Value::String(inner.0.to_utf8_string_lossy()),
        ScVal::Symbol(inner) => Value::String(inner.0.to_utf8_string_lossy()),
        ScVal::Address(_) => Value::String(address_from_scval(value, context)?),
        ScVal::Vec(Some(items)) => {
            if items.len() == 1 {
                if let ScVal::Symbol(symbol) = &items[0] {
                    return Ok(Value::String(symbol.0.to_utf8_string_lossy()));
                }
            }
            let mut out = Vec::with_capacity(items.len());
            for item in items.iter() {
                out.push(canonical(item, context)?);
            }
            Value::Array(out)
        }
        ScVal::Vec(None) => Value::Array(Vec::new()),
        ScVal::Map(Some(entries)) => {
            let mut map = Map::new();
            for entry in entries.iter() {
                let key = match &entry.key {
                    ScVal::Symbol(symbol) => symbol.0.to_utf8_string_lossy(),
                    ScVal::String(string) => string.0.to_utf8_string_lossy(),
                    other => {
                        return Err(DecodeError::Unexpected {
                            context: context.to_string(),
                            expected: "symbol map key",
                            found: crate::scval_kind(other),
                        })
                    }
                };
                map.insert(key.clone(), canonical(&entry.val, &format!("{context}.{key}"))?);
            }
            Value::Object(map)
        }
        ScVal::Map(None) => Value::Object(Map::new()),
        other => {
            return Err(DecodeError::Unexpected {
                context: context.to_string(),
                expected: "canonical scalar",
                found: crate::scval_kind(other),
            })
        }
    };
    Ok(out)
}

/// Convenience wrapper used by the conformance runner.
pub fn decode_vector_str(json_text: &str, spec: &Spec) -> Result<Value, DecodeError> {
    let vector: Value = serde_json::from_str(json_text).map_err(|error| {
        DecodeError::MissingField {
            context: format!("invalid vector JSON: {error}"),
        }
    })?;
    decode_vector(&vector, spec)
}
