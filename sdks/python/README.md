# streampay-sdk (Python)

Typed, dependency-free Python client for the StreamPay Soroban contract,
generated from [`sdks/spec/streampay.spec.json`](../spec/streampay.spec.json).

```bash
pip install streampay-sdk
# optional, for the stellar-sdk signing adapter:
pip install "streampay-sdk[signer]"
```

Requires Python 3.10+.

## Quickstart against testnet

```python
from streampay import Client, TESTNET_RPC_URL

client = Client("C…YOUR_TESTNET_CONTRACT_ID", rpc_url=TESTNET_RPC_URL)

stream = client.get_stream(1)
print(stream.deposit, stream.status.name, stream.start_time)

available = client.available(1)
print(f"{available} stroops accrued")
```

Reads simulate against testnet with a dummy source — no signer, no funded
account needed.

### Writes

The SDK never handles secret keys. Pass any object with `public_key()` and
`sign(envelope_xdr, network_passphrase) -> signed_envelope_xdr`:

```python
from stellar_sdk import Keypair
from streampay import (
    Client,
    CreateStreamArgs,
    WithdrawMaxArgs,
    signer_from_stellar_sdk,
)

keypair = Keypair.from_secret("S…")
client = Client(
    "C…YOUR_TESTNET_CONTRACT_ID",
    signer=signer_from_stellar_sdk(keypair),
)

stream_id = client.create_stream(
    CreateStreamArgs(
        sender=keypair.public_key,
        recipient="G…recipient",
        token="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        deposit_amount=10_000_000,
        start_time=1_700_000_000,
        end_time=1_700_003_600,
        cancelable=True,
    )
)
paid = client.withdraw_max(WithdrawMaxArgs(stream_id=stream_id))
```

Writes build an unsigned envelope, simulate, sign, submit, poll for inclusion,
then return the typed result. `StreamPayError.kind` tells you whether the
failure was `simulation`, `submission`, `inclusion`, `decode`, or `transport`,
and `error.code` / `error.contract_name` carry the typed `StreamError`.

## Events

```python
from streampay import decode_events

for event in decode_events([entry["valueXdr"] for entry in rpc_events]):
    print(type(event).__name__, event.stream_id)
```

`StreamCreatedEvent`, `WithdrawnEvent`, `StreamCancelledEvent`, and
`StreamToppedUpEvent` expose typed fields (integers, strkey addresses, bools).
Foreign events are dropped; malformed XDR raises `StreamPayError`.

## Index pagination

```python
ids = client.stream_ids("recipient", address)
streams = client.streams_for("recipient", address)
```

## Conformance

```bash
python -m unittest discover -s tests -v
python -m streampay.conformance ../vectors
```

## Versioning and publishing

Lockstep with the other SDKs; see [`../README.md`](../README.md#versioning-policy).
`python -m build` + `twine check` run in CI; `sdk-v*` tags publish to TestPyPI
and then PyPI (`TEST_PYPI_API_TOKEN`, `PYPI_API_TOKEN`). TestPyPI can also be
exercised from the publish workflow's manual dispatch.
