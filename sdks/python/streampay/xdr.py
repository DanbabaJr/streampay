"""Dependency-free Stellar XDR for the values StreamPay uses.

Scope, deliberately:

* Soroban ``ScVal`` values (the full set the contract emits and accepts)
* ``ContractEvent`` (RPC ``getEvents`` returns these as base64 XDR)
* Soroban invoke transactions (unsigned envelopes, for simulation)
* strkey G…/C… addresses

Not supported: fee-bump envelopes, other operation types, and transaction
extensions carrying pre-assembled Soroban transaction data. Those raise
``XdrError`` instead of returning partial data.

This module exists so the Python SDK has no runtime dependency; the cross
language conformance suite exercises it against the same vectors as the Rust
and TypeScript SDKs.
"""
from __future__ import annotations

import base64
import struct
from dataclasses import dataclass
from typing import Any

__all__ = [
    "ContractEvent",
    "Invocation",
    "ScVal",
    "XdrError",
    "address_to_scval",
    "build_invoke_envelope",
    "i128_to_scval",
    "native",
    "read_contract_event_b64",
    "read_envelope_b64",
    "read_scval_b64",
    "scval_to_address",
    "scval_to_bool",
    "scval_to_i128",
    "scval_to_struct",
    "scval_to_u32",
    "scval_to_u64",
    "u32_to_scval",
    "u64_to_scval",
]


class XdrError(ValueError):
    """Raised when XDR is malformed or outside the supported subset."""


# --------------------------------------------------------------------------- #
# strkey                                                                      #
# --------------------------------------------------------------------------- #

_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_VERSION_ACCOUNT = 6 << 3
_VERSION_CONTRACT = 2 << 3


def _crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def _strkey_encode(version: int, payload: bytes) -> str:
    body = bytes([version]) + payload
    body += _crc16_xmodem(body).to_bytes(2, "little")
    return base64.b32encode(body).decode("ascii").rstrip("=")


def _strkey_decode(value: str) -> bytes:
    padding = "=" * ((8 - len(value) % 8) % 8)
    try:
        raw = base64.b32decode(value + padding)
    except Exception as error:  # noqa: BLE001 - surfaced as XdrError
        raise XdrError(f"invalid strkey {value}: {error}") from error
    if len(raw) < 3:
        raise XdrError(f"strkey {value} is too short")
    body, checksum = raw[:-2], int.from_bytes(raw[-2:], "little")
    if _crc16_xmodem(body) != checksum:
        raise XdrError(f"strkey {value} has a bad checksum")
    version = body[0]
    if version not in (_VERSION_ACCOUNT, _VERSION_CONTRACT):
        raise XdrError(f"unsupported strkey version {version} in {value}")
    if len(body) != 33:
        raise XdrError(f"strkey {value} must carry 32 bytes")
    return body[1:]


def _is_contract(address: str) -> bool:
    return address.startswith("C")


def _address_bytes(address: str) -> bytes:
    payload = _strkey_decode(address)
    return payload


def _address_from_bytes(version: int, payload: bytes) -> str:
    return _strkey_encode(version, payload)


# --------------------------------------------------------------------------- #
# ScVal model                                                                 #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ScVal:
    """A decoded Soroban value.

    ``kind`` is one of ``bool``, ``void``, ``error``, ``u32``, ``i32``,
    ``u64``, ``i64``, ``u128``, ``i128``, ``symbol``, ``string``, ``bytes``,
    ``address``, ``vec``, ``map``. Integer kinds hold ``int``; addresses hold
    their strkey; maps hold a list of ``(key, value)`` pairs.
    """

    kind: str
    value: Any = None


_TRUE = ScVal("bool", True)
_FALSE = ScVal("bool", False)


def bool_to_scval(value: bool) -> ScVal:
    return _TRUE if value else _FALSE


def u32_to_scval(value: int) -> ScVal:
    return ScVal("u32", int(value))


def u64_to_scval(value: int) -> ScVal:
    return ScVal("u64", int(value))


def i128_to_scval(value: int) -> ScVal:
    return ScVal("i128", int(value))


def address_to_scval(address: str) -> ScVal:
    _strkey_decode(address)  # validate
    return ScVal("address", address)


def symbol_to_scval(value: str) -> ScVal:
    return ScVal("symbol", value)


def _int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise XdrError(f"{label} must be an integer")
    return value


def scval_to_bool(value: ScVal) -> bool:
    if value.kind != "bool":
        raise XdrError(f"expected bool, got {value.kind}")
    return bool(value.value)


def scval_to_u32(value: ScVal) -> int:
    if value.kind != "u32":
        raise XdrError(f"expected u32, got {value.kind}")
    return int(value.value)


def scval_to_u64(value: ScVal) -> int:
    if value.kind not in ("u64", "u32"):
        raise XdrError(f"expected u64, got {value.kind}")
    return int(value.value)


def scval_to_i128(value: ScVal) -> int:
    if value.kind not in ("i128", "i64", "u64"):
        raise XdrError(f"expected i128, got {value.kind}")
    return int(value.value)


def scval_to_address(value: ScVal) -> str:
    if value.kind != "address":
        raise XdrError(f"expected address, got {value.kind}")
    return str(value.value)


def scval_to_struct(value: ScVal) -> dict[str, ScVal]:
    """Contract structs are maps with symbol keys."""
    if value.kind != "map" or value.value is None:
        raise XdrError(f"expected a struct map, got {value.kind}")
    fields: dict[str, ScVal] = {}
    for key, item in value.value:
        if key.kind != "symbol":
            raise XdrError("struct map keys must be symbols")
        fields[str(key.value)] = item
    return fields


def native(value: ScVal) -> Any:
    """Converts a ScVal to plain Python values (for canonical JSON)."""
    kind = value.kind
    if kind == "void":
        return None
    if kind == "vec":
        return [native(item) for item in (value.value or [])]
    if kind == "map":
        out: dict[str, Any] = {}
        for key, item in value.value or []:
            out[str(key.value) if key.kind == "symbol" else str(native(key))] = native(item)
        return out
    return value.value


# --------------------------------------------------------------------------- #
# XDR writing                                                                 #
# --------------------------------------------------------------------------- #


def _pad(data: bytes) -> bytes:
    return data + b"\x00" * (-len(data) % 4)


def _i32(value: int) -> bytes:
    return struct.pack(">i", value)


def _u32(value: int) -> bytes:
    return struct.pack(">I", value)


def _u64(value: int) -> bytes:
    return struct.pack(">Q", value)


def _i64(value: int) -> bytes:
    return struct.pack(">q", value)


def _var(data: bytes) -> bytes:
    return _u32(len(data)) + _pad(data)


def _var_str(value: str) -> bytes:
    return _var(value.encode("utf-8"))


def _i128_bytes(value: int) -> bytes:
    if not -(1 << 127) <= value < (1 << 127):
        raise XdrError(f"i128 out of range: {value}")
    return (value % (1 << 128)).to_bytes(16, "big", signed=False)


def _u128_bytes(value: int) -> bytes:
    if not 0 <= value < (1 << 128):
        raise XdrError(f"u128 out of range: {value}")
    return value.to_bytes(16, "big")


def _scaddress_bytes(address: str) -> bytes:
    payload = _address_bytes(address)
    if _is_contract(address):
        return _i32(1) + payload
    return _i32(0) + _i32(0) + payload  # account, ed25519


def encode_scval(value: ScVal) -> bytes:
    kind = value.kind
    if kind == "bool":
        return _i32(0) + _i32(1 if value.value else 0)
    if kind == "void":
        return _i32(1)
    if kind == "error":
        return _i32(2) + _i32(0) + _u32(int(value.value))
    if kind == "u32":
        return _i32(3) + _u32(_int(value.value, "u32"))
    if kind == "i32":
        return _i32(4) + _i32(_int(value.value, "i32"))
    if kind == "u64":
        return _i32(5) + _u64(_int(value.value, "u64"))
    if kind == "i64":
        return _i32(6) + _i64(_int(value.value, "i64"))
    if kind == "u128":
        return _i32(9) + _u128_bytes(_int(value.value, "u128"))
    if kind == "i128":
        return _i32(10) + _i128_bytes(_int(value.value, "i128"))
    if kind == "bytes":
        return _i32(13) + _var(bytes(value.value))
    if kind == "string":
        return _i32(14) + _var_str(str(value.value))
    if kind == "symbol":
        return _i32(15) + _var_str(str(value.value))
    if kind == "vec":
        items = value.value or []
        return _i32(16) + _i32(1) + _u32(len(items)) + b"".join(
            encode_scval(item) for item in items
        )
    if kind == "map":
        entries = value.value or []
        # ScMap keys are canonically sorted by their encoded bytes.
        encoded = sorted(
            (encode_scval(key), encode_scval(item)) for key, item in entries
        )
        return _i32(17) + _i32(1) + _u32(len(encoded)) + b"".join(
            key + item for key, item in encoded
        )
    if kind == "address":
        return _i32(18) + _scaddress_bytes(str(value.value))
    raise XdrError(f"cannot encode ScVal kind {kind}")


# --------------------------------------------------------------------------- #
# XDR reading                                                                 #
# --------------------------------------------------------------------------- #


class Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    def take(self, count: int) -> bytes:
        end = self.offset + count
        if end > len(self.data):
            raise XdrError(
                f"incomplete XDR at offset {self.offset}, expected {count} byte(s)"
            )
        chunk = self.data[self.offset : end]
        self.offset = end
        return chunk

    def int32(self) -> int:
        return struct.unpack(">i", self.take(4))[0]

    def uint32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]

    def uint64(self) -> int:
        return struct.unpack(">Q", self.take(8))[0]

    def int64(self) -> int:
        return struct.unpack(">q", self.take(8))[0]

    def var(self) -> bytes:
        length = self.uint32()
        data = self.take(length)
        self.take(-length % 4)
        return data

    def var_str(self) -> str:
        return self.var().decode("utf-8")

    def optional(self) -> bool:
        flag = self.int32()
        if flag not in (0, 1):
            raise XdrError(f"invalid optional flag {flag}")
        return flag == 1


def read_scval(reader: Reader) -> ScVal:
    kind = reader.int32()
    if kind == 0:
        return _TRUE if reader.int32() else _FALSE
    if kind == 1:
        return ScVal("void")
    if kind == 2:
        error_type = reader.int32()
        if error_type != 0:
            raise XdrError(f"unsupported SCError type {error_type}")
        return ScVal("error", reader.uint32())
    if kind == 3:
        return ScVal("u32", reader.uint32())
    if kind == 4:
        return ScVal("i32", reader.int32())
    if kind == 5:
        return ScVal("u64", reader.uint64())
    if kind == 6:
        return ScVal("i64", reader.int64())
    if kind in (7, 8):  # timepoint, duration
        return ScVal("u64", reader.uint64())
    if kind == 9:
        return ScVal("u128", int.from_bytes(reader.take(16), "big"))
    if kind == 10:
        return ScVal("i128", int.from_bytes(reader.take(16), "big", signed=True))
    if kind == 11:
        return ScVal("u256", int.from_bytes(reader.take(32), "big"))
    if kind == 12:
        return ScVal("i256", int.from_bytes(reader.take(32), "big", signed=True))
    if kind == 13:
        return ScVal("bytes", reader.var())
    if kind == 14:
        return ScVal("string", reader.var_str())
    if kind == 15:
        return ScVal("symbol", reader.var_str())
    if kind == 16:
        if not reader.optional():
            return ScVal("vec", None)
        count = reader.uint32()
        return ScVal("vec", [read_scval(reader) for _ in range(count)])
    if kind == 17:
        if not reader.optional():
            return ScVal("map", None)
        count = reader.uint32()
        return ScVal(
            "map",
            [(read_scval(reader), read_scval(reader)) for _ in range(count)],
        )
    if kind == 18:
        return ScVal("address", _read_scaddress(reader))
    raise XdrError(f"unsupported ScVal kind {kind}")


def _read_scaddress(reader: Reader) -> str:
    address_type = reader.int32()
    if address_type == 0:
        public_key_type = reader.int32()
        if public_key_type != 0:
            raise XdrError(f"unsupported public key type {public_key_type}")
        return _address_from_bytes(_VERSION_ACCOUNT, reader.take(32))
    if address_type == 1:
        return _address_from_bytes(_VERSION_CONTRACT, reader.take(32))
    raise XdrError(f"unsupported SCAddress type {address_type}")


# --------------------------------------------------------------------------- #
# Contract events                                                             #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ContractEvent:
    contract: str
    name: str
    topics: list[ScVal]
    data: dict[str, ScVal]
    event_type: int


def read_contract_event(reader: Reader) -> ContractEvent:
    ext = reader.int32()
    if ext != 0:
        raise XdrError(f"unsupported ContractEvent ext {ext}")
    contract = "<none>"
    if reader.optional():
        contract = _address_from_bytes(_VERSION_CONTRACT, reader.take(32))
    event_type = reader.int32()
    arm = reader.int32()
    if arm != 0:
        raise XdrError(f"unsupported ContractEvent body arm {arm}")
    count = reader.uint32()
    topics = [read_scval(reader) for _ in range(count)]
    data = read_scval(reader)
    if not topics or topics[0].kind != "symbol":
        raise XdrError("contract events must start with a symbol topic")
    return ContractEvent(
        contract=contract,
        name=str(topics[0].value),
        topics=topics[1:],
        data=scval_to_struct(data),
        event_type=event_type,
    )


def read_contract_event_b64(encoded: str) -> ContractEvent:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as error:  # noqa: BLE001
        raise XdrError(f"invalid base64 event: {error}") from error
    reader = Reader(raw)
    event = read_contract_event(reader)
    if reader.offset != len(raw):
        raise XdrError("trailing bytes after ContractEvent")
    return event


def read_scval_b64(encoded: str) -> ScVal:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as error:  # noqa: BLE001
        raise XdrError(f"invalid base64 ScVal: {error}") from error
    reader = Reader(raw)
    value = read_scval(reader)
    if reader.offset != len(raw):
        raise XdrError("trailing bytes after ScVal")
    return value


# --------------------------------------------------------------------------- #
# Transactions                                                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Invocation:
    contract: str
    function: str
    args: list[ScVal]
    source: str
    fee: int
    sequence: int
    signatures: int


def _read_muxed_account(reader: Reader) -> str:
    kind = reader.int32()
    if kind == 0:
        return _address_from_bytes(_VERSION_ACCOUNT, reader.take(32))
    if kind == 1:
        account = _address_from_bytes(_VERSION_ACCOUNT, reader.take(32))
        reader.uint64()  # muxed id
        return account
    raise XdrError(f"unsupported muxed account kind {kind}")


def _read_preconditions(reader: Reader) -> None:
    kind = reader.int32()
    if kind == 0:
        return
    if kind == 1:
        # TimeBounds is a value, not an optional pointer.
        reader.uint64()
        reader.uint64()
        return
    raise XdrError(f"unsupported preconditions kind {kind}")


def _read_memo(reader: Reader) -> None:
    kind = reader.int32()
    if kind == 0:
        return
    if kind == 1:
        reader.var()
        return
    if kind == 2:
        reader.uint64()
        return
    if kind in (3, 4):
        reader.take(32)
        return
    raise XdrError(f"unsupported memo kind {kind}")


def _skip_asset(reader: Reader) -> None:
    kind = reader.int32()
    if kind == 0:
        return
    if kind == 1:
        reader.take(4)
        reader.take(32)
        return
    if kind == 2:
        reader.take(12)
        reader.take(32)
        return
    raise XdrError(f"unsupported asset kind {kind}")


def _skip_contract_id_preimage(reader: Reader) -> None:
    kind = reader.int32()
    if kind == 0:
        _read_scaddress(reader)
        reader.take(32)  # salt
        return
    _skip_asset(reader)


def _skip_contract_executable(reader: Reader) -> None:
    kind = reader.int32()
    if kind == 0:
        reader.take(32)  # wasm hash
        return
    _skip_asset(reader)


def _skip_authorized_invocation(reader: Reader) -> None:
    kind = reader.int32()
    if kind == 0:
        _read_scaddress(reader)
        reader.var_str()  # function name
        count = reader.uint32()
        for _ in range(count):
            read_scval(reader)
    elif kind == 1:
        _skip_contract_id_preimage(reader)
        _skip_contract_executable(reader)
    else:
        raise XdrError(f"unsupported authorized function kind {kind}")
    children = reader.uint32()
    for _ in range(children):
        _skip_authorized_invocation(reader)


def _skip_auth_entry(reader: Reader) -> None:
    credentials = reader.int32()
    if credentials == 1:
        _read_scaddress(reader)
        reader.int64()  # nonce
        reader.uint32()  # signature expiration ledger
        read_scval(reader)  # signature
    elif credentials != 0:
        raise XdrError(f"unsupported SorobanCredentials kind {credentials}")
    _skip_authorized_invocation(reader)


def read_envelope_b64(encoded: str) -> Invocation:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as error:  # noqa: BLE001
        raise XdrError(f"invalid base64 envelope: {error}") from error
    reader = Reader(raw)
    envelope_type = reader.int32()
    if envelope_type != 2:  # ENVELOPE_TYPE_TX
        raise XdrError(f"only v1 transaction envelopes are supported, got {envelope_type}")

    source = _read_muxed_account(reader)
    fee = reader.uint32()
    sequence = reader.int64()
    _read_preconditions(reader)
    _read_memo(reader)

    operation_count = reader.uint32()
    if operation_count == 0:
        raise XdrError("transaction has no operations")
    contract = function = None
    args: list[ScVal] = []
    for index in range(operation_count):
        if reader.optional():
            _read_muxed_account(reader)  # operation source
        operation_type = reader.int32()
        if operation_type != 24:  # INVOKE_HOST_FUNCTION
            raise XdrError(f"expected invokeHostFunction, got operation {operation_type}")
        host_function = reader.int32()
        if host_function != 0:
            raise XdrError(f"expected invokeContract, got host function {host_function}")
        parsed_contract = _read_scaddress(reader)
        parsed_function = reader.var_str()
        arg_count = reader.uint32()
        parsed_args = [read_scval(reader) for _ in range(arg_count)]
        auth_count = reader.uint32()
        for _ in range(auth_count):
            _skip_auth_entry(reader)
        if index == 0:
            contract, function, args = parsed_contract, parsed_function, parsed_args

    ext = reader.int32()
    if ext != 0:
        raise XdrError(
            "assembled Soroban transaction data (ext v1) is not decoded by this SDK"
        )
    signature_count = reader.uint32()
    for _ in range(signature_count):
        reader.take(4)  # hint
        reader.var()  # signature
    if reader.offset != len(raw):
        raise XdrError("trailing bytes after TransactionEnvelope")
    assert contract is not None and function is not None
    return Invocation(
        contract=contract,
        function=function,
        args=args,
        source=source,
        fee=fee,
        sequence=sequence,
        signatures=signature_count,
    )


def build_invoke_envelope(
    *,
    source: str,
    contract: str,
    function: str,
    args: list[ScVal],
    fee: int = 100,
    sequence: int = 0,
) -> str:
    """Builds an unsigned v1 envelope for ``simulateTransaction``."""
    tx = b"".join(
        [
            _i32(0) + _address_bytes(source),  # source: MuxedAccount ed25519
            _u32(fee),
            _i64(sequence),
            _i32(1) + _u64(0) + _u64(0),  # Preconditions: time bounds [0, 0)
            _i32(0),  # memo none
            _u32(1),  # one operation
            _i32(0),  # no operation source
            _i32(24),  # INVOKE_HOST_FUNCTION
            _i32(0),  # host function: invokeContract
            _scaddress_bytes(contract),
            _var_str(function),
            _u32(len(args)),
            b"".join(encode_scval(arg) for arg in args),
            _u32(0),  # auth
            _i32(0),  # transaction ext v0
        ]
    )
    return base64.b64encode(_i32(2) + tx + _u32(0)).decode("ascii")
