# @streampay/sdk

Typed TypeScript client for the StreamPay Soroban contract, generated from
[`sdks/spec/streampay.spec.json`](../spec/streampay.spec.json).

**This package is not published to npm.** Use the workspace or an `npm pack`
tarball:

```bash
# from a checkout of this repository
cd sdks/typescript
npm ci
npm run build          # emits dist/

# in another project: pack it here, install the tarball there
npm pack               # streampay-sdk-0.3.0.tgz
npm install /path/to/streampay-sdk-0.3.0.tgz @stellar/stellar-sdk
```

If it is ever published, the StreamPay maintainers (the Neziahtech organisation
owners) are the ones who hold the npm scope and run the release. Until then,
`npm install @streampay/sdk` will 404 and is not the documented path.

Requires Node 20+.

## Quickstart against testnet

```ts
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StreamPayClient, signerFromKeypair } from "@streampay/sdk";

const keypair = Keypair.fromSecret(process.env.STELLAR_SECRET!);

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: signerFromKeypair(keypair),
});

// Every operation takes one named-argument object; reads need no signer.
const stream = await client.getStream({ streamId: 1n });
console.log(stream.deposit, stream.status, stream.startTime, stream.useOracle);
// `useOracle` is `boolean | null` (the contract's `Option<bool>`): `null` is a
// record written before the oracle clock existed and settles on ledger time,
// exactly like `false`. The `create_stream_with_oracle` / `resolve_time`
// arguments stay a plain `boolean`.

// Mutating calls: build -> simulate -> sign -> send -> poll -> decode
const id = await client.createStream({
  sender: keypair.publicKey(),
  recipient: "G…recipient",
  token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // testnet native SAC
  depositAmount: 10_000_000n,
  startTime: Math.floor(Date.now() / 1000) + 1,
  endTime: Math.floor(Date.now() / 1000) + 3600,
  cancelable: true,
});

const paid = await client.withdrawMax({ streamId: id });
```

Oracle-settled streams use the same shape with `createStreamWithOracle`:

```ts
await client.createStreamWithOracle({ ...createStreamArgs, useOracle: true });
```

The client exposes every contract entrypoint in the spec (`createStreams`,
`createStreamsBatch`, `scheduleStream`, treasury/fee, the `policy_*` set,
governor rotation and upgrades, freeze, disputes, rate changes, the sponsor
relay, ownership transfer, oracle configuration, the `governance_*` timelock,
…) with the same one-object calling convention. `FUNCTIONS` and `METHODS`
export the generated operation metadata.

Contract enums follow the contract's wire encoding: unit enums are string
unions (`"Active" | "Cancelled" | "Depleted"`, encoded `Vec[Symbol]`), and
payload enums such as `GovernanceAction` are tagged objects:

```ts
await client.governancePropose({
  caller: signerAddress,
  action: { variant: "SetFeeBps", payload: [25] },
});
```

For a browser wallet, pass any object implementing `Signer`:

```ts
import { signTransaction } from "@stellar/freighter-api";
import type { Signer } from "@streampay/sdk";

const freighter: Signer = {
  publicKey: () => address, // from freighter requestAccess()
  async signTransaction(xdr, { networkPassphrase }) {
    const { signedTxXdr } = await signTransaction(xdr, { networkPassphrase });
    return { signedTxXdr };
  },
};
```

The pipeline mirrors `frontend/lib/stellar.ts`: simulate first (early typed
contract errors), assemble, sign, submit, poll, then decode the return value.

## Events

Events from RPC (`getEvents`) are base64 `ContractEvent` XDR:

```ts
import { decodeEvents } from "@streampay/sdk";

const events = decodeEvents(rpcResponse.events.map((event) => event.valueXdr));
// StreamCreatedEvent | WithdrawnEvent | … (all contract events)
for (const event of events) {
  if (event.type === "StreamCreated") {
    console.log(event.streamId, event.deposit, event.sender);
  }
}
```

Malformed XDR throws; events from other contracts are not returned.

## Index pagination

```ts
const ids = await client.streamIds("recipient", address);
const streams = await client.streamsFor("recipient", address);
```

`streamIds` follows the on-chain `recipient_streams` / `sender_streams` pages
until exhausted, clamping the page size to `MAX_PAGE_SIZE`. `streamsFor` skips
ids that no longer resolve.

## Errors

`StreamPayError` carries the failing stage and the catalog-backed contract code:

```ts
import { StreamPayError } from "@streampay/sdk";

try {
  await client.withdraw({ streamId: 1n, amount: 1n });
} catch (error) {
  if (error instanceof StreamPayError) {
    console.log(error.kind);      // simulation | submission | inclusion | decode | transport
    console.log(error.contract);  // { code: 10, name: "AmountExceedsAvailable" }
    console.log(error.transactionXdr);
  }
}
```

The error table is generated from the canonical catalog
(`frontend/lib/errors.ts`), not restated by this package.

## Conformance

`npm test` runs the vector suite plus codec round-trips, pagination, event, and
error tests. `npm run conformance -- ../vectors` prints this SDK's canonical
decode for the shared fixtures.

## Versioning and publishing

The package version tracks the contract release line (currently `0.3.0`).
Whether `@streampay/sdk` is published at all is undecided and is the StreamPay
maintainers' call; if it is, they hold the npm scope and run the release.
Until then `npm pack` / the workspace path is the supported distribution.
CI runs `npm pack --dry-run` only; no registry credentials are used by pull
requests.
