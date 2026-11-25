"""Typed errors for the StreamPay Python SDK."""
from __future__ import annotations

import re
from enum import Enum

from ._generated import contract_error_name

_CONTRACT_ERROR = re.compile(r"Error\(Contract, #(\d+)\)")


class FailureKind(str, Enum):
    """Where a call failed. The split matters for canaries and operator alerts."""

    SIMULATION = "simulation"
    SUBMISSION = "submission"
    INCLUSION = "inclusion"
    DECODE = "decode"
    TRANSPORT = "transport"


class StreamPayError(Exception):
    """The single exception raised by the client."""

    def __init__(
        self,
        message: str,
        kind: FailureKind,
        *,
        code: int | None = None,
        name: str | None = None,
        rpc_message: str | None = None,
        transaction_xdr: str | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.code = code
        self.contract_name = name
        self.rpc_message = rpc_message
        self.transaction_xdr = transaction_xdr

    @classmethod
    def from_rpc(
        cls,
        kind: FailureKind,
        rpc_message: str,
        transaction_xdr: str | None = None,
    ) -> "StreamPayError":
        match = _CONTRACT_ERROR.search(rpc_message)
        code = int(match.group(1)) if match else None
        name = contract_error_name(code) if code is not None else None
        if name is None:
            label = f"{kind.value} failed"
        else:
            label = f"{kind.value} failed: {name} (#{code})"
        return cls(
            f"{label}: {rpc_message}",
            kind,
            code=code,
            name=name,
            rpc_message=rpc_message,
            transaction_xdr=transaction_xdr,
        )

    @classmethod
    def decode(cls, message: str) -> "StreamPayError":
        return cls(f"decode failed: {message}", FailureKind.DECODE, rpc_message=message)
