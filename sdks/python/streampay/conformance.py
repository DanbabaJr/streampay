"""Canonical decoding of the shared conformance vectors.

The Python half of the cross-language suite. Run it with::

    python -m streampay.conformance [vectors_dir]

Decoding is driven by ``sdks/spec/streampay.spec.json`` — never a second
hand-maintained table of function arguments or event topics — so the Python
client stays aligned with the Rust and TypeScript SDKs when the spec grows.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ._generated import SPEC_FINGERPRINT, contract_error_name
from .xdr import (
    ScVal,
    XdrError,
    read_contract_event_b64,
    read_envelope_b64,
    read_scval_b64,
)

_DEFAULT_VECTORS = Path(__file__).resolve().parents[2] / "vectors"
_SPEC_PATH = Path(__file__).resolve().parents[2] / "spec" / "streampay.spec.json"
_SPEC: dict[str, Any] | None = None


def _spec() -> dict[str, Any]:
    global _SPEC
    if _SPEC is None:
        _SPEC = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
    return _SPEC


def _canonical(value: ScVal) -> Any:
    """Canonical JSON for a Soroban value: integers become decimal strings,
    addresses become StrKeys, unit enums become their case name and maps become
    objects (contract payloads are maps with symbol keys)."""
    kind = value.kind
    if kind == "void":
        return None
    if kind == "bool":
        return bool(value.value)
    if kind in ("u32", "i32", "u64", "i64", "u128", "i128"):
        return str(int(value.value))
    if kind in ("symbol", "string"):
        return str(value.value)
    if kind == "address":
        return str(value.value)
    if kind == "bytes":
        return bytes(value.value).hex()
    if kind == "vec":
        items = list(value.value or [])
        if len(items) == 1 and items[0].kind == "symbol":
            return str(items[0].value)
        return [_canonical(item) for item in items]
    if kind == "map":
        out: dict[str, Any] = {}
        for key, item in value.value or []:
            if key.kind not in ("symbol", "string"):
                raise XdrError(f"map keys must be symbols, got {key.kind}")
            out[str(key.value)] = _canonical(item)
        return out
    raise XdrError(f"unsupported canonical ScVal kind {kind}")


def _event_to_canonical(encoded: str, events: dict[str, dict[str, Any]]) -> dict[str, Any]:
    event = read_contract_event_b64(encoded)
    spec_event = events.get(event.name)
    if spec_event is None:
        raise XdrError(f"event {event.name!r} is not in the spec")
    fields = spec_event["topicFields"]
    if len(fields) != len(event.topics):
        raise XdrError(
            f"event {event.name!r} has {len(event.topics)} topics, "
            f"the spec declares {len(fields)}"
        )
    topics = {
        field["name"]: _canonical(topic)
        for field, topic in zip(fields, event.topics)
    }
    data = {name: _canonical(value) for name, value in event.data.items()}
    return {
        "contract": event.contract,
        "name": spec_event["name"],
        "topics": topics,
        "data": data,
    }


def decode_vector(vector: dict[str, Any]) -> dict[str, Any]:
    spec = _spec()
    functions = {function["name"]: function for function in spec["functions"]}
    events = {event["topic"]: event for event in spec["events"]}

    invocation = read_envelope_b64(vector["transactionEnvelopeXdr"])
    function = functions.get(invocation.function)
    if function is None:
        raise XdrError(f"function {invocation.function!r} is not in the spec")
    if len(invocation.args) != len(function["args"]):
        raise XdrError(
            f"{invocation.function} has {len(invocation.args)} arguments, "
            f"the spec declares {len(function['args'])}"
        )
    args = {
        arg["name"]: _canonical(value)
        for arg, value in zip(function["args"], invocation.args)
    }

    result_value = read_scval_b64(vector["resultXdr"])
    if result_value.kind == "error":
        code = int(result_value.value)
        name = contract_error_name(code) or "UnknownStreamError"
        result: dict[str, Any] = {"error": {"name": name, "code": code}}
    else:
        result = {"ok": _canonical(result_value)}

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
        "events": [
            _event_to_canonical(encoded, events) for encoded in vector["eventsXdr"]
        ],
    }


def decode_vector_file(path: Path) -> dict[str, Any]:
    vector = json.loads(path.read_text(encoding="utf-8"))
    return decode_vector(vector)


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    directory = Path(args[0]) if args else _DEFAULT_VECTORS
    vectors: dict[str, Any] = {}
    for path in sorted(directory.glob("*.json")):
        vector = json.loads(path.read_text(encoding="utf-8"))
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
