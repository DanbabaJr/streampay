/**
 * batch — create several streams in one transaction.
 *
 * `createStreams` is all-or-nothing: one authorization, one token pull per
 * token, and any invalid entry reverts the whole batch. `createStreamsBatch`
 * is best-effort per entry: it reports every failure in the result vector and
 * keeps the streams that did succeed.
 */
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StreamPayClient, signerFromKeypair } from "@streampay/sdk";

const sender = Keypair.fromSecret(process.env.STELLAR_SECRET!);
const recipient = process.env.RECIPIENT_ADDRESS!;
const token = process.env.TOKEN_CONTRACT_ID!; // testnet native SAC: CDLZFC3S…HYSC
const now = BigInt(Math.floor(Date.now() / 1000));

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: signerFromKeypair(sender),
});

// 1) Atomic batch: every entry validates, or nothing is created.
const ids = await client.createStreams({
  sender: sender.publicKey(),
  inputs: [
    { recipient, token, depositAmount: 5_000_000n, startTime: now + 1n, endTime: now + 3_600n, cancelable: true },
    { recipient, token, depositAmount: 7_500_000n, startTime: now + 1n, endTime: now + 7_200n, cancelable: false },
  ],
});
console.log(ids);
// [2n, 3n]

// 2) Per-entry batch: failures are returned, successful entries are kept.
const results = await client.createStreamsBatch({
  entries: [
    { sender: sender.publicKey(), recipient, token, deposit: 5_000_000n, startTime: now + 1n, endTime: now + 3_600n, cancelable: true },
    { sender: sender.publicKey(), recipient, token, deposit: 5_000_000n, startTime: now + 3_600n, endTime: now + 1n, cancelable: true },
  ],
});
for (const result of results) {
  console.log("ok" in result ? `created ${result.ok}` : `skipped: ${result.error}`);
}
// created 4n
// skipped: InvalidTimeRange
