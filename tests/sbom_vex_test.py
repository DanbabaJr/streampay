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
from datetime import date
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
        self.set_lock(
            {
                "node_modules/left-pad": {"version": "1.3.0"},
                "node_modules/express": {"version": "5.1.0"},
            }
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

    def set_lock(self, packages):
        """Write a lockfileVersion 3 `package-lock.json` from its node map."""
        self.lock.write_text(
            json.dumps(
                {
                    "name": "streampay-indexer",
                    "lockfileVersion": 3,
                    "packages": {"": {"name": "streampay-indexer", "version": "0.1.0"}, **packages},
                }
            ),
            encoding="utf-8",
        )

    def cargo_lock(self, text):
        """Point --lock at a Cargo.lock instead of an npm one."""
        self.lock = self.dir / "Cargo.lock"
        self.lock.write_text(text, encoding="utf-8")

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

    def test_cargo_deny_diagnostic_stream_is_normalised(self):
        # `cargo deny --format json` is a stream of concatenated documents, one
        # per finding, with the advisory id inside the human-readable message.
        # Reading only the first document would drop the second finding.
        cargo = self.dir / "cargo-deny.json"
        cargo.write_text(
            "\n".join(
                json.dumps(document)
                for document in (
                    {
                        "fields": {"code": "advisory", "graphs": ["dep"]},
                        "message": "RUSTSEC-2024-0436 (unmaintained) in paste 1.0.15",
                        "severity": "warning",
                        "type": "diagnostic",
                    },
                    {
                        "fields": {"code": "advisory"},
                        "message": "RUSTSEC-2025-0009 in ring 0.17.8",
                        "severity": "error",
                        "type": "diagnostic",
                    },
                )
            ),
            encoding="utf-8",
        )
        code, output = self.run_gate("--advisories", f"cargo-deny={cargo}")
        self.assert_blocks(code, output, "RUSTSEC-2024-0436")
        self.assertIn("RUSTSEC-2025-0009", output)

    def test_empty_advisory_report_blocks(self):
        # An empty file is what a wrong redirect or a changed output stream
        # leaves behind; it must never pass as "nothing found".
        cargo = self.dir / "cargo-deny.json"
        cargo.write_text("", encoding="utf-8")
        code, output = self.run_gate("--advisories", f"cargo-deny={cargo}")
        self.assert_blocks(code, output, "produced no report at all")

    def test_truncated_advisory_report_blocks(self):
        cargo = self.dir / "cargo-deny.json"
        cargo.write_text('{"advisories": {"found": [', encoding="utf-8")
        code, output = self.run_gate("--advisories", f"cargo-deny={cargo}")
        self.assert_blocks(code, output, "not a complete JSON document stream")

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
        self.assert_blocks(code, output, "does not describe it")

    def test_scoped_package_does_not_collide_with_its_unscoped_twin(self):
        # CycloneDX writes `@types/express` as group `@types` + name `express`,
        # and its purl percent-encodes the scope (`pkg:npm/%40types/express`).
        # Keying the inventory on the bare name made the scoped component
        # overwrite the real `express` at first-write-wins, and the lockfile
        # cross-check then reported a disagreement neither file contains: 43
        # times over in the indexer SBOM alone.
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "1.3.0"},
                {"type": "library", "name": "express", "version": "5.1.0", "purl": "pkg:npm/express@5.1.0"},
                {
                    "type": "library",
                    "group": "@types",
                    "name": "express",
                    "version": "5.0.6",
                    "purl": "pkg:npm/%40types/express@5.0.6",
                },
            ]
        )
        self.set_lock(
            {
                "node_modules/left-pad": {"version": "1.3.0"},
                "node_modules/express": {"version": "5.1.0"},
                "node_modules/@types/express": {"version": "5.0.6", "dev": True},
            }
        )
        code, output = self.run_gate()
        self.assertEqual(code, 0, output)

    def test_scoped_package_version_drift_still_blocks(self):
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "1.3.0"},
                {"type": "library", "name": "express", "version": "5.1.0", "purl": "pkg:npm/express@5.1.0"},
                {
                    "type": "library",
                    "group": "@types",
                    "name": "express",
                    "version": "5.0.6",
                    "purl": "pkg:npm/%40types/express@5.0.6",
                },
            ]
        )
        self.set_lock(
            {
                "node_modules/left-pad": {"version": "1.3.0"},
                "node_modules/express": {"version": "5.1.0"},
                "node_modules/@types/express": {"version": "5.0.5", "dev": True},
            }
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "@types/express@5.0.6")

    def test_nested_dev_only_copy_is_not_drift(self):
        # npm's `packages` map has one entry per node, and the SBOM generator
        # describes only the top-level ones. A dev-only nested copy therefore
        # reads as "the lock resolves a version the SBOM does not list" on every
        # tree that has one — which, in frontend, is 43 packages.
        self.set_lock(
            {
                "node_modules/left-pad": {"version": "1.3.0"},
                "node_modules/express": {"version": "5.1.0"},
                "node_modules/express/node_modules/left-pad": {"version": "1.2.0", "dev": True},
            }
        )
        code, output = self.run_gate()
        self.assertEqual(code, 0, output)
        self.assertIn("dev-only nested", output)

    def test_nested_production_copy_of_an_undescribed_package_blocks(self):
        self.set_lock(
            {
                "node_modules/left-pad": {"version": "1.3.0"},
                "node_modules/express": {"version": "5.1.0"},
                "node_modules/express/node_modules/chalk": {"version": "5.6.0"},
            }
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "does not describe that package at all")

    def test_every_version_in_an_sbom_is_checked_not_just_the_first(self):
        # One package at two versions is legal in one SBOM (the Rust graph does
        # it 20 times). A flat name -> version inventory kept whichever came
        # first, so a version nothing resolves could hide behind a real one.
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "1.3.0"},
                {"type": "library", "name": "left-pad", "version": "9.9.9"},
                {"type": "library", "name": "express", "version": "5.1.0"},
            ]
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "describes left-pad@9.9.9")
        self.assertIn("also appears at", output)

    def test_image_file_components_do_not_need_versions(self):
        # syft indexes the container image, so most of its 1,000+ components are
        # files on a filesystem: unversioned by nature and in no lockfile. They
        # are structural-validated, not treated as undeclared dependencies.
        self.write_sbom(
            [
                {"type": "library", "name": "left-pad", "version": "1.3.0"},
                {"type": "library", "name": "express", "version": "5.1.0"},
                {"type": "file", "name": "etc/os-release"},
                {"type": "file", "name": "usr/lib/node_modules/express/package.json"},
            ]
        )
        code, output = self.run_gate()
        self.assertEqual(code, 0, output)
        self.assertIn("2 component(s) of type 'file'", output)

    def test_cargo_lock_reverse_check_refuses_and_asks_for_the_shipped_graph(self):
        # Cargo.lock is the union of the normal, dev, build, proc-macro and
        # every-target graphs: 319 names for this contract against the 162 one
        # artifact contains. Comparing an SBOM to all of them is 157 phantom
        # omissions, and comparing it to nothing is no check at all.
        self.write_sbom([{"type": "library", "name": "crate-a", "version": "1.0.0"}])
        self.cargo_lock(
            'version = 4\n\n[[package]]\nname = "crate-a"\nversion = "1.0.0"\n'
            '\n[[package]]\nname = "dev-only-crate"\nversion = "2.0.0"\n'
        )
        code, output = self.run_gate()
        self.assert_blocks(code, output, "--shipped-graph")

    def test_shipped_graph_catches_a_crate_the_artifact_links(self):
        self.write_sbom([{"type": "library", "name": "crate-a", "version": "1.0.0"}])
        self.cargo_lock(
            'version = 4\n\n[[package]]\nname = "crate-a"\nversion = "1.0.0"\n'
            '\n[[package]]\nname = "dev-only-crate"\nversion = "2.0.0"\n'
        )
        graph = self.dir / "normal-deps.txt"
        graph.write_text("streampay-contract v0.1.0\ncrate-a v1.0.0\n", encoding="utf-8")
        code, output = self.run_gate("--shipped-graph", f"indexer={graph}")
        self.assertEqual(code, 0, output)

        self.write_sbom([{"type": "library", "name": "crate-a", "version": "1.0.0"}])
        graph.write_text("streampay-contract v0.1.0\ncrate-a v1.0.0\ncrate-b v3.1.0\n", encoding="utf-8")
        code, output = self.run_gate("--shipped-graph", f"indexer={graph}")
        self.assert_blocks(code, output, "crate-b@3.1.0")

        # The graph still has to be checked against the lockfile, so an SBOM
        # inventing a version that only the shipped graph lists is caught too.
        graph.write_text("streampay-contract v0.1.0\ncrate-a v9.9.9\n", encoding="utf-8")
        self.write_sbom([{"type": "library", "name": "crate-a", "version": "9.9.9"}])
        code, output = self.run_gate("--shipped-graph", f"indexer={graph}")
        self.assert_blocks(code, output, "Cargo.lock resolves ['1.0.0']")

    def test_shipped_graph_without_a_lock_is_a_usage_error(self):
        graph = self.dir / "normal-deps.txt"
        graph.write_text("streampay-contract v0.1.0\ncrate-a v1.0.0\n", encoding="utf-8")
        code, output = self.run_gate("--shipped-graph", f"indexer={graph}", lock=False)
        self.assert_blocks(code, output, "no --lock")

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
        entries = GATE.validate_vex(document, date.fromisoformat(TODAY), gate)
        self.assertEqual(gate.failures, [], "\n".join(gate.failures))
        self.assertIn("RUSTSEC-2024-0436", entries)
        # Every ignore in deny.toml must carry VEX with a rationale and expiry,
        # or the two records of the same decision drift apart. Read through the
        # gate's own parser, which is the one CI runs: the previous regex here
        # matched any quoted RUSTSEC id anywhere in the file, including one that
        # only appears in a comment, so it could pass while the real list moved.
        ignored = GATE.deny_ignores(ROOT / "deny.toml", gate)
        self.assertEqual(gate.failures, [], "\n".join(gate.failures))
        self.assertEqual(ignored, ["RUSTSEC-2024-0436", "RUSTSEC-2026-0387"])
        for ident in ignored:
            self.assertIn(ident, entries, f"{ident} is ignored in deny.toml but has no VEX entry")

    def test_deny_ignore_without_vex_blocks(self):
        deny = self.dir / "deny.toml"
        deny.write_text(
            '[advisories]\nignore = [\n    # RUSTSEC-2031-0001 is only a comment\n'
            '    "RUSTSEC-2025-9999",\n]\n\n[licenses]\n',
            encoding="utf-8",
        )
        code, output = self.run_gate("--deny-config", str(deny))
        self.assert_blocks(code, output, "RUSTSEC-2025-9999: ignored in")
        # The comment is not an ignore, so it must not be demanded of the VEX too.
        self.assertNotIn("RUSTSEC-2031-0001", output)

    def test_deny_ignore_covered_by_vex_passes_and_is_announced(self):
        deny = self.dir / "deny.toml"
        deny.write_text('[advisories]\nignore = [\n    "RUSTSEC-2026-0387",\n]\n', encoding="utf-8")
        self.write_vex([vex_entry("GHSA-aaaa-bbbb-cccc"), vex_entry("RUSTSEC-2026-0387",
                                                                    package="crypto-bigint",
                                                                    version="0.5.5")])
        code, output = self.run_gate("--deny-config", str(deny))
        self.assertEqual(code, 0, output)
        self.assertIn("RUSTSEC-2026-0387 (not_affected)", output)
        # An ignore-backed entry is deliberately never reported by cargo-deny, so
        # its absence from the advisory reports is not a stale review.
        self.assertNotIn("stale review", output)

    def test_missing_deny_config_blocks(self):
        code, output = self.run_gate("--deny-config", str(self.dir / "absent.toml"))
        self.assert_blocks(code, output, "cargo-deny config: file not found")


if __name__ == "__main__":
    unittest.main(verbosity=2)
