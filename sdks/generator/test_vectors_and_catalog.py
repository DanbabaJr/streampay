"""Language-independent checks on the shared inputs every SDK consumes.

* The generator reads error codes from the canonical catalog
  (``frontend/lib/errors.ts``) instead of keeping its own table, so the catalog
  reader must see every ``StreamError`` variant with its contract code.
* Every conformance vector in ``sdks/vectors`` must be built from the current
  spec and only name operations, arguments and events the spec declares, so a
  language SDK that passes the vectors is exercising the real surface.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_contract_surface as guard  # noqa: E402
import generate  # noqa: E402

VECTORS_DIR = guard.ROOT / "sdks" / "vectors"


class ErrorCatalogTest(unittest.TestCase):
    def test_catalog_reader_matches_the_contract_error_enum(self) -> None:
        contract = {
            item["code"]: item["name"]
            for item in guard.parse_errors((guard.CONTRACT / "errors.rs").read_text(encoding="utf-8"))
        }
        catalog = dict(generate.load_error_catalog())
        self.assertEqual(catalog, contract)

    def test_oracle_codes_are_read_from_the_catalog(self) -> None:
        catalog = dict(generate.load_error_catalog())
        self.assertEqual(
            {code: catalog.get(code) for code in (56, 57, 58, 59)},
            {
                56: "InvalidOracleThreshold",
                57: "OraclePublishersNotConfigured",
                58: "OracleReportTooOld",
                59: "NotOraclePublisher",
            },
        )


class ConformanceVectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = json.loads(guard.SPEC_PATH.read_text(encoding="utf-8"))
        cls.fingerprint = guard.FINGERPRINT_PATH.read_text(encoding="utf-8").strip()
        cls.functions = {item["name"]: item for item in cls.spec["functions"]}
        cls.events = {item["name"]: item for item in cls.spec["events"]}
        cls.catalog = dict(generate.load_error_catalog())
        cls.vectors = {
            path.name: json.loads(path.read_text(encoding="utf-8")) for path in sorted(VECTORS_DIR.glob("*.json"))
        }

    def test_suite_is_present(self) -> None:
        self.assertGreaterEqual(len(self.vectors), 5)

    def test_vectors_are_built_from_the_current_spec(self) -> None:
        for name, vector in self.vectors.items():
            with self.subTest(vector=name):
                self.assertEqual(vector["schema"], "streampay-vector/v1")
                self.assertEqual(
                    vector["specFingerprint"],
                    self.fingerprint,
                    "regenerate: cd sdks/vectors/builder && node build-vectors.mjs",
                )

    def test_vectors_only_use_declared_operations_and_events(self) -> None:
        for name, vector in self.vectors.items():
            expected = vector["expected"]
            with self.subTest(vector=name):
                function = self.functions.get(expected["transaction"]["function"])
                self.assertIsNotNone(function, "vector calls an operation outside the spec")
                self.assertEqual(
                    list(expected["transaction"]["args"]),
                    [arg["name"] for arg in function["args"]],
                )
                self.assertEqual(len(vector["eventsXdr"]), len(expected["events"]))
                for event in expected["events"]:
                    spec_event = self.events.get(event["name"])
                    self.assertIsNotNone(spec_event, f"event {event['name']} is not in the spec")
                    self.assertEqual(
                        sorted(event["topics"]),
                        sorted(field["name"] for field in spec_event["topicFields"]),
                    )
                    self.assertEqual(
                        sorted(event["data"]),
                        sorted(field["name"] for field in spec_event["dataFields"]),
                    )
                error = expected["result"].get("error")
                if error is not None:
                    self.assertEqual(self.catalog.get(error["code"]), error["name"])


if __name__ == "__main__":
    unittest.main()
