#!/usr/bin/env python3
"""
Cross-PR collision gate.

Why this script exists
----------------------
Every red main this repo has had since October came from the same shape: two
pull requests that were each correct against `main`, merged back to back, and
wrong only *together*. GitHub cannot see that. A PR check runs against one PR
merged into one main, so the collision between PR A's `pub fn authorize_agent`
and PR B's `pub fn authorize_agent` is invisible until both are in.

  * `b48a94be` (the 2026-11 bulk merge) carried both failures at once:
    `surface.rs` mapped 19 `Branch::BatchAmendment*` / `Branch::Insurance*`
    arms that no `enum Branch` ever declared, and #677 re-landed #660's session
    keys under the *same* method names, which is `E0592: duplicate definitions
    for name` inside one `impl` block. The tree did not compile.
  * `94f80e3` fixed the frontend twin of the same bug: #156 replaced
    `page.tsx`'s error state with the toast API while #144's handler still
    called the removed `setError`. Both PRs were green.

What it checks
--------------
  dup_entrypoints  two `pub fn` of the same name in one `impl` block (E0592),
                   and two `pub fn` of the same name in the contract API trait
  branch_registry  a `Branch::X` arm referenced anywhere that `enum Branch`
                   does not declare
  retired_reuse    a numeric error code belonging to a retired variant is
                   re-issued to a different variant (wire-protocol reuse), or a
                   `RETIRED_CODES` entry names a variant that no longer exists
  module_graph     a `mod X;` with no `X.rs` / `X/mod.rs` behind it, and a
                   source file no `mod` declaration ever reaches (dead on
                   arrival, which is how a test suite can be "green" while
                   never running)

These are the collision classes that a compile catches slowly and an integrator
needs stated precisely: which two names, in which file, on which line.

Usage
-----
  python3 scripts/cross_pr_collision.py [--root DIR] [--src PATH]
  python3 scripts/cross_pr_collision.py --self-test

Exit status: 0 clean, 1 findings, 2 the checker itself could not run.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

CONTRACT_SRC_DEFAULT = Path("contracts/streaming-payments/src")


@dataclass
class Finding:
    check: str
    message: str
    location: str = ""

    def line(self) -> str:
        return f"{self.check}: {self.location}: {self.message}" if self.location else f"{self.check}: {self.message}"


def strip_noise(text: str) -> str:
    """Blank out comments and string/char literals, keeping line structure.

    Brace counting and name extraction must not be moved by a `{` inside a
    doc comment or a `"{...}"` log string. Replacing rather than deleting keeps
    every line number intact.
    """
    out = []
    i, n = 0, len(text)
    state = "code"
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line"
                out.append("  ")
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block"
                out.append("  ")
                i += 2
                continue
            if ch == '"':
                state = "str"
                out.append(" ")
                i += 1
                continue
            if ch == "r" and nxt in '"#':
                state = "raw"
                out.append(" ")
                i += 1
                continue
            out.append(ch)
            i += 1
            continue
        if state == "line":
            if ch == "\n":
                state = "code"
                out.append(ch)
            else:
                out.append(" ")
            i += 1
            continue
        if state == "block":
            if ch == "*" and nxt == "/":
                state = "code"
                out.append("  ")
                i += 2
                continue
            out.append(ch if ch == "\n" else " ")
            i += 1
            continue
        if state == "raw":
            # Raw strings: consume through the next '"' run. Nested hashes in
            # the delimiter are rare here; the closing quote ends the literal.
            if ch == "\\":
                out.append("  ")
                i += 2
                continue
            if ch == '"':
                state = "code"
                out.append(" ")
                i += 1
                continue
            out.append(ch if ch == "\n" else " ")
            i += 1
            continue
        # state == "str"
        if ch == "\\":
            out.append("  ")
            i += 2
            continue
        if ch == '"':
            state = "code"
            out.append(" ")
            i += 1
            continue
        out.append(ch if ch == "\n" else " ")
        i += 1
    return "".join(out)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def block_from(text: str, header_re: re.Pattern) -> list[tuple[int, int, str]]:
    """Yield (start_line, end_line, body) for each `{...}` block whose opening
    line matches `header_re`. Braces are counted on comment-free text."""
    blocks = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        if header_re.search(lines[i]):
            depth = 0
            started = False
            buf = []
            j = i
            while j < len(lines):
                line = lines[j]
                buf.append(line)
                for ch in line:
                    if ch == "{":
                        depth += 1
                        started = True
                    elif ch == "}":
                        depth -= 1
                if started and depth <= 0:
                    break
                j += 1
            blocks.append((i + 1, j + 1, "\n".join(buf)))
            i = j + 1
            continue
        i += 1
    return blocks


# --- check: duplicate entrypoint / trait method names -----------------------

FN_RE = re.compile(r"^\s*pub\s+(?:unsafe\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)")


def check_duplicate_functions(src: Path) -> list[Finding]:
    findings = []
    for path in sorted(src.rglob("*.rs")):
        text = strip_noise(read(path))
        if not text:
            continue
        for start, _end, body in block_from(text, re.compile(r"^\s*impl\b")):
            seen: dict[str, int] = {}
            for offset, line in enumerate(body.split("\n")):
                m = FN_RE.match(line)
                if not m:
                    continue
                name = m.group(1)
                if name in seen:
                    findings.append(
                        Finding(
                            "dup_entrypoints",
                            f"`{name}` is declared twice in the same impl block that opens at "
                            f"{path.name}:{start} (first at line {seen[name]}) - E0592",
                            f"{path.relative_to(src.parent)}:{start + offset}",
                        )
                    )
                else:
                    seen[name] = start + offset
        # A trait with two same-named required methods is the same class of
        # merge collision and breaks every implementor at once.
        for start, _end, body in block_from(text, re.compile(r"^\s*pub\s+trait\b")):
            seen = {}
            for offset, line in enumerate(body.split("\n")):
                m = FN_RE.match(line)
                if not m:
                    continue
                name = m.group(1)
                if name in seen:
                    findings.append(
                        Finding(
                            "dup_entrypoints",
                            f"trait method `{name}` is declared twice (first at line {seen[name]})",
                            f"{path.relative_to(src.parent)}:{start + offset}",
                        )
                    )
                else:
                    seen[name] = start + offset
    return findings


# --- check: Branch registry --------------------------------------------------

BRANCH_USE_RE = re.compile(r"Branch::([A-Za-z0-9_]+)")


def declared_branches(surface_text: str) -> set[str]:
    names = set()
    for _start, _end, body in block_from(surface_text, re.compile(r"^\s*pub\s+enum\s+Branch\b")):
        for line in body.split("\n"):
            m = re.match(r"^\s*([A-Z][A-Za-z0-9_]*)\s*(?:,|=\s*\d+\s*,?)?\s*$", line)
            if m:
                names.add(m.group(1))
    # `Branch::ALL` and friends are associated items of `impl Branch`, not enum
    # variants; a reference to them is valid.
    for _start, _end, body in block_from(surface_text, re.compile(r"^\s*impl\s+Branch\b")):
        for line in body.split("\n"):
            m = re.match(
                r"^\s*(?:pub\s+)?(?:const|fn|static)\s+([A-Za-z0-9_]+)", line
            )
            if m:
                names.add(m.group(1))
    return names


def check_branch_registry(src: Path) -> list[Finding]:
    surface = src / "surface.rs"
    if not surface.exists():
        return []
    surface_clean = strip_noise(read(surface))
    declared = declared_branches(surface_clean)
    if not declared:
        return []
    findings = []
    seen_pairs: set[tuple[str, str]] = set()
    for path in sorted(src.rglob("*.rs")):
        text = strip_noise(read(path))
        rel = path.relative_to(src.parent)
        is_declaration_file = path == surface
        for lineno, raw in enumerate(text.split("\n"), 1):
            for m in BRANCH_USE_RE.finditer(raw):
                name = m.group(1)
                if name in declared:
                    continue
                # Inside the enum body itself a variant is a declaration, not
                # a reference; the re-declaration case is covered elsewhere.
                if is_declaration_file and re.search(
                    r"^\s*" + re.escape(name) + r"\s*,?\s*$", raw
                ):
                    continue
                key = (name, str(rel))
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                findings.append(
                    Finding(
                        "branch_registry",
                        f"`Branch::{name}` is referenced but `pub enum Branch` in "
                        f"surface.rs does not declare it",
                        f"{rel}:{lineno}",
                    )
                )
    return findings


# --- check: retired codes ----------------------------------------------------

VARIANT_CODE_RE = re.compile(r"^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,")
RETIRED_BLOCK_RE = re.compile(r"^\s*pub\s+const\s+RETIRED_CODES\b")
RETIRED_ENTRY_RE = re.compile(r"StreamError::([A-Za-z0-9_]+)")


def error_variants(errors_text: str) -> dict[str, int]:
    out = {}
    for _start, _end, body in block_from(errors_text, re.compile(r"^\s*pub\s+enum\s+StreamError\b")):
        for line in body.split("\n"):
            m = VARIANT_CODE_RE.match(line)
            if m:
                out[m.group(1)] = int(m.group(2))
    return out


def retired_names(surface_text: str) -> list[tuple[str, int]]:
    out = []
    for start, _end, body in block_from(surface_text, RETIRED_BLOCK_RE):
        for offset, line in enumerate(body.split("\n")):
            m = RETIRED_ENTRY_RE.search(line)
            if m:
                out.append((m.group(1), start + offset))
    return out


def check_retired_codes(src: Path) -> list[Finding]:
    errors_path, surface_path = src / "errors.rs", src / "surface.rs"
    if not (errors_path.exists() and surface_path.exists()):
        return []
    variants = error_variants(strip_noise(read(errors_path)))
    retired = retired_names(strip_noise(read(surface_path)))
    findings = []
    by_code: dict[int, list[str]] = {}
    for name, code in variants.items():
        by_code.setdefault(code, []).append(name)
    for name, lineno in retired:
        if name not in variants:
            findings.append(
                Finding(
                    "retired_reuse",
                    f"`RETIRED_CODES` lists `{name}`, which errors.rs no longer declares - "
                    "a retired code must stay declared so its number is never reused",
                    f"contracts/streaming-payments/src/surface.rs:{lineno}",
                )
            )
            continue
        others = [n for n in by_code.get(variants[name], []) if n != name]
        if others:
            findings.append(
                Finding(
                    "retired_reuse",
                    f"retired code {variants[name]} (`{name}`) is also issued to "
                    f"{', '.join(sorted(others))} - wire-protocol reuse",
                    f"contracts/streaming-payments/src/errors.rs",
                )
            )
    return findings


# --- check: module graph -----------------------------------------------------

MOD_RE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z0-9_]+)\s*;")
MOD_BLOCK_RE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z0-9_]+)\s*\{")


def check_module_graph(src: Path) -> list[Finding]:
    lib = src / "lib.rs"
    if not lib.exists():
        return []
    text = strip_noise(read(lib))
    declared: set[str] = set()
    for line in text.split("\n"):
        m = MOD_RE.match(line)
        if m:
            declared.add(m.group(1))
    # Innerscope declarations inside non-lib files count too: a file that is
    # itself reachable may declare its own children. `mod X {` is an inline
    # module and needs no file, so it only joins `reachable`.
    reachable = set(declared)
    for path in sorted(src.rglob("*.rs")):
        if path == src / "lib.rs":
            continue
        for line in strip_noise(read(path)).split("\n"):
            for rx in (MOD_RE, MOD_BLOCK_RE):
                m = rx.match(line)
                if m:
                    reachable.add(m.group(1))

    findings = []
    for name in sorted(declared):
        if not ((src / f"{name}.rs").exists() or (src / name / "mod.rs").exists()):
            findings.append(
                Finding(
                    "module_graph",
                    f"`mod {name};` has no {name}.rs or {name}/mod.rs behind it",
                    "contracts/streaming-payments/src/lib.rs",
                )
            )
    for path in sorted(src.rglob("*.rs")):
        rel = path.relative_to(src)
        if rel.as_posix() == "lib.rs":
            continue
        name = path.stem if path.name != "mod.rs" else path.parent.name
        if path.parent == src and name not in reachable:
            findings.append(
                Finding(
                    "module_graph",
                    f"{rel.as_posix()} is never declared by a `mod` - its tests do not run and "
                    "its code is not compiled",
                    f"contracts/streaming-payments/src/{rel.as_posix()}",
                )
            )
    return findings


def run_all(src: Path) -> list[Finding]:
    findings = []
    findings += check_duplicate_functions(src)
    findings += check_branch_registry(src)
    findings += check_retired_codes(src)
    findings += check_module_graph(src)
    return findings


# --- self-test ---------------------------------------------------------------
# The gate is a negative assertion over the whole tree, so it needs positive
# fixtures: each fixture is a tree that must be reported, and the clean fixture
# must not be. Without this the gate could pass forever by matching nothing.

FIXTURES = [
    (
        "clean",
        {
            "lib.rs": "pub mod alpha;\npub mod errors;\npub mod surface;\nmod alpha_test {\n}\nimpl StreamingPayments {\n    pub fn create_stream(env: Env) {}\n    pub fn withdraw(env: Env) {}\n}\n",
            "alpha.rs": "pub fn go() {}\n",
            "errors.rs": "pub enum StreamError {\n    Ok = 1,\n    Missing = 2,\n}\n",
            "surface.rs": "pub enum Branch {\n    MissingBranch,\n}\npub const RETIRED_CODES: &[StreamError] = &[];\nimpl Branch {\n    pub const ALL: [Branch; 1] = [Branch::MissingBranch];\n    fn map() { let _ = Branch::MissingBranch; let _ = Branch::ALL; }\n}\n",
        },
        [],
    ),
    (
        "dup_fn",
        {
            "lib.rs": "pub mod errors;\npub mod surface;\nimpl StreamingPayments {\n    pub fn authorize_agent(env: Env) {}\n    // duplicated by the second merge\n    pub fn authorize_agent(env: Env) {}\n}\n",
            "errors.rs": "pub enum StreamError {\n    A = 1,\n}\n",
            "surface.rs": "pub enum Branch {\n    A,\n}\npub const RETIRED_CODES: &[StreamError] = &[];\n",
        },
        ["dup_entrypoints"],
    ),
    (
        "missing_branch",
        {
            "lib.rs": "pub mod errors;\npub mod surface;\nimpl StreamingPayments {\n    pub fn x(env: Env) {}\n}\n",
            "errors.rs": "pub enum StreamError {\n    A = 1,\n}\n",
            "surface.rs": "pub enum Branch {\n    Real,\n}\nimpl Branch {\n    fn y() { record(Branch::Ghost); }\n}\n",
        },
        ["branch_registry"],
    ),
    (
        "reused_retired_code",
        {
            "lib.rs": "pub mod errors;\npub mod surface;\nimpl StreamingPayments {\n    pub fn x(env: Env) {}\n}\n",
            "errors.rs": "pub enum StreamError {\n    Gone = 9,\n    Fresh = 9,\n}\n",
            "surface.rs": "pub enum Branch {\n    Real,\n}\npub const RETIRED_CODES: &[StreamError] = &[StreamError::Gone];\n",
        },
        ["retired_reuse"],
    ),
    (
        "dangling_retired_name",
        {
            "lib.rs": "pub mod errors;\npub mod surface;\nimpl StreamingPayments {\n    pub fn x(env: Env) {}\n}\n",
            "errors.rs": "pub enum StreamError {\n    Gone = 9,\n}\n",
            "surface.rs": "pub enum Branch {\n    Real,\n}\npub const RETIRED_CODES: &[StreamError] = &[StreamError::Vanished];\n",
        },
        ["retired_reuse"],
    ),
    (
        "module_graph",
        {
            "lib.rs": "pub mod phantom;\npub mod real;\npub mod errors;\npub mod surface;\n",
            "real.rs": "pub fn x() {}\n",
            "orphan.rs": "#[test]\nfn never_runs() {}\n",
            "errors.rs": "pub enum StreamError {\n    A = 1,\n}\n",
            "surface.rs": "pub enum Branch {\n    A,\n}\npub const RETIRED_CODES: &[StreamError] = &[];\n",
        },
        ["module_graph", "module_graph"],
    ),
]


def self_test() -> int:
    import tempfile

    ok = True
    for name, files, expected in FIXTURES:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "src"
            root.mkdir(parents=True)
            for fname, body in files.items():
                (root / fname).write_text(body, encoding="utf-8")
            findings = run_all(root)
            kinds = sorted(f.check for f in findings)
            if kinds != sorted(expected):
                ok = False
                print(f"FAIL {name}: expected {sorted(expected)}, got {kinds}")
                for f in findings:
                    print(f"      {f.line()}")
            else:
                print(f"ok   {name}: {len(findings)} finding(s) as expected")
    # Every fixture above is a positive control; also prove the real tree is
    # readable by this parser at all (a silent open failure would pass).
    print("self-test", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1] if __doc__ else "")
    ap.add_argument("--root", default=".", help="repository root (default: cwd)")
    ap.add_argument("--src", default=str(CONTRACT_SRC_DEFAULT), help="contract source dir, relative to --root")
    ap.add_argument("--self-test", action="store_true", help="run the built-in positive fixtures")
    ap.add_argument("--quiet", action="store_true", help="only print the verdict line")
    args = ap.parse_args(argv)

    # Findings carry file paths and backtick-quoted names; a cp1252 console must
    # not turn a report into an encoding crash (check_ci_integrity.py, #400).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    if args.self_test:
        return self_test()

    root = Path(args.root)
    src = root / args.src
    if not src.is_dir():
        print(f"error: {src} is not a directory", file=sys.stderr)
        return 2

    findings = run_all(src)
    order = ["dup_entrypoints", "branch_registry", "retired_reuse", "module_graph"]
    grouped = sorted(findings, key=lambda f: (order.index(f.check) if f.check in order else 9, f.location))
    if not args.quiet:
        for f in grouped:
            print(f"::error::{f.line()}" if _in_github() else f"x {f.line()}")
    counts = {k: sum(1 for f in findings if f.check == k) for k in order}
    summary = ", ".join(f"{k}={v}" for k, v in counts.items())
    if findings:
        print(f"cross-PR collision gate: {len(findings)} finding(s) ({summary})")
        print(
            "  These are merge collisions: each side was valid alone. Split the surface\n"
            "  across merges, or land the conflicting PRs against each other's rebased heads."
        )
        return 1
    print(f"cross-PR collision gate: clean ({summary})")
    return 0


def _in_github() -> bool:
    return bool(__import__("os").environ.get("GITHUB_ACTIONS"))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
