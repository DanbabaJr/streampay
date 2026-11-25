import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  paginateStreamsByCursor,
  type StreamView,
} from "./pagination.ts";
import { computeAvailable } from "./accrual.ts";

function createMockStream(
  id: number | string,
  overrides: Partial<StreamView> = {}
): StreamView {
  return {
    id: String(id),
    sender: "GBZ...SENDER",
    recipient: "GBZ...RECIPIENT",
    token: "CAS3...TOKEN",
    deposit: "10000000",
    withdrawn: "0",
    startTime: 1700000000,
    endTime: 1700086400,
    cancelable: true,
    status: "Active",
    ...overrides,
  };
}

describe("paginateStreamsByCursor", () => {
  it("handles unknown or empty stream lists gracefully", () => {
    const result = paginateStreamsByCursor([], { limit: 10 });
    assert.deepEqual(result.streams, []);
    assert.equal(result.nextCursor, null);
    assert.equal(result.prevCursor, null);
    assert.equal(result.hasMore, false);
    assert.equal(result.hasPrev, false);
    assert.equal(result.totalMatching, 0);
    assert.ok(result.asOfTimestamp > 0);
  });

  it("handles address with 100+ streams across multiple cursor pages", () => {
    // Generate 125 streams with monotonic IDs 1..125
    const allStreams: StreamView[] = Array.from({ length: 125 }, (_, i) =>
      createMockStream(i + 1)
    );

    // Page 1: limit 20, default forward
    const page1 = paginateStreamsByCursor(allStreams, { limit: 20 });
    assert.equal(page1.streams.length, 20);
    assert.equal(page1.totalMatching, 125);
    // Streams should be sorted descending: newest first (125 down to 106)
    assert.equal(page1.streams[0].id, "125");
    assert.equal(page1.streams[19].id, "106");
    assert.equal(page1.hasMore, true);
    assert.equal(page1.hasPrev, false);
    assert.equal(page1.nextCursor, "106");
    assert.equal(page1.prevCursor, null);

    // Page 2: forward from cursor "106"
    const page2 = paginateStreamsByCursor(allStreams, {
      cursor: page1.nextCursor,
      direction: "forward",
      limit: 20,
    });
    assert.equal(page2.streams.length, 20);
    assert.equal(page2.streams[0].id, "105");
    assert.equal(page2.streams[19].id, "86");
    assert.equal(page2.hasMore, true);
    assert.equal(page2.hasPrev, true);
    assert.equal(page2.nextCursor, "86");
    assert.equal(page2.prevCursor, "105");

    // Backward from Page 2 cursor "105" should retrieve Page 1 streams (125 down to 106)
    const page1Revisited = paginateStreamsByCursor(allStreams, {
      cursor: "105",
      direction: "backward",
      limit: 20,
    });
    assert.equal(page1Revisited.streams.length, 20);
    assert.equal(page1Revisited.streams[0].id, "125");
    assert.equal(page1Revisited.streams[19].id, "106");
    assert.equal(page1Revisited.hasPrev, false); // Reached the newest items
    assert.equal(page1Revisited.hasMore, true);

    // Iterate all pages to verify exhaustion and no duplication
    const seenIds: string[] = [];
    let currentCursor: string | null = null;
    let pageCount = 0;

    while (true) {
      const page = paginateStreamsByCursor(allStreams, {
        cursor: currentCursor,
        direction: "forward",
        limit: 30,
      });
      seenIds.push(...page.streams.map((s) => s.id));
      pageCount++;
      if (!page.hasMore || !page.nextCursor) break;
      currentCursor = page.nextCursor;
    }

    assert.equal(seenIds.length, 125);
    const uniqueIds = new Set(seenIds);
    assert.equal(uniqueIds.size, 125);
    assert.equal(pageCount, 5); // 30 + 30 + 30 + 30 + 5
  });

  it("handles all-cancelled addresses and status filtering correctly", () => {
    const allCancelled: StreamView[] = [
      createMockStream("1", { status: "Cancelled" }),
      createMockStream("2", { status: "Cancelled" }),
      createMockStream("3", { status: "Cancelled" }),
      createMockStream("4", { status: "Cancelled" }),
    ];

    // Filter "active" should return zero streams
    const activePage = paginateStreamsByCursor(allCancelled, {
      status: "active",
      limit: 10,
    });
    assert.equal(activePage.streams.length, 0);
    assert.equal(activePage.totalMatching, 0);
    assert.equal(activePage.hasMore, false);

    // Filter "ended" should return all 4 cancelled streams
    const endedPage = paginateStreamsByCursor(allCancelled, {
      status: "ended",
      limit: 10,
    });
    assert.equal(endedPage.streams.length, 4);
    assert.equal(endedPage.totalMatching, 4);
    assert.equal(endedPage.streams[0].id, "4");
    assert.equal(endedPage.streams[3].id, "1");

    // Available amount on cancelled streams is always 0
    for (const s of endedPage.streams) {
      const avail = computeAvailable(
        BigInt(s.deposit),
        s.startTime,
        s.endTime,
        BigInt(s.withdrawn),
        s.status,
        BigInt(s.startTime + 1000)
      );
      assert.equal(avail, 0n);
    }
  });

  it("prevents page-shift bugs when streams are cancelled between queries", () => {
    // Initial state: streams 1..6 all Active
    const streams: StreamView[] = [
      createMockStream("6", { status: "Active" }),
      createMockStream("5", { status: "Active" }),
      createMockStream("4", { status: "Active" }),
      createMockStream("3", { status: "Active" }),
      createMockStream("2", { status: "Active" }),
      createMockStream("1", { status: "Active" }),
    ];

    // Client reads Page 1 (limit 2)
    const page1 = paginateStreamsByCursor(streams, { limit: 2, status: "all" });
    assert.deepEqual(
      page1.streams.map((s) => s.id),
      ["6", "5"]
    );
    assert.equal(page1.nextCursor, "5");

    // Mutation: Stream #4 is cancelled concurrently
    streams[2].status = "Cancelled";

    // Client requests next page using invariant cursor "5"
    const page2 = paginateStreamsByCursor(streams, {
      cursor: "5",
      direction: "forward",
      limit: 2,
      status: "all",
    });

    // Cursor pagination returns exactly [4, 3] without duplicate or shift!
    assert.deepEqual(
      page2.streams.map((s) => s.id),
      ["4", "3"]
    );
    assert.equal(page2.streams[0].status, "Cancelled");
    assert.equal(page2.streams[1].status, "Active");
  });

  it("handles invalid or non-numeric cursors safely", () => {
    const streams = [createMockStream("2"), createMockStream("1")];
    const page = paginateStreamsByCursor(streams, {
      cursor: "invalid-cursor-xyz",
      limit: 10,
    });
    assert.equal(page.streams.length, 2);
    assert.equal(page.streams[0].id, "2");
  });

  it("reconciles server asOfTimestamp with client tick math", () => {
    const deposit = 100_000n;
    const start = 1_000;
    const end = 2_000; // duration 1000s -> 100 units/second
    const asOf = 1_500; // halfway -> 50,000 units accrued

    // Server-side calculation at asOf
    const serverAvailable = computeAvailable(
      deposit,
      start,
      end,
      0n,
      "Active",
      BigInt(asOf)
    );
    assert.equal(serverAvailable, 50_000n);

    // Client ticks 5 seconds later
    const clientNow = asOf + 5;
    const clientAvailable = computeAvailable(
      deposit,
      start,
      end,
      0n,
      "Active",
      BigInt(clientNow)
    );
    assert.equal(clientAvailable, 50_500n);
  });
});
