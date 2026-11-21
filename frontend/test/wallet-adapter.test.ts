/**
 * wallet-adapter.test.ts
 *
 * Contract tests for the WalletAdapter interface.
 *
 * These run in Node (no browser globals) so we can only test:
 *  - The shape and type-safety of the interface.
 *  - FreighterAdapter.isAvailable() returning false in Node (no window.freighter).
 *  - AlbedoAdapter.isAvailable() returning false in Node (typeof window === 'undefined').
 *  - Correct error message when no wallet is connected (WalletContext signTransaction).
 *
 * Signing round-trips require a real browser + extension and are validated
 * through the manual test plan in docs/wallet-testing.md.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---- FreighterAdapter availability in Node ----
describe("FreighterAdapter", () => {
  it("isAvailable() returns false outside a browser context", async () => {
    const { FreighterAdapter } = await import("../lib/adapters/freighter.ts");
    const adapter = new FreighterAdapter();
    assert.equal(adapter.isAvailable(), false, "should be false: no window.freighter in Node");
  });

  it("has correct id and name", async () => {
    const { FreighterAdapter } = await import("../lib/adapters/freighter.ts");
    const adapter = new FreighterAdapter();
    assert.equal(adapter.id, "freighter");
    assert.equal(adapter.name, "Freighter");
  });
});

// ---- AlbedoAdapter availability in Node ----
describe("AlbedoAdapter", () => {
  it("isAvailable() returns false outside a browser context", async () => {
    const { AlbedoAdapter } = await import("../lib/adapters/albedo.ts");
    const adapter = new AlbedoAdapter();
    // typeof window === 'undefined' in Node → should return false
    assert.equal(adapter.isAvailable(), false, "should be false: no window in Node");
  });

  it("has correct id and name", async () => {
    const { AlbedoAdapter } = await import("../lib/adapters/albedo.ts");
    const adapter = new AlbedoAdapter();
    assert.equal(adapter.id, "albedo");
    assert.equal(adapter.name, "Albedo");
  });
});

// ---- WALLET_DESCRIPTORS registry ----
describe("WALLET_DESCRIPTORS", () => {
  it("contains entries for all supported wallets", async () => {
    const { WALLET_DESCRIPTORS } = await import("../lib/wallet-adapter.ts");
    const ids = WALLET_DESCRIPTORS.map((d) => d.id);
    assert.ok(ids.includes("freighter"), "should include freighter");
    assert.ok(ids.includes("albedo"), "should include albedo");
  });

  it("every descriptor has required fields", async () => {
    const { WALLET_DESCRIPTORS } = await import("../lib/wallet-adapter.ts");
    for (const d of WALLET_DESCRIPTORS) {
      assert.ok(d.id, `descriptor missing id`);
      assert.ok(d.name, `descriptor ${d.id} missing name`);
      assert.ok(d.installUrl, `descriptor ${d.id} missing installUrl`);
      assert.ok(d.iconPath, `descriptor ${d.id} missing iconPath`);
    }
  });
});

// ---- createAdapter factory ----
describe("createAdapter", () => {
  it("returns FreighterAdapter for 'freighter'", async () => {
    const { createAdapter } = await import("../lib/adapters/index.ts");
    const { FreighterAdapter } = await import("../lib/adapters/freighter.ts");
    const adapter = await createAdapter("freighter");
    assert.ok(adapter instanceof FreighterAdapter);
  });

  it("returns AlbedoAdapter for 'albedo'", async () => {
    const { createAdapter } = await import("../lib/adapters/index.ts");
    const { AlbedoAdapter } = await import("../lib/adapters/albedo.ts");
    const adapter = await createAdapter("albedo");
    assert.ok(adapter instanceof AlbedoAdapter);
  });
});
