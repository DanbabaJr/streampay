# StreamPay mobile SDK (UniFFI)

Read-only Kotlin and Swift bindings for the StreamPay Soroban contract. The
Rust core is generated from the same spec and vectors as the TypeScript, Rust
and Python SDKs; UniFFI generates the language surfaces from
[`src/streampay.udl`](./src/streampay.udl).

**Reads only.** The SDK does not build or sign transactions, does not submit
them, and never stores, derives or logs a key. A host adapter performs the
simulation and hands back the raw base64 `ScVal` result.

## Surface

```kotlin
import uniffi.streampay.StreamPayMobile

class RpcAdapter : RpcReadTransport {
    override fun simulate(contractId: String, functionName: String, argsJson: String): String {
        // Call Soroban RPC simulateTransaction with the host's Stellar SDK,
        // return results[0].xdr. Run on a worker thread.
    }
}

val client = StreamPayMobile("C...YOUR_CONTRACT", RpcAdapter())
val stream = client.getStream(1uL)        // StreamView, ULong/UInt/Bool fields
val accrued = client.available(1uL)       // decimal string, never a truncating Long
val ids = client.recipientStreams(address, 0u, 50u)
```

```swift
let client = StreamPayMobile(contractId: "C...", transport: RpcAdapter())
let stream = try client.getStream(streamId: 1)
let accrued = try client.available(streamId: 1) // String
```

`StreamView` keeps `deposit`/`withdrawn` as decimal strings: UniFFI has no
128-bit scalar, and truncating a token amount would corrupt balances.
`use_oracle` is optional because records written before the oracle clock carry
no key; absence means ledger time.

`decodeGetStream/ decode_get_stream` is available when the host already has RPC
plumbing and only wants typed decoding. `spec_fingerprint()` returns the exact
`sdks/spec/FINGERPRINT` the bindings were generated from.

## Error catalog

All 99 contract error codes from `frontend/lib/errors.ts` become typed UniFFI
exceptions, plus `Transport`, `Decode` and `Unknown` for host/decode failures.
`StreamPayError.code()`/`name()` preserve the stable numeric code for analytics
and support. A generated catalog test fails if any code is missing or renamed.

## Threading, async and keys

* UniFFI callback interfaces are synchronous. Do `simulate` and every client
  call on a background/IO dispatcher; never on the UI thread.
* The SDK holds no mutable state and no network handle, so one client may be
  shared across threads (`RpcReadTransport` must be thread-safe).
* Keys live in the platform wallet (Android Keystore / iOS Keychain or a
  hardware signer). This SDK is read-only and must never be passed a secret.
* There is no retry or rate limiting inside the SDK; the host owns RPC policy.

## Build and gates

```bash
# Regenerate UDL + Rust catalog + binding manifest (the freshness gate)
node sdks/mobile/scripts/generate-bindings.mjs
node sdks/mobile/scripts/generate-bindings.mjs --check

# Host-side tests and the vector runner
cargo test --manifest-path sdks/mobile/Cargo.toml
cargo run --manifest-path sdks/mobile/Cargo.toml \
  --bin streampay-mobile-conformance -- sdks/vectors

# Kotlin / Swift generated-binding compile smoke
sdks/mobile/scripts/smoke-kotlin.sh
sdks/mobile/scripts/smoke-swift.sh
```

CI runs the freshness check, host tests, `uniffi-bindgen`, and both compile
smoke tests. The UDL is the reviewed interface; do not hand-edit
`error_catalog.rs` or `bindings/INTERFACE`.
