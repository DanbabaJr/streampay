/**
 * Cursor pagination stability under concurrent inserts (issue #485).
 *
 * Only the public read API is used: `ShardedStore.listAddressPaged` (cursor =
 * last stream id, order = numeric ids ascending, then non-numeric
 * lexicographically) and `getEventsAfter` (cursor = last event id).
 *
 * Observed contract, also documented in README.md:
 * - every row present before the walk starts is returned exactly once, in
 *   order, whatever is inserted between page reads;
 * - a row inserted ahead of the cursor shows up in its sorted position;
 * - a row inserted behind the cursor is never returned by that walk;
 * - re-ingesting the boundary key (or any known key) adds no duplicate.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ShardedStore } from "./sharding/sharded-store.js";
import type { DecodedEvent, EventValue } from "./types.js";

const ADDR = "GCOMMON";

function makeEvent(id: string, streamId: string, ledger: number, name: string, data: Record<string, EventValue>): DecodedEvent {
  return {
    id,
    pagingToken: String(ledger),
    ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 1_000).toISOString(),
    contractId: "C",
    name,
    streamId,
    data,
  };
}

function add(store: ShardedStore, streamId: string, ledger = 100): void {
  store.ingestPage(
    [
      makeEvent(`ev-${streamId}-created`, streamId, ledger, "stream_created", {
        sender: `GSENDER${streamId}`,
        recipient: ADDR,
        token: "CTOKEN",
        deposit: "15000000",
        start_time: "1000",
        end_time: "2000",
        cancelable: true,
      }),
    ],
    undefined,
    ledger
  );
}

function ids(page: { streams: Array<{ streamId: string }> }): string[] {
  return page.streams.map((s) => s.streamId);
}

function fresh(initial: string[]): ShardedStore {
  const store = new ShardedStore({ shardCount: 3, rangeSize: 10 });
  initial.forEach((id, i) => add(store, id, 100 + i));
  return store;
}

test("insert ahead of the cursor appears in sorted position, no skip or duplicate", () => {
  const store = fresh(["10", "20", "30", "40", "50"]);
  try {
    const p1 = store.listAddressPaged(ADDR, { limit: 2 });
    assert.deepEqual(ids(p1), ["10", "20"]);
    add(store, "35");
    const p2 = store.listAddressPaged(ADDR, { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(ids(p2), ["30", "35"]);
    const p3 = store.listAddressPaged(ADDR, { limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(ids(p3), ["40", "50"]);
    assert.equal(p3.nextCursor, null);
  } finally {
    store.close();
  }
});

test("insert behind the cursor never reappears and does not shift later pages", () => {
  const store = fresh(["10", "20", "30", "40", "50"]);
  try {
    const p1 = store.listAddressPaged(ADDR, { limit: 2 });
    add(store, "5");
    add(store, "15");
    const p2 = store.listAddressPaged(ADDR, { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(ids(p2), ["30", "40"]);
    const p3 = store.listAddressPaged(ADDR, { limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(ids(p3), ["50"]);
    assert.equal(p3.nextCursor, null);
  } finally {
    store.close();
  }
});

test("boundary key: re-ingesting the cursor key adds no duplicate; next id lands right after it", () => {
  const store = fresh(["10", "20", "30"]);
  try {
    const p1 = store.listAddressPaged(ADDR, { limit: 2 });
    assert.deepEqual(ids(p1), ["10", "20"]);
    add(store, "20", 500);
    add(store, "21");
    const p2 = store.listAddressPaged(ADDR, { limit: 5, cursor: p1.nextCursor });
    assert.deepEqual(ids(p2), ["21", "30"]);
    assert.equal(store.listAddress(ADDR).filter((s) => s.streamId === "20").length, 1);
  } finally {
    store.close();
  }
});

test("empty and last-page semantics", () => {
  const empty = fresh([]);
  try {
    assert.deepEqual(empty.listAddressPaged(ADDR, { limit: 3 }), { streams: [], nextCursor: null });
  } finally {
    empty.close();
  }
  const store = fresh(["1", "2", "3", "4"]);
  try {
    const p1 = store.listAddressPaged(ADDR, { limit: 2 });
    const p2 = store.listAddressPaged(ADDR, { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(ids(p2), ["3", "4"]);
    assert.equal(p2.nextCursor, null, "exact-fit last page has no next cursor");
    const mid = store.listAddressPaged(ADDR, { limit: 3 }).nextCursor;
    assert.deepEqual(ids(store.listAddressPaged(ADDR, { limit: 3, cursor: mid })), ["4"]);
    add(store, "9");
    assert.deepEqual(ids(store.listAddressPaged(ADDR, { limit: 3, cursor: mid })), ["4", "9"]);
  } finally {
    store.close();
  }
});

test("seeded property loop: random inserts between pages never skip or duplicate pre-existing rows", () => {
  let seed = 485;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let round = 0; round < 25; round++) {
    const initial = new Set<string>();
    const n = 1 + Math.floor(rand() * 20);
    while (initial.size < n) initial.add(String(1 + Math.floor(rand() * 60)));
    const store = fresh([...initial]);
    try {
      const limit = 1 + Math.floor(rand() * 5);
      const seen: string[] = [];
      const inserted = new Set<string>();
      let cursor: string | null = null;
      for (let guard = 0; guard < 200; guard++) {
        const page = store.listAddressPaged(ADDR, { limit, cursor });
        seen.push(...ids(page));
        for (let k = Math.floor(rand() * 3); k > 0; k--) {
          const id = String(1 + Math.floor(rand() * 80));
          if (!initial.has(id)) inserted.add(id);
          add(store, id);
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      assert.equal(new Set(seen).size, seen.length, `round ${round}: duplicate row`);
      for (const id of initial) assert.ok(seen.includes(id), `round ${round}: pre-existing ${id} skipped`);
      for (const id of seen) assert.ok(initial.has(id) || inserted.has(id), `round ${round}: unknown row ${id}`);
      const numeric = seen.map(Number);
      assert.deepEqual(numeric, [...numeric].sort((a, b) => a - b), `round ${round}: out of order`);
    } finally {
      store.close();
    }
  }
});

test("getEventsAfter: events appended mid-walk are seen once, in (ledger, id) order", () => {
  const store = fresh(["10", "20", "30"]);
  try {
    const first = store.getEventsAfter("ev-10-created");
    assert.deepEqual(first.map((e) => e.id), ["ev-20-created", "ev-30-created"]);
    add(store, "40", 200);
    const next = store.getEventsAfter(first[first.length - 1]!.id);
    assert.deepEqual(next.map((e) => e.id), ["ev-40-created"]);
    assert.deepEqual(store.getEventsAfter("ev-40-created"), []);
    assert.deepEqual(store.getEventsAfter("missing"), [], "unknown cursor yields an empty page");
  } finally {
    store.close();
  }
});
