/**
 * Event decoding — turn RPC `ContractEvent` XDR into typed SDK events.
 *
 * `_getEvents` is the raw JSON-RPC shape: each event's `value` is the base64
 * `ContractEvent` XDR that `decodeEvents` consumes. (`getEvents` parses it
 * into ScVals for you; the decoder needs the XDR.) Foreign contracts are
 * dropped, and malformed XDR throws instead of being skipped, so an indexer
 * notices a corrupt feed.
 */
import { rpc } from "@stellar/stellar-sdk";
import { decodeEvents } from "@streampay/sdk";

const contractId = process.env.STREAM_CONTRACT_ID!;
const server = new rpc.Server("https://soroban-testnet.stellar.org");

const { sequence } = await server.getLatestLedger();
const page = await server._getEvents({
  startLedger: sequence - 1_000,
  filters: [{ type: "contract", contractIds: [contractId] }],
  limit: 100,
});

const events = decodeEvents(page.events.map((event) => event.value));

for (const event of events) {
  switch (event.type) {
    case "StreamCreated":
      console.log(event.streamId, event.sender, event.deposit);
      break;
    case "Withdrawn":
      console.log(event.streamId, event.recipient, event.amount, event.withdrawnTotal);
      break;
    case "StreamCancelled":
      console.log(event.streamId, event.recipientAmount, event.senderAmount);
      break;
    default:
      console.log(event.type);
  }
}
// 1n GBUQ…SDEP 10000000n
// 1n GBREC…7K2M 2500000n 2500000n
// 1n 3000000n 7000000n
