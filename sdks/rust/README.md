# streampay-sdk (Rust, read-only)

Read-only Rust client for the StreamPay Soroban contract, generated from
[`sdks/spec/streampay.spec.json`](../spec/streampay.spec.json) by the same
generator that produces the TypeScript client.

**Reads only.** The crate emits the operations the spec marks non-mutating,
their argument builders and typed result decoders, and the canonical contract
error enum. There is no signing, submission or write path, and the crate is
`#![forbid(unsafe_code)]`.

## Generate and test

```bash
make -C sdks generate      # rewrites src/generated.rs
make -C sdks check         # spec guard + generator tests + freshness gate
cd sdks/rust && cargo test # conformance vectors + doctests
```

`src/generated.rs` is generated: change `sdks/spec/streampay.spec.json` (or the
contract, then re-derive the spec) and regenerate. `src/lib.rs` is hand-written
and holds the transport trait and the shared error types.

## Use

`ReadClient<T>` is transport-agnostic. Implement `ReadTransport` over a Soroban
RPC `simulateTransaction` call, or over fixed values in tests:

```rust
use stellar_xdr::ScVal;
use streampay_sdk::{ReadClient, ReadTransport};

struct Rpc;

impl ReadTransport for Rpc {
    type Error = std::io::Error;

    fn simulate(&self, method: &str, args: Vec<ScVal>) -> Result<ScVal, Self::Error> {
        // POST simulateTransaction with (method, args), return result.retval
        todo!()
    }
}

let client = ReadClient::new(Rpc);
let stream = client.get_stream(1)?;
println!("{} {} {:?}", stream.id, stream.deposit, stream.status);
```

Every read operation the spec declares gets the same treatment
(`available`, `get_intent`, `treasury_status`, `recipient_streams`, the
`governance_*` views, …). The request builders (`get_stream_args`,
`recipient_streams_args`, …) and decoders (`decode_get_stream_result`, …) are
exported too, for callers that already hold an `ScVal`.

Errors come from the canonical catalog (`frontend/lib/errors.ts`), never a
second table:

```rust
use streampay_sdk::{decode_contract_error, StreamError};

if let Some(Ok(error)) = decode_contract_error(&result) {
    assert_eq!(error, StreamError::StreamNotActive);
    println!("{} = {}", error.name(), error.code()); // StreamNotActive = 5
}
```

## Conformance

`tests/conformance.rs` decodes the shared read fixtures and compares every
field with the recorded canonical value:

* `get-stream-active` → `Stream` (`Active`)
* `get-stream-cancelled` → `Stream` (`Cancelled`)
* `error-not-active` → `StreamError::StreamNotActive` (code 5)

It also rebuilds `get_stream`'s arguments and compares them with the signed
invoke envelope in the vector, so argument encoding is checked against a real
transaction rather than a round trip.
