//! Read-only StreamPay client for mobile hosts.
//!
//! UniFFI generates the Kotlin and Swift language surfaces from
//! `src/streampay.udl`. The host owns networking and keys:
//!
//! * [`RpcReadTransport`] is the only way this crate reaches the network. A
//!   Kotlin or Swift adapter simulates the given contract call and returns the
//!   base64 `ScVal` result. The SDK never signs, never submits and never sees a
//!   secret key.
//! * Calls are synchronous because UniFFI callback interfaces are synchronous.
//!   Hosts must call them off the main/UI thread and own the async boundary.
//! * Contract errors become typed UniFFI exceptions, one per catalog code.

uniffi::include_scaffolding!("streampay");

mod error_catalog;

pub use error_catalog::StreamPayError;

use stellar_xdr::{Limits, ReadXdr, ScError, ScVal};
use streampay_sdk::{
    decode_available_result, decode_get_stream_result, decode_recipient_streams_result,
    decode_sender_streams_result, Stream, StreamStatus as SdkStreamStatus,
};

/// A stream as the mobile UI needs it. `i128` amounts stay decimal strings so
/// no 64-bit bridge can silently truncate a token balance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamView {
    pub id: u64,
    pub sender: String,
    pub recipient: String,
    pub token: String,
    pub deposit: String,
    pub withdrawn: String,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
    pub status: StreamStatus,
    pub use_oracle: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamStatus {
    Active,
    Cancelled,
    Depleted,
}

impl From<SdkStreamStatus> for StreamStatus {
    fn from(status: SdkStreamStatus) -> Self {
        match status {
            SdkStreamStatus::Active => Self::Active,
            SdkStreamStatus::Cancelled => Self::Cancelled,
            SdkStreamStatus::Depleted => Self::Depleted,
        }
    }
}

impl From<Stream> for StreamView {
    fn from(stream: Stream) -> Self {
        Self {
            id: stream.id,
            sender: stream.sender,
            recipient: stream.recipient,
            token: stream.token,
            deposit: stream.deposit.to_string(),
            withdrawn: stream.withdrawn.to_string(),
            start_time: stream.start_time,
            end_time: stream.end_time,
            cancelable: stream.cancelable,
            status: stream.status.into(),
            use_oracle: stream.use_oracle,
        }
    }
}

impl StreamView {
    /// Canonical JSON used by the host-side conformance runner.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id.to_string(),
            "sender": self.sender,
            "recipient": self.recipient,
            "token": self.token,
            "deposit": self.deposit,
            "withdrawn": self.withdrawn,
            "start_time": self.start_time.to_string(),
            "end_time": self.end_time.to_string(),
            "cancelable": self.cancelable,
            "status": match self.status {
                StreamStatus::Active => "Active",
                StreamStatus::Cancelled => "Cancelled",
                StreamStatus::Depleted => "Depleted",
            },
            "use_oracle": self.use_oracle,
        })
    }
}

/// The host's simulation adapter. Implementations must be thread-safe because
/// UniFFI may call them from any worker thread.
pub trait RpcReadTransport: Send + Sync {
    fn simulate(
        &self,
        contract_id: String,
        function_name: String,
        args_json: String,
    ) -> Result<String, StreamPayError>;
}

/// One deployed StreamPay contract, read through a host transport.
pub struct StreamPayMobile {
    contract_id: String,
    transport: Box<dyn RpcReadTransport>,
}

impl StreamPayMobile {
    pub fn new(contract_id: String, transport: Box<dyn RpcReadTransport>) -> Self {
        Self {
            contract_id,
            transport,
        }
    }

    fn call(&self, function: &str, args: serde_json::Value) -> Result<ScVal, StreamPayError> {
        let encoded = self.transport.simulate(
            self.contract_id.clone(),
            function.to_string(),
            args.to_string(),
        )?;
        let value = ScVal::from_xdr_base64(&encoded, Limits::none())
            .map_err(|_| StreamPayError::Decode)?;
        if let ScVal::Error(ScError::Contract(code)) = &value {
            return Err(StreamPayError::from_code(
                u16::try_from(*code).unwrap_or(u16::MAX),
            ));
        }
        Ok(value)
    }

    pub fn get_stream(&self, stream_id: u64) -> Result<StreamView, StreamPayError> {
        let value = self.call(
            "get_stream",
            serde_json::json!({ "stream_id": stream_id.to_string() }),
        )?;
        decode_get_stream_result(&value)
            .map(StreamView::from)
            .map_err(|_| StreamPayError::Decode)
    }

    pub fn available(&self, stream_id: u64) -> Result<String, StreamPayError> {
        let value = self.call(
            "available",
            serde_json::json!({ "stream_id": stream_id.to_string() }),
        )?;
        decode_available_result(&value)
            .map(|amount| amount.to_string())
            .map_err(|_| StreamPayError::Decode)
    }

    pub fn recipient_streams(
        &self,
        recipient: String,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<u64>, StreamPayError> {
        let value = self.call(
            "recipient_streams",
            serde_json::json!({
                "recipient": recipient,
                "offset": offset,
                "limit": limit,
            }),
        )?;
        decode_recipient_streams_result(&value).map_err(|_| StreamPayError::Decode)
    }

    pub fn sender_streams(
        &self,
        sender: String,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<u64>, StreamPayError> {
        let value = self.call(
            "sender_streams",
            serde_json::json!({
                "sender": sender,
                "offset": offset,
                "limit": limit,
            }),
        )?;
        decode_sender_streams_result(&value).map_err(|_| StreamPayError::Decode)
    }

    /// Decodes a raw simulation result without a transport. Useful when the
    /// host already owns an RPC session and only needs typed decoding.
    pub fn decode_get_stream(&self, result_xdr: String) -> Result<StreamView, StreamPayError> {
        let value =
            ScVal::from_xdr_base64(&result_xdr, Limits::none()).map_err(|_| StreamPayError::Decode)?;
        if let ScVal::Error(ScError::Contract(code)) = &value {
            return Err(StreamPayError::from_code(
                u16::try_from(*code).unwrap_or(u16::MAX),
            ));
        }
        decode_get_stream_result(&value)
            .map(StreamView::from)
            .map_err(|_| StreamPayError::Decode)
    }
}

pub fn spec_fingerprint() -> String {
    streampay_sdk::SPEC_FINGERPRINT.to_string()
}
