/**
 * Lightweight in-memory rate limiter for discovery API endpoints.
 *
 * ARCHITECTURAL NOTICE — PROTOTYPE-GRADE RATE BUDGETING:
 * ------------------------------------------------------
 * IP bucket counters are stored in an in-memory Map (`ipBuckets`).
 * On serverless platforms (Netlify, Vercel, AWS Lambda) or multi-instance clusters,
 * rate budgets reset per instance and upon container recycling.
 *
 * For distributed production enforcement, replace or back this implementation with
 * an atomic centralized store (e.g., Redis `INCR` + `EXPIRE` or Cloudflare/Upstash rate limiting).
 */
interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateLimitBucket>();

export function checkRateLimit(
  clientIp: string,
  limit: number = 60,
  windowSeconds: number = 60
): { allowed: boolean; remaining: number; reset: number } {
  const now = Math.floor(Date.now() / 1000);
  const existing = ipBuckets.get(clientIp);

  if (!existing || now >= existing.resetAt) {
    ipBuckets.set(clientIp, {
      count: 1,
      resetAt: now + windowSeconds,
    });
    return {
      allowed: true,
      remaining: limit - 1,
      reset: now + windowSeconds,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      reset: existing.resetAt,
    };
  }

  existing.count += 1;
  ipBuckets.set(clientIp, existing);

  return {
    allowed: true,
    remaining: limit - existing.count,
    reset: existing.resetAt,
  };
}
