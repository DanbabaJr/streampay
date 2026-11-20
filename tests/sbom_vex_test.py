#!/usr/bin/env python3
"""Self-tests for the CycloneDX SBOM + VEX advisory gate (issue #612).

Each test breaks one control and requires the gate to block:

  * an injected advisory with no VEX entry (the explicit requirement)
  * an expired VEX entry, and one with no justification or owner
  * a critical advisory left under_investigation
  * SBOM drift against the lockfile, and against the committed baseline
  * an SBOM with an unresolved version, and an artifact no SBOM covers
  * a duplicated VEX entry

Run: python3 tests/sbom_vex_test.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_gate():
    spec = importlib.util.spec_from_file_location("sbom_vex", ROOT / "scripts" / "sbom_vex.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


GATE = load_gate()
TODAY = "2026-11-20"


def vex_entry(ident, state="not_affected", *, expires="2027-06-30", package="left-pad",
              version="1.3.0", justification="code_not_reachable", owner="security",
              detail="Not reachable from the indexer's hot path.", affects=True):
    entry = {
        "id": ident,
        "source": {"name": "npm-audit"},
        "analysis": {"state": state, "detail": detail},
        "properties": [
            {"name": GATE.PROP_OWNER, "value": owner},
            {"name": GATE.PROP_REVIEWED, "value": "2026-11-01"},
            {"name": GATE.PROP_EXPIRES, "value": expires},
        ],
    }
    if justification:
        entry["analysis"]["justification"] = justification
    if affects:
        entry["affects"] = [{"ref": f"pkg:npm/{package}@{version}"}]
    return entry


class SbomVexGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.sbom = self.dir / "indexer.cdx.json"
        self.lock = self.dir / "package-lock.json"
        self.audit = self.dir / "npm-audit.json"
        self.vex = self.dir / "vex.json"
        self.baseline = self.dir / "baseline.json"
        self.artifact = self.dir / "indexer.tgz"

        self.write_sbom()
        self.lock.write_text(
            json.dumps(
                {
                    "name": "streampay-indexer",
                    "lockfileVersion": 3,
                    "packages": {
                        "": {"name": "streampay-indexer", "version": "0.1.0"},
                        "node_modules/left-pad": {"version": "1.3.0"},
                        "node_modules/express": {"version": "5.1.0"},
                    },
                }
            ),
            encoding="utf-8",
        )
        self.audit.write_text(
            json.dumps(
                {
                    "vulnerabilities": {
                        "left-pad": {
                            "severity": "high",
                            "via": [
                                {
                                    "source": "GHSA-aaaa-bbbb-cccc",
                                    "name": "left-pad",
                                    "severity": "high",
                                    "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
                                }
                            ],
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc")])
        self.write_artifact()

    def tearDown(self):
        self.tmp.cleanup()

    # ── fixtures ────────────────────────────────────────────────────────────
    def write_sbom(self, components=None):
        components = components if components is not None else [
            {
                "type": "library",
                "name": "left-pad",
                "version": "1.3.0",
                "purl": "pkg:npm/left-pad@1.3.0",
                "hashes": [{"alg": "SHA-256", "content": "a" * 64}],
            },
            {
                "type": "library",
                "name": "express",
                "version": "5.1.0",
                "purl": "pkg:npm/express@5.1.0",
            },
        ]
        self.sbom.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "version": 1,
                    "metadata": {
                        "component": {"type": "application", "name": "streampay-indexer", "version": "0.1.0"}
                    },
                    "components": components,
                }
            ),
            encoding="utf-8",
        )

    def write_vex(self, entries):
        self.vex.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "version": 1,
                    "metadata": {"timestamp": "2026-11-01T00:00:00Z"},
                    "vulnerabilities": entries,
                }
            ),
            encoding="utf-8",
        )

    def write_artifact(self, payload: bytes = b"indexer tarball"):
        self.artifact.write_bytes(payload)

    def run_gate(self, *extra, sbom=True, lock=True, advisories=True):
        argv = ["--vex", str(self.vex), "--today", TODAY, "--index-out", str(self.dir / "sbom-index.json")]
        if sbom:
            argv += ["--sbom", f"indexer={self.sbom}", "--artifact", f"indexer={self.artifact}"]
        if lock:
            argv += ["--lock", f"indexer={self.lock}"]
        if advisories:
            argv += ["--advisories", f"npm-audit={self.audit}"]
        argv += list(extra)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = GATE.main(argv)
        return code, buffer.getvalue()

    def assert_blocks(self, code, output, needle):
        self.assertEqual(code, 1, output)
        self.assertIn(needle, output)

    # ── the happy path ──────────────────────────────────────────────────────
    def test_clean_release_passes_and_indexes_artifact(self):
        code, output = self.run_gate()
        self.assertEqual(code, 0, output)
        index = json.loads((self.dir / "sbom-index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["schema"], GATE.SCHEMA_INDEX)
        artifact = index["artifacts"][0]
        self.assertEqual(artifact["name"], "indexer")
        self.assertEqual(len(artifact["sbom_sha256"]), 64)
        self.assertEqual(artifact["components"], 2)
        self.assertEqual(index["vex"]["sha256"], GATE.sha256_file(self.vex))

    # ── injected advisory must block ────────────────────────────────────────
    def test_injected_advisory_without_vex_blocks(self):
        self.write_vex([])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "has no VEX entry")

    def test_injected_critical_advisory_from_pip_audit_blocks(self):
        pip = self.dir / "pip-audit.json"
        pip.write_text(
            json.dumps({"dependencies": [{"name": "requests", "version": "2.0.0",
                                          "vulns": [{"id": "PYSEC-2026-1", "fix_versions": ["2.32.0"]}]}]}),
            encoding="utf-8",
        )
        code, output = self.run_gate("--advisories", f"pip-audit={pip}")
        self.assert_blocks(code, output, "PYSEC-2026-1")

    def test_cargo_deny_findings_are_normalised(self):
        cargo = self.dir / "cargo-deny.json"
        cargo.write_text(
            json.dumps(
                {
                    "advisories": {
                        "found": [
                            {
                                "advisory": {"id": "RUSTSEC-2024-0436", "severity": None, "cvss": 9.8},
                                "package": {"name": "paste", "version": "1.0.15"},
                            }
                        ]
                    }
                }
            ),
            encoding="utf-8",
        )
        code, output = self.run_gate("--advisories", f"cargo-deny={cargo}")
        self.assert_blocks(code, output, "RUSTSEC-2024-0436")

    # ── VEX quality ─────────────────────────────────────────────────────────
    def test_expired_vex_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc", expires="2026-01-01")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "VEX expired")

    def test_not_affected_without_justification_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc", justification="")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "requires a CycloneDX justification")

    def test_missing_owner_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc", owner="")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "who owns this triage")

    def test_empty_detail_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc", detail="")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "silent suppression")

    def test_critical_under_investigation_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc", state="under_investigation")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "still under_investigation")

    def test_duplicate_vex_entry_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc"), vex_entry("GHSA-aaaa-bbbb-cccc")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "declared twice")

    def test_vex_version_drift_against_shipped_component_blocks(self):
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc", version="1.2.0")])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "re-triage against the shipped version")

    def test_unreviewed_advisory_severity_is_treated_as_blocking(self):
        report = json.loads(self.audit.read_text(encoding="utf-8"))
        report["vulnerabilities"]["left-pad"]["severity"] = "unknown"
        report["vulnerabilities"]["left-pad"]["via"][0].pop("severity")
        self.audit.write_text(json.dumps(report), encoding="utf-8")
        self.write_vex([])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "has no VEX entry")

    # ── SBOM accuracy / drift ───────────────────────────────────────────────
    def test_sbom_version_drift_against_lockfile_blocks(self):
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "1.3.0"},
                {"type": "library", "name": "express", "version": "4.18.0"},
            ]
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "SBOM drift")

    def test_dependency_missing_from_sbom_blocks(self):
        self.write_sbom([{"type": "library", "name": "left-pad", "version": "1.3.0"}])
        code, output = self.run_gate()
        self.assert_blocks(code, output, "does not list it")

    def test_unresolved_component_version_blocks(self):
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "latest"},
                {"type": "library", "name": "express", "version": "5.1.0"},
            ]
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "not a resolved version")

    def test_missing_component_version_blocks(self):
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad"},
                {"type": "library", "name": "express", "version": "5.1.0"},
            ]
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "has no version")

    def test_empty_sbom_blocks(self):
        self.write_sbom([])
        code, output = self.run_gate(lock=False)
        self.assert_blocks(code, output, "declares no components")

    def test_declared_stdlib_only_sbom_is_accepted(self):
        # The Python generator has no third-party dependencies today. An empty
        # SBOM is only acceptable when it says so explicitly; claiming it
        # silently would be indistinguishable from a failed generation.
        self.sbom.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "version": 1,
                    "metadata": {
                        "component": {"type": "application", "name": "streampay-sdk-generator",
                                      "version": "0.1.0"},
                        "properties": [{"name": GATE.PROP_NO_DEPS, "value": "true"}],
                    },
                    "components": [],
                }
            ),
            encoding="utf-8",
        )
        code, output = self.run_gate(lock=False, advisories=False)
        self.assertEqual(code, 0, output)
        self.assertIn("declares no third-party dependencies", output)

    def test_medium_advisory_without_vex_is_reported_but_not_blocking(self):
        report = json.loads(self.audit.read_text(encoding="utf-8"))
        report["vulnerabilities"]["left-pad"]["severity"] = "medium"
        report["vulnerabilities"]["left-pad"]["via"][0]["severity"] = "medium"
        self.audit.write_text(json.dumps(report), encoding="utf-8")
        self.write_vex([])
        code, output = self.run_gate()
        self.assertEqual(code, 0, output)
        self.assertIn("GHSA-aaaa-bbbb-cccc", output)
        self.assertIn("warning", output)

    def test_artifact_without_sbom_blocks(self):
        self.artifact.write_bytes(b"another artifact")
        argv = ["--vex", str(self.vex), "--today", TODAY,
                "--sbom", f"indexer={self.sbom}",
                "--artifact", "orphan=" + str(self.artifact)]
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = GATE.main(argv)
        self.assert_blocks(code, buffer.getvalue(), "no SBOM covers it")

    def test_baseline_round_trip_and_drift(self):
        code, output = self.run_gate("--baseline", str(self.baseline), "--write-baseline")
        self.assertEqual(code, 0, output)
        self.assertTrue(self.baseline.is_file())

        code, output = self.run_gate("--baseline", str(self.baseline))
        self.assertEqual(code, 0, output)

        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "1.3.0"},
                {"type": "library", "name": "express", "version": "5.1.0"},
                {"type": "library", "name": "newdep", "version": "0.0.1"},
            ]
        )
        code, output = self.run_gate("--baseline", str(self.baseline), lock=False)
        self.assert_blocks(code, output, "gained component 'newdep@0.0.1'")

    def test_unknown_advisory_tool_is_a_usage_error_not_a_pass(self):
        code, output = self.run_gate("--advisories", f"mystery={self.audit}")
        self.assert_blocks(code, output, "unknown tool")

    # ── the committed VEX must itself be valid ──────────────────────────────
    def test_committed_vex_document_passes_validation(self):
        gate = GATE.Gate()
        document = json.loads((ROOT / "security" / "vex" / "vex.json").read_text(encoding="utf-8"))
        entries = GATE.validate_vex(document, __import__("datetime").date.fromisoformat(TODAY), gate)
        self.assertEqual(gate.failures, [], "\n".join(gate.failures))
        self.assertIn("RUSTSEC-2024-0436", entries)
        # Every ignore in deny.toml must carry VEX with a rationale and expiry,
        # or the two records of the same decision drift apart.
        deny = (ROOT / "deny.toml").read_text(encoding="utf-8")
        ignored = __import__("re").findall(r'^\s*"(RUSTSEC-[0-9-]+)"', deny, __import__("re").MULTILINE)
        for ident in ignored:
            self.assertIn(ident, entries, f"{ident} is ignored in deny.toml but has no VEX entry")


if __name__ == "__main__":
    unittest.main(verbosity=2)
