/**
 * topUp — add funds to an active stream.
 *
 * Only the sender may top up, and the sender needs the same token allowance as
 * for `createStream` (see create-stream.ts). Accrual stays linear over the
 * original window, so the recipient's claimable balance grows immediately.
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

await client.topUp({
  streamId: 1n,
  amount: 5_000_000n,
});

// topUp resolves with no return value; read the enlarged deposit back:
const stream = await client.getStream({ streamId: 1n });
console.log(stream.deposit);
// 15000000n  (original 10_000_000n + the 5_000_000n top-up)
