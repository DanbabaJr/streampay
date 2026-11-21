import { describe, expect, it } from "vitest";
import { checkOrigin, parseAllowedOriginsParam } from "./origin-guard";

describe("checkOrigin", () => {
  const ALLOWED: readonly string[] = [
    "https://example.com",
    "https://app.example.com",
    "http://localhost:3000",
  ];

  it("allows an origin in the list", () => {
    expect(checkOrigin("https://example.com", ALLOWED)).toEqual({ allowed: true });
  });

  it("allows an origin matched case-insensitively", () => {
    expect(checkOrigin("HTTPS://EXAMPLE.COM", ALLOWED)).toEqual({ allowed: true });
  });

  it("rejects an origin not in the list", () => {
    const result = checkOrigin("https://evil.com", ALLOWED);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("evil.com");
    }
  });

  it("rejects a null / opaque origin", () => {
    const result = checkOrigin("null", ALLOWED);
    expect(result.allowed).toBe(false);
  });

  it("rejects undefined / empty origin", () => {
    expect(checkOrigin(undefined, ALLOWED).allowed).toBe(false);
    expect(checkOrigin("", ALLOWED).allowed).toBe(false);
    expect(checkOrigin(null, ALLOWED).allowed).toBe(false);
  });

  it("rejects every origin when the allow-list is empty (fail-closed)", () => {
    const result = checkOrigin("https://example.com", []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("allow-list is empty");
    }
  });

  it("skips wildcard entries silently and still rejects", () => {
    const withWildcard = ["*", "https://safe.com"] as const;
    expect(checkOrigin("https://anything.com", withWildcard).allowed).toBe(false);
    expect(checkOrigin("https://safe.com", withWildcard).allowed).toBe(true);
  });

  it("allows localhost origins", () => {
    expect(checkOrigin("http://localhost:3000", ALLOWED)).toEqual({ allowed: true });
  });
});

describe("parseAllowedOriginsParam", () => {
  it("returns an empty list for null input", () => {
    expect(parseAllowedOriginsParam(null)).toEqual([]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseAllowedOriginsParam("")).toEqual([]);
  });

  it("parses a single https origin", () => {
    expect(parseAllowedOriginsParam("https://example.com")).toEqual([
      "https://example.com",
    ]);
  });

  it("parses multiple comma-separated origins", () => {
    expect(
      parseAllowedOriginsParam("https://a.com,https://b.com")
    ).toEqual(["https://a.com", "https://b.com"]);
  });

  it("strips whitespace around entries", () => {
    expect(
      parseAllowedOriginsParam("  https://a.com , https://b.com  ")
    ).toEqual(["https://a.com", "https://b.com"]);
  });

  it("drops wildcard entries", () => {
    expect(parseAllowedOriginsParam("*,https://a.com")).toEqual([
      "https://a.com",
    ]);
  });

  it("drops http:// entries that are not localhost", () => {
    expect(
      parseAllowedOriginsParam("http://insecure.com,https://safe.com")
    ).toEqual(["https://safe.com"]);
  });

  it("allows http://localhost entries", () => {
    expect(
      parseAllowedOriginsParam("http://localhost:3000,http://localhost")
    ).toEqual(["http://localhost:3000", "http://localhost"]);
  });
});
