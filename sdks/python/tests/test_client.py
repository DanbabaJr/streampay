"""Exercises the client's JSON-RPC plumbing against an in-process fake RPC."""
import base64
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from streampay import (  # noqa: E402
    Client,
    CreateStreamArgs,
    FailureKind,
    StreamPayError,
    TESTNET_PASSPHRASE,
    WithdrawMaxArgs,
    address_to_scval,
    read_envelope_b64,
)
from streampay.xdr import ScVal, encode_scval, i128_to_scval, symbol_to_scval, u64_to_scval  # noqa: E402

CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM"
SENDER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M"
RECIPIENT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4"
TOKEN = "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL"
ACCOUNT = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"


def stream_scval() -> ScVal:
    fields = [
        ("id", u64_to_scval(1)),
        ("sender", address_to_scval(SENDER)),
        ("recipient", address_to_scval(RECIPIENT)),
        ("token", address_to_scval(TOKEN)),
        ("deposit", i128_to_scval(10_000_000_000)),
        ("withdrawn", i128_to_scval(0)),
        ("start_time", u64_to_scval(0)),
        ("end_time", u64_to_scval(86_400)),
        ("cancelable", ScVal("bool", True)),
        ("status", ScVal("u32", 0)),
    ]
    return ScVal("map", [(symbol_to_scval(name), value) for name, value in fields])


def encode_result(value: ScVal) -> dict:
    return {"results": [{"xdr": base64.b64encode(encode_scval(value)).decode("ascii")}]}


class FakeRpc(BaseHTTPRequestHandler):
    """Minimal Soroban RPC: simulation, account lookups, submission."""

    def log_message(self, *args):  # noqa: D401 - silence test server
        return

    def _reply(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 - stdlib hook
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        params = request.get("params", {})
        method = request["method"]
        if method == "getAccount":
            result = {"sequence": "41"}
        elif method == "simulateTransaction":
            invocation = read_envelope_b64(params["transaction"])
            if invocation.function == "get_stream":
                result = encode_result(stream_scval())
            elif invocation.function == "available":
                result = encode_result(i128_to_scval(1234))
            elif invocation.function == "recipient_streams":
                offset = invocation.args[1].value
                ids = range(offset, min(offset + 50, 53))
                result = encode_result(ScVal("vec", [u64_to_scval(i) for i in ids]))
            elif invocation.function == "withdraw_max":
                result = {"error": "HostError: Error(Contract, #5)"}
            elif invocation.function == "create_stream":
                result = encode_result(u64_to_scval(9))
            elif invocation.function == "top_up":
                result = encode_result(ScVal("void"))
            else:
                result = {"error": f"unexpected function {invocation.function}"}
        elif method == "sendTransaction":
            result = {"status": "PENDING", "hash": "abc123"}
        elif method == "getTransaction":
            result = {"status": "SUCCESS"}
        else:
            result = {"error": f"unexpected method {method}"}
        self._reply({"jsonrpc": "2.0", "id": request.get("id"), "result": result})


class FakeSigner:
    def public_key(self) -> str:
        return ACCOUNT

    def sign(self, envelope_xdr: str, network_passphrase: str) -> str:
        assert network_passphrase == TESTNET_PASSPHRASE
        return envelope_xdr


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeRpc)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)

    def client(self, signer=None) -> Client:
        return Client(
            CONTRACT,
            rpc_url=self.url,
            signer=signer,
            poll_interval=0.01,
            poll_timeout=2,
        )

    def test_get_stream_decodes_the_typed_view(self):
        stream = self.client().get_stream(1)
        self.assertEqual(stream.id, 1)
        self.assertEqual(stream.deposit, 10_000_000_000)
        self.assertEqual(stream.status.name, "ACTIVE")
        self.assertTrue(stream.cancelable)

    def test_available_decodes_an_i128(self):
        self.assertEqual(self.client().available(1), 1234)

    def test_pagination_follows_pages(self):
        ids = self.client().stream_ids("recipient", RECIPIENT)
        self.assertEqual(ids, list(range(53)))

    def test_simulation_failure_keeps_the_step_and_code(self):
        with self.assertRaises(StreamPayError) as caught:
            self.client(FakeSigner()).withdraw_max(WithdrawMaxArgs(stream_id=1))
        error = caught.exception
        self.assertEqual(error.kind, FailureKind.SIMULATION)
        self.assertEqual(error.code, 5)
        self.assertEqual(error.contract_name, "StreamNotActive")

    def test_mutating_calls_need_a_signer(self):
        args = CreateStreamArgs(
            sender=SENDER,
            recipient=RECIPIENT,
            token=TOKEN,
            deposit_amount=1,
            start_time=0,
            end_time=1,
            cancelable=True,
        )
        with self.assertRaises(StreamPayError) as caught:
            self.client().create_stream(args)
        self.assertEqual(caught.exception.kind, FailureKind.TRANSPORT)

    def test_write_pipeline_returns_the_typed_result(self):
        args = CreateStreamArgs(
            sender=SENDER,
            recipient=RECIPIENT,
            token=TOKEN,
            deposit_amount=1,
            start_time=0,
            end_time=1,
            cancelable=True,
        )
        self.assertEqual(self.client(FakeSigner()).create_stream(args), 9)


if __name__ == "__main__":
    unittest.main()
