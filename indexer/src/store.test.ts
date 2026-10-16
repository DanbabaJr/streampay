import assert from "node:assert/strict";
import test from "node:test";
import { StreamStore } from "./store.js";
import type { DecodedEvent } from "./types.js";

test("event upserts are idempotent and project stream lifecycle", () => {
  const store = new StreamStore(":memory:");
  const base: DecodedEvent = { id: "event-1", pagingToken: "1", ledger: 10, ledgerClosedAt: "2026-01-01T00:00:00Z", contractId: "C", name: "stream_created", streamId: "7", data: { sender: "Gsender", recipient: "Grecipient", token: "Ctoken", deposit: 1000n, start_time: 1n, end_time: 10n, cancelable: true } };
  store.ingestPage([base], "1", 10);
  store.ingestPage([base], "1", 10);
  assert.equal(store.getState("cursor"), "1");
  assert.equal(store.getState("lastLedger"), "10");
  assert.equal(store.getStream("7")?.deposit, "1000");
  assert.equal(store.listAddress("Grecipient").length, 1);
  store.ingest({ ...base, id: "event-2", pagingToken: "2", ledger: 11, name: "withdrawn", data: { recipient: "Grecipient", amount: 100n, withdrawn_total: 100n } });
  assert.equal(store.getStream("7")?.withdrawn, "100");
  store.ingest({ ...base, id: "event-3", pagingToken: "3", ledger: 12, name: "stream_topped_up", data: { new_deposit: 1500n } });
  assert.equal(store.getStream("7")?.deposit, "1500");
  store.ingest({ ...base, id: "event-4", pagingToken: "4", ledger: 13, name: "stream_cancelled", data: { sender_amount: 1n, recipient_amount: 2n } });
  assert.equal(store.getStream("7")?.status, "cancelled");
  store.close();
});
