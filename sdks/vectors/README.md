# Conformance vectors

One JSON file per contract scenario. Every SDK must decode it to exactly the
recorded `expected` payload. No language SDK is part of this change; each SDK
PR adds a test that decodes every file here.

## Vector format (`streampay-vector/v1`)

```json
{
  "schema": "streampay-vector/v1",
  "name": "create-stream",
  "specFingerprint": "a3f6…",
  "provenance": "where the payload came from",
  "transactionEnvelopeXdr": "AAAA…",
  "resultXdr": "AAAABQ…",
  "eventsXdr": ["AAAAAAAA…"],
  "expected": {
    "transaction": {
      "contract": "C…",
      "function": "create_stream",
      "args": { "sender": "C…", "deposit_amount": "10000000000" },
      "source": "G…",
      "fee": "100000",
      "sequence": "1",
      "signatures": 1
    },
    "result": { "ok": "1" },
    "events": [
      {
        "contract": "C…",
        "name": "StreamCreated",
        "topics": { "stream_id": "1" },
        "data": { "sender": "C…", "deposit": "10000000000" }
      }
    ]
  }
}
```

`result` is either `{ "ok": <value> }` or
`{ "error": { "name": "StreamNotActive", "code": 5 } }` for
`ScVal::Error(SCError::Contract(5))`.

### Canonicalization rules

* integers (`u32`, `u64`, `i128`) are **decimal strings** — no precision loss
  in JavaScript
* addresses are strkeys (`G…` / `C…`)
* `void` is `null`
* unit enums are their case name (`"Cancelled"`), whatever their wire encoding
* struct fields use their wire names (`start_time`, not `startTime`)
* event data keys are the symbol keys the contract emits
* argument objects are keyed by the spec's argument names, in spec order

## Provenance

* **Event payloads** are copied verbatim from the values the contract's own
  tests emitted, as recorded in
  `contracts/streaming-payments/test_snapshots/test/*.json`, then re-encoded as
  `ContractEvent` XDR. This means the fixture values (addresses, amounts, ids,
  field order) are real outputs of the contract, not invented.
* **Transaction envelopes** are real signed Soroban invoke envelopes built with
  `@stellar/stellar-sdk` from the same values, with fixed key seeds, fixed fee,
  and no time bounds, so regeneration is deterministic.
* **Struct results** (`get-stream-*`) are the stored `Stream` contract-data
  ledger entry from the same snapshots, so they carry the contract's real enum
  encoding (`status` is `Vec[Symbol("Cancelled")]`).
* **Other results** are ScVals encoded from the function's return type; the
  error vector encodes `SCError::Contract(code)`, with the code looked up by
  name in `frontend/lib/errors.ts`.

## Regenerating

```bash
make -C sdks vectors        # cd sdks/vectors/builder && npm ci && node build-vectors.mjs
git diff --exit-code sdks/vectors
```

The builder is `sdks/vectors/builder/build-vectors.mjs`, a private Node package
(pinned `@stellar/stellar-sdk`, committed lockfile) that only assembles
envelopes; it is shared tooling, not an SDK. CI runs it and fails if the
checked-in vectors change. `sdks/generator/test_vectors_and_catalog.py` also
checks that every vector carries the current spec fingerprint and only uses
operations, arguments and events the spec declares. If you have a deployed testnet contract
and want to capture live events instead, decode `getEvents().valueXdr` into a
`ContractEvent` XDR array; the vector schema only requires the base64 fields, so
`eventsXdr` can be replaced with captured values (keep `expected` in sync).

## Adding a vector

1. Pick a scenario and its snapshot event(s) (or a synthetic error result).
2. Add it to the `scenarios` array in the builder.
3. Regenerate and inspect the `expected` block: it is the oracle every SDK must
   match.
4. Run `make -C sdks check`.
