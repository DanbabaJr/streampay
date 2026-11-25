import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "ci_changed_paths", ROOT / "scripts" / "ci_changed_paths.py"
)
ci_changed_paths = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci_changed_paths)


def git(root, *args):
    return subprocess.check_output(
        ["git", *args], cwd=root, text=True, encoding="utf-8"
    ).strip()


class PathPatternTests(unittest.TestCase):
    def test_every_filter_has_a_positive_and_negative_fixture(self):
        for name, patterns in ci_changed_paths.PATH_GROUPS.items():
            for pattern in patterns:
                with self.subTest(group=name, pattern=pattern):
                    sample = pattern[:-2] + "example.txt" if pattern.endswith("/**") else pattern
                    self.assertTrue(ci_changed_paths.path_matches(sample, pattern))
                    self.assertFalse(ci_changed_paths.path_matches("unrelated/example.txt", pattern))

    def test_recursive_filter_does_not_match_a_sibling_prefix(self):
        self.assertFalse(ci_changed_paths.path_matches("contracts-other/lib.rs", "contracts/**"))
        self.assertFalse(ci_changed_paths.path_matches("contracts", "contracts/**"))

    def test_unsupported_patterns_fail_closed(self):
        with self.assertRaises(ValueError):
            ci_changed_paths.path_matches("src/file.ts", "src/*.ts")

    def test_common_ci_paths_select_every_group(self):
        for path in ci_changed_paths.COMMON_PATHS:
            with self.subTest(path=path):
                flags = ci_changed_paths.path_flags({path})
                self.assertTrue(all(flags.values()))

    def test_specialist_paths_select_the_documented_groups(self):
        cases = {
            "contracts/streaming-payments/src/lib.rs": {
                "fuzz", "sbom", "sdk", "wasm_diff", "whitepaper",
            },
            "indexer/src/secrets/rotation.ts": {"infra", "indexer_image", "sbom", "rotation"},
            "indexer/src/index.ts": {"infra", "indexer_image", "sbom"},
            "infra/docker/Dockerfile.indexer": {"infra", "indexer_image", "sbom"},
            ".dockerignore": {"infra", "indexer_image", "sbom"},
            "frontend/package.json": {"sbom"},
            "frontend/package-lock.json": {"sbom"},
            "model/src/model.rs": {"fuzz"},
            "sdks/rust/src/lib.rs": {"sbom", "sdk"},
            "scripts/attest.sh": {"attestation", "rehearsal"},
            "scripts/attestation_lib.sh": {"attestation", "release_signing", "rehearsal"},
            ".github/workflows/release-sign.yml": {"release_signing"},
            ".github/workflows/promote.yml": {"rehearsal"},
            "perf/baselines/docker.json": {"infra", "indexer_image", "sdk"},
            "schemas/events/registry.json": {"sdk"},
            "docs/WHITEPAPER.md": {"whitepaper"},
            "security/vex/vulns.json": {"sbom"},
            "tests/sigstore_verify_test.sh": {"release_signing"},
            ".github/actions/example/action.yml": {"wasm_diff"},
            "tools/streampay-cli/src/main.rs": {"sbom"},
            "docs/DEPLOY_PIPELINE.md": {"rehearsal"},
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                flags = ci_changed_paths.path_flags({path})
                self.assertEqual({name for name, enabled in flags.items() if enabled}, expected)


class ChangedPathsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "ci@example.invalid")
        git(self.root, "config", "user.name", "CI Test")
        self.write("contracts/streaming-payments/src/lib.rs", "base\n")
        self.write("docs/WHITEPAPER.md", "base\n")
        self.write("indexer/src/old.ts", "base\n")
        self.write("README.md", "base\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "base")
        self.base = git(self.root, "rev-parse", "HEAD")

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def commit(self, message):
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", message)
        return git(self.root, "rev-parse", "HEAD")

    def test_changed_deleted_and_renamed_paths_are_detected(self):
        self.write("contracts/streaming-payments/src/lib.rs", "changed\n")
        (self.root / "docs/WHITEPAPER.md").unlink()
        git(self.root, "mv", "indexer/src/old.ts", "indexer/src/new.ts")
        self.write("infra/docker/Dockerfile.indexer", "changed\n")
        head = self.commit("head")

        paths = ci_changed_paths.changed_paths(self.root, self.base, head)
        flags = ci_changed_paths.path_flags(paths)

        self.assertIn("docs/WHITEPAPER.md", paths)
        self.assertIn("indexer/src/old.ts", paths)
        self.assertIn("indexer/src/new.ts", paths)
        self.assertTrue(flags["fuzz"])
        self.assertTrue(flags["whitepaper"])
        self.assertTrue(flags["infra"])
        self.assertTrue(flags["indexer_image"])
        self.assertTrue(flags["sdk"])

    def test_no_changes_select_no_specialist_group(self):
        head = git(self.root, "rev-parse", "HEAD")
        flags = ci_changed_paths.path_flags(
            ci_changed_paths.changed_paths(self.root, self.base, head)
        )
        self.assertFalse(any(flags.values()))

    def test_missing_base_fails_closed(self):
        with self.assertRaises(RuntimeError):
            ci_changed_paths.changed_paths(self.root, "missing-base", "HEAD")

    def test_output_file_contains_every_flag(self):
        output = self.root / "github-output"
        ci_changed_paths.write_outputs({"fuzz": True, "infra": False}, output)
        self.assertEqual(
            output.read_text(encoding="utf-8"),
            "fuzz=true\ninfra=false\n",
        )

    def test_cli_rejects_non_pr_events(self):
        result = subprocess.run(
            [
                os.sys.executable,
                str(ROOT / "scripts" / "ci_changed_paths.py"),
                "--event-name", "push",
                "--base-sha", self.base,
                "--root", str(self.root),
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("only supports pull_request", result.stderr)


if __name__ == "__main__":
    unittest.main()
