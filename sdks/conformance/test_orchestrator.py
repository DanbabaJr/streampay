"""Tests for the cross-SDK conformance orchestrator.

These run without Docker, a network, Node, Rust or the SDKs: adapters and the
sandbox are in-process fakes, so the lifecycle itself (comparison, failure
pinning, teardown and runtime budget) is what is under test.
"""
from __future__ import annotations

import copy
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import orchestrator  # noqa: E402
from orchestrator import Orchestrator  # noqa: E402


EXPECTED = {
    "withdraw": {
        "transaction": {"function": "withdraw", "args": {"stream_id": "1", "amount": "10"}},
        "result": {"ok": None},
        "events": [{"name": "Withdrawn", "data": {"amount": "10"}}],
    },
    "error-not-active": {
        "transaction": {"function": "withdraw", "args": {"stream_id": "1", "amount": "1"}},
        "result": {"error": {"name": "StreamNotActive", "code": 5}},
        "events": [],
    },
}


def write_vectors(directory: Path) -> None:
    for name, expected in EXPECTED.items():
        (directory / f"{name}.json").write_text(
            json.dumps(
                {
                    "schema": "streampay-vector/v1",
                    "name": name,
                    "specFingerprint": "fingerprint",
                    "transactionEnvelopeXdr": "",
                    "resultXdr": "",
                    "eventsXdr": [],
                    "expected": expected,
                }
            ),
            encoding="utf-8",
        )


class FakeAdapter:
    def __init__(self, name: str, vectors: dict, state=None, delay: float = 0.0):
        self.name = name
        self.vectors = vectors
        self.state = state
        self.delay = delay

    def run(self, mode, context, deadline):
        if self.delay:
            time.sleep(self.delay)
        return {
            "sdk": self.name,
            "specFingerprint": "fingerprint",
            "vectors": copy.deepcopy(self.vectors),
            "state": self.state,
        }


class FakeSandbox:
    def __init__(self, state=None, clean=True):
        self.state = state or {"mode": "offline"}
        self.clean = clean
        self.calls: list[str] = []

    def up(self, deadline):
        self.calls.append("up")
        return dict(self.state)

    def down(self, deadline):
        self.calls.append("down")
        return {"clean": self.clean}


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.vectors = self.root / "vectors"
        self.vectors.mkdir()
        write_vectors(self.vectors)
        self.out = self.root / "out"

    def tearDown(self):
        self.temp.cleanup()

    def run_orchestrator(self, adapters, sandbox=None, **kwargs):
        original = orchestrator.SDKS
        orchestrator.SDKS = self.root
        (self.root / "spec").mkdir(exist_ok=True)
        (self.root / "spec" / "FINGERPRINT").write_text("fingerprint\n", encoding="utf-8")
        try:
            runner = Orchestrator(
                adapters=adapters,
                sandbox=sandbox or FakeSandbox(),
                vectors_dir=self.vectors,
                out_dir=self.out,
                runtime_budget=kwargs.pop("runtime_budget", 30.0),
                live=kwargs.pop("live", False),
                write_artifacts=kwargs.pop("write_artifacts", True),
                **kwargs,
            )
            return runner.run()
        finally:
            orchestrator.SDKS = original

    def test_all_clients_agree_and_artifacts_are_written(self):
        clients = [
            FakeAdapter("typescript", EXPECTED),
            FakeAdapter("rust", EXPECTED),
            FakeAdapter("python", EXPECTED),
        ]
        result = self.run_orchestrator(clients)
        self.assertTrue(result.ok, result.failures)
        self.assertTrue(result.clean_teardown)
        self.assertEqual(result.summary["vectors"], 2)
        self.assertIsNotNone(result.artifacts)
        summary = json.loads((Path(result.artifacts) / "summary.json").read_text())
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["clients"], ["typescript", "rust", "python"])

    def test_injected_drift_is_pinned_to_client_vector_ledger_and_error(self):
        drifted = copy.deepcopy(EXPECTED)
        drifted["withdraw"]["result"] = {"error": {"name": "NothingToWithdraw", "code": 7}}
        clients = [
            FakeAdapter("typescript", EXPECTED),
            FakeAdapter("rust", EXPECTED),
            FakeAdapter("python", drifted),
        ]
        result = self.run_orchestrator(clients)
        self.assertFalse(result.ok)
        failure = next(item for item in result.failures if item["client"] == "python")
        self.assertEqual(failure["vector"], "withdraw")
        self.assertEqual(failure["errorCode"], "NothingToWithdraw(7)")
        self.assertIn("recorded expectation", failure["message"])
        self.assertTrue(Path(result.artifacts, "summary.json").exists())

    def test_clients_disagreeing_with_each_other_is_a_failure(self):
        drifted = copy.deepcopy(EXPECTED)
        drifted["error-not-active"]["result"] = {"ok": None}
        result = self.run_orchestrator(
            [
                FakeAdapter("typescript", EXPECTED),
                FakeAdapter("rust", drifted),
            ]
        )
        self.assertFalse(result.ok)
        messages = [failure["message"] for failure in result.failures]
        self.assertTrue(any("disagrees with typescript" in message for message in messages))

    def test_teardown_always_runs_and_dirty_state_fails_the_run(self):
        sandbox = FakeSandbox(clean=False)
        result = self.run_orchestrator([FakeAdapter("typescript", EXPECTED)], sandbox)
        self.assertEqual(sandbox.calls, ["up", "down"])
        self.assertFalse(result.clean_teardown)
        self.assertTrue(any("clean state" in failure["message"] for failure in result.failures))

    def test_sandbox_startup_failure_still_tears_down(self):
        class BrokenSandbox(FakeSandbox):
            def up(self, deadline):
                self.calls.append("up")
                raise orchestrator.ConformanceError("sandbox image is unavailable")

        sandbox = BrokenSandbox()
        result = self.run_orchestrator([FakeAdapter("typescript", EXPECTED)], sandbox)
        self.assertFalse(result.ok)
        self.assertEqual(sandbox.calls, ["up", "down"])
        self.assertTrue(any("sandbox image" in failure["message"] for failure in result.failures))

    def test_runtime_budget_is_enforced(self):
        result = self.run_orchestrator(
            [FakeAdapter("typescript", EXPECTED, delay=0.25)],
            runtime_budget=0.05,
        )
        self.assertFalse(result.ok)
        self.assertTrue(
            any("runtime budget" in failure["message"] for failure in result.failures),
            result.failures,
        )

    def test_live_mode_compares_decoded_onchain_bytes_and_ledger(self):
        live = copy.deepcopy(EXPECTED["withdraw"])
        state = {
            "rpcUrl": "http://sandbox",
            "contractId": "C...",
            "streamId": "1",
            "ledger": 42,
            "vector": {
                "schema": "streampay-vector/v1",
                "name": "live-get-stream",
                "specFingerprint": "fingerprint",
                "transactionEnvelopeXdr": "",
                "resultXdr": "",
                "eventsXdr": [],
                "expected": live,
            },
        }
        clients = [
            FakeAdapter("typescript", {"live-get-stream": live}),
            FakeAdapter("rust", {"live-get-stream": live}),
            FakeAdapter("python", {"live-get-stream": {"result": {"ok": None}, "transaction": live["transaction"], "events": []}}),
        ]
        result = self.run_orchestrator(clients, FakeSandbox(state), live=True)
        self.assertFalse(result.ok)
        self.assertEqual(result.ledger, 42)
        failure = next(item for item in result.failures if item["client"] == "python")
        self.assertEqual(failure["vector"], "live-get-stream")
        self.assertEqual(failure["ledger"], 42)

    def test_missing_vector_is_reported_by_name(self):
        incomplete = {"withdraw": EXPECTED["withdraw"]}
        result = self.run_orchestrator([FakeAdapter("rust", incomplete)])
        self.assertFalse(result.ok)
        failure = next(item for item in result.failures if item["vector"] == "error-not-active")
        self.assertEqual(failure["client"], "rust")


if __name__ == "__main__":
    unittest.main()
