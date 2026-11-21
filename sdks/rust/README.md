# streampay-sdk (Rust)

Typed Rust bindings for the StreamPay streaming-payments contract, generated
from [`sdks/spec/streampay.spec.json`](../spec/streampay.spec.json).

```bash
cargo add streampay-sdk
```

## What you get

* `Client` with one method per entrypoint: `create_stream`, `withdraw`,
  `withdraw_max`, `cancel_stream`, `top_up`, `get_stream`, `available`,
  `recipient_streams`, `sender_streams`
* generated `Stream`, `StreamStatus`, argument structs, and result decoders
* `Event` with typed `StreamCreated` / `Withdrawn` / `StreamCancelled` /
  `StreamToppedUp` payloads decoded from `ContractEvent`
* `stream_ids(role, address)` / `streams_for(role, address)` pagination
* `StreamError` with stable numeric codes, mapped from `ScVal::Error`
* `SPEC_FINGERPRINT` for deployment/spec assertions

## Quickstart (testnet)

The client is transport-agnostic: implement `Transport` with the RPC and
signing stack you already use (the typed layer handles argument encoding,
result decoding, and error mapping).

```rust
use streampay_sdk::{Client, StreamError, SdkError, Transport};
use stellar_xdr::ScVal;

struct MyRpc; // wrap soroban-rpc / stellar-rpc-client here

impl Transport for MyRpc {
    fn invoke(&self, contract: &str, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError> {
        // simulate -> sign -> send -> poll, then return the contract's return value
        todo!("{contract}.{method}({args:?})")
    }
    fn simulate(&self, contract: &str, method: &str, args: Vec<ScVal>) -> Result<ScVal, SdkError> {
        todo!("{contract}.{method}({args:?})")
    }
}

# fn demo() -> Result<(), SdkError> {
let client = Client::new(
    "CDLZ…YOUR_TESTNET_CONTRACT_ID",
    MyRpc,
);

// Read-only: available(stream_id)
let available = client.available(1)?;
println!("{available} stroops accrued");

// Mutating: create_stream(7 args), returns the new id
let id = client.create_stream(
    "G…sender", "G…recipient", "C…token",
    10_000_000_000, // deposit in token units
    1_700_000_000,  // start
    1_700_086_400,  // end
    true,           // cancelable
)?;

// Typed contract errors:
match client.withdraw_max(id) {
    Ok(paid) => println!("paid {paid}"),
    Err(SdkError::Contract(StreamError::NothingToWithdraw)) => {}
    Err(error) => return Err(error),
}
# Ok(())
# }
```

`Client::decode_events` takes the `ContractEvent`s from your RPC/meta decoder
and returns typed events, ignoring events from other contracts on the ledger:

```rust
# use streampay_sdk::{Client, SdkError, Transport};
# use stellar_xdr::ScVal;
# struct T; impl Transport for T {
#   fn invoke(&self, _:&str, _:&str, _:Vec<ScVal>) -> Result<ScVal,SdkError>{unimplemented!()}
#   fn simulate(&self, _:&str, _:&str, _:Vec<ScVal>) -> Result<ScVal,SdkError>{unimplemented!()}
# }
# fn f(client: &Client<'_, T>, events: Vec<stellar_xdr::ContractEvent>) -> Result<(), SdkError> {
for event in client.decode_events(events)? {
    println!("{event:?}");
}
# Ok(()) }
```

## Index pagination

```rust
use streampay_sdk::Role;

let ids = client.stream_ids(Role::Recipient, "G…address")?;
let streams = client.streams_for(Role::Recipient, "G…address")?;
```

Pages are requested at `MAX_PAGE_SIZE` (50) and followed until a short page.
`streams_for` skips ids that disappeared between the index read and the state
read, matching the frontend's discovery behaviour.

## Conformance

The crate's tests decode every vector in [`../vectors`](../vectors) and compare
it to the recorded canonical JSON:

```bash
cargo test
cargo run --example conformance -- ../vectors
```

## Versioning and publishing

Lockstep with the other SDKs; see [`../README.md`](../README.md#versioning-policy).
`cargo publish --dry-run` runs in CI; `sdk-v*` tags publish with
`CARGO_REGISTRY_TOKEN`.
