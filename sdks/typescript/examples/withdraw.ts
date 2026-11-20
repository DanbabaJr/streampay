/**
 * withdraw — claim part of the accrued, unwithdrawn balance.
 *
 * Only the stream's recipient can call this, so the signer is the recipient
 * keypair. `amount` must not exceed `available({ streamId })`, which is how
 * you keep the call from reverting with `AmountExceedsAvailable` (code 10).
 */
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StreamPayClient, signerFromKeypair } from "@streampay/sdk";

const recipient = Keypair.fromSecret(process.env.RECIPIENT_SECRET!);

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: signerFromKeypair(recipient),
});

const claimable = await client.available({ streamId: 1n });
console.log(claimable); // 3000000n

await client.withdraw({
  streamId: 1n,
  amount: 1_000_000n, // <= claimable
});

// withdraw resolves with no return value; the payout is reflected in state:
const stream = await client.getStream({ streamId: 1n });
console.log(stream.withdrawn); // 1000000n
