// Framework-free ingest handler so the route is a thin wrapper and the logic is testable.
import { killSwitchOn } from "./config";
import { sanitizePayload } from "./redact";
import type { RateLimiter, Sink } from "./sink";

export const MAX_BODY_BYTES = 1024;

export function handleIngest(
  body: string,
  key: string,
  env: { killSwitch: string | undefined },
  limiter: RateLimiter,
  sink: Sink,
): number {
  if (killSwitchOn(env.killSwitch)) return 410;
  if (!limiter.allow(key)) return 429;
  if (body.length > MAX_BODY_BYTES) return 413;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return 400;
  }
  const payload = sanitizePayload(raw);
  if (!payload) return 400;
  sink.add(payload);
  return 204;
}
