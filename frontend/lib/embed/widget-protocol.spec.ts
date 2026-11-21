import { describe, expect, it } from "vitest";
import {
  isEmbedRequest,
  isEmbedResponse,
  isKnownRequestType,
  isKnownResponseType,
} from "./widget-protocol";

describe("isEmbedRequest", () => {
  it("accepts a well-formed init request", () => {
    expect(
      isEmbedRequest({
        type: "streampay:init",
        widgetId: "spw-abc123",
        streamId: "42",
        mode: "read",
        theme: "auto",
      })
    ).toBe(true);
  });

  it("accepts a well-formed claim request", () => {
    expect(
      isEmbedRequest({
        type: "streampay:claim",
        widgetId: "spw-abc123",
        claimantAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      })
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isEmbedRequest(null)).toBe(false);
  });

  it("rejects a string", () => {
    expect(isEmbedRequest("hello")).toBe(false);
  });

  it("rejects an object missing type", () => {
    expect(isEmbedRequest({ widgetId: "x" })).toBe(false);
  });

  it("rejects an object missing widgetId", () => {
    expect(isEmbedRequest({ type: "streampay:init" })).toBe(false);
  });

  it("rejects an object with empty widgetId", () => {
    expect(isEmbedRequest({ type: "streampay:init", widgetId: "" })).toBe(false);
  });

  it("rejects a type that does not start with streampay:", () => {
    expect(isEmbedRequest({ type: "malicious:payload", widgetId: "x" })).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isEmbedRequest(undefined)).toBe(false);
  });
});

describe("isEmbedResponse", () => {
  it("accepts a well-formed ready response", () => {
    expect(
      isEmbedResponse({ type: "streampay:ready", widgetId: "spw-abc" })
    ).toBe(true);
  });

  it("accepts a well-formed error response", () => {
    expect(
      isEmbedResponse({
        type: "streampay:error",
        widgetId: "spw-abc",
        code: "STREAM_LOAD_FAILED",
        message: "not found",
      })
    ).toBe(true);
  });

  it("rejects malformed messages (no type)", () => {
    expect(isEmbedResponse({ widgetId: "spw-abc" })).toBe(false);
  });

  it("rejects objects with wrong namespace", () => {
    expect(isEmbedResponse({ type: "xss:attack", widgetId: "spw-abc" })).toBe(
      false
    );
  });
});

describe("isKnownRequestType", () => {
  it("recognises streampay:init", () => {
    expect(isKnownRequestType("streampay:init")).toBe(true);
  });

  it("recognises streampay:claim", () => {
    expect(isKnownRequestType("streampay:claim")).toBe(true);
  });

  it("rejects unknown types", () => {
    expect(isKnownRequestType("streampay:unknown")).toBe(false);
    expect(isKnownRequestType("")).toBe(false);
  });
});

describe("isKnownResponseType", () => {
  it("recognises all defined response types", () => {
    for (const t of [
      "streampay:ready",
      "streampay:stream_loaded",
      "streampay:error",
      "streampay:claim_success",
      "streampay:height",
    ]) {
      expect(isKnownResponseType(t)).toBe(true);
    }
  });

  it("rejects unknown types", () => {
    expect(isKnownResponseType("streampay:bogus")).toBe(false);
    expect(isKnownResponseType("")).toBe(false);
  });
});
