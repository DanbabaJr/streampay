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

## Method examples

Every example under [`examples/`](./examples) is a complete, copy-pasteable
script against testnet, written with the SDK's own generated types. Each row
below links its runnable file, and the files are typechecked in CI
(`npm run typecheck`), so they cannot drift from the API.

| Method | Example | Returns |
|---|---|---|
| `createStream` | [`examples/create-stream.ts`](./examples/create-stream.ts) | `bigint` — new stream id |
| `topUp` | [`examples/top-up.ts`](./examples/top-up.ts) | `void` — deposit grows; read it back with `getStream` |
| `withdraw` | [`examples/withdraw.ts`](./examples/withdraw.ts) | `void` — `Stream.withdrawn` grows |
| `withdrawMax` | [`examples/withdraw-max.ts`](./examples/withdraw-max.ts) | `bigint` — amount paid |
| `pauseStream` / `resumeStream` | [`examples/pause-resume.ts`](./examples/pause-resume.ts) | `void` — `endTime` shifts on resume |
| `cancelStream` | [`examples/cancel-stream.ts`](./examples/cancel-stream.ts) | `void` — pro-rata split to both sides |
| `createStreams` / `createStreamsBatch` | [`examples/batch.ts`](./examples/batch.ts) | `bigint[]` / per-entry `{ ok }` or `{ error }` |
| `getStream`, `available`, `recipientStreams`, `streamIds`, `streamsFor` | [`examples/reads.ts`](./examples/reads.ts) | typed `Stream`, `bigint` accrual, index pages |
| `decodeEvent` / `decodeEvents` | [`examples/decode-events.ts`](./examples/decode-events.ts) | `StreamPayEvent[]` |

Each script reads its configuration from the environment:

| Variable | Used by |
|---|---|
| `STREAM_CONTRACT_ID` | all examples |
| `TOKEN_CONTRACT_ID` | `create`, `top-up`, `batch` |
| `STELLAR_SECRET` | `create`, `top-up`, `pause/resume`, `cancel`, `batch` (sender) |
| `RECIPIENT_ADDRESS` | `create`, `batch`, `reads` |
| `RECIPIENT_SECRET` | `withdraw`, `withdrawMax` |

Mutating examples need a funded sender. Fund it with Friendbot and approve the
contract as a spender before running (the whole funded walkthrough, including
the demo token, is in [`docs/DEMO.md`](../../docs/DEMO.md#step-1-generate--fund-keypairs)):

```bash
curl -s "https://friendbot.stellar.org?addr=$STELLAR_PUBLIC" >/dev/null
stellar contract invoke --id "$TOKEN_CONTRACT_ID" --source sender --network testnet \
  -- approve --spender "$STREAM_CONTRACT_ID" --amount 10000000 --expiration_ledger +5000
```

The examples are typechecked, not executed, by CI. To paste one into a project
that installed the SDK tarball, keep the snippets as they are — the imports are
`@streampay/sdk` in both the README and the example files.

## Events

Events from RPC are base64 `ContractEvent` XDR. `rpc.Server._getEvents`
returns that raw shape (`event.value`); `getEvents` parses it into ScVals:

```ts
import { decodeEvents } from "@streampay/sdk";

const events = decodeEvents(rawGetEventsResponse.events.map((event) => event.value));
// StreamCreatedEvent | WithdrawnEvent | … (all contract events)
for (const event of events) {
  if (event.type === "StreamCreated") {
    console.log(event.streamId, event.deposit, event.sender);
  }
}
```

Malformed XDR throws; events from other contracts are not returned.

### Resumable indexer subscription

Configure the indexer's SSE endpoint on the client to subscribe to one stream:

```ts
const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  eventFeedUrl: "https://indexer.example/events/stream",
});
const controller = new AbortController();

for await (const event of client.subscribeEvents(1n, {
  fromCursor: "evt-123",
  signal: controller.signal,
  onError: (error) => console.warn("Event feed reconnecting:", error),
})) {
  // `event.type` is the generated event discriminator.
  // The feed may replay events, so deduplicate by `event.id` before applying
  // non-idempotent state changes.
  console.log(event.id, event.type, event.data);
}

// Stop the iterator from another task:
controller.abort();
```

The indexer feed is at-least-once: a reconnect may replay the last event.
`id`/`cursor` is the stable deduplication key. The subscription reconnects
from its latest received ID with exponential backoff; unknown event names are
skipped, matching the generated decoder's `null` result for unregistered
events.

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

## Retrying submissions

Mutating calls do not retry unless you opt in. Without `retry`, every failure
surfaces exactly as before.

```ts
const client = new StreamPayClient({
  contractId,
  signer,
  retry: {
    maxAttempts: 3,     // total attempts per stage, including the first
    baseDelayMs: 250,   // ceiling for the first wait
    maxDelayMs: 5_000,  // hard cap for any single wait
    jitter: "full",     // uniform in [0, ceiling]; "none" waits the full ceiling
    onRetry: ({ stage, attempt, delayMs, error }) => log.warn({ stage, attempt, delayMs }, String(error)),
  },
});
// `retry: true` uses exactly these defaults.
```

The wait after failed attempt `n` is drawn from
`[0, min(maxDelayMs, baseDelayMs * 2^(n-1))]`. A `Retry-After` header on a
429/503 raises that floor, still capped at `maxDelayMs`. This matches how the
frontend's RPC budget manager (`frontend/lib/budget-manager.ts`) treats rate
limits.

**What is retried.** Only failures where the RPC clearly gave no answer:
network errors (`ECONNRESET`, `ETIMEDOUT`, `fetch failed`, …), request
timeouts, HTTP 408/429/500/502/503/504, and `sendTransaction` returning
`TRY_AGAIN_LATER`. Simulation errors, contract errors, other 4xx responses,
`sendTransaction` `ERROR`, and a transaction that failed in a ledger are
permanent. They throw on the first attempt.

**Why a retry cannot double-submit.**

1. `getAccount` and `simulateTransaction` run before anything is signed, so
   repeating them has no side effects.
2. After signing, the envelope is fixed. A retry resends the same bytes and
   never rebuilds, re-signs, or takes a new sequence number. The transaction
   hash is the idempotency key, and a transaction with a given source and
   sequence number can be included at most once.
3. Before resending after an unanswered attempt, the client calls
   `getTransaction(hash)`. If the network already knows the hash, it skips
   the resend and goes straight to confirmation. If a resend is rejected
   (for example `tx_bad_seq`) after an earlier attempt that may have landed,
   the client checks the hash again before reporting a failure.
4. Confirmation polling tolerates transient `getTransaction` errors until
   `pollTimeoutMs`.

**Ambiguous timeouts.** A transaction that was accepted but not confirmed
before `pollTimeoutMs` is never resubmitted, because its outcome is unknown.
The client throws `StreamPayError` with `kind: "inclusion"` and
`transactionHash`. Reconcile by looking the hash up later. Rebuild and
re-sign only once you know it did not land. The claim scheduler does the same
(`frontend/lib/claim-runtime.ts`): it records a submitted hash and only
re-signs after a definite rejection.

## Conformance

`npm test` runs the vector suite plus codec round-trips, pagination, event,
retry, and error tests. `npm run conformance -- ../vectors` prints this SDK's canonical
decode for the shared fixtures.

## Versioning and publishing

The package version tracks the contract release line (currently `0.3.0`).
Whether `@streampay/sdk` is published at all is undecided and is the StreamPay
maintainers' call; if it is, they hold the npm scope and run the release.
Until then `npm pack` / the workspace path is the supported distribution.
CI runs `npm pack --dry-run` only; no registry credentials are used by pull
requests.

## Telemetry (opt-in)

Telemetry is **off** by default: importing the SDK records and sends nothing. A
host opts in from its consent flow (#515):

```ts
import { enableTelemetry, disableTelemetry, flushTelemetry } from "@streampay/sdk";

enableTelemetry();       // start reporting
await flushTelemetry();  // flush queued batches (e.g. before page unload)
disableTelemetry();      // withdraw consent and discard anything unsent
```

What is reported is a fixed allowlist: schema version, SDK name and version,
event kind, SDK method name, outcome, a latency bucket and an error code (the
contract error name or the failure kind). Addresses, amounts, keys, XDR, payloads
and error messages have no field to travel in, and every emitted value is checked
against a denylist at the emission boundary. Reporting is batched, bounded, backs
off after a failed send, honours a kill switch, and never throws into the host
application.
