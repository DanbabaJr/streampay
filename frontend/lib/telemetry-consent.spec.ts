import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadTelemetryConsent,
  saveTelemetryConsent,
  TELEMETRY_CONSENT_STORAGE_KEY,
} from "./storage";
import {
  globalFrontendTracer,
  registerTraceCorrelation,
  traceCorrelationRegistry,
} from "./telemetry";

describe("telemetry consent", () => {
  const values = new Map<string, string>();

  afterEach(() => {
    values.clear();
    saveTelemetryConsent(true);
    vi.unstubAllGlobals();
  });

  it("defaults to the current enabled behavior and persists changes", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    expect(loadTelemetryConsent()).toBe(true);
    saveTelemetryConsent(false);
    expect(values.get(TELEMETRY_CONSENT_STORAGE_KEY)).toBe("false");
    expect(loadTelemetryConsent()).toBe(false);
    saveTelemetryConsent(true);
    expect(values.get(TELEMETRY_CONSENT_STORAGE_KEY)).toBe("true");
    expect(loadTelemetryConsent()).toBe(true);
  });

  it("stops span exports and correlation requests as soon as disabled", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    saveTelemetryConsent(false);

    await globalFrontendTracer.withSpan("consent.disabled", () => undefined);
    const context = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
    };
    registerTraceCorrelation("consent-disabled-tx", context, "42");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(traceCorrelationRegistry.get("consent-disabled-tx")).toBeNull();
  });
});
