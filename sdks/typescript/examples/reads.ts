/**
 * Reads — no signer, no fees: every view simulates against testnet RPC.
 *
 * A read-only client only needs `contractId`. `getStream` returns a typed
 * `Stream`; `available` is the claimable accrual; the index helpers page
 * through the on-chain sender/recipient lists.
 */
import { StreamPayClient, type Stream } from "@streampay/sdk";

const address = process.env.RECIPIENT_ADDRESS!;

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
});

const stream: Stream = await client.getStream({ streamId: 1n });
console.log(stream.deposit, stream.withdrawn, stream.status);
// 10000000n 0n 'Active'

const claimable = await client.available({ streamId: 1n });
console.log(claimable);
// 2500000n

// One page of the recipient index (`limit` is clamped to MAX_PAGE_SIZE):
const page = await client.recipientStreams({ recipient: address, offset: 0, limit: 10 });
console.log(page);
// [1n, 4n]

// Every indexed id, following pages to exhaustion:
const ids = await client.streamIds("recipient", address);
console.log(ids);
// [1n, 4n]

// The same ids loaded into full records; stale ids are skipped:
const streams = await client.streamsFor("recipient", address);
console.log(streams.map((s) => [s.id, s.status]));
// [[1n, 'Active'], [4n, 'Cancelled']]
