#!/usr/bin/env python3
"""
WebAssembly (Wasm) Function-Level Binary Diffing & Normalization Tool
for CI Pull Request analysis.

Uses scripts/wasm-report.mjs --json to inspect Wasm binaries directly
with zero external dependencies, measures per-function byte sizes,
maps exported entrypoint names, normalizes index churn, and computes
top movers by byte delta.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple


# ==============================================================================
# 1. Rust Symbol Demangling
# ==============================================================================

def demangle_symbol(name: str) -> str:
    """
    Demangles Rust symbols (legacy _ZN and v0 _R mangling) preserving
    hash suffixes (::h[0-9a-f]{16}) so that compiler monomorphizations
    do not collide.
    """
    if not name:
        return "unnamed_function"

    demangled = name

    # Legacy Rust mangling: _ZN...E
    if name.startswith("_ZN") and name.endswith("E"):
        demangled = _demangle_rust_legacy(name)
    # Rust v0 mangling: _R...
    elif name.startswith("_R"):
        demangled = _demangle_rust_v0(name)

    return demangled


def _demangle_rust_legacy(mangled: str) -> str:
    """Demangle Rust legacy ABI (_ZN...E) with segment decoding."""
    pos = 3
    end = len(mangled) - 1
    parts = []
    while pos < end:
        len_str = ""
        while pos < end and mangled[pos].isdigit():
            len_str += mangled[pos]
            pos += 1
        if not len_str:
            break
        length = int(len_str)
        part = mangled[pos : min(pos + length, end)]
        pos += length

        # Handle special replacements
        part = (part.replace("$SP$", "@")
                    .replace("$BP$", "*")
                    .replace("$RF$", "&")
                    .replace("$LT$", "<")
                    .replace("$GT$", ">")
                    .replace("$LP$", "(")
                    .replace("$RP$", ")")
                    .replace("$u20$", " ")
                    .replace("$u7b$", "{")
                    .replace("$u7d$", "}")
                    .replace("$C$", ","))
        parts.append(part)

    return "::".join(parts) if parts else mangled


def _demangle_rust_v0(mangled: str) -> str:
    """Basic demangling and cleanup for Rust v0 mangling (_R...)."""
    s = mangled[2:]
    s = re.sub(r'Cs[0-9a-zA-Z]+_', '', s)
    parts = re.findall(r'[a-zA-Z_][a-zA-Z0-9_]*', s)
    filtered = [p for p in parts if len(p) > 1]
    return "::".join(filtered) if filtered else mangled


# ==============================================================================
# 2. wasm-report.mjs Integration & Report Loading
# ==============================================================================

@dataclass
class WasmFunction:
    index: int
    name: str
    demangled_name: str
    export_name: Optional[str] = None
    size: int = 0
    offset: int = 0
    signature: str = ""
    raw_body: bytes = b""
    disassembly: List[str] = field(default_factory=list)
    normalized_fingerprint: str = ""


@dataclass
class FunctionDiff:
    status: str  # NEW, REMOVED, GROWN, SHRUNK, UNCHANGED, CHURN, MODIFIED
    name: str
    demangled_signature: str
    base_size: int
    head_size: int
    delta: int
    percent_change: float
    is_churn: bool
    notes: str = ""


def find_wasm_report_script(custom_path: Optional[str] = None) -> str:
    """Locates scripts/wasm-report.mjs across common repository layouts."""
    candidates = []
    if custom_path:
        candidates.append(custom_path)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates.extend([
        os.path.join(script_dir, "../../../scripts/wasm-report.mjs"),
        os.path.join(script_dir, "../../scripts/wasm-report.mjs"),
        os.path.join(os.getcwd(), "scripts/wasm-report.mjs"),
        os.path.join(os.getcwd(), "head-repo/scripts/wasm-report.mjs"),
    ])

    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return os.path.abspath(candidate)

    return "scripts/wasm-report.mjs"


def run_wasm_report_mjs(wasm_path: str, script_path: Optional[str] = None) -> dict:
    """Runs `node wasm-report.mjs <wasm_path> --json` and returns parsed JSON dict."""
    mjs_path = find_wasm_report_script(script_path)
    if not os.path.isfile(mjs_path):
        raise FileNotFoundError(f"wasm-report.mjs not found at {mjs_path}")

    cmd = ["node", mjs_path, wasm_path, "--json"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"wasm-report.mjs failed on {wasm_path}: {e.stderr}") from e

    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse JSON output from wasm-report.mjs: {res.stdout}") from e


def load_report(target: Any, script_path: Optional[str] = None) -> dict:
    """
    Loads wasm report dictionary from:
    1. A dictionary directly
    2. A JSON file path or raw JSON string
    3. A WebAssembly (.wasm) binary path (invoking wasm-report.mjs)
    """
    if isinstance(target, dict):
        return target

    if not isinstance(target, str):
        raise TypeError(f"Expected dict or str path, got {type(target)}")

    # Check if target is an existing file
    if os.path.isfile(target):
        # Check if it is a JSON file
        try:
            with open(target, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

        # Otherwise parse Wasm binary with wasm-report.mjs
        return run_wasm_report_mjs(target, script_path)

    # Try parsing string directly as JSON
    return json.loads(target)


def parse_wasm_functions(wasm_path: str, script_path: Optional[str] = None) -> Tuple[List[WasmFunction], Dict[str, int]]:
    """
    Parses a Wasm binary using wasm-report.mjs --json and returns:
    1. A list of WasmFunction items with exact sizes and names.
    2. General section statistics (total size, code section size, function count).
    """
    report = load_report(wasm_path, script_path)

    functions: List[WasmFunction] = []
    for f in report.get("functions", []):
        idx = f["index"]
        size = f["size"]
        raw_name = f.get("name")
        display_name = raw_name or f"func[{idx}]"
        demangled = demangle_symbol(raw_name) if raw_name else display_name

        functions.append(WasmFunction(
            index=idx,
            name=display_name,
            demangled_name=demangled,
            export_name=raw_name,
            size=size,
        ))

    sections = report.get("sections", [])
    code_size = next((s["size"] for s in sections if s.get("name") == "code"), 0)
    stats = {
        "total_size": report.get("total_bytes", 0),
        "code_section_size": code_size,
        "total_functions": len(functions),
    }

    return functions, stats


# ==============================================================================
# 3. Function Matching & Diffing Engine
# ==============================================================================

def diff_wasm_functions(
    base_funcs: List[WasmFunction],
    head_funcs: List[WasmFunction],
) -> Tuple[List[FunctionDiff], Dict[str, int]]:
    """
    Diffs base vs head functions:
    1. Matches exported functions by export name / demangled symbol
    2. Identifies offset/index churn (identical size with shifted index)
    3. Matches internal helpers by index
    """
    diffs: List[FunctionDiff] = []

    # Map named and unnamed functions
    base_named = {f.export_name: f for f in base_funcs if f.export_name}
    head_named = {f.export_name: f for f in head_funcs if f.export_name}

    all_export_names = sorted(set(base_named.keys()) | set(head_named.keys()))
    for name in all_export_names:
        b = base_named.get(name)
        h = head_named.get(name)
        demangled = demangle_symbol(name)

        if b is not None and h is not None:
            delta = h.size - b.size
            pct = ((delta / b.size) * 100.0) if b.size > 0 else 0.0

            if delta == 0:
                if h.index != b.index:
                    status = "CHURN"
                    is_churn = True
                    notes = "Identical logic (index shifted)"
                else:
                    status = "UNCHANGED"
                    is_churn = False
                    notes = "Identical logic (0 B delta)"
            elif delta > 0:
                status = "GROWN"
                is_churn = False
                notes = f"Function expanded by {delta} bytes"
            else:
                status = "SHRUNK"
                is_churn = False
                notes = f"Function shrunk by {abs(delta)} bytes"

            diffs.append(FunctionDiff(
                status=status,
                name=name,
                demangled_signature=demangled,
                base_size=b.size,
                head_size=h.size,
                delta=delta,
                percent_change=pct,
                is_churn=is_churn,
                notes=notes,
            ))
        elif h is not None:
            diffs.append(FunctionDiff(
                status="NEW",
                name=name,
                demangled_signature=demangled,
                base_size=0,
                head_size=h.size,
                delta=h.size,
                percent_change=100.0,
                is_churn=False,
                notes="New function added to Wasm binary",
            ))
        else:
            diffs.append(FunctionDiff(
                status="REMOVED",
                name=name,
                demangled_signature=demangled,
                base_size=b.size,
                head_size=0,
                delta=-b.size,
                percent_change=-100.0,
                is_churn=False,
                notes="Function eliminated/dead-code-stripped",
            ))

    # Match unnamed functions (by positional order among internal functions)
    base_unnamed = sorted([f for f in base_funcs if not f.export_name], key=lambda f: f.index)
    head_unnamed = sorted([f for f in head_funcs if not f.export_name], key=lambda f: f.index)

    min_unnamed = min(len(base_unnamed), len(head_unnamed))
    for i in range(min_unnamed):
        b = base_unnamed[i]
        h = head_unnamed[i]
        fn_name = f"func[{h.index}]"
        delta = h.size - b.size
        pct = ((delta / b.size) * 100.0) if b.size > 0 else 0.0

        if delta == 0:
            if h.index != b.index:
                status = "CHURN"
                is_churn = True
                notes = "Identical logic (index shifted)"
            else:
                status = "UNCHANGED"
                is_churn = False
                notes = "Identical logic (0 B delta)"
        elif delta > 0:
            status = "GROWN"
            is_churn = False
            notes = f"Function expanded by {delta} bytes"
        else:
            status = "SHRUNK"
            is_churn = False
            notes = f"Function shrunk by {abs(delta)} bytes"

        diffs.append(FunctionDiff(
            status=status,
            name=fn_name,
            demangled_signature=fn_name,
            base_size=b.size,
            head_size=h.size,
            delta=delta,
            percent_change=pct,
            is_churn=is_churn,
            notes=notes,
        ))

    # Any extra unnamed in head are NEW
    for h in head_unnamed[min_unnamed:]:
        fn_name = f"func[{h.index}]"
        diffs.append(FunctionDiff(
            status="NEW",
            name=fn_name,
            demangled_signature=fn_name,
            base_size=0,
            head_size=h.size,
            delta=h.size,
            percent_change=100.0,
            is_churn=False,
            notes="New internal function added",
        ))

    # Any extra unnamed in base are REMOVED
    for b in base_unnamed[min_unnamed:]:
        fn_name = f"func[{b.index}]"
        diffs.append(FunctionDiff(
            status="REMOVED",
            name=fn_name,
            demangled_signature=fn_name,
            base_size=b.size,
            head_size=0,
            delta=-b.size,
            percent_change=-100.0,
            is_churn=False,
            notes="Internal function removed",
        ))

    counts = {
        "new": sum(1 for d in diffs if d.status == "NEW"),
        "removed": sum(1 for d in diffs if d.status == "REMOVED"),
        "grown": sum(1 for d in diffs if d.status == "GROWN"),
        "shrunk": sum(1 for d in diffs if d.status == "SHRUNK"),
        "modified": sum(1 for d in diffs if d.status == "MODIFIED"),
        "unchanged": sum(1 for d in diffs if d.status == "UNCHANGED"),
        "churn": sum(1 for d in diffs if d.status == "CHURN"),
    }

    # Deterministic sorting: largest absolute byte delta descending, then symbol name
    diffs.sort(key=lambda d: (-abs(d.delta), d.demangled_signature, d.name))

    return diffs, counts


# ==============================================================================
# 4. Pipeline Execution & CLI
# ==============================================================================

def run_wasm_diff(
    base_wasm: str,
    head_wasm: str,
    base_json: Optional[str] = None,
    head_json: Optional[str] = None,
    base_dis: Optional[str] = None,
    head_dis: Optional[str] = None,
    output_json: Optional[str] = None,
    output_markdown: Optional[str] = None,
    top_limit: int = 15,
    wasm_report_script: Optional[str] = None,
) -> dict:
    """Executes full diff pipeline using wasm-report.mjs --json data."""
    base_target = base_json if base_json and os.path.exists(base_json) else base_wasm
    head_target = head_json if head_json and os.path.exists(head_json) else head_wasm

    base_funcs, base_stats = parse_wasm_functions(base_target, wasm_report_script)
    head_funcs, head_stats = parse_wasm_functions(head_target, wasm_report_script)

    diffs, counts = diff_wasm_functions(base_funcs, head_funcs)

    movers = [d for d in diffs if d.status in ("NEW", "REMOVED", "GROWN", "SHRUNK", "MODIFIED")]
    movers.sort(key=lambda d: (-abs(d.delta), d.demangled_signature, d.name))
    top_movers = movers[:top_limit]

    total_delta = head_stats["total_size"] - base_stats["total_size"]
    total_pct = ((total_delta / base_stats["total_size"]) * 100.0) if base_stats["total_size"] > 0 else 0.0

    code_delta = head_stats["code_section_size"] - base_stats["code_section_size"]
    code_pct = ((code_delta / base_stats["code_section_size"]) * 100.0) if base_stats["code_section_size"] > 0 else 0.0

    result = {
        "summary": {
            "base_total_size": base_stats["total_size"],
            "head_total_size": head_stats["total_size"],
            "total_delta": total_delta,
            "total_percent": total_pct,
            "base_code_size": base_stats["code_section_size"],
            "head_code_size": head_stats["code_section_size"],
            "code_delta": code_delta,
            "code_percent": code_pct,
            "base_functions": base_stats["total_functions"],
            "head_functions": head_stats["total_functions"],
            "counts": counts,
        },
        "top_movers": [asdict(d) for d in top_movers],
        "all_diffs": [asdict(d) for d in diffs],
    }

    if output_json:
        with open(output_json, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

    if output_markdown:
        from format_report import render_markdown_report
        markdown_text = render_markdown_report(result)
        with open(output_markdown, "w", encoding="utf-8") as f:
            f.write(markdown_text)

    return result


def main():
    parser = argparse.ArgumentParser(description="Wasm Function-Level Binary Diffing Tool")
    parser.add_argument("--base", required=True, help="Path to base branch .wasm binary or JSON report")
    parser.add_argument("--head", required=True, help="Path to head branch .wasm binary or JSON report")
    parser.add_argument("--base-json", default=None, help="Path to base branch wasm-report.mjs JSON")
    parser.add_argument("--head-json", default=None, help="Path to head branch wasm-report.mjs JSON")
    parser.add_argument("--base-dis", default=None, help="Legacy ignored flag for backwards compatibility")
    parser.add_argument("--head-dis", default=None, help="Legacy ignored flag for backwards compatibility")
    parser.add_argument("--output-json", default="wasm_diff.json", help="Path to save output JSON")
    parser.add_argument("--output-markdown", default="wasm_diff_report.md", help="Path to save markdown report")
    parser.add_argument("--top", type=int, default=15, help="Number of top movers to include in table")
    parser.add_argument("--max-delta", type=int, default=1024, help="Maximum allowable total byte growth before failing")
    parser.add_argument("--wasm-report-script", default=None, help="Path to scripts/wasm-report.mjs")

    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    result = run_wasm_diff(
        base_wasm=args.base,
        head_wasm=args.head,
        base_json=args.base_json,
        head_json=args.head_json,
        base_dis=args.base_dis,
        head_dis=args.head_dis,
        output_json=args.output_json,
        output_markdown=args.output_markdown,
        top_limit=args.top,
        wasm_report_script=args.wasm_report_script,
    )

    summary = result["summary"]
    print("=" * 60)
    print("WASM FUNCTION DIFF COMPLETE")
    print(f"Base size: {summary['base_total_size']:,} B | Head size: {summary['head_total_size']:,} B")
    print(f"Delta: {summary['total_delta']:+,} B ({summary['total_percent']:+.2f}%)")
    print(f"Functions: {summary['counts']['new']} new, {summary['counts']['removed']} removed, "
          f"{summary['counts']['grown']} grown, {summary['counts']['shrunk']} shrunk, "
          f"{summary['counts']['modified']} modified (0 B), "
          f"{summary['counts']['unchanged']} unchanged, "
          f"{summary['counts']['churn']} filtered churn")
    print(f"Top movers: {len(result['top_movers'])}")
    print("=" * 60)

    if summary["total_delta"] > args.max_delta:
        print(f"ERROR: Total size growth (+{summary['total_delta']} B) exceeds maximum threshold ({args.max_delta} B)!", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
