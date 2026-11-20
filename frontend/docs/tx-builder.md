# Transaction builder sandbox

The spec-driven transaction builder lives at **`/tx-builder`**. It is for
integrators who need to call a StreamPay entrypoint that does not have a
dedicated screen (or who need to inspect the raw Soroban response before
building their own integration).

## What it does

1. Reads the canonical contract spec at `sdks/spec/streampay.spec.json`.
   Turbopack's workspace root is the repository root so this remains the single
   source of truth; there is no copied spec to drift.
2. Generates a typed argument form for **every** current entrypoint — 101 at the
   time of writing — including recursive `vec`, `option`, struct, enum and
   tagged-union values.
3. Builds the unsigned transaction XDR, simulates it against Stellar Testnet,
   and shows the assembled XDR, resource footprint, return value, diagnostic
   events and raw `SorobanTransactionData`.
4. Optionally signs with the connected Freighter wallet and submits it, then
   polls `getTransaction` for the execution result and contract events.

The form is not a per-function hand-written UI. Adding a function or changing a
struct in the spec changes the form automatically; the encoder and form share
the same `emptyValue` / `toScVal` model in `lib/tx-builder/values.ts`.

## Testnet-only safety

The page refuses to render the builder when either condition holds:

- `NEXT_PUBLIC_NETWORK` is not `TESTNET` (for example `PUBLIC`); or
- `NEXT_PUBLIC_SOROBAN_RPC_URL` is a mainnet endpoint, a malformed URL, or a
  custom host that is not explicitly Testnet/local.

The refusal is loud, non-dismissible, and lists every reason. The guard is in
`lib/tx-builder/safety.ts` and is unit-tested for Testnet, localhost, PUBLIC,
mainnet and unknown hosts. It is a UI safety gate, not a substitute for
reviewing what you sign; the RPC ultimately submits wherever its URL points.

## Reading the output

| Pane | What to look for |
|---|---|
| Assembled transaction XDR | The base64 envelope including the simulated Soroban resource data. This is what the wallet signs. |
| Simulation | `minResourceFee`, instruction/disk/write budget, read-only and read-write ledger key counts. Expand the footprint details for each key's base64 XDR. |
| Return value | Human-readable `scValToNative` value plus its raw XDR. |
| Events | Humanized diagnostic events from simulation, and contract events from execution. |
| Execution | Transaction hash, ledger, status, result XDR and return value. |

Simulation uses a dummy sequence (`Account(source, "0")`) so the call can be
inspected before the source account is funded. Submission re-fetches the real
source account before building and signing.

## `create_stream` demo

The checked-in fixture
[`lib/tx-builder/fixtures/create-stream.json`](../lib/tx-builder/fixtures/create-stream.json)
is the end-to-end demo. It uses the same addresses as the client-parity
fixtures:

```json
{
  "contractId": "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL",
  "source": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "functionName": "create_stream",
  "args": {
    "sender": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "recipient": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
    "token": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    "deposit_amount": "101",
    "start_time": "1000",
    "end_time": "1010",
    "cancelable": true
  }
}
```

To reproduce it in the UI:

1. Start the frontend (`npm run dev` in `frontend/`) with a Testnet RPC.
2. Open `/tx-builder` and select `create_stream`.
3. Paste the values above. The contract id and source come from
   `NEXT_PUBLIC_STREAMING_CONTRACT_ID` and your connected wallet respectively;
   the fixture addresses are intentionally the byte-zero demo accounts.
4. Click **Simulate**. The fixture test asserts the generic builder's operation
   XDR is byte-for-byte identical to
   `buildCreateStreamOperation(...)` from `lib/stellar-ops.ts`, which itself is
   covered by the client-parity suite.
5. With a funded Testnet source account and the token approval in place, connect
   Freighter and click **Sign & submit**. The output pane then polls for the
   execution result and shows `StreamCreated`/`FeeCharged` events.

The simulation step will return a contract error for the byte-zero demo
accounts if they have no token balance/allowance; that is expected. Use a funded
sender and a real token allowance for a successful submit. The point of the
fixture is the exact invocation encoding, not a live funded stream.

## Verification

```bash
cd frontend
npm run typecheck
npm test -- lib/tx-builder/tx-builder.spec.ts
npm run lint
npm run build
```

`tx-builder.spec.ts` builds an invocation for all 101 spec entrypoints, exercises
nested vectors, options, unions, enums, struct field ordering, integer/bytes
validation and the safety gate, and checks the `create_stream` fixture against
the canonical SDK operation XDR.

## Limitations

- The page is client-only and depends on a browser wallet for submission.
  Simulation needs only RPC access.
- It does not restore archived ledger entries automatically. If simulation
  reports a restore preamble, restore the entries first.
- The RPC URL is build-time configuration (`NEXT_PUBLIC_*`), so changing it
  requires a rebuild/restart.
