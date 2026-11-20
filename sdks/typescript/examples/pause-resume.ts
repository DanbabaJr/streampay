/**
 * pauseStream / resumeStream — freeze and restart accrual (sender only).
 *
 * Pausing locks the stream at its current clock; the recipient can still
 * withdraw what already accrued. Resuming shifts the window and any rate
 * segments forward by the paused length, so the full deposit still streams.
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

await client.pauseStream({
  caller: sender.publicKey(),
  streamId: 1n,
});

// ...later, once the work resumes:

await client.resumeStream({
  caller: sender.publicKey(),
  streamId: 1n,
});

// Both calls resolve with no return value. The pause is visible on the record:
const stream = await client.getStream({ streamId: 1n });
console.log(stream.status, stream.endTime);
// 'Active' 1763593200n  (endTime shifted forward by the paused length)
