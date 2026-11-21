"""Canonical decoding of the shared conformance vectors.

The Python half of the cross-language suite. Run it with::

    python -m streampay.conformance [vectors_dir]
"""
from __future__ import annotations

import json
import sys
from dataclasses import fields
from pathlib import Path
from typing import Any

from ._generated import (
    FUNCTIONS,
    SPEC_FINGERPRINT,
    Stream,
    StreamCreatedEvent,
    StreamCancelledEvent,
    StreamToppedUpEvent,
    WithdrawnEvent,
    contract_error_name,
    decode_event,
)
from .xdr import (
    ScVal,
    XdrError,
    read_contract_event_b64,
    read_envelope_b64,
    read_scval_b64,
)

_DEFAULT_VECTORS = Path(__file__).resolve().parents[2] / "vectors"


def _canonical(value: ScVal, kind: str) -> Any:
    if kind == "void":
        return None
    if kind == "Stream":
        return stream_to_canonical(Stream.from_native(value))
    if kind.startswith("vec:"):
        inner = kind[4:]
        if value.kind != "vec":
            raise XdrError(f"expected a vec, got {value.kind}")
        return [_canonical(item, inner) for item in value.value or []]
    if kind == "address":
        if value.kind != "address":
            raise XdrError(f"expected address, got {value.kind}")
        return str(value.value)
    if kind in ("i128", "u64"):
        return str(int(value.value))
    if kind == "u32":
        return str(int(value.value))
    if kind == "bool":
        return bool(value.value)
    raise XdrError(f"unsupported canonical type {kind}")


def stream_to_canonical(stream: Stream) -> dict[str, Any]:
    return {
        "id": str(stream.id),
        "sender": stream.sender,
        "recipient": stream.recipient,
        "token": stream.token,
        "deposit": str(stream.deposit),
        "withdrawn": str(stream.withdrawn),
        "start_time": str(stream.start_time),
        "end_time": str(stream.end_time),
        "cancelable": stream.cancelable,
        "status": stream.status.name.title(),
        "use_oracle": stream.use_oracle,
    }


def event_to_canonical(encoded: str) -> dict[str, Any]:
    event = read_contract_event_b64(encoded)
    decoded = decode_event(event)
    if decoded is None:
        raise XdrError(f"event {event.name!r} is outside the StreamPay interface")
    if not isinstance(
        decoded,
        (
            StreamCreatedEvent,
            WithdrawnEvent,
            StreamCancelledEvent,
            StreamToppedUpEvent,
        ),
    ):  # pragma: no cover - exhaustiveness guard
        raise XdrError(f"unknown decoded event {type(decoded).__name__}")
    name = type(decoded).__name__[: -len("Event")]
    data: dict[str, Any] = {}
    for field in fields(decoded):
        if field.name in ("contract_id", "stream_id"):
            continue
        value = getattr(decoded, field.name)
        data[field.name] = str(value) if type(value) is int else value
    return {
        "contract": decoded.contract_id,
        "name": name,
        "topics": {"stream_id": str(decoded.stream_id)},
        "data": data,
    }


def decode_vector(vector: dict[str, Any]) -> dict[str, Any]:
    invocation = read_envelope_b64(vector["transactionEnvelopeXdr"])
    spec = next(
        (candidate for candidate in FUNCTIONS if candidate["name"] == invocation.function),
        None,
    )
    if spec is None:
        raise XdrError(f"function {invocation.function!r} is not in the spec")

    args = {
        name: _canonical(value, kind)
        for name, kind, value in zip(spec["arg_names"], spec["arg_types"], invocation.args)
    }

    result_value = read_scval_b64(vector["resultXdr"])
    if result_value.kind == "error":
        code = int(result_value.value)
        name = contract_error_name(code) or "UnknownStreamError"
        result: dict[str, Any] = {"error": {"name": name, "code": code}}
    else:
        result = {"ok": _canonical(result_value, spec["return_type"])}

    return {
        "transaction": {
            "contract": invocation.contract,
            "function": invocation.function,
            "args": args,
            "source": invocation.source,
            "fee": str(invocation.fee),
            "sequence": str(invocation.sequence),
            "signatures": invocation.signatures,
        },
        "result": result,
        "events": [event_to_canonical(encoded) for encoded in vector["eventsXdr"]],
    }


def decode_vector_file(path: Path) -> dict[str, Any]:
    vector = json.loads(path.read_text())
    return decode_vector(vector)


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    directory = Path(args[0]) if args else _DEFAULT_VECTORS
    vectors: dict[str, Any] = {}
    for path in sorted(directory.glob("*.json")):
        vector = json.loads(path.read_text())
        try:
            vectors[vector["name"]] = decode_vector(vector)
        except (KeyError, XdrError) as error:
            raise SystemExit(f"{path.name}: {error}") from error
    json.dump(
        {"sdk": "python", "specFingerprint": SPEC_FINGERPRINT, "vectors": vectors},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
