/**
 * Minimal Soroban RPC double for CLI tests. Answers `simulateTransaction`
 * with a decoded `get_stream` map and rotates through the supplied states,
 * bumping `latestLedger` on every call (the noise watch mode must ignore).
 */
import http from "node:http";
import {
  nativeToScVal,
  SorobanDataBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

const SENDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

export interface MockStream {
  id: bigint;
  deposit: bigint;
  withdrawn: bigint;
  startTime: bigint;
  endTime: bigint;
  cancelable: boolean;
  status: string;
}

export function mockStream(overrides: Partial<MockStream> = {}): MockStream {
  return {
    id: 7n,
    deposit: 1_000n,
    withdrawn: 0n,
    startTime: 1_700_000_000n,
    endTime: 1_700_086_400n,
    cancelable: true,
    status: "Active",
    ...overrides,
  };
}

export interface MockRpc {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves `states` in order; once exhausted, repeats the last one. The decoded
 * map deliberately carries extra ledger-ish fields so the tests prove the CLI
 * compares the stream projection rather than the whole RPC payload.
 */
export async function startMockRpc(
  contractId: string,
  states: MockStream[]
): Promise<MockRpc> {
  const transactionData = new SorobanDataBuilder().build().toXDR("base64");
  let calls = 0;
  let ledger = 100;

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id?: number; method?: string };
      if (parsed.method !== "simulateTransaction") {
        response.statusCode = 400;
        response.end("unsupported mock method");
        return;
      }
      const state = states[Math.min(calls, states.length - 1)] ?? mockStream();
      calls += 1;
      const retval: xdr.ScVal = nativeToScVal(
        {
          id: state.id,
          sender: SENDER,
          recipient: RECIPIENT,
          token: TOKEN,
          deposit: state.deposit,
          withdrawn: state.withdrawn,
          start_time: state.startTime,
          end_time: state.endTime,
          cancelable: state.cancelable,
          status: state.status,
          // Noise that must never influence change detection.
          latest_ledger: BigInt(ledger),
          ledger_timestamp: BigInt(1_700_000_000 + ledger),
        }
      );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id ?? 1,
          result: {
            latestLedger: ledger,
            transactionData,
            minResourceFee: "100",
            events: [],
            results: [{ auth: [], xdr: retval.toXDR("base64") }],
          },
        })
      );
      ledger += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock RPC failed to bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export { SENDER, RECIPIENT, TOKEN };
