"""Coverage tests for the schema guard.

The review of the generated-SDK change asked for a test that fails when the
spec's operation set is smaller than the contract's. These tests make that a
property of the repository rather than a one-off manual check:

* every public contract entrypoint must appear in the spec, and
* every entrypoint named by the contract's own ``surface.rs`` branch registry
  must appear as well, so a parser regression cannot quietly shrink the set.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_contract_surface as guard  # noqa: E402


class SpecCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = guard.parse_contract()
        cls.expected = guard.build_spec(cls.contract)
        cls.spec = json.loads(guard.SPEC_PATH.read_text())
        cls.contract_operations = {
            function["name"]
            for function in cls.contract["functions"]
            if function["name"] not in guard.NON_INVOKABLE
        }
        cls.spec_operations = {function["name"] for function in cls.spec["functions"]}

    def test_spec_covers_every_contract_entrypoint(self) -> None:
        missing = sorted(self.contract_operations - self.spec_operations)
        self.assertEqual(
            missing,
            [],
            "the spec is missing contract entrypoints: " + ", ".join(missing),
        )

    def test_spec_has_no_operations_outside_the_contract(self) -> None:
        extra = sorted(self.spec_operations - self.contract_operations)
        self.assertEqual(
            extra,
            [],
            "the spec declares operations the contract does not expose: " + ", ".join(extra),
        )

    def test_spec_covers_the_surface_registry_entrypoints(self) -> None:
        registry_source = (guard.CONTRACT / "surface.rs").read_text()
        start = registry_source.find("pub const fn entrypoints")
        self.assertNotEqual(start, -1, "surface.rs has no entrypoints() registry")
        brace = registry_source.find("{", start)
        end = guard.match_delimiter(registry_source, brace, "{", "}")
        block = registry_source[brace : end + 1]
        named = set(re.findall(r'"(\w+)"', block))
        # The registry also names internal helpers (e.g. `streamed_at`); only
        # real entrypoints are in scope for coverage.
        registry_operations = named & self.contract_operations
        self.assertGreaterEqual(
            len(registry_operations),
            20,
            "the surface registry parse found suspiciously few entrypoints",
        )
        missing = sorted(registry_operations - self.spec_operations)
        self.assertEqual(
            missing,
            [],
            "the spec is missing entrypoints named by surface.rs: " + ", ".join(missing),
        )

    def test_spec_is_exactly_what_the_parser_emits(self) -> None:
        """`--write-spec` must be a no-op on a clean tree."""
        self.assertEqual(
            guard.format_spec(self.spec),
            guard.format_spec(self.expected),
            "streampay.spec.json is stale; run check_contract_surface.py --write-spec",
        )

    def test_spec_matches_the_contract_surface(self) -> None:
        self.assertEqual(guard.compare(self.spec, self.expected), [])

    def test_fingerprint_matches_the_spec(self) -> None:
        recorded = guard.FINGERPRINT_PATH.read_text().strip()
        self.assertEqual(recorded, guard.fingerprint(self.spec))

    def test_payload_enum_variants_keep_their_field_types(self) -> None:
        """A tuple variant is part of the surface; dropping it breaks clients."""
        action = next(
            (enum for enum in self.spec["enums"] if enum["name"] == "GovernanceAction"),
            None,
        )
        self.assertIsNotNone(action, "GovernanceAction is missing from the spec")
        cases = {case["name"]: case for case in action["cases"]}
        self.assertEqual(cases["SetFeeBps"]["types"], ["u32"])
        self.assertEqual(
            cases["SetStreamPolicy"]["types"],
            [{"option": "address"}, "StreamPolicy"],
        )
        self.assertNotIn("types", cases["ExecuteUpgrade"])

    def test_doc_attributes_are_visible_to_the_parser(self) -> None:
        """Docs live behind `cfg_attr(..., doc = "...")`, often multi-line."""
        self.assertEqual(
            guard.normalize_docs(
                '    #[cfg_attr(\n        not(target_family = "wasm"),\n'
                '        doc = " text"\n    )]\n    Variant,\n'
            ),
            "    /// text\n    Variant,\n",
        )


if __name__ == "__main__":
    unittest.main()
