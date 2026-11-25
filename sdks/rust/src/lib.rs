//! Read-only StreamPay client for the Soroban contract.
//!
//! This crate is generated from [`sdks/spec/streampay.spec.json`] by
//! `sdks/generator/emit_rust.py`. It exposes the contract's read operations,
//! their typed arguments and return values, and the canonical contract error
//! enum. Writes are deliberately out of scope: there is no transaction
//! building, signing or submission code here.
//!
//! [`ReadClient`] is transport-agnostic. Implement [`ReadTransport`] over a
//! Soroban RPC `simulateTransaction` call (or over a fixed map in tests), and
//! every generated read method becomes available with a typed result:
//!
//! ```no_run
//! use stellar_xdr::ScVal;
//! use streampay_sdk::{ReadClient, ReadTransport};
//!
//! struct Rpc;
//!
//! impl ReadTransport for Rpc {
//!     type Error = std::io::Error;
//!
//!     fn simulate(&self, method: &str, args: Vec<ScVal>) -> Result<ScVal, Self::Error> {
//!         // call soroban-rpc simulateTransaction with `method`/`args`
//!         # let _ = (method, args);
//!         # Err(std::io::Error::other("unimplemented"))
//!     }
//! }
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let client = ReadClient::new(Rpc);
//! let stream = client.get_stream(1)?;
//! println!("{} {} {:?}", stream.id, stream.deposit, stream.status);
//! # Ok(())
//! # }
//! ```
//!
//! Decoders and request builders are also exported individually
//! (`decode_get_stream_result`, `get_stream_args`, …) for callers that already
//! have an `ScVal` result and do not want a client wrapper.

#![forbid(unsafe_code)]

use stellar_strkey::{ed25519, Strkey};
use stellar_xdr::{AccountId, ContractId, Hash, PublicKey, ScAddress, ScError, ScVal, Uint256};

mod generated;
pub mod vectors;

pub use generated::*;

/// Simulates one read-only contract invocation and returns the result `ScVal`.
///
/// Implementations talk to whatever RPC, cache or fixture source they like;
/// this crate makes no network calls itself and never signs anything.
pub trait ReadTransport {
    /// Transport-specific failure (HTTP, JSON-RPC, XDR, …).
    type Error;

    /// Simulates `method(args)` against the configured contract.
    fn simulate(&self, method: &str, args: Vec<ScVal>) -> Result<ScVal, Self::Error>;
}

/// Failure to encode a read argument as `ScVal`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// A request argument was not a valid StrKey `G…`/`C…` address.
    InvalidAddress { value: String },
}

impl core::fmt::Display for EncodeError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::InvalidAddress { value } => {
                write!(formatter, "invalid address: {value}")
            }
        }
    }
}

impl std::error::Error for EncodeError {}

/// Failure to decode a contract result `ScVal` into its typed form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// A required struct field or union tag was absent.
    MissingField { context: String },
    /// The `ScVal` had the wrong shape for the expected type.
    Unexpected {
        context: String,
        expected: &'static str,
        found: &'static str,
    },
    /// A fixed-width byte field had the wrong length.
    InvalidLength {
        context: String,
        expected: usize,
        found: usize,
    },
    /// A unit enum carried a case the spec does not declare.
    UnknownEnumCase { context: String, tag: String },
    /// A payload enum carried the wrong number of values.
    UnionArity {
        context: String,
        expected: usize,
        found: usize,
    },
    /// The contract returned a known `StreamError`.
    Contract(StreamError),
    /// The contract returned an error code outside the catalog.
    UnknownContractError(u32),
}

impl DecodeError {
    pub(crate) fn missing(context: impl Into<String>) -> Self {
        Self::MissingField {
            context: context.into(),
        }
    }

    pub(crate) fn unexpected(
        context: impl Into<String>,
        expected: &'static str,
        found: &ScVal,
    ) -> Self {
        Self::Unexpected {
            context: context.into(),
            expected,
            found: scval_kind(found),
        }
    }

    pub(crate) fn unknown_case(context: impl Into<String>, tag: impl Into<String>) -> Self {
        Self::UnknownEnumCase {
            context: context.into(),
            tag: tag.into(),
        }
    }

    pub(crate) fn union_arity(context: impl Into<String>, expected: usize, found: usize) -> Self {
        Self::UnionArity {
            context: context.into(),
            expected,
            found,
        }
    }
}

impl core::fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::MissingField { context } => write!(formatter, "missing field {context}"),
            Self::Unexpected {
                context,
                expected,
                found,
            } => write!(
                formatter,
                "{context}: expected {expected}, found {found}"
            ),
            Self::InvalidLength {
                context,
                expected,
                found,
            } => write!(
                formatter,
                "{context}: expected {expected} bytes, found {found}"
            ),
            Self::UnknownEnumCase { context, tag } => {
                write!(formatter, "unknown {context} case: {tag}")
            }
            Self::UnionArity {
                context,
                expected,
                found,
            } => write!(
                formatter,
                "{context}: expected {expected} values, found {found}"
            ),
            Self::Contract(error) => write!(formatter, "contract error: {error}"),
            Self::UnknownContractError(code) => {
                write!(formatter, "unknown contract error code {code}")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

/// A failed read: transport, request encoding, or result decoding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallError<E> {
    /// The transport could not simulate the call.
    Transport(E),
    /// A request argument could not be encoded.
    Encode(EncodeError),
    /// The returned `ScVal` (or contract error) could not be decoded.
    Decode(DecodeError),
}

impl<E> From<EncodeError> for CallError<E> {
    fn from(error: EncodeError) -> Self {
        Self::Encode(error)
    }
}

impl<E> From<DecodeError> for CallError<E> {
    fn from(error: DecodeError) -> Self {
        Self::Decode(error)
    }
}

impl<E: core::fmt::Display> core::fmt::Display for CallError<E> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Transport(error) => write!(formatter, "transport error: {error}"),
            Self::Encode(error) => write!(formatter, "{error}"),
            Self::Decode(error) => write!(formatter, "{error}"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for CallError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Encode(error) => Some(error),
            Self::Decode(error) => Some(error),
        }
    }
}

// --------------------------------------------------------------------------- //
// ScVal helpers shared by the generated codecs                               //
// --------------------------------------------------------------------------- //

/// Returns the contract error encoded in `value`, if it is an `ScVal::Error`.
///
/// `Some(Err(code))` means the contract failed with a code outside the
/// canonical catalog; callers should surface it rather than decode the payload.
pub fn decode_contract_error(value: &ScVal) -> Option<Result<StreamError, u32>> {
    match value {
        ScVal::Error(ScError::Contract(code)) => Some(match StreamError::from_code(*code) {
            Some(error) => Ok(error),
            None => Err(*code),
        }),
        _ => None,
    }
}

pub(crate) fn reject_contract_error(value: &ScVal) -> Result<(), DecodeError> {
    match decode_contract_error(value) {
        Some(Ok(error)) => Err(DecodeError::Contract(error)),
        Some(Err(code)) => Err(DecodeError::UnknownContractError(code)),
        None => Ok(()),
    }
}

pub(crate) fn scval_kind(value: &ScVal) -> &'static str {
    match value {
        ScVal::Void => "void",
        ScVal::Bool(_) => "bool",
        ScVal::Error(_) => "error",
        ScVal::U32(_) => "u32",
        ScVal::I32(_) => "i32",
        ScVal::U64(_) => "u64",
        ScVal::I64(_) => "i64",
        ScVal::Timepoint(_) => "timepoint",
        ScVal::Duration(_) => "duration",
        ScVal::U128(_) => "u128",
        ScVal::I128(_) => "i128",
        ScVal::U256(_) => "u256",
        ScVal::I256(_) => "i256",
        ScVal::Bytes(_) => "bytes",
        ScVal::String(_) => "string",
        ScVal::Symbol(_) => "symbol",
        ScVal::Vec(_) => "vec",
        ScVal::Map(_) => "map",
        ScVal::Address(_) => "address",
        _ => "other",
    }
}

pub(crate) fn scval_bool(value: &ScVal, context: &str) -> Result<bool, DecodeError> {
    match value {
        ScVal::Bool(inner) => Ok(*inner),
        other => Err(DecodeError::unexpected(context, "bool", other)),
    }
}

pub(crate) fn scval_u32(value: &ScVal, context: &str) -> Result<u32, DecodeError> {
    match value {
        ScVal::U32(inner) => Ok(*inner),
        other => Err(DecodeError::unexpected(context, "u32", other)),
    }
}

#[allow(dead_code)] // codec kept for spec types a future read may add
pub(crate) fn scval_i32(value: &ScVal, context: &str) -> Result<i32, DecodeError> {
    match value {
        ScVal::I32(inner) => Ok(*inner),
        other => Err(DecodeError::unexpected(context, "i32", other)),
    }
}

pub(crate) fn scval_u64(value: &ScVal, context: &str) -> Result<u64, DecodeError> {
    match value {
        ScVal::U64(inner) => Ok(*inner),
        ScVal::U32(inner) => Ok(u64::from(*inner)),
        other => Err(DecodeError::unexpected(context, "u64", other)),
    }
}

pub(crate) fn scval_i128(value: &ScVal, context: &str) -> Result<i128, DecodeError> {
    match value {
        ScVal::I128(parts) => Ok(((parts.hi as i128) << 64) | (parts.lo as i128)),
        ScVal::U64(inner) => Ok(i128::from(*inner)),
        ScVal::U32(inner) => Ok(i128::from(*inner)),
        other => Err(DecodeError::unexpected(context, "i128", other)),
    }
}

#[allow(dead_code)] // codec kept for spec types a future read may add
pub(crate) fn scval_u128(value: &ScVal, context: &str) -> Result<u128, DecodeError> {
    match value {
        ScVal::U128(parts) => Ok((u128::from(parts.hi) << 64) | u128::from(parts.lo)),
        ScVal::U64(inner) => Ok(u128::from(*inner)),
        ScVal::U32(inner) => Ok(u128::from(*inner)),
        other => Err(DecodeError::unexpected(context, "u128", other)),
    }
}

#[allow(dead_code)] // codec kept for spec types a future read may add
pub(crate) fn scval_string(value: &ScVal, context: &str) -> Result<String, DecodeError> {
    match value {
        ScVal::String(inner) => Ok(inner.0.to_utf8_string_lossy()),
        other => Err(DecodeError::unexpected(context, "string", other)),
    }
}

#[allow(dead_code)] // codec kept for spec types a future read may add
pub(crate) fn scval_symbol(value: &ScVal, context: &str) -> Result<String, DecodeError> {
    match value {
        ScVal::Symbol(inner) => Ok(inner.0.to_utf8_string_lossy()),
        other => Err(DecodeError::unexpected(context, "symbol", other)),
    }
}

#[allow(dead_code)] // codec kept for spec types a future read may add
pub(crate) fn scval_void(value: &ScVal, context: &str) -> Result<(), DecodeError> {
    match value {
        ScVal::Void => Ok(()),
        other => Err(DecodeError::unexpected(context, "void", other)),
    }
}

fn fixed_bytes<const N: usize>(value: &ScVal, context: &str) -> Result<[u8; N], DecodeError> {
    match value {
        ScVal::Bytes(bytes) => {
            let bytes = bytes.as_slice();
            if bytes.len() != N {
                return Err(DecodeError::InvalidLength {
                    context: context.to_string(),
                    expected: N,
                    found: bytes.len(),
                });
            }
            let mut out = [0u8; N];
            out.copy_from_slice(bytes);
            Ok(out)
        }
        other => Err(DecodeError::unexpected(context, "bytes", other)),
    }
}

pub(crate) fn scval_bytes32(value: &ScVal, context: &str) -> Result<[u8; 32], DecodeError> {
    fixed_bytes::<32>(value, context)
}

#[allow(dead_code)] // codec kept for spec types a future read may add
pub(crate) fn scval_bytes64(value: &ScVal, context: &str) -> Result<[u8; 64], DecodeError> {
    fixed_bytes::<64>(value, context)
}

/// Decodes a decoded address as its StrKey `G…`/`C…` string.
pub(crate) fn address_from_scval(value: &ScVal, context: &str) -> Result<String, DecodeError> {
    match value {
        ScVal::Address(ScAddress::Account(account)) => {
            let bytes = match &account.0 {
                PublicKey::PublicKeyTypeEd25519(Uint256(bytes)) => *bytes,
                #[allow(unreachable_patterns)]
                _ => return Err(DecodeError::unexpected(context, "ed25519 account", value)),
            };
            Ok(Strkey::PublicKeyEd25519(ed25519::PublicKey(bytes))
                .to_string()
                .to_string())
        }
        ScVal::Address(ScAddress::Contract(ContractId(Hash(bytes)))) => {
            Ok(Strkey::Contract(stellar_strkey::Contract(*bytes))
                .to_string()
                .to_string())
        }
        other => Err(DecodeError::unexpected(context, "address", other)),
    }
}

/// Encodes a StrKey `G…`/`C…` address as `ScVal::Address`.
pub fn address_to_scval(value: &str) -> Result<ScVal, EncodeError> {
    match Strkey::from_string(value) {
        Ok(Strkey::PublicKeyEd25519(key)) => Ok(ScVal::Address(ScAddress::Account(AccountId(
            PublicKey::PublicKeyTypeEd25519(Uint256(key.0)),
        )))),
        Ok(Strkey::Contract(contract)) => Ok(ScVal::Address(ScAddress::Contract(ContractId(Hash(
            contract.0,
        ))))),
        _ => Err(EncodeError::InvalidAddress {
            value: value.to_string(),
        }),
    }
}

pub(crate) fn decode_option<T>(
    value: &ScVal,
    _context: &str,
    decode: impl Fn(&ScVal) -> Result<T, DecodeError>,
) -> Result<Option<T>, DecodeError> {
    match value {
        ScVal::Void => Ok(None),
        other => Ok(Some(decode(other)?)),
    }
}

pub(crate) fn decode_vec<T>(
    value: &ScVal,
    context: &str,
    decode: impl Fn(&ScVal) -> Result<T, DecodeError>,
) -> Result<Vec<T>, DecodeError> {
    match value {
        ScVal::Vec(Some(items)) => items.iter().map(decode).collect(),
        other => Err(DecodeError::unexpected(context, "vec", other)),
    }
}

/// Returns a contract struct's `(field name, value)` map entries.
pub(crate) fn struct_fields<'a>(
    value: &'a ScVal,
    context: &str,
) -> Result<Vec<(String, &'a ScVal)>, DecodeError> {
    match value {
        ScVal::Map(Some(entries)) => entries
            .iter()
            .map(|entry| {
                let key = match &entry.key {
                    ScVal::Symbol(symbol) => symbol.0.to_utf8_string_lossy(),
                    other => {
                        return Err(DecodeError::unexpected(context, "symbol map key", other));
                    }
                };
                Ok((key, &entry.val))
            })
            .collect(),
        other => Err(DecodeError::unexpected(context, "map", other)),
    }
}

/// Looks up a required field in a decoded struct map.
pub(crate) fn field<'a>(
    fields: &[(String, &'a ScVal)],
    name: &str,
    context: &str,
) -> Result<&'a ScVal, DecodeError> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| *value)
        .ok_or_else(|| DecodeError::missing(format!("{context}.{name}")))
}

/// Decodes a struct field that is optional on the wire: an absent key or
/// `ScVal::Void` decodes as `None` (older records omit appended fields).
pub(crate) fn decode_optional_field<T>(
    fields: &[(String, &ScVal)],
    name: &str,
    context: &str,
    decode: impl Fn(&ScVal) -> Result<T, DecodeError>,
) -> Result<Option<T>, DecodeError> {
    let _ = context;
    match fields.iter().find(|(key, _)| key == name) {
        None | Some((_, ScVal::Void)) => Ok(None),
        Some((_, value)) => Ok(Some(decode(value)?)),
    }
}
