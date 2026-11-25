/**
 * createStream — open a linear payment stream and pull the deposit.
 *
 * The sender must be funded on testnet (Friendbot) and must have approved the
 * StreamPay contract for `depositAmount` (+ protocol fee, if any) on `token`:
 *
 *   curl -s "https://friendbot.stellar.org?addr=$STELLAR_PUBLIC" >/dev/null
 *   stellar contract invoke --id "$TOKEN_CONTRACT_ID" --source sender \
 *     --network testnet -- approve --spender "$STREAM_CONTRACT_ID" \
 *     --amount 10000000 --expiration_ledger +5000
 *
 * Full funded walkthrough: docs/DEMO.md → "Step 1: Generate & Fund Keypairs"
 * and "Step 3: Register Demo Asset & Approve Contract".
 */
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StreamPayClient, signerFromKeypair } from "@streampay/sdk";

const sender = Keypair.fromSecret(process.env.STELLAR_SECRET!);
const now = Math.floor(Date.now() / 1000);

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: signerFromKeypair(sender),
});

const streamId = await client.createStream({
  sender: sender.publicKey(),
  recipient: process.env.RECIPIENT_ADDRESS!,
  token: process.env.TOKEN_CONTRACT_ID!, // testnet native SAC: CDLZFC3S…HYSC
  depositAmount: 10_000_000n, // 1.0 units at 7 decimals
  startTime: now + 1,
  endTime: now + 3_600, // 1 hour
  cancelable: true, // recipient may also cancel and claim what accrued
});

console.log(streamId);
// 1n  (ids increase from 1; read the stream with getStream)
