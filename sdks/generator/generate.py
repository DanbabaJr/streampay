#!/usr/bin/env python3
"""Generate StreamPay client code from the canonical spec.

Inputs
  * ``sdks/spec/streampay.spec.json`` — the spec IR, derived from the Rust
    contract by ``check_contract_surface.py --write-spec``.
  * ``frontend/lib/errors.ts`` — the canonical error catalog (itself generated
    from ``contracts/streaming-payments/src/errors.rs`` and gated in CI). The
    generator reads error codes and names from it; no language target keeps a
    second error table.

Targets
  Each language target is an ``emit_<language>.py`` module next to this file
  exposing ``PACKAGE_DIR`` and ``outputs(spec, fingerprint, errors)``. A target
  is generated only when its package directory exists in the checkout, so the
  shared spec/generator change carries no language package, and each language
  change adds its package plus its emitter and is covered by the same
  ``--check`` gate.

The output is deterministic, so ``--check`` is a valid CI gate: regeneration
must be a no-op.

Usage
  python3 sdks/generator/generate.py           # write generated files
  python3 sdks/generator/generate.py --check   # fail if outputs are stale
"""
from __future__ import annotations

import argparse
import difflib
import importlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from check_contract_surface import fingerprint  # noqa: E402

ROOT = HERE.parents[1]
SPEC_PATH = ROOT / "sdks" / "spec" / "streampay.spec.json"
CATALOG_PATH = ROOT / "frontend" / "lib" / "errors.ts"


def load_spec() -> dict:
    return json.loads(SPEC_PATH.read_text(encoding="utf-8"))


def load_error_catalog(path: Path = CATALOG_PATH) -> list[tuple[int, str]]:
    """Read ``(code, name)`` pairs from the canonical error catalog.

    The SDKs must not keep a second error table: codes and names come from
    ``frontend/lib/errors.ts``, which CI already gates against ``errors.rs``.
    """
    text = path.read_text(encoding="utf-8")
    entries = [
        (int(code), name)
        for code, name in re.findall(
            r"^\s*(\d+):\s*\{\s*code:\s*\d+,\s*name:\s*\"(\w+)\"",
            text,
            re.MULTILINE,
        )
    ]
    if not entries:
        raise ValueError(f"could not read the error catalog from {path}")
    if len({code for code, _ in entries}) != len(entries):
        raise ValueError("duplicate error codes in the catalog")
    return sorted(entries)


def emitters() -> list[object]:
    """Language emitters whose package exists in this checkout."""
    found = []
    for path in sorted(HERE.glob("emit_*.py")):
        module = importlib.import_module(path.stem)
        if Path(module.PACKAGE_DIR).is_dir():
            found.append(module)
    return found


def outputs() -> dict[Path, str]:
    spec = load_spec()
    digest = fingerprint(spec)
    errors = load_error_catalog()
    targets: dict[Path, str] = {}
    for module in emitters():
        targets.update(module.outputs(spec, digest, errors))
    return targets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when the committed files differ from the generator output",
    )
    args = parser.parse_args()

    spec = load_spec()
    digest = fingerprint(spec)
    targets = outputs()

    stale = False
    for path, content in targets.items():
        if args.check:
            existing = path.read_text(encoding="utf-8") if path.exists() else ""
            if existing != content:
                stale = True
                diff = difflib.unified_diff(
                    existing.splitlines(keepends=True),
                    content.splitlines(keepends=True),
                    fromfile=str(path),
                    tofile=str(path) + " (generated)",
                )
                sys.stderr.writelines(list(diff)[:80])
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
            print(f"wrote {path.relative_to(ROOT)}")
    if args.check and stale:
        print(
            "generated clients are stale; run `python3 sdks/generator/generate.py`",
            file=sys.stderr,
        )
        return 1
    if args.check:
        print(
            f"generated clients match the spec: {len(spec['functions'])} operations, "
            f"{len(targets)} file(s), sha256 {digest[:12]}…"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
