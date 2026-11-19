/**
 * cancelStream — unwind a stream, paying both sides atomically.
 *
 * The sender may always cancel; the recipient may also cancel when the stream
 * was created `cancelable: true` (that is why `caller` is explicit). The
 * recipient receives what accrued and is still unwithdrawn, and the sender
 * (or the pinned refund target) receives the unaccrued remainder.
 */
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StreamPayClient, signerFromKeypair } from "@streampay/sdk";

const sender = Keypair.fromSecret(process.env.STELLAR_SECRET!);

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: signerFromKeypair(sender),
});

await client.cancelStream({
  caller: sender.publicKey(),
  streamId: 1n,
});

// cancelStream resolves with no return value; the payout split is in state:
const stream = await client.getStream({ streamId: 1n });
console.log(stream.status, stream.withdrawn);
// 'Cancelled' 3000000n  (paid to the recipient at cancellation)
