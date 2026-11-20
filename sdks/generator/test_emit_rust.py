"""Checks on the Rust emitter.

The Rust crate is generated, so the properties that make it a *read-only* SDK
must be asserted here rather than reviewed by hand:

* every ``mutating: false`` operation gets a request builder, a result decoder
  and a client method, and no mutating operation is emitted at all;
* no generated identifier is declared twice;
* the crate carries the spec fingerprint and no ``unsafe`` code.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_contract_surface as guard  # noqa: E402
import emit_rust  # noqa: E402
import generate  # noqa: E402


class RustEmitterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = json.loads(guard.SPEC_PATH.read_text(encoding="utf-8"))
        cls.saved = (emit_rust.SPEC, emit_rust.FINGERPRINT, emit_rust.ERRORS)
        files = emit_rust.outputs(
            cls.spec, guard.fingerprint(cls.spec), generate.load_error_catalog()
        )
        cls.generated = next(
            text for path, text in files.items() if path.name == "generated.rs"
        )
        cls.read_only = [
            function for function in cls.spec["functions"] if not function["mutating"]
        ]
        cls.mutating = [
            function for function in cls.spec["functions"] if function["mutating"]
        ]

    @classmethod
    def tearDownClass(cls) -> None:
        (emit_rust.SPEC, emit_rust.FINGERPRINT, emit_rust.ERRORS) = cls.saved

    def test_every_read_operation_is_exposed(self) -> None:
        for function in self.read_only:
            name = function["name"]
            with self.subTest(operation=name):
                self.assertIn(f"pub fn {name}_args(", self.generated)
                self.assertIn(f"pub fn decode_{name}_result(", self.generated)
                self.assertIn(f"    pub fn {name}(", self.generated)
                self.assertIn(
                    f'pub const {name.upper()}: &str = "{name}";', self.generated
                )

    def test_no_mutating_operation_is_emitted(self) -> None:
        for function in self.mutating:
            name = function["name"]
            with self.subTest(operation=name):
                self.assertNotIn(f"pub fn {name}_args(", self.generated)
                self.assertNotIn(f"pub fn decode_{name}_result(", self.generated)
                self.assertNotIn(
                    f'pub const {name.upper()}: &str = "{name}";', self.generated
                )

    def test_generated_identifiers_are_declared_once(self) -> None:
        # Top-level items only: `impl` blocks legitimately repeat method names
        # (`from_scval`, `name`, `ALL`) across types.
        names = re.findall(
            r"^pub (?:fn|struct|enum|const) ([A-Za-z0-9_]+)", self.generated, re.MULTILINE
        )
        duplicates = sorted({name for name in names if names.count(name) > 1})
        self.assertEqual(duplicates, [], f"generated.rs re-declares {duplicates}")

    def test_error_enum_comes_from_the_catalog(self) -> None:
        for code, name in generate.load_error_catalog():
            with self.subTest(error=name):
                self.assertIn(f"    {name} = {code},", self.generated)
        self.assertIn("pub enum StreamError {", self.generated)

    def test_generated_rust_is_unsafe_free_and_fingerprinted(self) -> None:
        self.assertNotIn("unsafe", self.generated)
        self.assertIn(
            f'pub const SPEC_FINGERPRINT: &str = "{guard.fingerprint(self.spec)}";',
            self.generated,
        )


if __name__ == "__main__":
    unittest.main()
