import { describe, expect, it } from "vitest";
import { createCollector } from "../lib/rum/collector";
import { normalizeRoute, sanitizePayload } from "../lib/rum/redact";

const ADDR = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

describe("route normalization", () => {
  it("templates stream ids and drops query/hash", () => {
    expect(normalizeRoute("/stream/42")).toBe("/stream/[id]");
    expect(normalizeRoute("/stream/42?addr=" + ADDR + "#x")).toBe("/stream/[id]");
    expect(normalizeRoute("/?amount=100")).toBe("/");
  });
  it("collapses anything unknown, including addresses in the path", () => {
    expect(normalizeRoute("/" + ADDR)).toBe("other");
    expect(normalizeRoute("/stream/1/extra/" + ADDR)).toBe("other");
    expect(normalizeRoute(undefined)).toBe("other");
  });
});

describe("sanitizePayload allowlist", () => {
  it("drops every non-allowlisted field", () => {
    const out = sanitizePayload({
      route: "/stream/7", metric: "LCP", value: 1500, rating: "good", nav: "navigate",
      address: ADDR, amount: "1000000", userAgent: "x", sessionId: "s", email: "a@b.c", url: "https://x/?a=" + ADDR,
    });
    expect(out).toEqual({ route: "/stream/[id]", metric: "LCP", value: 1500, rating: "good", nav: "navigate" });
    const json = JSON.stringify(out);
    expect(json).not.toContain(ADDR);
    expect(json).not.toContain("1000000");
    expect(json).not.toContain("a@b.c");
  });
  it("rejects bad metrics and values", () => {
    expect(sanitizePayload({ metric: "FID", value: 1 })).toBeNull();
    expect(sanitizePayload({ metric: "LCP", value: -1 })).toBeNull();
    expect(sanitizePayload({ metric: "LCP", value: Infinity })).toBeNull();
    expect(sanitizePayload({ metric: "LCP", value: "9" })).toBeNull();
    expect(sanitizePayload({ metric: "CLS", value: 999 })).toBeNull();
    expect(sanitizePayload(null)).toBeNull();
  });
  it("free-text rating/nav cannot smuggle data", () => {
    const out = sanitizePayload({ metric: "INP", value: 100, rating: ADDR, nav: ADDR });
    expect(out?.rating).toBeUndefined();
    expect(out?.nav).toBe("other");
  });
});

describe("end to end: collector output has no sensitive data", () => {
  it("a sensitive route and extra metric fields never reach send()", () => {
    const sent: string[] = [];
    const c = createCollector({
      hasConsent: () => true, isKilled: () => false, sampleRate: 1, random: () => 0,
      getRoute: () => "/stream/9?to=" + ADDR + "&amount=5",
      send: (p) => sent.push(JSON.stringify(p)),
    });
    c.report({ name: "LCP", value: 900, rating: "good", navigationType: "navigate", ...({ address: ADDR } as object) } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(ADDR);
    expect(sent[0]).not.toContain("amount");
    expect(JSON.parse(sent[0]).route).toBe("/stream/[id]");
  });
});
