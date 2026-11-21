//! Decodes the shared conformance vectors (`sdks/vectors/*.json`).
//!
//! This module is the Rust half of the cross-language conformance suite: it
//! turns a signed envelope, contract events, and a result ScVal into the same
//! canonical JSON that the TypeScript and Python SDKs must produce.

use serde_json::{json, Map, Value};
use stellar_strkey::ed25519::PublicKey as StrkeyPublicKey;
use stellar_strkey::Contract as StrkeyContract;
use stellar_xdr::{
    ContractEvent, ContractId, HostFunction, Limits, MuxedAccount, OperationBody, ReadXdr,
    ScAddress, ScVal, TransactionEnvelope, Uint256,
};

use crate::{
    scval_to_address, scval_to_bool, scval_to_i128, scval_to_u32, scval_to_u64, scval_to_void,
    Event, FunctionSpec, SdkError, Stream, StreamError, FUNCTIONS,
};

fn xdr_error(error: stellar_xdr::Error) -> SdkError {
    SdkError::Decode(format!("invalid XDR: {error}"))
}

fn field_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, SdkError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::Decode(format!("vector is missing string `{key}`")))
}

/// Decodes one vector into `{ transaction, result, events }`.
pub fn decode_vector(vector: &Value) -> Result<Value, SdkError> {
    let envelope = field_str(vector, "transactionEnvelopeXdr")?;
    let (transaction, function) = decode_transaction(envelope)?;

    let result = decode_result(field_str(vector, "resultXdr")?, function)?;

    let mut events = Vec::new();
    if let Some(list) = vector.get("eventsXdr").and_then(Value::as_array) {
        for item in list {
            let encoded = item
                .as_str()
                .ok_or_else(|| SdkError::Decode("eventsXdr must contain base64 strings".into()))?;
            events.push(decode_event(encoded)?);
        }
    }

    Ok(json!({
        "transaction": transaction,
        "result": result,
        "events": events,
    }))
}

fn address_string(address: &ScAddress) -> Result<String, SdkError> {
    match address {
        ScAddress::Contract(id) => Ok(format!("{}", StrkeyContract(id.0 .0))),
        ScAddress::Account(account) => match &account.0 {
            stellar_xdr::PublicKey::PublicKeyTypeEd25519(Uint256(bytes)) => {
                Ok(format!("{}", StrkeyPublicKey(*bytes)))
            }
        },
        other => Err(SdkError::Decode(format!(
            "unsupported address in vector: {other:?}"
        ))),
    }
}

fn muxed_string(account: &MuxedAccount) -> Result<String, SdkError> {
    match account {
        MuxedAccount::Ed25519(Uint256(bytes)) => Ok(format!("{}", StrkeyPublicKey(*bytes))),
        MuxedAccount::MuxedEd25519(muxed) => {
            let Uint256(bytes) = &muxed.ed25519;
            Ok(format!("{}", StrkeyPublicKey(*bytes)))
        }
    }
}

fn decode_transaction(envelope: &str) -> Result<(Value, &'static FunctionSpec), SdkError> {
    let envelope =
        TransactionEnvelope::from_xdr_base64(envelope, Limits::none()).map_err(xdr_error)?;
    let envelope = match envelope {
        TransactionEnvelope::Tx(envelope) => envelope,
        other => {
            return Err(SdkError::Decode(format!(
                "only v1 transaction envelopes are supported, got {other:?}"
            )))
        }
    };
    let tx = envelope.tx;
    let operation = tx
        .operations
        .first()
        .ok_or_else(|| SdkError::Decode("transaction has no operations".into()))?;
    let invoke = match &operation.body {
        OperationBody::InvokeHostFunction(invoke) => invoke,
        other => {
            return Err(SdkError::Decode(format!(
                "expected invokeHostFunction, got {other:?}"
            )))
        }
    };
    let call = match &invoke.host_function {
        HostFunction::InvokeContract(call) => call,
        other => {
            return Err(SdkError::Decode(format!(
                "expected invokeContract, got {other:?}"
            )))
        }
    };

    let function_name = call.function_name.0.to_string();
    let spec = FUNCTIONS
        .iter()
        .find(|candidate| candidate.name == function_name)
        .ok_or_else(|| {
            SdkError::Decode(format!(
                "function `{function_name}` is not part of the spec"
            ))
        })?;

    let mut args = Map::new();
    for (index, name) in spec.arg_names.iter().enumerate() {
        let value = call.args.get(index).ok_or_else(|| {
            SdkError::Decode(format!("`{function_name}` is missing argument #{index}"))
        })?;
        let arg_type = spec.arg_types.get(index).copied().unwrap_or("unknown");
        args.insert(name.to_string(), value_json(value, arg_type)?);
    }

    Ok((
        json!({
            "contract": address_string(&call.contract_address)?,
            "function": function_name,
            "args": args,
            "source": muxed_string(&tx.source_account)?,
            "fee": tx.fee.to_string(),
            "sequence": tx.seq_num.0.to_string(),
            "signatures": envelope.signatures.len(),
        }),
        spec,
    ))
}

fn value_json(value: &ScVal, kind: &str) -> Result<Value, SdkError> {
    match kind {
        "address" => Ok(Value::String(scval_to_address(value)?)),
        "i128" => Ok(Value::String(scval_to_i128(value)?.to_string())),
        "u64" => Ok(Value::String(scval_to_u64(value)?.to_string())),
        "u32" => Ok(Value::String(scval_to_u32(value)?.to_string())),
        "bool" => Ok(Value::Bool(scval_to_bool(value)?)),
        "void" => {
            scval_to_void(value)?;
            Ok(Value::Null)
        }
        "Stream" => Ok(stream_json(&Stream::from_scval(value)?)),
        other if other.starts_with("vec:") => {
            let inner = &other[4..];
            let ScVal::Vec(Some(items)) = value else {
                return Err(SdkError::Decode(format!("expected a vec, got {value:?}")));
            };
            let mut out = Vec::new();
            for item in items.0.iter() {
                out.push(value_json(item, inner)?);
            }
            Ok(Value::Array(out))
        }
        other => Err(SdkError::Decode(format!("unsupported type `{other}`"))),
    }
}

fn stream_json(stream: &Stream) -> Value {
    json!({
        "id": stream.id.to_string(),
        "sender": stream.sender,
        "recipient": stream.recipient,
        "token": stream.token,
        "deposit": stream.deposit.to_string(),
        "withdrawn": stream.withdrawn.to_string(),
        "start_time": stream.start_time.to_string(),
        "end_time": stream.end_time.to_string(),
        "cancelable": stream.cancelable,
        "status": stream.status.as_str(),
        "use_oracle": stream.use_oracle,
    })
}

fn decode_result(encoded: &str, function: &'static FunctionSpec) -> Result<Value, SdkError> {
    let value = ScVal::from_xdr_base64(encoded, Limits::none()).map_err(xdr_error)?;
    if let ScVal::Error(stellar_xdr::ScError::Contract(code)) = &value {
        let name = StreamError::from_code(*code)
            .map(|error| error.name())
            .unwrap_or("UnknownStreamError");
        return Ok(json!({ "error": { "name": name, "code": code } }));
    }
    Ok(json!({ "ok": value_json(&value, function.return_type)? }))
}

fn decode_event(encoded: &str) -> Result<Value, SdkError> {
    let event = ContractEvent::from_xdr_base64(encoded, Limits::none()).map_err(xdr_error)?;
    let contract = event
        .contract_id
        .as_ref()
        .map(|ContractId(hash)| format!("{}", StrkeyContract(hash.0)))
        .ok_or_else(|| SdkError::Decode("event has no contract id".into()))?;

    let decoded = Event::decode(&event)?
        .ok_or_else(|| SdkError::Decode("event is not part of the StreamPay interface".into()))?;

    let (name, topics, data) = match decoded {
        Event::StreamCreated(event) => (
            "StreamCreated",
            json!({ "stream_id": event.stream_id.to_string() }),
            json!({
                "sender": event.sender,
                "recipient": event.recipient,
                "token": event.token,
                "deposit": event.deposit.to_string(),
                "start_time": event.start_time.to_string(),
                "end_time": event.end_time.to_string(),
                "cancelable": event.cancelable,
            }),
        ),
        Event::Withdrawn(event) => (
            "Withdrawn",
            json!({ "stream_id": event.stream_id.to_string() }),
            json!({
                "recipient": event.recipient,
                "amount": event.amount.to_string(),
                "withdrawn_total": event.withdrawn_total.to_string(),
            }),
        ),
        Event::StreamCancelled(event) => (
            "StreamCancelled",
            json!({ "stream_id": event.stream_id.to_string() }),
            json!({
                "cancelled_by": event.cancelled_by,
                "recipient_amount": event.recipient_amount.to_string(),
                "sender_amount": event.sender_amount.to_string(),
            }),
        ),
        Event::StreamToppedUp(event) => (
            "StreamToppedUp",
            json!({ "stream_id": event.stream_id.to_string() }),
            json!({
                "sender": event.sender,
                "amount": event.amount.to_string(),
                "new_deposit": event.new_deposit.to_string(),
            }),
        ),
    };

    Ok(json!({
        "contract": contract,
        "name": name,
        "topics": topics,
        "data": data,
    }))
}

/// Convenience wrapper used by the conformance runner.
pub fn decode_vector_str(json_text: &str) -> Result<Value, SdkError> {
    let vector: Value = serde_json::from_str(json_text)
        .map_err(|error| SdkError::Decode(format!("invalid vector JSON: {error}")))?;
    decode_vector(&vector)
}

/// Returns the typed field map of a `Stream` result (handy for SDK users who
/// already have a decoded `ScVal`). Kept here so `Stream` stays generated.
pub fn stream_fields(stream: &Stream) -> Result<Map<String, Value>, SdkError> {
    let mut fields = Map::new();
    fields.insert("id".into(), Value::String(stream.id.to_string()));
    fields.insert("sender".into(), Value::String(stream.sender.clone()));
    fields.insert("recipient".into(), Value::String(stream.recipient.clone()));
    fields.insert("token".into(), Value::String(stream.token.clone()));
    fields.insert("deposit".into(), Value::String(stream.deposit.to_string()));
    fields.insert(
        "withdrawn".into(),
        Value::String(stream.withdrawn.to_string()),
    );
    fields.insert(
        "start_time".into(),
        Value::String(stream.start_time.to_string()),
    );
    fields.insert(
        "end_time".into(),
        Value::String(stream.end_time.to_string()),
    );
    fields.insert("cancelable".into(), Value::Bool(stream.cancelable));
    fields.insert(
        "status".into(),
        Value::String(stream.status.as_str().into()),
    );
    Ok(fields)
}
