/**
 * embed-widget.test.ts
 *
 * Tests for the embed widget loader script and postMessage security layer.
 *
 * These run with the Node built-in test runner (`node --test`).
 * No DOM is available; we import only the pure utility modules.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Loader script integrity
// ---------------------------------------------------------------------------

describe("embed loader script", () => {
  const loaderPath = path.join(ROOT, "public", "embed", "loader.js");

  it("loader.js exists in public/embed/", () => {
    assert.ok(fs.existsSync(loaderPath), `loader.js not found at ${loaderPath}`);
  });

  it("loader.js is non-empty", () => {
    const size = fs.statSync(loaderPath).size;
    assert.ok(size > 0, "loader.js is empty");
  });

  it("loader.js is within the 10 KB size budget", () => {
    const BUDGET_BYTES = 10 * 1024;
    const size = fs.statSync(loaderPath).size;
    assert.ok(
      size <= BUDGET_BYTES,
      `loader.js is ${size} bytes, over the ${BUDGET_BYTES} byte budget`
    );
  });

  it("loader.js does not contain eval()", () => {
    const src = fs.readFileSync(loaderPath, "utf-8");
    assert.strictEqual(
      src.includes("eval("),
      false,
      "loader.js must not contain eval()"
    );
  });

  it("loader.js sets window.__STREAMPAY_EMBED_BASE__", () => {
    const src = fs.readFileSync(loaderPath, "utf-8");
    assert.ok(
      src.includes("__STREAMPAY_EMBED_BASE__"),
      "loader.js must set window.__STREAMPAY_EMBED_BASE__"
    );
  });

  it("loader.js carries a version comment", () => {
    const src = fs.readFileSync(loaderPath, "utf-8");
    assert.ok(
      /StreamPay Embed Loader v\d+\.\d+\.\d+/.test(src),
      "loader.js must carry a version comment"
    );
  });
});

// ---------------------------------------------------------------------------
// Origin guard — pure module, importable in Node
// ---------------------------------------------------------------------------

describe("origin-guard: cross-origin rejection", () => {
  it("rejects an unlisted origin", async () => {
    const { checkOrigin } = await import(
      "../lib/embed/origin-guard.ts"
    );
    const result = checkOrigin("https://attacker.com", [
      "https://trusted.example.com",
    ]);
    assert.strictEqual(result.allowed, false);
  });

  it("rejects the opaque null origin produced by sandboxed iframes", async () => {
    const { checkOrigin } = await import(
      "../lib/embed/origin-guard.ts"
    );
    const result = checkOrigin("null", ["https://trusted.example.com"]);
    assert.strictEqual(result.allowed, false);
  });

  it("allows a trusted origin", async () => {
    const { checkOrigin } = await import(
      "../lib/embed/origin-guard.ts"
    );
    const result = checkOrigin("https://trusted.example.com", [
      "https://trusted.example.com",
    ]);
    assert.strictEqual(result.allowed, true);
  });

  it("fails closed when allow-list is empty", async () => {
    const { checkOrigin } = await import(
      "../lib/embed/origin-guard.ts"
    );
    const result = checkOrigin("https://trusted.example.com", []);
    assert.strictEqual(result.allowed, false);
  });
});

// ---------------------------------------------------------------------------
// Protocol — malformed message rejection
// ---------------------------------------------------------------------------

describe("widget-protocol: malformed message guard", () => {
  it("rejects a plain string message", async () => {
    const { isEmbedRequest } = await import(
      "../lib/embed/widget-protocol.ts"
    );
    assert.strictEqual(isEmbedRequest("not an object"), false);
  });

  it("rejects null", async () => {
    const { isEmbedRequest } = await import(
      "../lib/embed/widget-protocol.ts"
    );
    assert.strictEqual(isEmbedRequest(null), false);
  });

  it("rejects an object with a foreign namespace type", async () => {
    const { isEmbedRequest } = await import(
      "../lib/embed/widget-protocol.ts"
    );
    assert.strictEqual(
      isEmbedRequest({ type: "xss:steal", widgetId: "x" }),
      false
    );
  });

  it("rejects an object with no widgetId", async () => {
    const { isEmbedRequest } = await import(
      "../lib/embed/widget-protocol.ts"
    );
    assert.strictEqual(
      isEmbedRequest({ type: "streampay:init" }),
      false
    );
  });

  it("rejects unknown streampay: sub-types", async () => {
    const { isEmbedRequest, isKnownRequestType } = await import(
      "../lib/embed/widget-protocol.ts"
    );
    // structurally valid but unknown type
    const msg = { type: "streampay:future_unknown", widgetId: "spw-x" };
    assert.strictEqual(isEmbedRequest(msg), true); // passes structural check
    assert.strictEqual(isKnownRequestType(msg.type), false); // fails type gate
  });

  it("accepts a well-formed init request", async () => {
    const { isEmbedRequest, isKnownRequestType } = await import(
      "../lib/embed/widget-protocol.ts"
    );
    const msg = {
      type: "streampay:init",
      widgetId: "spw-abc",
      streamId: "42",
      mode: "read",
      theme: "auto",
    };
    assert.strictEqual(isEmbedRequest(msg), true);
    assert.strictEqual(isKnownRequestType(msg.type), true);
  });
});
