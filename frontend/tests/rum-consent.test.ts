import { describe, expect, it } from "vitest";
import { createCollector } from "../lib/rum/collector";
import { CONSENT_KEY, clearConsent, getConsent, hasConsent, setConsent } from "../lib/rum/consent";

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("consent store", () => {
  it("defaults off", () => {
    const s = memStore();
    expect(getConsent(s)).toBe("unset");
    expect(hasConsent(s)).toBe(false);
  });
  it("opt-in then opt-out", () => {
    const s = memStore();
    setConsent("granted", s);
    expect(hasConsent(s)).toBe(true);
    setConsent("denied", s);
    expect(hasConsent(s)).toBe(false);
    clearConsent(s);
    expect(getConsent(s)).toBe("unset");
  });
  it("fails closed on junk values and missing storage", () => {
    const s = memStore();
    s.setItem(CONSENT_KEY, "true");
    expect(hasConsent(s)).toBe(false);
    expect(hasConsent(null)).toBe(false);
  });
});

describe("collector gating", () => {
  const base = { sampleRate: 1, random: () => 0, getRoute: () => "/" };
  const m = { name: "LCP", value: 1200 };

  it("sends nothing by default (no consent)", () => {
    const sent: unknown[] = [];
    const c = createCollector({ ...base, hasConsent: () => false, isKilled: () => false, send: (p) => sent.push(p) });
    expect(c.report(m)).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it("sends after opt-in and stops immediately after opt-out", () => {
    const s = memStore();
    const sent: unknown[] = [];
    const c = createCollector({ ...base, hasConsent: () => hasConsent(s), isKilled: () => false, send: (p) => sent.push(p) });
    expect(c.report(m)).toBe(false);
    setConsent("granted", s);
    expect(c.report(m)).toBe(true);
    setConsent("denied", s);
    expect(c.report(m)).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe("sampling, kill switch, beacon cap", () => {
  const m = { name: "CLS", value: 0.02 };
  it("sampling decided once per page load", () => {
    const sent: unknown[] = [];
    const out = createCollector({ hasConsent: () => true, isKilled: () => false, send: (p) => sent.push(p), sampleRate: 0.1, random: () => 0.5, getRoute: () => "/" });
    expect(out.sampled).toBe(false);
    expect(out.report(m)).toBe(false);
    const inn = createCollector({ hasConsent: () => true, isKilled: () => false, send: (p) => sent.push(p), sampleRate: 0.1, random: () => 0.05, getRoute: () => "/" });
    expect(inn.sampled).toBe(true);
    expect(inn.report(m)).toBe(true);
  });
  it("sample rate 0 never sends, 1 always samples", () => {
    expect(createCollector({ hasConsent: () => true, isKilled: () => false, send: () => {}, sampleRate: 0, random: () => 0, getRoute: () => "/" }).sampled).toBe(false);
    expect(createCollector({ hasConsent: () => true, isKilled: () => false, send: () => {}, sampleRate: 1, random: () => 0.999, getRoute: () => "/" }).sampled).toBe(true);
  });
  it("kill switch stops collection mid-session", () => {
    let killed = false;
    const c = createCollector({ hasConsent: () => true, isKilled: () => killed, send: () => {}, sampleRate: 1, random: () => 0, getRoute: () => "/" });
    expect(c.report(m)).toBe(true);
    killed = true;
    expect(c.report(m)).toBe(false);
  });
  it("caps beacons per page", () => {
    const c = createCollector({ hasConsent: () => true, isKilled: () => false, send: () => {}, sampleRate: 1, random: () => 0, getRoute: () => "/", maxBeacons: 2 });
    expect([c.report(m), c.report(m), c.report(m)]).toEqual([true, true, false]);
  });
});
