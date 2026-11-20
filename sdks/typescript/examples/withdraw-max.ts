/**
 * withdrawMax — claim the entire accrued balance in one call.
 *
 * This is the atomic form of "read `available`, then `withdraw` it", so the
 * client never races a stale amount. Recipient signer only. Reverts with
 * `NothingToWithdraw` (code 12) when nothing has accrued yet.
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

const paid = await client.withdrawMax({ streamId: 1n });

console.log(paid);
// 2500000n  (the amount transferred to the recipient; 0n is never returned)
