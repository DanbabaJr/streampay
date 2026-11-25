import { describe, expect, it } from "vitest";
import { handleIngest } from "../lib/rum/ingest";
import { RateLimiter, Sink, percentile } from "../lib/rum/sink";

const ok = JSON.stringify({ route: "/", metric: "LCP", value: 1000 });
const env = { killSwitch: undefined as string | undefined };

describe("ingest endpoint logic", () => {
  it("accepts a valid payload and stores only the allowlist", () => {
    const sink = new Sink();
    const body = JSON.stringify({ route: "/stream/3", metric: "LCP", value: 1000, address: "GXYZ" });
    expect(handleIngest(body, "k", env, new RateLimiter(), sink)).toBe(204);
    expect(JSON.stringify(sink.summary())).not.toContain("GXYZ");
    expect(sink.summary()[0].route).toBe("/stream/[id]");
  });
  it("kill switch returns 410 and stores nothing", () => {
    const sink = new Sink();
    for (const v of ["1", "true", "on", "TRUE"]) {
      expect(handleIngest(ok, "k", { killSwitch: v }, new RateLimiter(), sink)).toBe(410);
    }
    expect(sink.summary()).toHaveLength(0);
  });
  it("rate limits per key and recovers after the window", () => {
    const sink = new Sink();
    const rl = new RateLimiter(2, 1000);
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("a", 1)).toBe(true);
    expect(rl.allow("a", 2)).toBe(false);
    expect(rl.allow("b", 2)).toBe(true);
    expect(rl.allow("a", 1001)).toBe(true);
    const rl2 = new RateLimiter(1, 60_000);
    expect(handleIngest(ok, "k", env, rl2, sink)).toBe(204);
    expect(handleIngest(ok, "k", env, rl2, sink)).toBe(429);
  });
  it("rejects oversized, malformed and invalid bodies", () => {
    const sink = new Sink();
    expect(handleIngest("x".repeat(5000), "k", env, new RateLimiter(), sink)).toBe(413);
    expect(handleIngest("{nope", "k", env, new RateLimiter(), sink)).toBe(400);
    expect(handleIngest(JSON.stringify({ metric: "LCP", value: -5 }), "k", env, new RateLimiter(), sink)).toBe(400);
  });
});

describe("field aggregation", () => {
  it("computes percentiles and flags over-budget p75", () => {
    const sink = new Sink();
    for (const v of [1000, 1200, 1400, 3000, 4000]) sink.add({ route: "/", metric: "LCP", value: v });
    const s = sink.summary()[0];
    expect(s.count).toBe(5);
    expect(s.p50).toBe(1400);
    expect(s.p75).toBe(3000);
    expect(s.budget).toBe(2500);
    expect(s.overBudget).toBe(true);
  });
  it("percentile of empty is NaN; storage is capped", () => {
    expect(percentile([], 75)).toBeNaN();
    const sink = new Sink();
    for (let i = 0; i < 1500; i++) sink.add({ route: "/", metric: "CLS", value: 0.01 });
    expect(sink.summary()[0].count).toBe(1000);
  });
});
