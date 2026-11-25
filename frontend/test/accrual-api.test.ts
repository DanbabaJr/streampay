import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { handleAccrualRequest } from "../lib/accrual-handler.ts";
import { RpcBudgetManager } from "../lib/budget-manager.ts";
import { type IStreamFetcher, type StreamFetcherResult } from "../lib/indexer-client.ts";
import { type StreamData } from "../lib/curve.ts";

function createMockFetcher(streams: Record<string, StreamData>, lagSeconds = 5): IStreamFetcher {
  return {
    async fetchStream(id: string): Promise<StreamFetcherResult | null> {
      const stream = streams[id];
      if (!stream) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      const isLagging = lagSeconds > 60;
      return {
        stream,
        freshness: {
          asOfLedger: stream.asOfLedger,
          asOfTimestamp: stream.asOfTimestamp,
          tipLedger: stream.asOfLedger + Math.floor(lagSeconds / 5),
          tipTimestamp: nowSec,
          lagSeconds,
          isLagging,
        },
      };
    },
  };
}

const testStream: StreamData = {
  id: "1",
  sender: "GB...SENDER",
  recipient: "GB...RECIPIENT",
  token: "CB...TOKEN",
  deposit: 10_000_000_000n,
  withdrawn: 0n,
  startTime: 1000,
  endTime: 2000,
  cancelable: true,
  status: "Active",
  asOfLedger: 750000,
  asOfTimestamp: 1500,
};

describe("Accrual Curve Endpoint: GET /accrual/:id", () => {
  it("returns 200 with computed curve and required headers", async () => {
    const budgetManager = new RpcBudgetManager();
    const fetcher = createMockFetcher({ "1": testStream }, 10);

    const req = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50");
    const res = await handleAccrualRequest(req, { id: "1" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/json");

    // ETag & State Hash headers
    const etag = res.headers.get("etag");
    const stateHash = res.headers.get("x-state-hash");
    assert.ok(etag && etag.startsWith('W/"'));
    assert.ok(stateHash && stateHash.length === 64);

    // Honest freshness headers
    assert.strictEqual(res.headers.get("x-as-of-ledger"), "750000");
    assert.ok(res.headers.get("x-as-of-timestamp"));
    assert.strictEqual(res.headers.get("age"), "10");

    // Cache-Control for active stream
    assert.strictEqual(res.headers.get("cache-control"), "public, max-age=5, stale-while-revalidate=15");

    const json = (await res.json()) as {
      streamId: string;
      asOfLedger: number;
      stateHash: string;
      points: Array<{ timestamp: number; accrued: string }>;
    };

    assert.strictEqual(json.streamId, "1");
    assert.strictEqual(json.stateHash, stateHash);
    assert.strictEqual(json.asOfLedger, 750000);
    assert.strictEqual(json.points.length, 5); // 1000, 1050, 1100, 1150, 1200
  });

  it("returns 304 Not Modified when If-None-Match matches ETag", async () => {
    const budgetManager = new RpcBudgetManager();
    const fetcher = createMockFetcher({ "1": testStream });

    // Initial request to get ETag
    const req1 = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50");
    const res1 = await handleAccrualRequest(req1, { id: "1" }, { budgetManager, indexerClient: fetcher });
    const etag = res1.headers.get("etag")!;

    // Conditional request with If-None-Match
    const req2 = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50", {
      headers: { "if-none-match": etag },
    });
    const res2 = await handleAccrualRequest(req2, { id: "1" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res2.status, 304);
    assert.strictEqual(res2.headers.get("etag"), etag);
    assert.strictEqual(res2.headers.get("x-state-hash"), res1.headers.get("x-state-hash"));

    // 304 must have no body
    const bodyText = await res2.text();
    assert.strictEqual(bodyText, "");
  });

  it("returns 400 for validation errors", async () => {
    const budgetManager = new RpcBudgetManager();
    const fetcher = createMockFetcher({ "1": testStream });

    // from > to
    const req1 = new Request("http://localhost:3000/accrual/1?from=2000&to=1000&step=10");
    const res1 = await handleAccrualRequest(req1, { id: "1" }, { budgetManager, indexerClient: fetcher });
    assert.strictEqual(res1.status, 400);
    const json1 = await res1.json() as { error: string };
    assert.strictEqual(json1.error, "FROM_GREATER_THAN_TO");

    // step <= 0
    const req2 = new Request("http://localhost:3000/accrual/1?from=1000&to=2000&step=0");
    const res2 = await handleAccrualRequest(req2, { id: "1" }, { budgetManager, indexerClient: fetcher });
    assert.strictEqual(res2.status, 400);
    const json2 = await res2.json() as { error: string };
    assert.strictEqual(json2.error, "INVALID_STEP_POSITIVE");

    // Unbounded computation limit
    const req3 = new Request("http://localhost:3000/accrual/1?from=0&to=100000&step=1");
    const res3 = await handleAccrualRequest(req3, { id: "1" }, { budgetManager, indexerClient: fetcher });
    assert.strictEqual(res3.status, 400);
    const json3 = await res3.json() as { error: string };
    assert.strictEqual(json3.error, "POINT_LIMIT_EXCEEDED");
  });

  it("returns 404 for unknown stream ID", async () => {
    const budgetManager = new RpcBudgetManager();
    const fetcher = createMockFetcher({ "1": testStream });

    const req = new Request("http://localhost:3000/accrual/999?from=1000&to=2000&step=100");
    const res = await handleAccrualRequest(req, { id: "999" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res.status, 404);
    const json = await res.json() as { error: string };
    assert.strictEqual(json.error, "StreamNotFound");
  });

  it("emits honest Warning and lag header when indexer is lagging behind network tip", async () => {
    const budgetManager = new RpcBudgetManager();
    // Simulate indexer lagging by 120 seconds (> 60s threshold)
    const fetcher = createMockFetcher({ "1": testStream }, 120);

    const req = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50");
    const res = await handleAccrualRequest(req, { id: "1" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-indexer-lag"), "120");
    const warning = res.headers.get("warning");
    assert.ok(warning && warning.includes("Indexer state lagging behind tip"));
  });

  it("returns 429 with Retry-After when client rate budget is exhausted", async () => {
    // 2 requests allowed
    const budgetManager = new RpcBudgetManager({ clientLimit: 2, clientWindowSeconds: 60 });
    const fetcher = createMockFetcher({ "1": testStream });

    const reqOptions = {
      headers: { "x-forwarded-for": "198.51.100.1" },
    };

    const req1 = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50", reqOptions);
    const res1 = await handleAccrualRequest(req1, { id: "1" }, { budgetManager, indexerClient: fetcher });
    assert.strictEqual(res1.status, 200);

    const req2 = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50", reqOptions);
    const res2 = await handleAccrualRequest(req2, { id: "1" }, { budgetManager, indexerClient: fetcher });
    assert.strictEqual(res2.status, 200);

    // 3rd request from same client exceeds limit
    // When no snapshot cached in budgetManager: returns 429
    const req3 = new Request("http://localhost:3000/accrual/2?from=1000&to=1200&step=50", reqOptions);
    const res3 = await handleAccrualRequest(req3, { id: "2" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res3.status, 429);
    assert.ok(res3.headers.get("retry-after"));
    const json3 = await res3.json() as { error: string; retryAfter: number };
    assert.strictEqual(json3.error, "TooManyRequests");
    assert.ok(json3.retryAfter > 0);
  });

  it("serves stale response with X-Cache: STALE when rate-limited but safe cached state exists", async () => {
    const budgetManager = new RpcBudgetManager({ clientLimit: 1, clientWindowSeconds: 60 });
    const fetcher = createMockFetcher({ "1": testStream });

    // Store a snapshot in the budget manager's transient cache
    budgetManager.storeSnapshot("1", {
      ...testStream,
      fetchedAt: Date.now() - 5000,
    });

    const reqOptions = {
      headers: { "x-forwarded-for": "198.51.100.2" },
    };

    // 1st request consumes client token
    const req1 = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50", reqOptions);
    const res1 = await handleAccrualRequest(req1, { id: "1" }, { budgetManager, indexerClient: fetcher });
    assert.strictEqual(res1.status, 200);

    // 2nd request exceeds budget, but falls back to cached snapshot
    const req2 = new Request("http://localhost:3000/accrual/1?from=1000&to=1200&step=50", reqOptions);
    const res2 = await handleAccrualRequest(req2, { id: "1" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.headers.get("x-cache"), "STALE");
    assert.ok(res2.headers.get("retry-after"));
    assert.ok(res2.headers.get("warning")?.includes("Served stale snapshot"));
  });

  it("sets immutable Cache-Control on terminal streams", async () => {
    const budgetManager = new RpcBudgetManager();
    const cancelledStream: StreamData = {
      ...testStream,
      id: "2",
      status: "Cancelled",
    };
    const fetcher = createMockFetcher({ "2": cancelledStream });

    const req = new Request("http://localhost:3000/accrual/2?from=1000&to=1200&step=50");
    const res = await handleAccrualRequest(req, { id: "2" }, { budgetManager, indexerClient: fetcher });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("cache-control"), "public, max-age=3600, immutable");
  });
});
