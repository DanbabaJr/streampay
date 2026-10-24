import {
  validateQueryParams,
  computeStateHash,
  computeETag,
  matchesIfNoneMatch,
  computeCurve,
  ValidationError,
  type AccrualCurveResponse,
} from "./curve.ts";
import {
  globalRpcBudgetManager,
  RpcBudgetManager,
} from "./budget-manager.ts";
import {
  defaultIndexerClient,
  type IStreamFetcher,
  type StreamFetcherResult,
} from "./indexer-client.ts";

export interface AccrualHandlerOptions {
  budgetManager?: RpcBudgetManager;
  indexerClient?: IStreamFetcher;
}

/**
 * Extracts a client identification key from request headers.
 */
export function extractClientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const auth = request.headers.get("authorization");
  if (auth) return auth.trim();
  return "127.0.0.1";
}

/**
 * Core handler for GET /accrual/:id?from&to&step
 */
export async function handleAccrualRequest(
  request: Request,
  routeParams: { id: string },
  options: AccrualHandlerOptions = {}
): Promise<Response> {
  const budgetManager = options.budgetManager ?? globalRpcBudgetManager;
  const indexerClient = options.indexerClient ?? defaultIndexerClient;

  const clientId = extractClientId(request);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // 1. Enforce per-client rate budget
  const clientDecision = budgetManager.consumeClientBudget(clientId, 1, nowMs);

  if (!clientDecision.allowed) {
    const retryAfter = clientDecision.retryAfterSeconds ?? 1;

    // Check if we can serve a safe stale response
    const staleSnapshot = budgetManager.getStaleSnapshot(routeParams.id, nowSec);
    if (staleSnapshot) {
      try {
        const url = new URL(request.url);
        const queryParams = validateQueryParams({
          id: routeParams.id,
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          step: url.searchParams.get("step"),
        });

        const stateHash = computeStateHash(staleSnapshot);
        const etag = computeETag(stateHash, queryParams);
        const lagSeconds = Math.max(0, nowSec - staleSnapshot.asOfTimestamp);

        // If client sent If-None-Match and it matches stale etag:
        if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: etag,
              "X-State-Hash": stateHash,
              "X-As-Of-Ledger": staleSnapshot.asOfLedger.toString(),
              "X-As-Of-Timestamp": new Date(staleSnapshot.asOfTimestamp * 1000).toISOString(),
              Age: lagSeconds.toString(),
              "X-Cache": "STALE",
              "X-RateLimit-Remaining": "0",
              "Retry-After": retryAfter.toString(),
              "Cache-Control": "private, no-cache",
              Warning: `199 - "Served stale snapshot due to rate limit: retry after ${retryAfter}s"`,
            },
          });
        }

        const points = computeCurve(staleSnapshot, queryParams);
        const body: AccrualCurveResponse = {
          streamId: staleSnapshot.id,
          asOfLedger: staleSnapshot.asOfLedger,
          asOfTimestamp: staleSnapshot.asOfTimestamp,
          stateHash,
          params: {
            from: queryParams.from,
            to: queryParams.to,
            step: queryParams.step,
            count: points.length,
          },
          points,
        };

        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: etag,
            "X-State-Hash": stateHash,
            "X-As-Of-Ledger": staleSnapshot.asOfLedger.toString(),
            "X-As-Of-Timestamp": new Date(staleSnapshot.asOfTimestamp * 1000).toISOString(),
            Age: lagSeconds.toString(),
            "X-Cache": "STALE",
            "X-RateLimit-Remaining": "0",
            "Retry-After": retryAfter.toString(),
            "Cache-Control": "private, no-cache",
            Warning: `199 - "Served stale snapshot due to rate limit: retry after ${retryAfter}s"`,
          },
        });
      } catch {
        // If query params were invalid, fall through to 429
      }
    }

    return new Response(
      JSON.stringify({
        error: "TooManyRequests",
        message: `Client rate budget exhausted. Please retry after ${retryAfter} seconds.`,
        retryAfter,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  // 2. Validate input parameters
  let queryParams;
  try {
    const url = new URL(request.url);
    queryParams = validateQueryParams({
      id: routeParams.id,
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      step: url.searchParams.get("step"),
    });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return new Response(
        JSON.stringify({
          error: err.code,
          message: err.message,
        }),
        {
          status: err.statusCode,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    return new Response(
      JSON.stringify({
        error: "INVALID_REQUEST",
        message: "Invalid query parameters.",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // 3. Fetch stream state from contract / indexer
  let fetchResult: StreamFetcherResult | null;
  try {
    fetchResult = await indexerClient.fetchStream(queryParams.id);
  } catch (err: unknown) {
    const errorObj = err as { code?: string; retryAfter?: number; message?: string };
    if (errorObj?.code === "RPC_BUDGET_EXHAUSTED") {
      const retryAfter = errorObj.retryAfter ?? 5;
      return new Response(
        JSON.stringify({
          error: "TooManyRequests",
          message: `Shared upstream RPC budget exhausted. Please retry after ${retryAfter} seconds.`,
          retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": retryAfter.toString(),
          },
        }
      );
    }
    return new Response(
      JSON.stringify({
        error: "INTERNAL_ERROR",
        message: errorObj?.message || "Failed to fetch stream state.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!fetchResult) {
    return new Response(
      JSON.stringify({
        error: "StreamNotFound",
        message: `Stream #${queryParams.id} does not exist.`,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const { stream, freshness, isStaleFallback } = fetchResult;

  // 4. Compute State Hash & ETag
  const stateHash = computeStateHash(stream);
  const etag = computeETag(stateHash, queryParams);

  // 5. Build freshness and cache headers
  const isTerminal = stream.status === "Cancelled" || stream.status === "Depleted";
  const cacheControl = isTerminal
    ? "public, max-age=3600, immutable"
    : "public, max-age=5, stale-while-revalidate=15";

  const headers: Record<string, string> = {
    ETag: etag,
    "X-State-Hash": stateHash,
    "X-As-Of-Ledger": freshness.asOfLedger.toString(),
    "X-As-Of-Timestamp": new Date(freshness.asOfTimestamp * 1000).toISOString(),
    Age: freshness.lagSeconds.toString(),
    "Cache-Control": cacheControl,
    "X-RateLimit-Remaining": clientDecision.remaining.toString(),
  };

  if (freshness.isLagging) {
    headers["X-Indexer-Lag"] = freshness.lagSeconds.toString();
    headers["Warning"] = `199 - "Indexer state lagging behind tip by ${freshness.lagSeconds} seconds"`;
  }

  if (isStaleFallback) {
    headers["X-Cache"] = "STALE";
  }

  // 6. Support Caching: ETag / If-None-Match -> 304 Not Modified
  const ifNoneMatch = request.headers.get("if-none-match");
  if (matchesIfNoneMatch(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  // 7. Compute Accrual Curve (Computed, never stored)
  const points = computeCurve(stream, queryParams);

  const responseBody: AccrualCurveResponse = {
    streamId: stream.id,
    asOfLedger: freshness.asOfLedger,
    asOfTimestamp: freshness.asOfTimestamp,
    stateHash,
    params: {
      from: queryParams.from,
      to: queryParams.to,
      step: queryParams.step,
      count: points.length,
    },
    points,
  };

  headers["Content-Type"] = "application/json";

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers,
  });
}
