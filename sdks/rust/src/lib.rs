#![forbid(unsafe_code)]
//! # StreamPay SDK (Rust)
//!
//! Typed bindings for the StreamPay Soroban contract, generated from
//! `sdks/spec/streampay.spec.json`: entrypoint argument encoding, result
//! decoding, contract-event decoding, and index pagination helpers.
//!
//! The client is transport-agnostic. Implement [`Transport`] on top of the
//! Stellar RPC client (or a test double) and every generated entrypoint
//! becomes available with typed arguments and results:
//!
//! ```no_run
//! use streampay_sdk::{Client, SdkError, Transport};
//! use stellar_xdr::ScVal;
//!
//! struct MyRpc;
//! impl Transport for MyRpc {
//!     fn invoke(&self, contract: &str, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError> {
//!         // build, sign, submit, and return the contract's return value
//!         # let _ = (contract, method, args);
//!         todo!()
//!     }
//!     fn simulate(&self, contract: &str, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError> {
//!         # let _ = (contract, method, args);
//!         todo!()
//!     }
//! }
//!
//! let client = Client::new("C...", MyRpc);
//! let available = client.available(1).unwrap();
//! ```
//!
//! Anything not generated is a deliberately small runtime: value conversions,
//! the [`Transport`] trait, pagination, and conformance-vector decoding.

mod generated;
pub mod vectors;

pub use generated::*;

use std::collections::BTreeMap;
use std::fmt;

use stellar_strkey::ed25519::PublicKey as StrkeyPublicKey;
use stellar_strkey::Contract as StrkeyContract;
use stellar_xdr::{
    AccountId, ContractId, Hash, Int128Parts, PublicKey, ScAddress, ScError, ScVal, Uint256,
};

/// Anything that can execute a contract call for this client.
pub trait Transport {
    /// Executes a state-changing entrypoint and returns its raw return value.
    fn invoke(&self, contract_id: &str, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError>;

    /// Simulates a read-only entrypoint and returns its raw return value.
    fn simulate(
        &self,
        contract_id: &str,
        method: &str,
        args: Vec<ScVal>,
    ) -> Result<ScVal, SdkError>;
}

/// Errors surfaced by the SDK.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SdkError {
    /// The transport failed (RPC, signing, submission, or polling).
    Transport(String),
    /// A value did not have the shape the spec requires.
    Decode(String),
    /// The contract returned a typed [`StreamError`].
    Contract(StreamError),
    /// The operation is not supported by this build of the SDK.
    Unsupported(String),
}

impl fmt::Display for SdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(message) => write!(f, "transport error: {message}"),
            Self::Decode(message) => write!(f, "decode error: {message}"),
            Self::Contract(error) => {
                write!(f, "contract error: {} (#{})", error.name(), error.code())
            }
            Self::Unsupported(message) => write!(f, "unsupported: {message}"),
        }
    }
}

impl std::error::Error for SdkError {}

/// A typed client for one deployed StreamPay contract.
pub struct Client<'a, T: Transport> {
    contract_id: &'a str,
    transport: T,
}

impl<'a, T: Transport> Client<'a, T> {
    pub fn new(contract_id: &'a str, transport: T) -> Self {
        Self {
            contract_id,
            transport,
        }
    }

    pub fn contract_id(&self) -> &'a str {
        self.contract_id
    }

    /// Executes a mutating entrypoint, mapping contract errors to
    /// [`SdkError::Contract`].
    pub fn invoke(&self, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError> {
        let value = self.transport.invoke(self.contract_id, method, args)?;
        unwrap_contract_error(value)
    }

    /// Simulates a read-only entrypoint, mapping contract errors to
    /// [`SdkError::Contract`].
    pub fn simulate(&self, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError> {
        let value = self.transport.simulate(self.contract_id, method, args)?;
        unwrap_contract_error(value)
    }

    /// Every stream id for `address`, following the on-chain index pages until
    /// the last partial page. Pages are requested at [`MAX_PAGE_SIZE`].
    pub fn stream_ids(&self, role: Role, address: &str) -> Result<Vec<u64>, SdkError> {
        let mut ids = Vec::new();
        let mut offset: u32 = 0;
        loop {
            let page = match role {
                Role::Sender => self.sender_streams(address, offset, MAX_PAGE_SIZE)?,
                Role::Recipient => self.recipient_streams(address, offset, MAX_PAGE_SIZE)?,
            };
            let fetched = page.len() as u32;
            ids.extend(page);
            if fetched < MAX_PAGE_SIZE {
                break;
            }
            offset = offset.saturating_add(MAX_PAGE_SIZE);
        }
        Ok(ids)
    }

    /// Loads every stream for `address` through the index views, skipping ids
    /// that disappeared between the index read and the state read.
    pub fn streams_for(&self, role: Role, address: &str) -> Result<Vec<Stream>, SdkError> {
        let mut streams = Vec::new();
        for id in self.stream_ids(role, address)? {
            match self.get_stream(id) {
                Ok(stream) => streams.push(stream),
                Err(SdkError::Contract(StreamError::StreamNotFound)) => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(streams)
    }

    /// Decodes contract events, discarding events not emitted by StreamPay's
    /// contract interface.
    pub fn decode_events(
        &self,
        events: impl IntoIterator<Item = stellar_xdr::ContractEvent>,
    ) -> Result<Vec<Event>, SdkError> {
        let mut decoded = Vec::new();
        for event in events {
            if let Some(event) = Event::decode(&event)? {
                decoded.push(event);
            }
        }
        Ok(decoded)
    }
}

fn unwrap_contract_error(value: ScVal) -> Result<ScVal, SdkError> {
    if let ScVal::Error(ScError::Contract(code)) = &value {
        if let Some(error) = StreamError::from_code(*code) {
            return Err(SdkError::Contract(error));
        }
    }
    Ok(value)
}

/// Which on-chain index to page through.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Role {
    Sender,
    Recipient,
}

// --------------------------------------------------------------------------- //
// ScVal conversions                                                           //
// --------------------------------------------------------------------------- //

/// Encodes a `G…` account or `C…` contract strkey as an address ScVal.
pub fn address_scval(value: &str) -> Result<ScVal, SdkError> {
    if value.starts_with('C') {
        let contract: StrkeyContract = value.parse().map_err(|error| {
            SdkError::Decode(format!("invalid contract address {value}: {error:?}"))
        })?;
        return Ok(ScVal::Address(ScAddress::Contract(ContractId(Hash(
            contract.0,
        )))));
    }
    if value.starts_with('G') {
        let key: StrkeyPublicKey = value.parse().map_err(|error| {
            SdkError::Decode(format!("invalid account address {value}: {error:?}"))
        })?;
        return Ok(ScVal::Address(ScAddress::Account(AccountId(
            PublicKey::PublicKeyTypeEd25519(Uint256(key.0)),
        ))));
    }
    Err(SdkError::Decode(format!(
        "address must be a G… account or C… contract, got {value}"
    )))
}

pub fn scval_to_address(value: &ScVal) -> Result<String, SdkError> {
    match value {
        ScVal::Address(ScAddress::Contract(id)) => Ok(format!("{}", StrkeyContract(id.0 .0))),
        ScVal::Address(ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(
            Uint256(bytes),
        )))) => Ok(format!("{}", StrkeyPublicKey(*bytes))),
        other => Err(SdkError::Decode(format!(
            "expected an address, got {other:?}"
        ))),
    }
}

pub fn scval_u32(value: u32) -> ScVal {
    ScVal::U32(value)
}

pub fn scval_to_u32(value: &ScVal) -> Result<u32, SdkError> {
    match value {
        ScVal::U32(value) => Ok(*value),
        other => Err(SdkError::Decode(format!("expected u32, got {other:?}"))),
    }
}

pub fn scval_u64(value: u64) -> ScVal {
    ScVal::U64(value)
}

pub fn scval_to_u64(value: &ScVal) -> Result<u64, SdkError> {
    match value {
        ScVal::U64(value) => Ok(*value),
        other => Err(SdkError::Decode(format!("expected u64, got {other:?}"))),
    }
}

pub fn scval_i128(value: i128) -> ScVal {
    ScVal::I128(Int128Parts {
        hi: (value >> 64) as i64,
        lo: value as u64,
    })
}

pub fn scval_to_i128(value: &ScVal) -> Result<i128, SdkError> {
    let decimal = match value {
        ScVal::I128(parts) => parts.to_string(),
        ScVal::U64(value) => value.to_string(),
        ScVal::I64(value) => value.to_string(),
        other => return Err(SdkError::Decode(format!("expected an i128, got {other:?}"))),
    };
    decimal
        .parse::<i128>()
        .map_err(|error| SdkError::Decode(format!("invalid i128 {decimal}: {error}")))
}

pub fn scval_bool(value: bool) -> ScVal {
    ScVal::Bool(value)
}

pub fn scval_to_bool(value: &ScVal) -> Result<bool, SdkError> {
    match value {
        ScVal::Bool(value) => Ok(*value),
        other => Err(SdkError::Decode(format!("expected bool, got {other:?}"))),
    }
}

pub fn scval_to_void(value: &ScVal) -> Result<(), SdkError> {
    match value {
        ScVal::Void => Ok(()),
        other => Err(SdkError::Decode(format!("expected void, got {other:?}"))),
    }
}

/// Flattens a contract-type map (`ScVal::Map` with symbol keys) into fields.
pub fn scval_to_struct(value: &ScVal) -> Result<BTreeMap<String, ScVal>, SdkError> {
    let ScVal::Map(Some(map)) = value else {
        return Err(SdkError::Decode(format!(
            "expected a struct map, got {value:?}"
        )));
    };
    let mut fields = BTreeMap::new();
    for entry in map.0.iter() {
        let ScVal::Symbol(key) = &entry.key else {
            return Err(SdkError::Decode(
                "struct map keys must be symbols".to_string(),
            ));
        };
        fields.insert(key.0.to_string(), entry.val.clone());
    }
    Ok(fields)
}
