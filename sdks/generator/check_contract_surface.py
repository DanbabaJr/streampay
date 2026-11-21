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

SPEC_SCHEMA = "streampay-spec/v3"

def contract_modules(lib: str) -> list[str]:
    """Non-test modules declared in ``lib.rs`` (``mod x;`` not behind a
    test-only ``#[cfg(...)]``), in declaration order.

    Discovering the modules from ``lib.rs`` instead of hard-coding them means a
    new domain module (governance, disputes, ...) is scanned automatically.
    """
    modules: list[str] = []
    lines = lib.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"\s*(?:pub(?:\([\w:]+\))?\s+)?mod (\w+);", line)
        if not match:
            continue
        name = match.group(1)
        previous = lines[index - 1].strip() if index else ""
        if previous.startswith("#[cfg(") and "test" in previous:
            continue
        if name.endswith("_test") or name.startswith("test") or name in ("errors", "events", "surface"):
            continue
        modules.append(name)
    return modules

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
    "pending_sender_transfer",
    "pending_upgrade",
    "policy_admin",
    "policy_get_queued_asset",
    "policy_is_asset_allowed",
    "policy_pending_admin",
    "policy_timelock_delay",
    "rate_segments",
    "recipient_streams",
    "refund_target",
    "required_dispute_bond",
    "resolve_time",
    "schema_version",
    "sender_history",
    "sender_intents",
    "sender_streams",
    "sponsor_period_spend",
    "stream_fee",
    "stream_record_version",
    "total_streams",
    "treasury_status",
    "verify_treasury",
}


# --------------------------------------------------------------------------- #
# Source scanning helpers                                                     #
# --------------------------------------------------------------------------- #


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


def extract_docs(attrs: str) -> str:
    """Collect doc text from ``///`` lines and ``doc = "..."`` attributes.

    The contract writes most docs as ``#[cfg_attr(not(target_family =
    "wasm"), doc = "...")]`` so they stay out of the Wasm binary; both forms
    are read, in source order.
    """
    docs: list[str] = []
    for match in re.finditer(r'^\s*///(.*)$|\bdoc\s*=\s*("(?:[^"\\]|\\.)*")', attrs, re.MULTILINE):
        if match.group(2) is not None:
            literal = match.group(2)
            try:
                text = ast.literal_eval(literal)
            except (ValueError, SyntaxError):
                text = literal[1:-1]
        else:
            text = match.group(1)
        docs.append(text[1:] if text.startswith(" ") else text)
    return "\n".join(docs).strip("\n")


def attrs_before(source_lines: list[str], line_index: int) -> str:
    """Return the attribute/doc-comment block directly above an item.

    Handles multi-line attributes (``#[cfg_attr(\n ...\n)]``). A blank line or
    any other code ends the block.
    """
    index = line_index - 1
    collected: list[str] = []
    while index >= 0:
        stripped = source_lines[index].strip()
        if stripped.startswith("#["):
            # `#[allow(...)] // why` — a trailing comment after an attribute.
            stripped = re.sub(r"\]\s*//.*$", "]", stripped)
        if stripped.startswith("///") or (stripped.startswith("#[") and stripped.endswith("]")):
            collected.append(source_lines[index])
            index -= 1
            continue
        if stripped.endswith(")]") and not stripped.startswith("#["):
            # Tail of a multi-line attribute: walk up to its `#[` line.
            block = [source_lines[index]]
            index -= 1
            while index >= 0 and not source_lines[index].strip().startswith("#["):
                block.append(source_lines[index])
                index -= 1
            if index < 0:
                break
            block.append(source_lines[index])
            collected.extend(block)
            index -= 1
            continue
        break
    return "\n".join(reversed(collected))


def doc_before(source_lines: list[str], line_index: int) -> str:
    """Docs attached to the item at ``source_lines[line_index]``."""
    return extract_docs(attrs_before(source_lines, line_index))


def block_members(block: str) -> list[tuple[str, str]]:
    """Split a ``{ ... }`` body into ``(attributes, member line)`` pairs.

    Attributes may span several lines; a member is any other non-blank,
    non-comment line (a field, an enum case).
    """
    def bracket_delta(text: str) -> int:
        # Brackets inside string literals (doc text) do not nest attributes.
        code = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
        return code.count("[") - code.count("]")

    members: list[tuple[str, str]] = []
    attrs: list[str] = []
    depth = 0
    for line in block.splitlines():
        stripped = line.strip()
        if depth > 0:
            attrs.append(line)
            depth += bracket_delta(stripped)
            continue
        if stripped.startswith("#["):
            attrs.append(line)
            depth = bracket_delta(stripped)
            continue
        if stripped.startswith("///"):
            attrs.append(line)
            continue
        if not stripped or stripped.startswith("//"):
            continue
        members.append(("\n".join(attrs), stripped))
        attrs = []
    return members


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


def parse_structs_and_enums(
    sources: dict[str, str],
) -> tuple[list[dict], list[dict], list[dict]]:
    structs: list[dict] = []
    enums: list[dict] = []
    unions: list[dict] = []
    for module, source in sources.items():
        lines = source.splitlines()
        for index, line in enumerate(lines):
            struct_match = re.match(r"pub(?:\([\w:]+\))? struct (\w+) \{", line)
            enum_match = re.match(r"pub(?:\([\w:]+\))? enum (\w+) \{", line)
            if not struct_match and not enum_match:
                continue
            if not _contract_type(lines, index):
                continue
            brace = source.find("{", _line_offset(lines, index))
            end = match_delimiter(source, brace, "{", "}")
            block = source[brace + 1 : end]
            doc = doc_before(lines, index)
            if struct_match:
                structs.append(
                    {
                        "name": struct_match.group(1),
                        "doc": doc,
                        "fields": _parse_fields(block, module),
                    }
                )
                continue
            name = enum_match.group(1)
            try:
                kind, encoding, cases = _parse_cases(block)
            except ValueError as error:
                # Storage-key enums may use shapes the IR does not model; that
                # only matters if one is reachable, which the type check flags.
                unmodelled.setdefault(name, str(error))
                continue
            if kind == "union":
                unions.append({"name": name, "doc": doc, "cases": cases})
            else:
                enums.append({"name": name, "doc": doc, "encoding": encoding, "cases": cases})
    return structs, enums, unions


unmodelled: dict[str, str] = {}


def _line_offset(lines: list[str], line_index: int) -> int:
    return sum(len(line) + 1 for line in lines[:line_index])


def _parse_fields(block: str, module: str) -> list[dict]:
    fields: list[dict] = []
    for attrs, line in block_members(block):
        match = re.match(r"pub (\w+): (.+),\s*$", line)
        if match:
            fields.append(
                {
                    "name": match.group(1),
                    "type": parse_type(match.group(2)),
                    "doc": extract_docs(attrs),
                }
            )
    declared = len(re.findall(r"^\s*pub \w+:", block, re.MULTILINE))
    if declared != len(fields):
        raise ValueError(
            f"parsed {len(fields)} of {declared} struct fields; the member scan lost some"
        )
    return fields


def _parse_cases(block: str) -> tuple[str, str | None, list[dict]]:
    """Parse enum cases into ``(kind, encoding, cases)``: ``("enum", "symbol"
    | "u32", cases)`` for an all-unit enum, ``("union", None, cases)`` once any
    case carries a tuple payload.

    Soroban encodes a ``#[contracttype]`` enum without integer discriminants
    as ``Vec[Symbol(case), payload...]`` (a unit case is ``Vec[Symbol(case)]``);
    an enum whose cases all carry ``= N`` discriminants is an integer enum and
    encodes as ``u32``. Both shapes are recorded so clients encode correctly.
    """
    cases: list[dict] = []
    has_payload = False
    has_discriminants = False
    for attrs, line in block_members(block):
        match = re.match(r"(\w+)\s*(\((.*)\))?\s*(?:=\s*(\d+))?\s*,?$", line)
        if not match:
            if re.match(r"\w+\s*\{", line):
                raise ValueError(f"struct-like enum case {line!r} is not modelled")
            raise ValueError(f"cannot parse enum case {line!r}")
        case: dict = {"name": match.group(1), "doc": extract_docs(attrs)}
        if match.group(2) is not None:
            has_payload = True
            case["types"] = [parse_type(part) for part in split_top_level(match.group(3))]
        else:
            case["types"] = []
        if match.group(4) is not None:
            has_discriminants = True
            case["value"] = int(match.group(4))
        cases.append(case)
    if has_payload:
        if has_discriminants:
            raise ValueError("payload enum cases cannot carry discriminants")
        return "union", None, cases
    if has_discriminants:
        if not all("value" in case for case in cases):
            raise ValueError("enum mixes explicit and implicit discriminants")
        return "enum", "u32", [
            {"name": c["name"], "value": c["value"], "doc": c["doc"]} for c in cases
        ]
    return "enum", "symbol", [{"name": c["name"], "doc": c["doc"]} for c in cases]


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
        for attrs, field_line in block_members(block):
            field = re.match(r"pub (\w+): (.+),\s*$", field_line)
            if not field:
                continue
            entry = {
                "name": field.group(1),
                "type": parse_type(field.group(2)),
                "doc": extract_docs(attrs),
            }
            is_topic = any(
                line.strip() == "#[topic]" for line in attrs.splitlines()
            )
            (topics if is_topic else data).append(entry)
        declared = len(re.findall(r"^\s*pub \w+:", block, re.MULTILINE))
        if declared != len(topics) + len(data):
            raise ValueError(
                f"event `{name}`: parsed {len(topics) + len(data)} of {declared} fields"
            )
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
    attrs = attrs_before(lines, line_index)
    return any(line.strip().startswith(attribute) for line in attrs.splitlines())


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
    lib = (CONTRACT / "lib.rs").read_text(encoding="utf-8")
    # Types may be declared in lib.rs itself (StreamInput) as well as in the
    # domain modules; constants live only in the modules.
    sources = {
        name: (CONTRACT / f"{name}.rs").read_text(encoding="utf-8") for name in contract_modules(lib)
    }
    type_sources = {"lib": lib, **sources}
    events_source = (CONTRACT / "events.rs").read_text(encoding="utf-8")
    errors_source = (CONTRACT / "errors.rs").read_text(encoding="utf-8")

    functions = parse_functions(lib)
    structs, enums, unions = parse_structs_and_enums(type_sources)
    events = parse_events(events_source)
    errors = parse_errors(errors_source)
    constants = parse_constants(sources)

    reachable = _reachable_types(functions, events, structs, enums, unions)
    structs = [item for item in structs if item["name"] in reachable]
    enums = [item for item in enums if item["name"] in reachable]
    unions = [item for item in unions if item["name"] in reachable]

    return {
        "functions": functions,
        "structs": structs,
        "enums": enums,
        "unions": unions,
        "events": events,
        "errors": errors,
        "constants": constants,
    }


def _reachable_types(
    functions: list[dict],
    events: list[dict],
    structs: list[dict],
    enums: list[dict],
    unions: list[dict],
) -> set[str]:
    struct_map = {item["name"]: item for item in structs}
    enum_map = {item["name"]: item for item in enums}
    union_map = {item["name"]: item for item in unions}
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
        elif name in union_map:
            reachable.add(name)
            for case in union_map[name]["cases"]:
                for case_type in case["types"]:
                    pending.extend(type_names(case_type))
        else:
            reason = unmodelled.get(name, "no #[contracttype] definition was found")
            raise ValueError(
                f"reachable contract type `{name}` is not modelled by the spec IR: {reason}"
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
        "unions": contract["unions"],
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
            ("encoding", "cases"),
        )
    )
    problems.extend(
        _compare_named(
            "union",
            spec.get("unions", []),
            expected["unions"],
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
        SPEC_PATH.write_text(format_spec(expected), encoding="utf-8", newline="\n")
        digest = fingerprint(expected)
        FINGERPRINT_PATH.write_text(digest + "\n", encoding="utf-8", newline="\n")
        print(
            f"spec written: {len(expected['functions'])} operations, "
            f"{len(expected['structs'])} structs, {len(expected['enums'])} enums, "
            f"{len(expected['unions'])} unions, "
            f"{len(expected['events'])} events, sha256 {digest[:12]}…"
        )
        return 0

    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    problems = compare(spec, expected)

    digest = fingerprint(spec)
    if args.update_fingerprint:
        FINGERPRINT_PATH.write_text(digest + "\n", encoding="utf-8", newline="\n")
        print(f"fingerprint updated: {digest}")
    else:
        recorded = FINGERPRINT_PATH.read_text(encoding="utf-8").strip() if FINGERPRINT_PATH.exists() else ""
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
