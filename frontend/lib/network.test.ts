/**
 * Unit tests for lib/network.ts — the network/contract indicator logic
 * (issue #33). Runs in Node's built-in test runner, no browser needed:
 *
 *   node --experimental-strip-types --test lib/network.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import {
  APP_NETWORK_LABEL,
  PUBLIC_PASSPHRASE,
  TESTNET_PASSPHRASE,
  checkWalletNetwork,
  createNetworkWarningStore,
  explorerContractUrl,
  findNetworkMismatch,
  labelForPassphrase,
  mismatchHint,
  networkDisplayName,
  truncateContractId,
} from "./network.ts";

describe("passphrase constants", () => {
  it("agree with the SDK the signing path builds transactions with", () => {
    // Required rather than imported: the SDK has no ESM entry point for a
    // plain Node run, and this module must stay loadable without it.
    const require = createRequire(import.meta.url);
    const { Networks } = require("@stellar/stellar-sdk") as {
      Networks: { TESTNET: string; PUBLIC: string };
    };
    assert.equal(TESTNET_PASSPHRASE, Networks.TESTNET);
    assert.equal(PUBLIC_PASSPHRASE, Networks.PUBLIC);
  });
});

describe("labelForPassphrase", () => {
  it("recognises the two SDF passphrases", () => {
    assert.equal(labelForPassphrase(TESTNET_PASSPHRASE), "testnet");
    assert.equal(labelForPassphrase(PUBLIC_PASSPHRASE), "public");
  });

  it("classifies anything else as unknown", () => {
    assert.equal(labelForPassphrase("Public Global Stellar Network ; 2026"), "unknown");
    assert.equal(labelForPassphrase(""), "unknown");
  });
});

describe("findNetworkMismatch", () => {
  it("stays silent when the wallet matches the app", () => {
    assert.equal(findNetworkMismatch({ networkPassphrase: TESTNET_PASSPHRASE }, "testnet"), null);
    assert.equal(findNetworkMismatch({ networkPassphrase: PUBLIC_PASSPHRASE }, "public"), null);
  });

  it("flags a mainnet wallet on a testnet dapp", () => {
    const mismatch = findNetworkMismatch({ networkPassphrase: PUBLIC_PASSPHRASE }, "testnet");
    assert.ok(mismatch);
    assert.equal(mismatch.appLabel, "testnet");
    assert.equal(mismatch.walletLabel, "public");
  });

  it("flags a testnet wallet on a public-network dapp", () => {
    const mismatch = findNetworkMismatch({ networkPassphrase: TESTNET_PASSPHRASE }, "public");
    assert.ok(mismatch);
    assert.equal(mismatch.appLabel, "public");
    assert.equal(mismatch.walletLabel, "testnet");
  });

  it("flags an unrecognized wallet network (futurenet, RPC of a friend)", () => {
    const mismatch = findNetworkMismatch(
      { networkPassphrase: "Some Private Network ; January 2026" },
      "testnet"
    );
    assert.ok(mismatch);
    assert.equal(mismatch.walletLabel, "unknown");
    assert.match(mismatchHint(mismatch), /unrecognized network/);
  });

  it("reports nothing when Freighter did not answer", () => {
    assert.equal(findNetworkMismatch({ error: { message: "no extension" } }), null);
    assert.equal(findNetworkMismatch({ networkPassphrase: "" }), null);
    assert.equal(findNetworkMismatch(null), null);
    assert.equal(findNetworkMismatch(undefined), null);
  });

  it("compares against the configured app network by default", () => {
    const wrong =
      APP_NETWORK_LABEL === "testnet" ? PUBLIC_PASSPHRASE : TESTNET_PASSPHRASE;
    assert.ok(findNetworkMismatch({ networkPassphrase: wrong }));
  });
});

describe("mismatchHint", () => {
  it("names the network the wallet must switch to", () => {
    const mismatch = findNetworkMismatch(
      { networkPassphrase: PUBLIC_PASSPHRASE },
      "testnet"
    );
    assert.ok(mismatch);
    const hint = mismatchHint(mismatch);
    assert.match(hint, /Freighter/);
    assert.match(hint, /Testnet/);
    assert.doesNotMatch(hint, /unrecognized/);
  });
});

describe("truncateContractId", () => {
  const id = "CAAP5FRQLPBOHD3CH7XMD4JY4WAX5PP3HNRWZP6Y3LZJZ4RQAB4D";

  it("keeps both ends and stays readable on a phone", () => {
    const short = truncateContractId(id);
    assert.ok(short.length < id.length);
    assert.ok(short.startsWith("CAAP5FRQ"));
    assert.ok(short.endsWith("AB4D"));
  });

  it("never hides a short id behind an ellipsis", () => {
    assert.equal(truncateContractId("CAAP"), "CAAP");
    assert.equal(truncateContractId(""), "");
  });

  it("honours custom widths", () => {
    assert.equal(truncateContractId("0123456789", 4, 2), "0123…89");
  });
});

describe("explorerContractUrl", () => {
  it("links to the contract page on the configured network", () => {
    assert.equal(
      explorerContractUrl("CAAP5FRQ", "testnet"),
      "https://stellar.expert/explorer/testnet/contract/CAAP5FRQ"
    );
    assert.equal(
      explorerContractUrl("CAAP5FRQ", "public"),
      "https://stellar.expert/explorer/public/contract/CAAP5FRQ"
    );
  });

  it("returns no link when no contract is deployed yet", () => {
    assert.equal(explorerContractUrl("", "testnet"), "");
  });
});

describe("networkDisplayName", () => {
  it("spells out each network", () => {
    assert.equal(networkDisplayName("testnet"), "Testnet");
    assert.match(networkDisplayName("public"), /Public Network/);
    assert.equal(networkDisplayName("unknown"), "another network");
  });
});

describe("checkWalletNetwork", () => {
  it("publishes a mismatch for a wallet on the wrong network", async () => {
    const store = createNetworkWarningStore();
    const check = await checkWalletNetwork(store, async () => ({
      networkPassphrase: PUBLIC_PASSPHRASE,
    }));

    assert.equal(check.state, "mismatch");
    assert.ok(store.getState().warning);
    assert.equal(store.getState().dismissed, false);
  });

  it("clears a stale warning once the wallet is fixed", async () => {
    const store = createNetworkWarningStore();
    await checkWalletNetwork(store, async () => ({
      networkPassphrase: TESTNET_PASSPHRASE,
    }));
    store.report({
      state: "mismatch",
      mismatch: {
        appLabel: "testnet",
        walletLabel: "public",
        walletPassphrase: PUBLIC_PASSPHRASE,
      },
    });
    assert.ok(store.getState().warning);

    await checkWalletNetwork(store, async () => ({
      networkPassphrase: TESTNET_PASSPHRASE,
    }));
    assert.equal(store.getState().warning, null);
  });

  it("stays quiet when Freighter is absent or throws", async () => {
    const store = createNetworkWarningStore();

    const absent = await checkWalletNetwork(store, async () => ({
      networkPassphrase: "",
      error: { message: "extension not found" },
    }));
    assert.equal(absent.state, "unavailable");
    assert.equal(store.getState().warning, null);

    const thrown = await checkWalletNetwork(store, async () => {
      throw new Error("chrome.runtime disconnected");
    });
    assert.equal(thrown.state, "unavailable");
    assert.equal(store.getState().warning, null);
  });

  it("dismissal hides the warning until the next check", () => {
    const store = createNetworkWarningStore();
    const mismatch = {
      appLabel: "testnet" as const,
      walletLabel: "public" as const,
      walletPassphrase: PUBLIC_PASSPHRASE,
    };
    let notifications = 0;
    store.subscribe(() => notifications++);

    store.report({ state: "mismatch", mismatch });
    assert.equal(store.getState().warning, mismatch);

    store.dismiss();
    assert.equal(store.getState().dismissed, true);
    // The badge keeps the warning so a later check can re-show it.
    assert.equal(store.getState().warning, mismatch);

    store.report({ state: "mismatch", mismatch });
    assert.equal(store.getState().dismissed, false);
    assert.equal(notifications, 3);
  });

  it("keeps one snapshot object between changes (useSyncExternalStore contract)", () => {
    const store = createNetworkWarningStore();
    const before = store.getState();
    assert.equal(store.getState(), before);

    store.report({
      state: "mismatch",
      mismatch: {
        appLabel: "testnet",
        walletLabel: "public",
        walletPassphrase: PUBLIC_PASSPHRASE,
      },
    });
    const after = store.getState();
    assert.notEqual(after, before);
    assert.equal(store.getState(), after);
  });
});
