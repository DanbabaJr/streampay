"""StreamPay Python SDK.

Typed, spec-generated bindings for the StreamPay Soroban contract: entrypoint
arguments, result decoding, contract events, and index pagination.

```python
from streampay import Client, TESTNET_RPC_URL

client = Client("C...", rpc_url=TESTNET_RPC_URL)
stream = client.get_stream(1)
print(stream.deposit, stream.status)
```
"""
from ._generated import (
    CONTRACT_VERSION,
    FUNCTIONS,
    MAX_DURATION_SECONDS,
    MAX_PAGE_SIZE,
    METHODS,
    SPEC_FINGERPRINT,
    AvailableArgs,
    CancelStreamArgs,
    CreateStreamArgs,
    GetStreamArgs,
    RecipientStreamsArgs,
    SenderStreamsArgs,
    StreamCancelledEvent,
    StreamCreatedEvent,
    StreamError,
    StreamPayEvent,
    StreamStatus,
    StreamToppedUpEvent,
    Stream,
    TopUpArgs,
    WithdrawArgs,
    WithdrawMaxArgs,
    WithdrawnEvent,
    contract_error,
    decode_available_result,
    decode_cancel_stream_result,
    decode_create_stream_result,
    decode_event,
    decode_get_stream_result,
    decode_recipient_streams_result,
    decode_sender_streams_result,
    decode_top_up_result,
    decode_withdraw_max_result,
    decode_withdraw_result,
)
from .client import (
    PUBLIC_PASSPHRASE,
    TESTNET_PASSPHRASE,
    TESTNET_RPC_URL,
    Client,
    Signer,
    signer_from_stellar_sdk,
)
from .errors import FailureKind, StreamPayError
from .events import decode_event_xdr, decode_events
from .pagination import collect_pages
from .xdr import (
    ContractEvent,
    Invocation,
    ScVal,
    XdrError,
    address_to_scval,
    build_invoke_envelope,
    native,
    read_contract_event_b64,
    read_envelope_b64,
    read_scval_b64,
)

__version__ = CONTRACT_VERSION

__all__ = [
    "AvailableArgs",
    "CancelStreamArgs",
    "Client",
    "CONTRACT_VERSION",
    "ContractEvent",
    "CreateStreamArgs",
    "FailureKind",
    "FUNCTIONS",
    "GetStreamArgs",
    "Invocation",
    "MAX_DURATION_SECONDS",
    "MAX_PAGE_SIZE",
    "METHODS",
    "PUBLIC_PASSPHRASE",
    "RecipientStreamsArgs",
    "SPEC_FINGERPRINT",
    "ScVal",
    "SenderStreamsArgs",
    "Signer",
    "Stream",
    "StreamCancelledEvent",
    "StreamCreatedEvent",
    "StreamError",
    "StreamPayError",
    "StreamPayEvent",
    "StreamStatus",
    "StreamToppedUpEvent",
    "TESTNET_PASSPHRASE",
    "TESTNET_RPC_URL",
    "TopUpArgs",
    "WithdrawArgs",
    "WithdrawMaxArgs",
    "WithdrawnEvent",
    "XdrError",
    "address_to_scval",
    "build_invoke_envelope",
    "collect_pages",
    "contract_error",
    "decode_available_result",
    "decode_cancel_stream_result",
    "decode_create_stream_result",
    "decode_event",
    "decode_event_xdr",
    "decode_events",
    "decode_get_stream_result",
    "decode_recipient_streams_result",
    "decode_sender_streams_result",
    "decode_top_up_result",
    "decode_withdraw_max_result",
    "decode_withdraw_result",
    "native",
    "read_contract_event_b64",
    "read_envelope_b64",
    "read_scval_b64",
    "signer_from_stellar_sdk",
]
