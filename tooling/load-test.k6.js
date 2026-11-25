import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

/**
 * k6 Load Test for StreamPay Accrual Curve Endpoint: GET /accrual/:id
 *
 * Evaluates:
 * 1. 200 OK throughput and computation latency
 * 2. ETag / If-None-Match conditional request caching (304 Not Modified)
 * 3. Cache-hit ratio
 * 4. Latency percentiles (p50, p90, p95, p99)
 * 5. Rate budget manager (#56) 429 throttling behavior
 */

export const cacheHitRate = new Rate("cache_hit_rate");
export const rateLimitRate = new Rate("rate_limit_rate");
export const uncachedLatency = new Trend("uncached_latency_ms");
export const cachedLatency = new Trend("cached_304_latency_ms");

export const options = {
  scenarios: {
    // Stage 1: Warmup & baseline
    baseline: {
      executor: "constant-vus",
      vus: 5,
      duration: "10s",
    },
    // Stage 2: Heavy concurrency with conditional caching
    caching_and_load: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "10s", target: 25 },
        { duration: "20s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      startTime: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.15"], // allow for intentional 429 rate limits
    cached_304_latency_ms: ["p(95)<15"],
    uncached_latency_ms: ["p(95)<60"],
  },
};

const BASE_URL = __ENV.TARGET_URL || "http://localhost:3000";
const STREAM_ID = __ENV.STREAM_ID || "1";

export default function () {
  const from = 1700000000;
  const to = 1700003600;
  const step = 60;
  const url = `${BASE_URL}/accrual/${STREAM_ID}?from=${from}&to=${to}&step=${step}`;

  // 1. Uncached / Cold Request
  const res1 = http.get(url);
  uncachedLatency.add(res1.timings.duration);

  if (res1.status === 429) {
    rateLimitRate.add(1);
    sleep(0.1);
    return;
  }

  const passedCold = check(res1, {
    "status is 200": (r) => r.status === 200,
    "has ETag header": (r) => r.headers["Etag"] || r.headers["ETag"],
    "has state hash header": (r) => r.headers["X-State-Hash"] !== undefined,
    "has as-of ledger header": (r) => r.headers["X-As-Of-Ledger"] !== undefined,
  });

  const etag = res1.headers["Etag"] || res1.headers["ETag"];
  if (!etag) {
    cacheHitRate.add(0);
    return;
  }

  // 2. Conditional Request with If-None-Match (ETag)
  const cachedParams = {
    headers: {
      "If-None-Match": etag,
    },
  };

  const res2 = http.get(url, cachedParams);
  cachedLatency.add(res2.timings.duration);

  if (res2.status === 304) {
    cacheHitRate.add(1);
    check(res2, {
      "conditional returns 304": (r) => r.status === 304,
      "304 has empty body": (r) => r.body.length === 0,
      "304 preserves ETag": (r) => (r.headers["Etag"] || r.headers["ETag"]) === etag,
    });
  } else if (res2.status === 429) {
    rateLimitRate.add(1);
  } else {
    cacheHitRate.add(0);
  }

  sleep(0.05);
}
