#!/usr/bin/env python3
"""Ephemeral Stellar sandbox for live SDK conformance.

    python3 sdks/conformance/sandbox.py up     # prints JSON on stdout
    python3 sdks/conformance/sandbox.py down   # removes everything, prints JSON

`up` starts a throwaway `stellar/quickstart --local` container on a random
loopback port, funds one identity deterministically from
`STREAMPAY_SANDBOX_SECRET`, deploys the contract passed in `STREAMPAY_WASM`
and reports the state the orchestrator needs. `down` removes the container and
the temporary identity, verifies they are gone, and only then reports
`{"clean": true}`.

Nothing is stored globally: the state lives in
`$STREAMPAY_SANDBOX_STATE` (default `sdks/conformance/.sandbox-state.json`).
The secret is read from the environment only; it is never written to disk.

Prerequisites on the live runner: docker, the `stellar` CLI, a built contract
WASM (`STREAMPAY_WASM`), and `STREAMPAY_SANDBOX_SECRET`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
STATE_PATH = Path(
    os.environ.get("STREAMPAY_SANDBOX_STATE", HERE / ".sandbox-state.json")
)
PASSPHRASE = "Standalone Network ; February 2017"
IMAGE = os.environ.get("STREAMPAY_SANDBOX_IMAGE", "stellar/quickstart:latest")
SECRET = os.environ.get("STREAMPAY_SANDBOX_SECRET", "")
WASM = os.environ.get(
    "STREAMPAY_WASM",
    str(ROOT / "target/wasm32-unknown-unknown/release/streampay_contract.wasm"),
)


class SandboxError(RuntimeError):
    pass


def run(argv: list[str], *, timeout: float = 120.0, check: bool = True) -> str:
    completed = subprocess.run(
        argv, capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and completed.returncode != 0:
        raise SandboxError(
            f"{' '.join(argv[:3])} exited {completed.returncode}: "
            f"{completed.stderr.strip()[:400]}"
        )
    return completed.stdout.strip()


def require_tools() -> None:
    missing = [tool for tool in ("docker", "stellar") if shutil.which(tool) is None]
    if missing:
        raise SandboxError(f"missing live-sandbox prerequisites: {', '.join(missing)}")
    if not SECRET:
        raise SandboxError("STREAMPAY_SANDBOX_SECRET is required (deterministic funding)")
    if not Path(WASM).is_file():
        raise SandboxError(
            f"contract WASM not found at {WASM}; set STREAMPAY_WASM "
            "(cargo build -p streampay-contract --target wasm32-unknown-unknown --release)"
        )


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def rpc(url: str, method: str, params: dict | None = None, timeout: float = 5.0) -> dict:
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    ).encode()
    request = urllib.request.Request(
        url, body, {"Content-Type": "application/json", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if "error" in payload:
        raise SandboxError(f"RPC {method}: {payload['error']}")
    return payload["result"]


def wait_for_rpc(url: str, timeout: float = 60.0) -> dict:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return rpc(url, "getHealth", timeout=3.0)
        except (urllib.error.URLError, TimeoutError, SandboxError, OSError) as error:
            last = error
            time.sleep(1.0)
    raise SandboxError(f"sandbox RPC did not become healthy in {timeout:.0f}s: {last}")


def wait_for_friendbot(horizon_url: str, address: str, timeout: float = 60.0) -> None:
    url = f"{horizon_url}/friendbot?addr={address}"
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=10.0) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last = error
            time.sleep(1.0)
    raise SandboxError(f"friendbot did not fund {address} in {timeout:.0f}s: {last}")


def latest_ledger(rpc_url: str) -> int:
    result = rpc(rpc_url, "getLatestLedger")
    return int(result.get("sequence") or result.get("ledger") or 0)


def stream_not_found_code() -> int:
    catalog = ROOT / "frontend" / "lib" / "errors.ts"
    text = catalog.read_text(encoding="utf-8")
    match = re.search(
        r"^\s*(\d+):\s*\{\s*code:\s*\d+,\s*name:\s*\"StreamNotFound\"",
        text,
        re.MULTILINE,
    )
    if not match:
        raise SandboxError("could not read StreamNotFound from the error catalog")
    return int(match.group(1))


def up() -> dict:
    require_tools()
    if STATE_PATH.exists():
        raise SandboxError(
            f"{STATE_PATH} already exists; run `sandbox.py down` before `up`"
        )

    container = f"streampay-conformance-{os.getpid()}-{int(time.time())}"
    port = free_port()
    identity = f"streampay-conf-{os.getpid()}"
    state: dict = {"container": container, "identity": identity}
    try:
        run(
            [
                "docker",
                "run",
                "--rm",
                "-d",
                "--name",
                container,
                "-p",
                f"127.0.0.1:{port}:8000",
                IMAGE,
                "--local",
            ]
        )
        horizon = f"http://127.0.0.1:{port}"
        rpc_url = f"{horizon}/rpc"
        wait_for_rpc(rpc_url)
        state.update({"horizonUrl": horizon, "rpcUrl": rpc_url, "port": port})

        run(["stellar", "keys", "add", identity, "--secret-key", SECRET, "--overwrite"])
        address = run(["stellar", "keys", "address", identity])
        wait_for_friendbot(horizon, address)

        contract = run(
            [
                "stellar",
                "contract",
                "deploy",
                "--wasm",
                WASM,
                "--source",
                identity,
                "--rpc-url",
                rpc_url,
                "--network-passphrase",
                PASSPHRASE,
            ],
            timeout=180.0,
        )
        if not contract.startswith("C"):
            raise SandboxError(f"deploy returned no contract id: {contract!r}")

        code = stream_not_found_code()
        state.update(
            {
                "contractId": contract,
                "streamId": "1",
                "source": address,
                "ledger": latest_ledger(rpc_url),
                "function": "get_stream",
                "args": {"stream_id": "1"},
                "expectedResult": {
                    "error": {"name": "StreamNotFound", "code": code}
                },
            }
        )
        STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        return state
    except Exception:
        try:
            run(["docker", "rm", "-f", container], check=False)
            run(["stellar", "keys", "remove", identity], check=False)
        finally:
            STATE_PATH.unlink(missing_ok=True)
        raise


def down() -> dict:
    state: dict = {}
    if STATE_PATH.exists():
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    failures: list[str] = []
    container = state.get("container")
    if container:
        run(["docker", "rm", "-f", container], check=False)
        running = run(
            ["docker", "ps", "-a", "--filter", f"name=^/{re.escape(container)}$", "-q"],
            check=False,
        )
        if running:
            failures.append(f"container {container} still exists")
    identity = state.get("identity")
    if identity:
        run(["stellar", "keys", "remove", identity], check=False)
        output = run(["stellar", "keys", "ls"], check=False)
        if identity in output.split():
            failures.append(f"identity {identity} still exists")
    STATE_PATH.unlink(missing_ok=True)
    if failures:
        raise SandboxError("; ".join(failures))
    return {"clean": True}


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in ("up", "down"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        result = up() if argv[1] == "up" else down()
    except Exception as error:  # noqa: BLE001 - one actionable line for the runner
        print(f"sandbox {argv[1]}: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
