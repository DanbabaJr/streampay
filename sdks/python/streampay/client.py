"""Synchronous StreamPay client.

Reads simulate a contract call and decode the returned value. Writes follow
build → simulate → sign (caller-supplied signer) → submit → poll, then return
the typed result. A signer is anything with ``public_key()`` and
``sign(envelope_xdr, network_passphrase) -> signed_envelope_xdr``; this SDK
never touches secret keys itself.

No third-party dependency is required. Use
``streampay.client.signer_from_stellar_sdk`` if you already depend on
``stellar-sdk`` for signing.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Protocol

from ._generated import (
    MAX_PAGE_SIZE,
    METHODS,
    AvailableArgs,
    CancelStreamArgs,
    CreateStreamArgs,
    GetStreamArgs,
    RecipientStreamsArgs,
    SenderStreamsArgs,
    Stream,
    TopUpArgs,
    WithdrawArgs,
    WithdrawMaxArgs,
    decode_available_result,
    decode_cancel_stream_result,
    decode_create_stream_result,
    decode_get_stream_result,
    decode_recipient_streams_result,
    decode_sender_streams_result,
    decode_top_up_result,
    decode_withdraw_max_result,
    decode_withdraw_result,
)
from .errors import FailureKind, StreamPayError
from .pagination import collect_pages
from .xdr import (
    Reader,
    ScVal,
    XdrError,
    address_to_scval,
    build_invoke_envelope,
    read_scval_b64,
    u64_to_scval,
)

TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015"
TESTNET_RPC_URL = "https://soroban-testnet.stellar.org"

# ed25519 all-zero account: a syntactically valid simulation source.
_DUMMY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"


class Signer(Protocol):
    def public_key(self) -> str: ...

    def sign(self, envelope_xdr: str, network_passphrase: str) -> str: ...


def signer_from_stellar_sdk(keypair: Any) -> Signer:
    """Wraps a ``stellar_sdk.Keypair`` as a signer.

    Requires the optional ``stellar-sdk`` dependency.
    """
    try:
        from stellar_sdk import TransactionBuilder
    except ImportError as error:  # pragma: no cover - optional path
        raise StreamPayError(
            "signer_from_stellar_sdk requires `pip install streampay-sdk[signer]`",
            FailureKind.TRANSPORT,
        ) from error

    class _KeypairSigner:
        def public_key(self) -> str:
            return keypair.public_key

        def sign(self, envelope_xdr: str, network_passphrase: str) -> str:
            tx = TransactionBuilder.from_xdr(envelope_xdr, network_passphrase)
            tx.sign(keypair)
            return tx.to_xdr()

    return _KeypairSigner()


class Client:
    def __init__(
        self,
        contract_id: str,
        *,
        rpc_url: str = TESTNET_RPC_URL,
        network_passphrase: str = TESTNET_PASSPHRASE,
        signer: Any | None = None,
        timeout: float = 30.0,
        poll_interval: float = 1.0,
        poll_timeout: float = 60.0,
    ) -> None:
        if not contract_id:
            raise ValueError("contract_id is required")
        self.contract_id = contract_id
        self.rpc_url = rpc_url
        self.network_passphrase = network_passphrase
        self.signer = signer
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        self._request_id = 0

    # ------------------------------------------------------------------ RPC
    def _rpc(self, method: str, params: dict[str, Any]) -> Any:
        self._request_id += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params}
        ).encode("utf-8")
        request = urllib.request.Request(
            self.rpc_url,
            body,
            {"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            raise StreamPayError.from_rpc(FailureKind.TRANSPORT, str(error)) from error
        if "error" in payload:
            raise StreamPayError.from_rpc(
                FailureKind.TRANSPORT, json.dumps(payload["error"])
            )
        if "result" not in payload:
            raise StreamPayError.from_rpc(
                FailureKind.TRANSPORT, f"malformed RPC response: {payload}"
            )
        return payload["result"]

    def _simulate(self, envelope_xdr: str) -> ScVal:
        result = self._rpc("simulateTransaction", {"transaction": envelope_xdr})
        error = result.get("error")
        if error is not None:
            message = error if isinstance(error, str) else json.dumps(error)
            raise StreamPayError.from_rpc(
                FailureKind.SIMULATION, message, envelope_xdr
            )
        entries = result.get("results") or []
        if not entries or "xdr" not in entries[0]:
            raise StreamPayError(
                "simulation returned no value",
                FailureKind.SIMULATION,
                transaction_xdr=envelope_xdr,
            )
        try:
            return read_scval_b64(entries[0]["xdr"])
        except XdrError as error:  # pragma: no cover - defensive
            raise StreamPayError.decode(str(error)) from error

    def _account_sequence(self, public_key: str) -> int:
        result = self._rpc("getAccount", {"address": public_key})
        raw = result.get("sequence") or result.get("seqNum") or "0"
        try:
            return int(raw)
        except (TypeError, ValueError) as error:
            raise StreamPayError.from_rpc(
                FailureKind.TRANSPORT, f"invalid account sequence {raw!r}"
            ) from error

    # ------------------------------------------------------------- plumbing
    def _read(self, method: str, args: list[ScVal], decode: Callable[[Any], Any]) -> Any:
        envelope = build_invoke_envelope(
            source=_DUMMY_SOURCE,
            contract=self.contract_id,
            function=method,
            args=args,
            fee=100,
            sequence=0,
        )
        value = self._simulate(envelope)
        try:
            return decode(value)
        except (XdrError, KeyError, ValueError) as error:
            raise StreamPayError.decode(str(error)) from error

    def _write(
        self, method: str, args: list[ScVal], decode: Callable[[Any], Any]
    ) -> Any:
        signer = self.signer
        if signer is None:
            raise StreamPayError(
                "a signer is required for mutating calls", FailureKind.TRANSPORT
            )
        public_key = signer.public_key()
        sequence = self._account_sequence(public_key)
        envelope = build_invoke_envelope(
            source=public_key,
            contract=self.contract_id,
            function=method,
            args=args,
            fee=1_000_000,
            sequence=sequence + 1,
        )
        simulated = self._simulate(envelope)

        try:
            signed = signer.sign(envelope, self.network_passphrase)
        except Exception as error:  # noqa: BLE001 - signer is caller code
            raise StreamPayError.from_rpc(
                FailureKind.SUBMISSION, f"signer failed: {error}", envelope
            ) from error

        submitted = self._rpc("sendTransaction", {"transaction": signed})
        status = submitted.get("status")
        tx_hash = submitted.get("hash", "")
        if status not in ("PENDING", "DUPLICATE"):
            raise StreamPayError.from_rpc(
                FailureKind.SUBMISSION,
                json.dumps(submitted.get("errorResultXdr") or submitted),
                signed,
            )

        deadline = time.monotonic() + self.poll_timeout
        while time.monotonic() < deadline:
            time.sleep(self.poll_interval)
            result = self._rpc("getTransaction", {"hash": tx_hash})
            if result.get("status") == "SUCCESS":
                try:
                    return decode(simulated)
                except (XdrError, KeyError, ValueError) as error:
                    raise StreamPayError.decode(str(error)) from error
            if result.get("status") == "FAILED":
                raise StreamPayError.from_rpc(
                    FailureKind.INCLUSION,
                    f"transaction {tx_hash} failed: "
                    f"{json.dumps(result.get('resultXdr') or result)}",
                    signed,
                )
        raise StreamPayError(
            f"timed out after {self.poll_timeout}s waiting for {tx_hash}",
            FailureKind.INCLUSION,
            transaction_xdr=signed,
        )

    # ---------------------------------------------------------------- writes
    def create_stream(self, args: CreateStreamArgs) -> int:
        return self._write(
            METHODS["createStream"], args.to_scvals(), decode_create_stream_result
        )

    def withdraw(self, args: WithdrawArgs) -> None:
        return self._write(
            METHODS["withdraw"], args.to_scvals(), decode_withdraw_result
        )

    def withdraw_max(self, args: WithdrawMaxArgs) -> int:
        return self._write(
            METHODS["withdrawMax"], args.to_scvals(), decode_withdraw_max_result
        )

    def cancel_stream(self, args: CancelStreamArgs) -> None:
        return self._write(
            METHODS["cancelStream"], args.to_scvals(), decode_cancel_stream_result
        )

    def top_up(self, args: TopUpArgs) -> None:
        return self._write(METHODS["topUp"], args.to_scvals(), decode_top_up_result)

    # ----------------------------------------------------------------- reads
    def get_stream(self, stream_id: int) -> Stream:
        args = GetStreamArgs(stream_id=stream_id)
        return self._read(
            METHODS["getStream"], args.to_scvals(), decode_get_stream_result
        )

    def available(self, stream_id: int) -> int:
        args = AvailableArgs(stream_id=stream_id)
        return self._read(METHODS["available"], args.to_scvals(), decode_available_result)

    # ------------------------------------------------------------ pagination
    def stream_ids_page(
        self, role: str, address: str, offset: int, limit: int = MAX_PAGE_SIZE
    ) -> list[int]:
        if role == "sender":
            args = SenderStreamsArgs(sender=address, offset=offset, limit=limit)
            return self._read(
                METHODS["senderStreams"], args.to_scvals(), decode_sender_streams_result
            )
        if role == "recipient":
            args = RecipientStreamsArgs(recipient=address, offset=offset, limit=limit)
            return self._read(
                METHODS["recipientStreams"],
                args.to_scvals(),
                decode_recipient_streams_result,
            )
        raise ValueError(f"role must be 'sender' or 'recipient', got {role!r}")

    def stream_ids(self, role: str, address: str) -> list[int]:
        return collect_pages(
            lambda offset, limit: self.stream_ids_page(role, address, offset, limit)
        )

    def streams_for(self, role: str, address: str) -> list[Stream]:
        streams: list[Stream] = []
        for stream_id in self.stream_ids(role, address):
            try:
                streams.append(self.get_stream(stream_id))
            except StreamPayError:
                # A stale index entry must not hide the rest of the portfolio.
                continue
        return streams


# Re-exported so callers can encode one-off arguments without importing xdr.
__all__ = [
    "Client",
    "PUBLIC_PASSPHRASE",
    "Signer",
    "TESTNET_PASSPHRASE",
    "TESTNET_RPC_URL",
    "address_to_scval",
    "signer_from_stellar_sdk",
    "u64_to_scval",
]

_ = Reader  # keep the import surface explicit for type checkers
