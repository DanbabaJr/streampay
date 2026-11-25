import {
  Account,
  Contract,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  type StreamData,
  DEFAULT_LAG_THRESHOLD_SECONDS,
} from "./curve.ts";
import {
  globalRpcBudgetManager,
  RpcBudgetManager,
  type CachedStreamState,
} from "./budget-manager.ts";

export interface NetworkFreshness {
  asOfLedger: number;
  asOfTimestamp: number;
  tipLedger: number;
  tipTimestamp: number;
  lagSeconds: number;
  isLagging: boolean;
}

export interface StreamFetcherResult {
  stream: StreamData;
  freshness: NetworkFreshness;
  isStaleFallback?: boolean;
}

export interface IStreamFetcher {
  fetchStream(streamId: string): Promise<StreamFetcherResult | null>;
}

const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

/**
 * Direct read-only RPC simulation against the Soroban contract.
 * Does not require any browser wallet or signing credentials.
 */
async function queryContractStream(streamId: string): Promise<StreamData | null> {
  const contractId = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID;
  if (!contractId) return null;
  const rpcUrl =
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org";
  const network =
    process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
      ? Networks.PUBLIC
      : Networks.TESTNET;

  const server = new rpc.Server(rpcUrl);
  const contractInstance = new Contract(contractId);
  const scValId = nativeToScVal(BigInt(streamId), { type: "u64" });

  const tx = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: network,
  })
    .addOperation(contractInstance.call("get_stream", scValId))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;

  const raw = scValToNative(sim.result.retval) as Record<string, unknown>;
  const nowSec = Math.floor(Date.now() / 1000);
  const asOfLedger = sim.latestLedger ?? 1_000_000 + Math.floor(nowSec / 5);

  return {
    id: String(raw.id),
    sender: String(raw.sender),
    recipient: String(raw.recipient),
    token: String(raw.token),
    deposit: BigInt(String(raw.deposit)),
    withdrawn: BigInt(String(raw.withdrawn)),
    startTime: Number(raw.start_time),
    endTime: Number(raw.end_time),
    cancelable: Boolean(raw.cancelable),
    status: String(raw.status),
    asOfLedger,
    asOfTimestamp: nowSec,
  };
}

export class IndexerClient implements IStreamFetcher {
  private budgetManager: RpcBudgetManager;
  private lagThresholdSeconds: number;
  private customFetcher?: (streamId: string) => Promise<StreamData | null>;

  constructor(
    budgetManager: RpcBudgetManager = globalRpcBudgetManager,
    lagThresholdSeconds = DEFAULT_LAG_THRESHOLD_SECONDS,
    customFetcher?: (streamId: string) => Promise<StreamData | null>
  ) {
    this.budgetManager = budgetManager;
    this.lagThresholdSeconds = lagThresholdSeconds;
    this.customFetcher = customFetcher;
  }

  /**
   * Fetches stream state while respecting shared node RPC limits.
   * If node RPC is exhausted, falls back to transient stale snapshot if safe.
   */
  async fetchStream(streamId: string): Promise<StreamFetcherResult | null> {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // 1. Check upstream node RPC budget before attempting network call
    const nodeBudget = this.budgetManager.consumeNodeRpcBudget(1, nowMs);

    if (!nodeBudget.allowed) {
      // Upstream RPC budget exhausted! Attempt honest stale fallback
      const stale = this.budgetManager.getStaleSnapshot(streamId, nowSec);
      if (stale) {
        const freshness: NetworkFreshness = {
          asOfLedger: stale.asOfLedger,
          asOfTimestamp: stale.asOfTimestamp,
          tipLedger: stale.asOfLedger, // cannot query tip without budget
          tipTimestamp: nowSec,
          lagSeconds: Math.max(0, nowSec - stale.asOfTimestamp),
          isLagging: nowSec - stale.asOfTimestamp > this.lagThresholdSeconds,
        };
        return {
          stream: {
            id: stale.id,
            sender: stale.sender,
            recipient: stale.recipient,
            token: stale.token,
            deposit: stale.deposit,
            withdrawn: stale.withdrawn,
            startTime: stale.startTime,
            endTime: stale.endTime,
            cancelable: stale.cancelable,
            status: stale.status,
            asOfLedger: stale.asOfLedger,
            asOfTimestamp: stale.asOfTimestamp,
          },
          freshness,
          isStaleFallback: true,
        };
      }

      // No safe stale snapshot available; propagate budget exhaustion
      const err = new Error("Upstream Soroban RPC node rate budget exhausted.");
      (err as unknown as { code: string; retryAfter: number }).code =
        "RPC_BUDGET_EXHAUSTED";
      (err as unknown as { retryAfter: number }).retryAfter =
        nodeBudget.retryAfterSeconds ?? 5;
      throw err;
    }

    // 2. Perform stream state read
    let streamData: StreamData | null = null;

    if (this.customFetcher) {
      streamData = await this.customFetcher(streamId);
    } else {
      try {
        streamData = await queryContractStream(streamId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("not found") || msg.includes("StreamNotFound")) {
          return null;
        }
        throw e;
      }
    }

    if (!streamData) {
      return null;
    }

    // 3. Cache snapshot for stale fallback
    const cachedState: CachedStreamState = {
      ...streamData,
      fetchedAt: nowMs,
    };
    this.budgetManager.storeSnapshot(streamId, cachedState);

    // 4. Compute freshness metrics
    const tipTimestamp = nowSec;
    const tipLedger = streamData.asOfLedger;
    const lagSeconds = Math.max(0, tipTimestamp - streamData.asOfTimestamp);
    const isLagging = lagSeconds > this.lagThresholdSeconds;

    return {
      stream: streamData,
      freshness: {
        asOfLedger: streamData.asOfLedger,
        asOfTimestamp: streamData.asOfTimestamp,
        tipLedger,
        tipTimestamp,
        lagSeconds,
        isLagging,
      },
      isStaleFallback: false,
    };
  }
}

export const defaultIndexerClient = new IndexerClient();
