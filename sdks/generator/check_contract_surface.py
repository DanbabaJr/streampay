#!/usr/bin/env python3
"""Schema guard: the checked-in spec must match the Rust contract surface.

The spec IR in ``sdks/spec/streampay.spec.json`` is the single source of truth
for every generated SDK. This script parses the contract sources and fails when
the two drift, so a contract change cannot silently ship stale clients.

The spec is *derived* from the contract, not hand-maintained:

    python3 sdks/generator/check_contract_surface.py --write-spec

rewrites the IR from the sources below. The normal (no-flag) run is the CI
gate: it re-parses the contract, rebuilds the expected IR, and reports every
difference. That makes the operation list structural rather than aspirational:
if a contract entrypoint is missing from the spec, the guard fails with the
entrypoint name.

Checks
  * every ``pub fn`` in the ``#[contractimpl]`` block of ``lib.rs`` (except the
    deploy-time ``__constructor``) — names, ordered arguments, argument types,
    return types, fallibility
  * ``#[contracttype]`` structs/enums reachable from entrypoints or events
  * numeric constants exposed in the IR
  * event names, topic symbols, topic fields, and data fields from ``events.rs``
  * the spec fingerprint (``FINGERPRINT``) against the canonical JSON

Error codes are deliberately *not* restated here: ``generate.py`` reads the
canonical catalog (``frontend/lib/errors.ts``, itself generated from
``errors.rs``) and emits the error table from it, so there is exactly one
error registry in the repository.

Usage
  python3 sdks/generator/check_contract_surface.py
  python3 sdks/generator/check_contract_surface.py --write-spec
  python3 sdks/generator/check_contract_surface.py --update-fingerprint
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "contracts" / "streaming-payments" / "src"
SPEC_PATH = ROOT / "sdks" / "spec" / "streampay.spec.json"
FINGERPRINT_PATH = ROOT / "sdks" / "spec" / "FINGERPRINT"

SPEC_SCHEMA = "streampay-spec/v2"

MODULES = [
    "stream",
    "schedule",
    "sponsor",
    "treasury",
    "policy",
    "oracle",
    "governance",
    "dispute",
]

PRIMITIVES = {
    "address",
    "bool",
    "i32",
    "u32",
    "i128",
    "u128",
    "u64",
    "string",
    "symbol",
    "bytes32",
    "bytes64",
    "void",
}

# Deploy-time constructor: it is part of the contract's ABI but is not an
# operation a client can invoke on a deployed contract.
NON_INVOKABLE = {"__constructor"}

# Getters and pure views. Everything else defaults to mutating, which is the
# safe direction for a client: a mutating call that is simulated still works,
# while signing a read-only call needlessly asks for a signature.
READ_ONLY = {
    "available",
    "beneficiary_spend",
    "get_beneficiary_public_key",
    "get_dispute",
    "get_intent",
    "get_sponsor",
    "get_stream",
    "get_stream_policy",
    "governance_is_initialized",
    "governance_proposal",
    "governance_proposal_count",
    "governance_signers",
    "governance_veto_window",
    "is_frozen",
    "migration_progress",
    "oracle_config",
    "oracle_report",
    "pending_ownership_transfer",
    "pending_rate_change",
    "pending_upgrade",
    "policy_admin",
    "policy_get_queued_asset",
    "policy_is_asset_allowed",
    "policy_pending_admin",
    "policy_timelock_delay",
    "rate_segments",
    "recipient_streams",
    "required_dispute_bond",
    "resolve_time",
    "schema_version",
    "sender_intents",
    "sender_streams",
    "sponsor_period_spend",
    "stream_fee",
    "total_streams",
    "treasury_status",
    "verify_treasury",
}


# --------------------------------------------------------------------------- #
# Source scanning helpers                                                     #
# --------------------------------------------------------------------------- #


DOC_ATTRIBUTE = "#[cfg_attr("


def match_delimiter(text: str, start: int, open_char: str, close_char: str) -> int:
    """Return the index of the delimiter matching ``text[start]``.

    Skips line/block comments and string/char literals, so braces in format
    strings or doc examples cannot confuse the scan.
    """
    assert text[start] == open_char
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == "/" and index + 1 < len(text):
            nxt = text[index + 1]
            if nxt == "/":
                newline = text.find("\n", index)
                index = len(text) if newline == -1 else newline + 1
                continue
            if nxt == "*":
                end = text.find("*/", index + 2)
                index = len(text) if end == -1 else end + 2
                continue
        if char == "r" and index + 1 < len(text) and text[index + 1] in "#\"":
            raw_end = _raw_string_end(text, index)
            if raw_end is not None:
                index = raw_end
                continue
        if char == '"':
            index = _string_end(text, index)
            continue
        if char == "'":
            # A char literal (or a lifetime). Lifetimes never contain the
            # delimiters we are matching, so skipping to the next quote is safe
            # only when a closing quote exists nearby.
            end = text.find("'", index + 1)
            if end != -1 and end - index <= 4:
                index = end + 1
                continue
        if char == open_char:
            depth += 1
        elif char == close_char:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError(f"unterminated {open_char!r} starting at {start}")


def _string_end(text: str, start: int) -> int:
    index = start + 1
    while index < len(text):
        if text[index] == "\\":
            index += 2
            continue
        if text[index] == '"':
            return index + 1
        index += 1
    raise ValueError("unterminated string literal")


def _raw_string_end(text: str, start: int) -> int | None:
    match = re.match(r'r(#*)"', text[start:])
    if not match:
        return None
    hashes = match.group(1)
    terminator = '"' + hashes
    end = text.find(terminator, start + match.end())
    return len(text) if end == -1 else end + len(terminator)


def split_top_level(text: str, delimiter: str = ",") -> list[str]:
    parts: list[str] = []
    depth = 0
    start = 0
    index = 0
    while index < len(text):
        char = text[index]
        if char in "<([{":
            depth += 1
        elif char in ">)]}":
            depth -= 1
        elif char == delimiter and depth == 0:
            parts.append(text[start:index])
            start = index + 1
        index += 1
    tail = text[start:]
    if tail.strip():
        parts.append(tail)
    return [part.strip() for part in parts if part.strip()]


def _unescape_doc(value: str) -> str:
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}
    out: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "\\" and index + 1 < len(value):
            out.append(escapes.get(value[index + 1], value[index + 1]))
            index += 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def _doc_strings(attribute: str) -> list[str]:
    return [
        _unescape_doc(match.group(1))
        for match in re.finditer(r'doc\s*=\s*"((?:[^"\\]|\\.)*)"', attribute)
    ]


def normalize_docs(source: str) -> str:
    """Rewrite ``#[cfg_attr(..., doc = "...")]`` as plain ``///`` lines.

    The contract keeps its long docs behind ``cfg_attr(not(target_family =
    "wasm"), ...)`` so the Wasm binary does not embed them, and rustfmt spreads
    those attributes over several lines. Everything below reads one line at a
    time, so normalizing the attributes first keeps the parsers simple and
    makes the doc text visible to the spec (and therefore to the clients).

    Attributes without a ``doc`` key (for example ``cfg_attr(kani, ...)``) are
    left untouched.
    """
    out: list[str] = []
    index = 0
    while True:
        start = source.find(DOC_ATTRIBUTE, index)
        if start == -1:
            out.append(source[index:])
            break
        line_start = source.rfind("\n", 0, start) + 1
        indent = source[line_start:start]
        if indent.strip():
            # An occurrence that is not at the start of a line (inside a
            # string, say) is not an attribute.
            out.append(source[index : start + len(DOC_ATTRIBUTE)])
            index = start + len(DOC_ATTRIBUTE)
            continue
        bracket = start + 1
        try:
            end = match_delimiter(source, bracket, "[", "]")
        except ValueError:
            out.append(source[index:])
            break
        docs = _doc_strings(source[start : end + 1])
        if not docs:
            out.append(source[index : end + 1])
            index = end + 1
            continue
        out.append(source[index:line_start])
        normalized: list[str] = []
        for doc in docs:
            text = doc.lstrip()
            normalized.append(f"{indent}/// {text}" if text else f"{indent}///")
        out.append("\n".join(normalized))
        index = end + 1
    return "".join(out)


def doc_before(source_lines: list[str], line_index: int) -> str:
    """Collect the ``///`` block immediately above ``source_lines[line_index]``.

    Attribute lines between the docs and the item are skipped; a blank line
    ends the block.
    """
    index = line_index - 1
    while index >= 0 and source_lines[index].lstrip().startswith("#["):
        index -= 1
    docs: list[str] = []
    while index >= 0:
        stripped = source_lines[index].strip()
        if stripped.startswith("///"):
            docs.append(stripped[3:].lstrip())
        elif stripped == "":
            break
        elif stripped.startswith("#["):
            pass
        else:
            break
        index -= 1
    return "\n".join(reversed(docs))


def normalize_type(rust: str) -> str:
    value = " ".join(rust.split())
    value = value.replace("soroban_sdk::", "").replace("crate::", "")
    return value


def parse_type(rust: str) -> object:
    """Map a Rust type to the spec IR type language."""
    value = normalize_type(rust)
    if value.startswith("&"):
        value = value[1:].strip()
    if value == "()":
        return "void"

    vec = re.fullmatch(r"Vec<(.+)>", value)
    if vec:
        return {"vec": parse_type(vec.group(1))}

    option = re.fullmatch(r"Option<(.+)>", value)
    if option:
        return {"option": parse_type(option.group(1))}

    result = re.fullmatch(r"Result<(.+)>", value)
    if result:
        parts = split_top_level(result.group(1))
        if len(parts) != 2:
            raise ValueError(f"cannot parse Result type {rust!r}")
        ok, err = parts
        err_type = parse_type(err)
        return {
            "result": {
                "ok": parse_type(ok),
                "err": err_type if isinstance(err_type, str) else "unknown",
            }
        }

    bytes_n = re.fullmatch(r"BytesN<(\d+)>", value)
    if bytes_n:
        width = int(bytes_n.group(1))
        if width not in (32, 64):
            raise ValueError(f"unsupported BytesN width {width}")
        return f"bytes{width}"

    if value == "Bytes":
        raise ValueError("dynamic Bytes are not used by the contract surface")

    table = {
        "Address": "address",
        "MuxedAddress": "address",
        "bool": "bool",
        "i32": "i32",
        "u32": "u32",
        "i128": "i128",
        "u128": "u128",
        "u64": "u64",
        "String": "string",
        "Symbol": "symbol",
    }
    if value in table:
        return table[value]

    # A named contract type, possibly module-qualified (`sponsor::SponsorConfig`).
    named = value.split("::")[-1]
    if re.fullmatch(r"[A-Z]\w*", named):
        return named
    raise ValueError(f"cannot map Rust type {rust!r} to the spec IR")


def type_names(value: object) -> set[str]:
    if isinstance(value, dict):
        names: set[str] = set()
        for key, inner in value.items():
            if key in ("vec", "option"):
                names |= type_names(inner)
            elif key == "result":
                names |= type_names(inner["ok"])
            else:
                raise ValueError(f"unknown IR type key {key}")
        return names
    if isinstance(value, str) and value not in PRIMITIVES and value != "StreamError":
        return {value}
    return set()


def camel_to_snake(name: str) -> str:
    value = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value).lower()


# --------------------------------------------------------------------------- #
# Contract parsing                                                            #
# --------------------------------------------------------------------------- #


def parse_functions(source: str) -> list[dict]:
    start = source.find("impl StreamingPayments {")
    if start == -1:
        raise ValueError("could not find `impl StreamingPayments` in lib.rs")
    body_start = source.find("{", start)
    body_end = match_delimiter(source, body_start, "{", "}")
    body = source[body_start + 1 : body_end]
    body_offset = body_start + 1

    functions: list[dict] = []
    for match in re.finditer(r"pub fn\s+(\w+)\s*\(", body):
        name = match.group(1)
        paren_start = body.find("(", match.start())
        paren_end = match_delimiter(body, paren_start, "(", ")")
        params_text = body[paren_start + 1 : paren_end]
        tail = body[paren_end + 1 :]
        arrow = re.match(r"\s*(?:->\s*([^{]+?))?\s*\{", tail, re.DOTALL)
        if not arrow:
            raise ValueError(f"could not parse the signature of `{name}`")
        return_text = arrow.group(1)

        line_index = source[: body_offset + match.start()].count("\n")
        doc = doc_before(source.splitlines(), line_index)

        args = []
        for param in split_top_level(params_text):
            param = re.sub(r"^mut\s+", "", param.strip())
            arg_name, _, arg_type = param.partition(":")
            if not arg_type:
                raise ValueError(f"cannot parse parameter {param!r} of `{name}`")
            arg_name = arg_name.strip()
            if arg_name in ("env", "_env"):
                continue
            args.append({"name": arg_name, "type": parse_type(arg_type)})

        returns: object = "void"
        error = None
        if return_text:
            parsed = parse_type(return_text)
            if isinstance(parsed, dict) and "result" in parsed:
                returns = parsed["result"]["ok"]
                err = parsed["result"]["err"]
                error = err if isinstance(err, str) else "unknown"
            else:
                returns = parsed
        functions.append(
            {
                "name": name,
                "doc": doc,
                "args": args,
                "returns": returns,
                "error": error,
                "mutating": name not in READ_ONLY,
            }
        )
    return functions


def parse_structs_and_enums(sources: dict[str, str]) -> tuple[list[dict], list[dict]]:
    structs: list[dict] = []
    enums: list[dict] = []
    for module, source in sources.items():
        lines = source.splitlines()
        for index, line in enumerate(lines):
            struct_match = re.match(r"pub struct (\w+) \{", line)
            enum_match = re.match(r"pub enum (\w+) \{", line)
            if not struct_match and not enum_match:
                continue
            if not _contract_type(lines, index):
                continue
            if struct_match:
                name = struct_match.group(1)
                brace = source.find("{", _line_offset(lines, index))
                end = match_delimiter(source, brace, "{", "}")
                block = source[brace + 1 : end]
                fields = _parse_fields(block, module)
                structs.append(
                    {
                        "name": name,
                        "doc": doc_before(lines, index),
                        "fields": fields,
                    }
                )
            else:
                name = enum_match.group(1)
                brace = source.find("{", _line_offset(lines, index))
                end = match_delimiter(source, brace, "{", "}")
                block = source[brace + 1 : end]
                cases = _parse_cases(block)
                enums.append(
                    {
                        "name": name,
                        "doc": doc_before(lines, index),
                        "cases": cases,
                    }
                )
    return structs, enums


def _contract_type(lines: list[str], line_index: int) -> bool:
    index = line_index - 1
    while index >= 0:
        stripped = lines[index].strip()
        if stripped.startswith("#[contracttype]"):
            return True
        if stripped.startswith("///") or stripped.startswith("#["):
            index -= 1
            continue
        return False
    return False


def _line_offset(lines: list[str], line_index: int) -> int:
    return sum(len(line) + 1 for line in lines[:line_index])


def _parse_fields(block: str, module: str) -> list[dict]:
    fields: list[dict] = []
    docs: list[str] = []
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            docs.append(stripped[3:].lstrip())
            continue
        if stripped.startswith("#["):
            continue
        match = re.match(r"pub (\w+): (.+),\s*$", stripped)
        if match:
            fields.append(
                {
                    "name": match.group(1),
                    "type": parse_type(match.group(2)),
                    "doc": "\n".join(docs),
                }
            )
        docs = []
    return fields


def _parse_cases(block: str) -> list[dict]:
    """Parse enum variants, including tuple variants that carry values.

    ``value`` is the variant's declaration index. It is *not* the wire tag:
    soroban-sdk encodes every ``#[contracttype]`` enum as a vector whose first
    element is the variant name as a ``Symbol`` followed by the variant's
    values. Tuple variants therefore carry their positional ``types``.
    """
    cases: list[dict] = []
    docs: list[str] = []
    next_value = 0
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            docs.append(stripped[3:].lstrip())
            continue
        if not stripped or stripped.startswith("#["):
            continue
        tuple_case = re.fullmatch(r"(\w+)\s*\((.*)\)\s*,?", stripped)
        if tuple_case:
            types = [
                parse_type(item) for item in split_top_level(tuple_case.group(2))
            ]
            cases.append(
                {
                    "name": tuple_case.group(1),
                    "value": next_value,
                    "doc": "\n".join(docs),
                    "types": types,
                }
            )
            next_value += 1
            docs = []
            continue
        match = re.fullmatch(r"(\w+)(?:\s*=\s*(\d+))?,?", stripped)
        if not match:
            raise ValueError(f"cannot parse enum case {stripped!r}")
        value = int(match.group(2)) if match.group(2) is not None else next_value
        cases.append({"name": match.group(1), "value": value, "doc": "\n".join(docs)})
        next_value = value + 1
        docs = []
    return cases


def parse_events(source: str) -> list[dict]:
    events: list[dict] = []
    lines = source.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"pub struct (\w+) \{", line)
        if not match or not _contract_type(lines, index, "#[contractevent]"):
            continue
        name = match.group(1)
        brace = source.find("{", _line_offset(lines, index))
        end = match_delimiter(source, brace, "{", "}")
        block = source[brace + 1 : end]
        topics: list[dict] = []
        data: list[dict] = []
        docs: list[str] = []
        topic_pending = False
        for field_line in block.splitlines():
            stripped = field_line.strip()
            if stripped.startswith("///"):
                docs.append(stripped[3:].lstrip())
                continue
            if stripped == "#[topic]":
                topic_pending = True
                continue
            field = re.match(r"pub (\w+): (.+),\s*$", stripped)
            if field:
                entry = {
                    "name": field.group(1),
                    "type": parse_type(field.group(2)),
                    "doc": "\n".join(docs),
                }
                (topics if topic_pending else data).append(entry)
                topic_pending = False
            docs = []
        events.append(
            {
                "name": name,
                "topic": camel_to_snake(name),
                "doc": doc_before(lines, index),
                "topicFields": topics,
                "dataFields": data,
            }
        )
    return events


def _contract_type(
    lines: list[str], line_index: int, attribute: str = "#[contracttype]"
) -> bool:
    index = line_index - 1
    while index >= 0:
        stripped = lines[index].strip()
        if stripped.startswith(attribute):
            return True
        if stripped.startswith("///") or stripped.startswith("#["):
            index -= 1
            continue
        return False
    return False


def parse_errors(source: str) -> list[dict]:
    enum_start = source.find("pub enum StreamError {")
    if enum_start == -1:
        raise ValueError("could not find `pub enum StreamError`")
    brace = source.find("{", enum_start)
    end = match_delimiter(source, brace, "{", "}")
    block = source[brace + 1 : end]
    errors: list[dict] = []
    docs: list[str] = []
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            docs.append(stripped[3:].lstrip())
            continue
        match = re.match(r"(\w+)\s*=\s*(\d+),", stripped)
        if match:
            errors.append(
                {
                    "name": match.group(1),
                    "code": int(match.group(2)),
                    "doc": "\n".join(docs),
                }
            )
        docs = []
    return errors


def parse_constants(sources: dict[str, str]) -> dict[str, dict]:
    constants: dict[str, dict] = {}
    for source in sources.values():
        for match in re.finditer(
            r"pub const ([A-Z][A-Z0-9_]*): (u32|u64|i128) = ([^;]+);", source
        ):
            name, kind, expression = match.groups()
            if name in ("ALL", "RETIRED_CODES"):
                continue
            try:
                value = evaluate_int(expression)
            except ValueError:
                continue
            constants[name] = {"value": value, "type": kind}
    return dict(sorted(constants.items()))


def evaluate_int(expression: str) -> int:
    """Evaluate a constant expression using integer arithmetic only."""
    expression = expression.replace("_", "")
    tree = ast.parse(expression, mode="eval")

    def visit(node: ast.AST) -> int:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int):
            return node.value
        if isinstance(node, ast.BinOp):
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.FloorDiv):
                return left // right
        raise ValueError(f"unsupported constant expression {expression!r}")

    return visit(tree)


def parse_contract() -> dict:
    lib = normalize_docs((CONTRACT / "lib.rs").read_text())
    # Types may be declared in lib.rs itself (StreamInput) as well as in the
    # domain modules; constants live only in the modules.
    sources = {
        name: normalize_docs((CONTRACT / f"{name}.rs").read_text())
        for name in MODULES
    }
    type_sources = {"lib": lib, **sources}
    events_source = normalize_docs((CONTRACT / "events.rs").read_text())
    errors_source = normalize_docs((CONTRACT / "errors.rs").read_text())

    functions = parse_functions(lib)
    structs, enums = parse_structs_and_enums(type_sources)
    events = parse_events(events_source)
    errors = parse_errors(errors_source)
    constants = parse_constants(sources)

    known = {item["name"] for item in structs} | {item["name"] for item in enums}
    reachable = _reachable_types(functions, events, structs, enums, known)
    structs = [item for item in structs if item["name"] in reachable]
    enums = [item for item in enums if item["name"] in reachable]

    return {
        "functions": functions,
        "structs": structs,
        "enums": enums,
        "events": events,
        "errors": errors,
        "constants": constants,
    }


def _reachable_types(
    functions: list[dict],
    events: list[dict],
    structs: list[dict],
    enums: list[dict],
    known: set[str],
) -> set[str]:
    struct_map = {item["name"]: item for item in structs}
    enum_map = {item["name"]: item for item in enums}
    pending: list[str] = []

    for function in functions:
        for arg in function["args"]:
            pending.extend(type_names(arg["type"]))
        pending.extend(type_names(function["returns"]))
    for event in events:
        for field in event["topicFields"] + event["dataFields"]:
            pending.extend(type_names(field["type"]))

    reachable: set[str] = set()
    while pending:
        name = pending.pop()
        if name in reachable:
            continue
        if name in struct_map:
            reachable.add(name)
            for field in struct_map[name]["fields"]:
                pending.extend(type_names(field["type"]))
        elif name in enum_map:
            reachable.add(name)
            for case in enum_map[name]["cases"]:
                for case_type in case.get("types", []):
                    pending.extend(type_names(case_type))
        elif name not in known:
            raise ValueError(
                f"reachable contract type `{name}` is not a modelled struct or unit enum"
            )
    return reachable


# --------------------------------------------------------------------------- #
# Spec assembly and comparison                                                #
# --------------------------------------------------------------------------- #


def build_spec(contract: dict) -> dict:
    entrypoints = [
        function
        for function in contract["functions"]
        if function["name"] not in NON_INVOKABLE
    ]
    return {
        "schema": SPEC_SCHEMA,
        "generator": "sdks/generator/generate.py",
        "contract": {
            "name": "StreamingPayments",
            "crate": "streampay-contract",
            "version": "0.3.0",
            "description": "Continuous, linear streaming payments on Stellar (Soroban).",
        },
        "constants": contract["constants"],
        "functions": entrypoints,
        "structs": contract["structs"],
        "enums": contract["enums"],
        "events": contract["events"],
    }


def canonical_bytes(spec: dict) -> bytes:
    return json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def fingerprint(spec: dict) -> str:
    return hashlib.sha256(canonical_bytes(spec)).hexdigest()


def compare(spec: dict, expected: dict) -> list[str]:
    problems: list[str] = []
    if spec.get("schema") != expected["schema"]:
        problems.append(
            f"spec schema is {spec.get('schema')!r}, expected {expected['schema']!r}"
        )

    spec_functions = {item["name"]: item for item in spec.get("functions", [])}
    expected_functions = {item["name"]: item for item in expected["functions"]}
    missing = sorted(expected_functions.keys() - spec_functions.keys())
    extra = sorted(spec_functions.keys() - expected_functions.keys())
    for name in missing:
        problems.append(
            f"operation `{name}` is an entrypoint in the contract but missing from the spec"
        )
    for name in extra:
        problems.append(f"operation `{name}` is in the spec but not in the contract")
    if not missing and not extra:
        for name in expected_functions:
            expected_function = expected_functions[name]
            actual = spec_functions[name]
            for key in ("args", "returns", "error", "mutating"):
                if actual.get(key) != expected_function[key]:
                    problems.append(
                        f"operation `{name}` {key} drifted: "
                        f"spec={actual.get(key)!r} contract={expected_function[key]!r}"
                    )

    problems.extend(
        _compare_named(
            "struct",
            spec.get("structs", []),
            expected["structs"],
            ("fields",),
        )
    )
    problems.extend(
        _compare_named(
            "enum",
            spec.get("enums", []),
            expected["enums"],
            ("cases",),
        )
    )
    problems.extend(
        _compare_named(
            "event",
            spec.get("events", []),
            expected["events"],
            ("topic", "topicFields", "dataFields"),
        )
    )

    spec_constants = spec.get("constants", {})
    expected_constants = expected["constants"]
    for name in sorted(expected_constants.keys() - spec_constants.keys()):
        problems.append(f"constant `{name}` is missing from the spec")
    for name in sorted(spec_constants.keys() - expected_constants.keys()):
        problems.append(f"constant `{name}` is in the spec but not in the contract")
    for name in sorted(spec_constants.keys() & expected_constants.keys()):
        if spec_constants[name] != expected_constants[name]:
            problems.append(
                f"constant `{name}` drifted: "
                f"spec={spec_constants[name]} contract={expected_constants[name]}"
            )
    return problems


def _compare_named(kind: str, actual_items: list[dict], expected_items: list[dict], keys: tuple[str, ...]) -> list[str]:
    problems: list[str] = []
    actual = {item["name"]: item for item in actual_items}
    expected = {item["name"]: item for item in expected_items}
    for name in sorted(expected.keys() - actual.keys()):
        problems.append(f"{kind} `{name}` exists in the contract but not in the spec")
    for name in sorted(actual.keys() - expected.keys()):
        problems.append(f"{kind} `{name}` exists in the spec but not in the contract")
    for name in sorted(actual.keys() & expected.keys()):
        for key in keys:
            if actual[name].get(key) != expected[name][key]:
                problems.append(
                    f"{kind} `{name}` {key} drifted: "
                    f"spec={actual[name].get(key)!r} contract={expected[name][key]!r}"
                )
    return problems


def format_spec(spec: dict) -> str:
    return json.dumps(spec, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write-spec",
        action="store_true",
        help="rewrite sdks/spec/streampay.spec.json from the contract sources",
    )
    parser.add_argument(
        "--update-fingerprint",
        action="store_true",
        help="rewrite sdks/spec/FINGERPRINT from the current spec",
    )
    args = parser.parse_args()

    contract = parse_contract()
    expected = build_spec(contract)

    if args.write_spec:
        SPEC_PATH.write_text(format_spec(expected))
        digest = fingerprint(expected)
        FINGERPRINT_PATH.write_text(digest + "\n")
        print(
            f"spec written: {len(expected['functions'])} operations, "
            f"{len(expected['structs'])} structs, {len(expected['enums'])} enums, "
            f"{len(expected['events'])} events, sha256 {digest[:12]}…"
        )
        return 0

    spec = json.loads(SPEC_PATH.read_text())
    problems = compare(spec, expected)

    digest = fingerprint(spec)
    if args.update_fingerprint:
        FINGERPRINT_PATH.write_text(digest + "\n")
        print(f"fingerprint updated: {digest}")
    else:
        recorded = FINGERPRINT_PATH.read_text().strip() if FINGERPRINT_PATH.exists() else ""
        if recorded != digest:
            problems.append(
                f"spec fingerprint mismatch: recorded={recorded or '<missing>'} "
                f"actual={digest} (run with --write-spec after an intentional change)"
            )

    if problems:
        for problem in problems:
            print(f"spec drift: {problem}", file=sys.stderr)
        return 1
    print(
        f"spec matches the contract surface: {len(spec['functions'])} operations, "
        f"{len(spec['events'])} events, sha256 {digest[:12]}…"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
