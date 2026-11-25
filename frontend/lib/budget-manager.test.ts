import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { RpcBudgetManager, type CachedStreamState } from "./budget-manager.ts";

describe("Shared RPC Budget Manager (Issue #56)", () => {
  it("allows client requests within configured budget", () => {
    const manager = new RpcBudgetManager({ clientLimit: 5, clientWindowSeconds: 10 });
    const client = "client-A";

    for (let i = 0; i < 5; i++) {
      const decision = manager.consumeClientBudget(client, 1, 1000);
      assert.strictEqual(decision.allowed, true);
    }
  });

  it("exhausts client budget and returns 429 Retry-After", () => {
    const manager = new RpcBudgetManager({ clientLimit: 3, clientWindowSeconds: 30 });
    const client = "client-B";

    // Consume all 3
    assert.strictEqual(manager.consumeClientBudget(client, 1, 1000).allowed, true);
    assert.strictEqual(manager.consumeClientBudget(client, 1, 1000).allowed, true);
    assert.strictEqual(manager.consumeClientBudget(client, 1, 1000).allowed, true);

    // 4th request must be rejected
    const blocked = manager.consumeClientBudget(client, 1, 1000);
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.reason, "client_limit");
    assert.strictEqual(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSeconds! > 0);
  });

  it("refills client bucket over time", () => {
    const manager = new RpcBudgetManager({ clientLimit: 10, clientWindowSeconds: 10 });
    const client = "client-C";

    // Consume all 10 at t=0
    manager.consumeClientBudget(client, 10, 0);
    assert.strictEqual(manager.consumeClientBudget(client, 1, 0).allowed, false);

    // At t = 5000ms (5s elapsed), 5 tokens should have refilled (1 token/sec)
    const at5s = manager.consumeClientBudget(client, 3, 5000);
    assert.strictEqual(at5s.allowed, true);
  });

  it("enforces shared upstream Soroban RPC node budget", () => {
    const manager = new RpcBudgetManager({ nodeRpcLimit: 2, nodeRpcWindowSeconds: 20 });

    // Request 1 from client A triggers 1 node RPC call
    assert.strictEqual(manager.consumeNodeRpcBudget(1, 1000).allowed, true);

    // Request 2 from client B triggers 1 node RPC call
    assert.strictEqual(manager.consumeNodeRpcBudget(1, 1000).allowed, true);

    // Request 3: Node RPC quota exhausted! Protects node from rate bans
    const blocked = manager.consumeNodeRpcBudget(1, 1000);
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.reason, "node_rpc_limit");
    assert.ok(blocked.retryAfterSeconds! > 0);
  });

  it("stores and serves stale snapshot within max stale age", () => {
    const manager = new RpcBudgetManager({ maxStaleAgeSeconds: 120 });
    const snapshot: CachedStreamState = {
      id: "99",
      sender: "SENDER",
      recipient: "RECIPIENT",
      token: "TOKEN",
      deposit: 1000n,
      withdrawn: 0n,
      startTime: 1000,
      endTime: 2000,
      cancelable: true,
      status: "Active",
      asOfLedger: 100,
      asOfTimestamp: 1500,
      fetchedAt: 1500 * 1000, // fetched at 1500s
    };

    manager.storeSnapshot("99", snapshot);

    // At 1600s (age = 100s <= 120s): Stale snapshot is available
    const staleOk = manager.getStaleSnapshot("99", 1600);
    assert.notStrictEqual(staleOk, null);
    assert.strictEqual(staleOk!.id, "99");

    // At 1700s (age = 200s > 120s): Stale snapshot expired
    const staleExpired = manager.getStaleSnapshot("99", 1700);
    assert.strictEqual(staleExpired, null);
  });
});
