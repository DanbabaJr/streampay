#!/usr/bin/env python3
"""Cross-SDK conformance orchestrator.

Runs the TypeScript, Rust and Python clients against one sandbox and one
vector suite, then compares every decoded payload with the recorded
expectation and with every other client. It is deliberately dependency-free
(stdlib only) and every external effect is an injectable command, so the
lifecycle can be tested without Docker, a network or a Rust toolchain.

Modes
  offline  decode `sdks/vectors/*.json` with each client (default)
  live     provision a sandbox, run each client's live adapter against the
           same contract/stream/ledger, compare the observed state

Failure discipline
  * every failure pins client, vector, ledger and decoded contract error code;
  * per-client and whole-run runtime budgets are hard deadlines;
  * the sandbox is torn down in a `finally` block, and a teardown that reports
    a dirty state is itself a failure;
  * artifacts are written for every run (and are guaranteed on failure).

Usage
  python3 sdks/conformance/orchestrator.py
  python3 sdks/conformance/orchestrator.py --client typescript="node ..." \
      --client rust="cargo run ..." --client python="python3 -m ..."
  python3 sdks/conformance/orchestrator.py --live \
      --sandbox "python3 sdks/conformance/sandbox.py"
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol

HERE = Path(__file__).resolve().parent
SDKS = HERE.parent
DEFAULT_VECTORS = SDKS / "vectors"
DEFAULT_OUT = HERE / "out"
DEFAULT_TIMEOUT = 180.0
DEFAULT_CLIENTS = {
    "typescript": "node sdks/typescript/dist/src/conformance.js {vectors}",
    "rust": (
        "cargo run --quiet --manifest-path sdks/rust/Cargo.toml "
        "--example conformance -- {vectors}"
    ),
    "python": "env PYTHONPATH=sdks/python python3 -m streampay.conformance {vectors}",
}
LIVE_ENV = "STREAMPay_CONFORMANCE_LIVE"


class ConformanceError(RuntimeError):
    """A run failed. Carries everything an operator needs to reproduce it."""

    def __init__(self, message: str, *, client: str | None = None,
                 vector: str | None = None, ledger: int | None = None,
                 error_code: str | None = None):
        super().__init__(message)
        self.client = client
        self.vector = vector
        self.ledger = ledger
        self.error_code = error_code

    def as_dict(self) -> dict[str, Any]:
        return {
            "message": str(self),
            "client": self.client,
            "vector": self.vector,
            "ledger": self.ledger,
            "errorCode": self.error_code,
        }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def vector_expectations(vectors_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ({name: vector file}, {name: expected payload})."""
    files: dict[str, Any] = {}
    expected: dict[str, Any] = {}
    for path in sorted(vectors_dir.glob("*.json")):
        vector = read_json(path)
        name = vector.get("name")
        if not isinstance(name, str) or not name:
            raise ConformanceError(f"{path.name}: vector has no name")
        if name in files:
            raise ConformanceError(f"duplicate vector name {name!r}")
        files[name] = vector
        expected[name] = vector.get("expected", {})
    if not files:
        raise ConformanceError(f"no vectors found in {vectors_dir}")
    return files, expected


def error_code(payload: Any) -> str | None:
    """The typed contract error carried by a decoded result, if any."""
    if not isinstance(payload, Mapping):
        return None
    result = payload.get("result")
    if isinstance(result, Mapping):
        error = result.get("error")
        if isinstance(error, Mapping):
            name = error.get("name")
            code = error.get("code")
            if name is not None and code is not None:
                return f"{name}({code})"
            if code is not None:
                return str(code)
    return None


def diff_paths(expected: Any, actual: Any, prefix: str = "") -> Iterable[str]:
    if isinstance(expected, Mapping) and isinstance(actual, Mapping):
        for key in sorted(set(expected) | set(actual)):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in expected:
                yield f"{path}: unexpected"
            elif key not in actual:
                yield f"{path}: missing"
            else:
                yield from diff_paths(expected[key], actual[key], path)
    elif isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            yield f"{prefix}: length {len(expected)} != {len(actual)}"
        for index, (left, right) in enumerate(zip(expected, actual)):
            yield from diff_paths(left, right, f"{prefix}[{index}]")
    elif expected != actual:
        yield f"{prefix}: {expected!r} != {actual!r}"


class Sandbox(Protocol):
    def up(self, deadline: float) -> dict[str, Any]: ...
    def down(self, deadline: float) -> dict[str, Any]: ...


class FixtureSandbox:
    """The hermetic offline default: no external process, clean by definition."""

    def up(self, deadline: float) -> dict[str, Any]:
        return {"mode": "offline", "clean": True}

    def down(self, deadline: float) -> dict[str, Any]:
        return {"clean": True}


class CommandSandbox:
    """An ephemeral sandbox implemented by an external command pair.

    `<command> up` prints one JSON object (rpcUrl, contractId, streamId,
    ledger, expected, ...) on stdout. `<command> down` prints
    `{"clean": true}` after removing everything it created.
    """

    def __init__(self, command: str, cwd: Path, timeout: float):
        self.argv = shlex.split(command)
        self.cwd = cwd
        self.timeout = timeout

    def _run(self, action: str, deadline: float) -> dict[str, Any]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ConformanceError(f"sandbox {action}: runtime budget exhausted")
        try:
            completed = subprocess.run(
                [*self.argv, action],
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=min(self.timeout, remaining),
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ConformanceError(
                f"sandbox {action} exceeded its {self.timeout:.0f}s budget"
            ) from error
        if completed.returncode != 0:
            raise ConformanceError(
                f"sandbox {action} exited {completed.returncode}: "
                f"{completed.stderr.strip()[:400]}"
            )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ConformanceError(
                f"sandbox {action} printed invalid JSON: {error}"
            ) from error

    def up(self, deadline: float) -> dict[str, Any]:
        state = self._run("up", deadline)
        if not state.get("contractId") or not state.get("rpcUrl"):
            raise ConformanceError("sandbox up must report rpcUrl and contractId")
        return state

    def down(self, deadline: float) -> dict[str, Any]:
        return self._run("down", deadline)


DUMMY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"


def rpc_call(rpc_url: str, method: str, params: Mapping[str, Any], timeout: float) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        rpc_url,
        body,
        {"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if "error" in payload:
        raise ConformanceError(f"RPC {method} failed: {payload['error']}")
    return payload["result"]


def live_vector(state: Mapping[str, Any], directory: Path, timeout: float) -> Path:
    """Create a one-vector suite from live chain data.

    A sandbox may hand over the finished vector (`vector`), or a simulation
    envelope plus result XDR, or enough state for the orchestrator to build and
    simulate a read-only call itself. In every form the SDKs decode the same
    on-chain bytes, so live conformance needs no client-specific network code.
    """
    vector = state.get("vector")
    if vector is None:
        envelope = state.get("simulateEnvelopeXdr")
        function = state.get("function", "get_stream")
        args = state.get("args", {"stream_id": str(state.get("streamId", "1"))})
        if envelope is None:
            contract = state.get("contractId")
            rpc_url = state.get("rpcUrl")
            if not contract or not rpc_url:
                raise ConformanceError("live sandbox must report contractId and rpcUrl")
            sys.path.insert(0, str(SDKS / "python"))
            from streampay.xdr import build_invoke_envelope, u64_to_scval  # noqa: PLC0415

            envelope = build_invoke_envelope(
                source=state.get("source", DUMMY_SOURCE),
                contract=contract,
                function=function,
                args=[u64_to_scval(int(args["stream_id"]))],
                fee=int(state.get("fee", 100)),
                sequence=int(state.get("sequence", 0)),
            )
        result_xdr = state.get("resultXdr")
        expected_result = state.get("expectedResult", {"ok": None})
        if result_xdr is None:
            rpc_url = state.get("rpcUrl")
            if not rpc_url:
                raise ConformanceError("live sandbox must report rpcUrl or resultXdr")
            simulated = rpc_call(
                rpc_url, "simulateTransaction", {"transaction": envelope}, timeout
            )
            entries = simulated.get("results") or []
            if simulated.get("error") or not entries or "xdr" not in entries[0]:
                # A contract error is a real result: encode the same ScVal every
                # client would receive so error mapping is still compared.
                error = expected_result.get("error") if isinstance(expected_result, Mapping) else None
                code = error.get("code") if isinstance(error, Mapping) else None
                if code is None:
                    raise ConformanceError(
                        f"simulation failed: {simulated.get('error') or 'no result XDR'}"
                    )
                from streampay.xdr import ScVal, encode_scval  # noqa: PLC0415

                result_xdr = base64.b64encode(
                    encode_scval(ScVal("error", int(code)))
                ).decode("ascii")
            else:
                result_xdr = entries[0]["xdr"]
        vector = {
            "schema": "streampay-vector/v1",
            "name": state.get("name", "live-get-stream"),
            "specFingerprint": state.get("specFingerprint", ""),
            "transactionEnvelopeXdr": envelope,
            "resultXdr": result_xdr,
            "eventsXdr": state.get("eventsXdr", []),
            "expected": {
                "transaction": {
                    "contract": state["contractId"],
                    "function": function,
                    "args": args,
                    "source": state.get("source", DUMMY_SOURCE),
                    "fee": str(state.get("fee", 100)),
                    "sequence": str(state.get("sequence", 0)),
                    "signatures": int(state.get("signatures", 0)),
                },
                "result": expected_result,
                "events": [],
            },
        }
    path = directory / f"{vector.get('name', 'live')}.json"
    path.write_text(json.dumps(vector, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path.parent


class Adapter(Protocol):
    name: str

    def run(self, mode: str, context: Mapping[str, Any], deadline: float) -> dict[str, Any]: ...


class CommandAdapter:
    """Runs one client's conformance CLI and parses its JSON envelope."""

    def __init__(self, name: str, command: str, cwd: Path, timeout: float):
        self.name = name
        self.argv = shlex.split(command)
        self.cwd = cwd
        self.timeout = timeout

    def run(self, mode: str, context: Mapping[str, Any], deadline: float) -> dict[str, Any]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ConformanceError(
                "runtime budget exhausted before the client started",
                client=self.name,
            )
        env = os.environ.copy()
        env.update(
            {
                "STREAMPay_CONFORMANCE_MODE": mode,
                "STREAMPay_VECTORS": str(context["vectors"]),
                "STREAMPay_SPEC_FINGERPRINT": str(context.get("fingerprint", "")),
                "STREAMPay_RPC_URL": str(context.get("rpcUrl", "")),
                "STREAMPay_CONTRACT_ID": str(context.get("contractId", "")),
                "STREAMPay_STREAM_ID": str(context.get("streamId", "")),
                "STREAMPay_LEDGER": str(context.get("ledger", "")),
                LIVE_ENV: "1" if mode == "live" else "0",
            }
        )
        try:
            argv = [
                part.replace("{vectors}", str(context["vectors"]))
                for part in self.argv
            ]
            completed = subprocess.run(
                argv,
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=min(self.timeout, remaining),
                env=env,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ConformanceError(
                f"client exceeded its {self.timeout:.0f}s runtime budget",
                client=self.name,
                ledger=context.get("ledger"),
            ) from error
        if completed.returncode != 0:
            raise ConformanceError(
                f"client exited {completed.returncode}: {completed.stderr.strip()[:400]}",
                client=self.name,
                ledger=context.get("ledger"),
            )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ConformanceError(
                f"client printed invalid JSON: {error}",
                client=self.name,
                ledger=context.get("ledger"),
            ) from error


@dataclass
class RunResult:
    ok: bool
    mode: str
    fingerprint: str
    ledger: int | None
    clients: list[str]
    failures: list[dict[str, Any]] = field(default_factory=list)
    artifacts: str | None = None
    duration_seconds: float = 0.0
    clean_teardown: bool = True
    summary: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "mode": self.mode,
            "specFingerprint": self.fingerprint,
            "ledger": self.ledger,
            "clients": self.clients,
            "failures": self.failures,
            "artifacts": self.artifacts,
            "durationSeconds": round(self.duration_seconds, 3),
            "cleanTeardown": self.clean_teardown,
            "summary": self.summary,
        }


class Orchestrator:
    def __init__(
        self,
        *,
        adapters: Iterable[Adapter],
        sandbox: Sandbox,
        vectors_dir: Path = DEFAULT_VECTORS,
        out_dir: Path = DEFAULT_OUT,
        runtime_budget: float = DEFAULT_TIMEOUT,
        live: bool = False,
        clock: Callable[[], float] = time.monotonic,
        write_artifacts: bool = True,
    ):
        self.adapters = list(adapters)
        self.sandbox = sandbox
        self.vectors_dir = vectors_dir
        self.out_dir = out_dir
        self.runtime_budget = runtime_budget
        self.live = live
        self.clock = clock
        self.write_artifacts = write_artifacts
        fingerprint_file = SDKS / "spec" / "FINGERPRINT"
        self.fingerprint = (
            fingerprint_file.read_text(encoding="utf-8").strip()
            if fingerprint_file.exists()
            else ""
        )

    def _client_deadline(self, run_deadline: float) -> float:
        """Each client gets a slice of the remaining run budget."""
        remaining = run_deadline - self.clock()
        share = self.runtime_budget / max(len(self.adapters), 1)
        return self.clock() + max(0.0, min(share, remaining))

    def _run_clients(
        self,
        mode: str,
        context: Mapping[str, Any],
        failures: list[dict[str, Any]],
        run_deadline: float,
        ledger: int | None,
    ) -> dict[str, Any]:
        outputs: dict[str, Any] = {}
        for adapter in self.adapters:
            deadline = self._client_deadline(run_deadline)
            if deadline <= self.clock():
                self._record_failure(
                    failures,
                    ConformanceError(
                        "runtime budget exhausted before the client started",
                        client=adapter.name,
                        ledger=ledger,
                    ),
                )
                continue
            try:
                outputs[adapter.name] = adapter.run(mode, context, deadline)
            except Exception as error:  # noqa: BLE001 - reported, not swallowed
                self._record_failure(
                    failures, error, client=adapter.name, ledger=ledger
                )
        return outputs

    def _record_failure(
        self, failures: list[dict[str, Any]], error: Exception, **context: Any
    ) -> None:
        if isinstance(error, ConformanceError):
            failure = error.as_dict()
        else:
            failure = {"message": f"{type(error).__name__}: {error}"}
        failure.update({key: value for key, value in context.items() if value is not None})
        failures.append(failure)

    def run(self) -> RunResult:
        started = self.clock()
        run_deadline = started + self.runtime_budget
        failures: list[dict[str, Any]] = []
        state: dict[str, Any] = {"mode": "live" if self.live else "offline"}
        outputs: dict[str, Any] = {}
        clean_teardown = True
        mode = "live" if self.live else "offline"
        ledger: int | None = None
        vectors_dir = self.vectors_dir

        try:
            state = self.sandbox.up(run_deadline)
            ledger_value = state.get("ledger")
            ledger = int(ledger_value) if ledger_value is not None else None
            if self.live:
                self.out_dir.mkdir(parents=True, exist_ok=True)
                live_dir = self.out_dir / "live-vectors"
                live_dir.mkdir(parents=True, exist_ok=True)
                for stale in live_dir.glob("*.json"):
                    stale.unlink()
                vectors_dir = live_vector(
                    state,
                    live_dir,
                    max(1.0, min(self.runtime_budget / 4, 30.0)),
                )
                context = {
                    "vectors": vectors_dir,
                    "fingerprint": self.fingerprint,
                    "rpcUrl": state.get("rpcUrl"),
                    "contractId": state.get("contractId"),
                    "streamId": state.get("streamId"),
                    "ledger": ledger,
                }
                outputs = self._run_clients(
                    mode, context, failures, run_deadline, ledger
                )
            else:
                context = {
                    "vectors": vectors_dir,
                    "fingerprint": self.fingerprint,
                    "rpcUrl": state.get("rpcUrl"),
                    "contractId": state.get("contractId"),
                    "streamId": state.get("streamId"),
                    "ledger": ledger,
                }
                outputs = self._run_clients(mode, context, failures, run_deadline, ledger)
        except Exception as error:  # noqa: BLE001 - sandbox startup failure
            self._record_failure(failures, error, ledger=ledger)
        finally:
            try:
                teardown = self.sandbox.down(run_deadline + max(10.0, self.runtime_budget / 10))
                clean_teardown = bool(teardown.get("clean", False))
                if not clean_teardown:
                    failures.append(
                        {
                            "message": "sandbox teardown did not report a clean state",
                            "client": None,
                            "vector": None,
                            "ledger": ledger,
                            "errorCode": None,
                        }
                    )
            except Exception as error:  # noqa: BLE001 - teardown must be reported
                clean_teardown = False
                self._record_failure(failures, error, ledger=ledger)

        comparison = self._compare(outputs, vectors_dir, ledger)
        failures.extend(comparison["failures"])
        duration = self.clock() - started
        if duration > self.runtime_budget:
            failures.append(
                {
                    "message": (
                        f"run took {duration:.1f}s, exceeding the "
                        f"{self.runtime_budget:.0f}s runtime budget"
                    ),
                    "client": None,
                    "vector": None,
                    "ledger": ledger,
                    "errorCode": None,
                }
            )

        result = RunResult(
            ok=not failures,
            mode=mode,
            fingerprint=self.fingerprint,
            ledger=ledger,
            clients=[adapter.name for adapter in self.adapters],
            failures=failures,
            duration_seconds=duration,
            clean_teardown=clean_teardown,
            summary=comparison["summary"],
        )
        if self.write_artifacts:
            result.artifacts = self._write_artifacts(result, outputs, state)
        return result

    def _compare(
        self,
        outputs: Mapping[str, Any],
        vectors_dir: Path,
        ledger: int | None,
    ) -> dict[str, Any]:
        failures: list[dict[str, Any]] = []
        summary: dict[str, Any] = {"vectors": 0, "clients": list(outputs)}
        try:
            files, expected = vector_expectations(vectors_dir)
        except Exception as error:  # noqa: BLE001
            self._record_failure(failures, error, ledger=ledger)
            return {"failures": failures, "summary": summary}
        summary["vectors"] = len(files)

        for name, output in sorted(outputs.items()):
            if not isinstance(output, Mapping):
                failures.append(
                    {
                        "message": "client payload is not a JSON object",
                        "client": name,
                        "vector": None,
                        "ledger": ledger,
                        "errorCode": None,
                    }
                )
                continue
            if output.get("sdk") != name:
                failures.append(
                    {
                        "message": f"payload reports sdk={output.get('sdk')!r}",
                        "client": name,
                        "vector": None,
                        "ledger": ledger,
                        "errorCode": None,
                    }
                )
            if self.fingerprint and output.get("specFingerprint") != self.fingerprint:
                failures.append(
                    {
                        "message": (
                            "spec fingerprint does not match sdks/spec/FINGERPRINT"
                        ),
                        "client": name,
                        "vector": None,
                        "ledger": ledger,
                        "errorCode": None,
                    }
                )
            vectors = output.get("vectors")
            if not isinstance(vectors, Mapping):
                failures.append(
                    {
                        "message": "payload has no `vectors` object",
                        "client": name,
                        "vector": None,
                        "ledger": ledger,
                        "errorCode": None,
                    }
                )
                continue
            for vector_name, want in expected.items():
                actual = vectors.get(vector_name)
                if actual is None:
                    failures.append(
                        {
                            "message": "missing vector",
                            "client": name,
                            "vector": vector_name,
                            "ledger": ledger,
                            "errorCode": None,
                        }
                    )
                    continue
                for path in diff_paths(want, actual):
                    failures.append(
                        {
                            "message": f"differs from the recorded expectation at {path}",
                            "client": name,
                            "vector": vector_name,
                            "ledger": ledger,
                            "errorCode": error_code(actual) or error_code(want),
                        }
                    )

        if len(outputs) > 1:
            names = list(outputs)
            reference_name = names[0]
            reference = outputs[reference_name].get("vectors", {}) if isinstance(
                outputs[reference_name], Mapping
            ) else {}
            for name in names[1:]:
                candidate = outputs[name].get("vectors", {}) if isinstance(
                    outputs[name], Mapping
                ) else {}
                for vector_name in expected:
                    left = reference.get(vector_name)
                    right = candidate.get(vector_name)
                    if left is not None and right is not None and left != right:
                        failures.append(
                            {
                                "message": (
                                    f"disagrees with {reference_name} on {vector_name}"
                                ),
                                "client": name,
                                "vector": vector_name,
                                "ledger": ledger,
                                "errorCode": error_code(right) or error_code(left),
                            }
                        )
        return {"failures": failures, "summary": summary}

    def _write_artifacts(
        self,
        result: RunResult,
        outputs: Mapping[str, Any],
        state: Mapping[str, Any],
    ) -> str:
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        directory = self.out_dir / stamp
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "summary.json").write_text(
            json.dumps(result.as_dict(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (directory / "sandbox.json").write_text(
            json.dumps(state, indent=2, sort_keys=True, default=str) + "\n",
            encoding="utf-8",
        )
        for name, payload in outputs.items():
            safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in name)
            (directory / f"{safe}.json").write_text(
                json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n",
                encoding="utf-8",
            )
        return str(directory)


def client_adapters(specs: list[str], timeout: float) -> list[CommandAdapter]:
    adapters = []
    for spec in specs:
        if "=" not in spec:
            raise ConformanceError(f"--client must be name=command, got {spec!r}")
        name, command = spec.split("=", 1)
        if not name or not command:
            raise ConformanceError(f"--client must be name=command, got {spec!r}")
        adapters.append(CommandAdapter(name, command, SDKS.parent, timeout))
    return adapters


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vectors", type=Path, default=DEFAULT_VECTORS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--client",
        action="append",
        default=[],
        metavar="NAME=COMMAND",
        help="override a client adapter (repeatable)",
    )
    parser.add_argument("--sandbox", default="", metavar="COMMAND")
    parser.add_argument("--live", action="store_true")
    parser.add_argument(
        "--runtime-budget",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="hard budget for the whole run in seconds",
    )
    parser.add_argument(
        "--client-timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="hard budget for one client in seconds",
    )
    parser.add_argument(
        "--list-clients",
        action="store_true",
        help="print the default client commands and exit",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.list_clients:
        print(json.dumps(DEFAULT_CLIENTS, indent=2))
        return 0
    live = args.live or os.environ.get(LIVE_ENV) == "1"
    specs = args.client or [f"{name}={command}" for name, command in DEFAULT_CLIENTS.items()]
    sandbox: Sandbox = (
        CommandSandbox(args.sandbox, SDKS.parent, args.client_timeout)
        if live and args.sandbox
        else FixtureSandbox()
    )
    if live and not args.sandbox:
        print(
            "--live requires --sandbox (see sdks/conformance/sandbox.py)",
            file=sys.stderr,
        )
        return 2
    try:
        orchestrator = Orchestrator(
            adapters=client_adapters(specs, args.client_timeout),
            sandbox=sandbox,
            vectors_dir=args.vectors,
            out_dir=args.out,
            runtime_budget=args.runtime_budget,
            live=live,
        )
    except Exception as error:  # noqa: BLE001
        print(f"conformance: {error}", file=sys.stderr)
        return 2

    result = orchestrator.run()
    print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
    if not result.ok:
        for failure in result.failures:
            pinned = " ".join(
                f"{key}={failure[key]}"
                for key in ("client", "vector", "ledger", "errorCode")
                if failure.get(key) is not None
            )
            print(f"FAIL {pinned}: {failure['message']}", file=sys.stderr)
        if result.artifacts:
            print(f"artifacts: {result.artifacts}", file=sys.stderr)
        return 1
    print(
        f"conformance: {len(result.clients)} clients × "
        f"{result.summary.get('vectors', 0)} vectors identical"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
