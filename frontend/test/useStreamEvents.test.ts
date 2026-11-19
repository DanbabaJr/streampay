import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toStreamView, type StreamEventData } from "../lib/useStreamEvents.ts";

describe("useStreamEvents helpers and deduplication contract", () => {
  it("correctly converts indexed stream data to UI StreamView model", () => {
    const rawStream: NonNullable<StreamEventData["stream"]> = {
      id: "42",
      streamId: "42",
      sender: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      recipient: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
      token: "C_NATIVE_XLM",
      deposit: "10000000",
      withdrawn: "2500000",
      startTime: "1700000000",
      endTime: "1700100000",
      cancelable: true,
      status: "active",
      lastLedger: 54321,
      updatedAt: "2026-10-17T12:00:00Z",
    };

    const view = toStreamView(rawStream);
    assert.equal(view.id, "42");
    assert.equal(view.sender, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4");
    assert.equal(view.recipient, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M");
    assert.equal(view.token, "C_NATIVE_XLM");
    assert.equal(view.deposit, "10000000");
    assert.equal(view.withdrawn, "2500000");
    assert.equal(view.startTime, 1700000000);
    assert.equal(view.endTime, 1700100000);
    assert.equal(view.cancelable, true);
    assert.equal(view.status, "active");
  });

  it("handles null / default values safely in toStreamView", () => {
    const emptyRaw: NonNullable<StreamEventData["stream"]> = {
      streamId: "99",
      sender: null,
      recipient: null,
      token: null,
      deposit: null,
      withdrawn: "0",
      startTime: null,
      endTime: null,
      cancelable: null,
      status: "active",
      lastLedger: 100,
      updatedAt: "2026-10-17T12:00:00Z",
    };

    const view = toStreamView(emptyRaw);
    assert.equal(view.id, "99");
    assert.equal(view.sender, "");
    assert.equal(view.recipient, "");
    assert.equal(view.token, "");
    assert.equal(view.deposit, "0");
    assert.equal(view.withdrawn, "0");
    assert.equal(view.startTime, 0);
    assert.equal(view.endTime, 0);
    assert.equal(view.cancelable, false);
    assert.equal(view.status, "active");
  });

  it("deduplicates repetitive at-least-once event deliveries by event ID", () => {
    const seenEventIds = new Set<string>();
    const order: string[] = [];
    const MAX_SIZE = 5;

    function recordEvent(id: string): boolean {
      if (seenEventIds.has(id)) return false;
      seenEventIds.add(id);
      order.push(id);
      if (order.length > MAX_SIZE) {
        const oldest = order.shift();
        if (oldest) seenEventIds.delete(oldest);
      }
      return true;
    }

    // First arrival
    assert.equal(recordEvent("evt-1"), true);
    // Duplicate arrival (at-least-once replay)
    assert.equal(recordEvent("evt-1"), false);
    assert.equal(recordEvent("evt-1"), false);

    // Distinct events
    assert.equal(recordEvent("evt-2"), true);
    assert.equal(recordEvent("evt-3"), true);
    assert.equal(recordEvent("evt-4"), true);
    assert.equal(recordEvent("evt-5"), true);

    // Evicts oldest when max size exceeded
    assert.equal(recordEvent("evt-6"), true);
    assert.equal(seenEventIds.has("evt-1"), false, "Oldest event was evicted from bounded cache");
    assert.equal(seenEventIds.has("evt-6"), true);
  });
});
