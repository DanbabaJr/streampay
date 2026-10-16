import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "node:http";

import { StreamStore } from "./store.js";
import { createApp } from "./index.js";
import { decodeEvent } from "./decoder.js";
import type { RpcEvent } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getFixturePath(): string {
  const candidates = [
    path.resolve(__dirname, "../fixtures/events-fixture.json"),
    path.resolve(__dirname, "../test/events-fixture.json"),
    path.resolve(process.cwd(), "fixtures/events-fixture.json"),
    path.resolve(process.cwd(), "test/events-fixture.json"),
    path.resolve(process.cwd(), "indexer/test/events-fixture.json"),
    path.resolve(process.cwd(), "indexer/fixtures/events-fixture.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  throw new Error("Cannot locate events-fixture.json in any expected path");
}

function fetchJson(url: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve({ status: res.statusCode || 200, data });
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

describe("Indexer Integration Tests", () => {
  const fixturePath = getFixturePath();
  const fixtureEvents: RpcEvent[] = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  it("indexes events, persists cursor, prevents double-counting, handles cancel payout, and serves API", async () => {
    const testDbPath = path.resolve(__dirname, `test-indexer-${Date.now()}.sqlite`);
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    try {
      // Step 1: Start indexer store against test SQLite database
      const store = new StreamStore(testDbPath);
      assert.equal(store.getState("cursor"), undefined);

      // Ingest fixture events
      const decodedEvents = fixtureEvents.map(decodeEvent);
      store.ingestPage(decodedEvents, "120", 120);

      // Cursor check
      assert.equal(store.getState("cursor"), "120");
      assert.equal(store.getState("lastLedger"), "120");

      // Step 2: Start HTTP server on an ephemeral port
      const app = createApp(store);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        // GET /health
        const healthRes = await fetchJson(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);
        assert.equal(healthRes.data.ok, true);
        assert.equal(healthRes.data.cursor, "120");

        // GET /streams?recipient=<address>
        const recipient = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
        const streamsRes = await fetchJson(`${baseUrl}/streams?recipient=${recipient}`);
        assert.equal(streamsRes.status, 200);
        assert.equal(Array.isArray(streamsRes.data), true);
        assert.equal(streamsRes.data.length, 1);

        const stream = streamsRes.data[0];
        assert.equal(stream.streamId, "1");
        assert.equal(stream.sender, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M");
        assert.equal(stream.recipient, recipient);
        assert.equal(stream.status, "cancelled");
        assert.equal(stream.cancelled_by, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M");
        assert.equal(stream.recipient_amount, "3000000");
        assert.equal(stream.sender_amount, "10000000");
        // Total withdrawn is previous withdrawn (2000000) + cancel recipient_amount (3000000) = 5000000
        assert.equal(stream.withdrawn, "5000000");
        // Deposit was topped up to 15000000
        assert.equal(stream.deposit, "15000000");

        // GET /streams?recipient=nonexistent returns empty array gracefully
        const emptyStreamsRes = await fetchJson(`${baseUrl}/streams?recipient=NONEXISTENT`);
        assert.equal(emptyStreamsRes.status, 200);
        assert.deepEqual(emptyStreamsRes.data, []);

        // GET /streams/:id/history returns full event history in ledger order
        const historyRes = await fetchJson(`${baseUrl}/streams/1/history`);
        assert.equal(historyRes.status, 200);
        assert.equal(Array.isArray(historyRes.data), true);
        assert.equal(historyRes.data.length, 4);

        assert.equal(historyRes.data[0].event_type, "stream_created");
        assert.equal(historyRes.data[0].ledger, 100);
        assert.equal(historyRes.data[1].event_type, "withdrawn");
        assert.equal(historyRes.data[1].ledger, 105);
        assert.equal(historyRes.data[2].event_type, "stream_topped_up");
        assert.equal(historyRes.data[2].ledger, 110);
        assert.equal(historyRes.data[3].event_type, "stream_cancelled");
        assert.equal(historyRes.data[3].ledger, 115);

        // GET /streams/999/history returns empty array
        const emptyHistoryRes = await fetchJson(`${baseUrl}/streams/999/history`);
        assert.equal(emptyHistoryRes.status, 200);
        assert.deepEqual(emptyHistoryRes.data, []);

        // GET /streams/:id
        const singleStreamRes = await fetchJson(`${baseUrl}/streams/1`);
        assert.equal(singleStreamRes.status, 200);
        assert.equal(singleStreamRes.data.streamId, "1");

        // GET /streams/999 returns 404
        const notFoundRes = await fetchJson(`${baseUrl}/streams/999`);
        assert.equal(notFoundRes.status, 404);

        // GET /address/:addr/streams
        const addrRes = await fetchJson(`${baseUrl}/address/${recipient}/streams`);
        assert.equal(addrRes.status, 200);
        assert.equal(addrRes.data.count, 1);
        assert.equal(addrRes.data.streams[0].streamId, "1");

        // Step 4: Duplicate ingestion test (idempotency, no duplicate counting)
        store.ingestPage(decodedEvents, "120", 120);
        const historyAfterDup = store.getStreamHistory("1");
        assert.equal(historyAfterDup.length, 4, "Event history remains exactly 4 events");

        // Close server and store
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();

        // Step 5: Restart simulation - open fresh store with same SQLite file
        const restartedStore = new StreamStore(testDbPath);
        assert.equal(restartedStore.getState("cursor"), "120", "Cursor persisted across restart");
        assert.equal(restartedStore.getStreamHistory("1").length, 4);
        restartedStore.close();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      if (fs.existsSync(testDbPath)) {
        try {
          fs.unlinkSync(testDbPath);
        } catch {}
      }
    }
  });
});

