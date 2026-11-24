/**
 * Contract tests for the time-travel / as-of API (issue #577).
 *
 * Fixtures are a small journal with known historical states: stream 7 is
 * created at ledger 10, withdrawn from at 11, topped up at 12, paused at
 * 13, resumed at 14 and cancelled at 15. Every expected record below is
 * written out from that script first, then checked three ways — against
 * the pure reconstruction, against the live `StreamStore` projection fed
 * the same events (parity), and through the HTTP routes.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";

import { createApp } from "../index.js";
import { canonicalStreamState } from "../replay/engine.js";
import { StreamStore } from "../store.js";
import type { DecodedEvent } from "../types.js";
import {
  TimeTravelError,
  TimeTravelService,
  eventRegistryDigest,
  queryStreamAsOf,
  reconstructStream,
  verifyAsOfProof,
  type HistoricalEvent,
} from "./time-travel.js";

const SENDER = `G${"A".repeat(55)}`;
const RECIPIENT = `G${"B".repeat(55)}`;
const TOKEN = `C${"C".repeat(55)}`;

function at(ledger: number): string {
  return `2026-01-01T00:00:${String(ledger).padStart(2, "0")}Z`;
}

const JOURNAL: HistoricalEvent[] = [
  { id: "e1", streamId: "7", name: "stream_created", ledger: 10, ledgerClosedAt: at(10), data: { sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: "1000", start_time: "1", end_time: "100", cancelable: true } },
  { id: "e2", streamId: "7", name: "withdrawn", ledger: 11, ledgerClosedAt: at(11), data: { recipient: RECIPIENT, amount: "100", withdrawn_total: "100" } },
  { id: "e3", streamId: "7", name: "stream_topped_up", ledger: 12, ledgerClosedAt: at(12), data: { sender: SENDER, amount: "500", new_deposit: "1500" } },
  { id: "e4", streamId: "7", name: "stream_paused", ledger: 13, ledgerClosedAt: at(13), data: { paused_at: "50" } },
  { id: "e5", streamId: "7", name: "stream_resumed", ledger: 14, ledgerClosedAt: at(14), data: { new_end_time: "100" } },
  { id: "e6", streamId: "7", name: "stream_cancelled", ledger: 15, ledgerClosedAt: at(15), data: { cancelled_by: RECIPIENT, recipient_amount: "200", sender_amount: "1300" } },
  // Another stream's event in the same journal must never leak into stream 7.
  { id: "e7", streamId: "8", name: "stream_created", ledger: 12, ledgerClosedAt: at(12), data: { sender: RECIPIENT, recipient: SENDER, token: TOKEN, deposit: "5", start_time: "1", end_time: "9", cancelable: false } },
];

const TIP = 15;
const context = { tipLedger: TIP };

function decoded(event: HistoricalEvent): DecodedEvent {
  return {
    id: event.id,
    pagingToken: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: "C",
    name: event.name,
    streamId: event.streamId,
    data: event.data,
  };
}

function filledStore(): StreamStore {
  const store = new StreamStore(":memory:");
  for (const event of JOURNAL) store.ingest(decoded(event));
  store.setState("lastLedger", String(TIP));
  return store;
}

test("reconstruction parity: as-of records match the live projection at every ledger", () => {
  const store = new StreamStore(":memory:");
  try {
    for (const event of JOURNAL.filter((e) => e.streamId === "7")) {
      store.ingest(decoded(event));
      const live = store.getStream("7");
      assert.ok(live, "live projection exists after a projecting event");
      const historical = reconstructStream(JOURNAL, "7", event.ledger);
      assert.ok(historical);
      assert.equal(canonicalStreamState(historical), canonicalStreamState(live), `parity at ledger ${event.ledger}`);
    }
  } finally {
    store.close();
  }
});

test("known historical states: exact records at fixture ledgers", () => {
  const at10 = reconstructStream(JOURNAL, "7", 10);
  assert.equal(at10?.deposit, "1000");
  assert.equal(at10?.withdrawn, "0");
  assert.equal(at10?.status, "active");

  const at12 = reconstructStream(JOURNAL, "7", 12);
  assert.equal(at12?.deposit, "1500");
  assert.equal(at12?.withdrawn, "100");
  assert.equal(at12?.lastLedger, 12);

  assert.equal(reconstructStream(JOURNAL, "7", 13)?.status, "paused");
  assert.equal(reconstructStream(JOURNAL, "7", 14)?.status, "active");

  const at15 = reconstructStream(JOURNAL, "7", 15);
  assert.equal(at15?.status, "cancelled");
  assert.equal(at15?.withdrawn, "300", "cancel adds recipient_amount to prior withdrawn, as the store does");
  assert.equal(at15?.cancelled_by, RECIPIENT);

  assert.equal(reconstructStream(JOURNAL, "7", 9), undefined, "no state before creation");
  assert.equal(reconstructStream(JOURNAL, "8", 15)?.deposit, "5", "stream 8 reconstructs independently");
});

test("as-of proof verifies client-side and carries the registry freshness gate", () => {
  const result = queryStreamAsOf(JOURNAL, "7", 12, context);
  assert.ok(result);
  assert.equal(result.ledger, 12);
  assert.equal(result.cursor, "e3", "cursor is the last folded event id, resumable via getEventsAfter");
  assert.equal(result.proof.registryDigest, eventRegistryDigest());
  assert.match(result.proof.registryDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.proof.eventCount, 3);
  assert.equal(verifyAsOfProof(result), true);
  assert.equal(verifyAsOfProof(result, 12), true);
});

test("proof verification rejects tampered, wrong-ledger and stale-registry answers", () => {
  const result = queryStreamAsOf(JOURNAL, "7", 12, context);
  assert.ok(result);

  const tamperedRecord = structuredClone(result);
  tamperedRecord.stream.deposit = "999999";
  assert.equal(verifyAsOfProof(tamperedRecord), false, "tampered record");

  const tamperedEvent = structuredClone(result);
  (tamperedEvent.events[0].data as Record<string, unknown>).deposit = "1";
  assert.equal(verifyAsOfProof(tamperedEvent), false, "tampered event payload");

  assert.equal(verifyAsOfProof(result, 13), false, "wrong expected ledger");
  const wrongLedger = structuredClone(result);
  wrongLedger.proof.ledger = 11;
  assert.equal(verifyAsOfProof(wrongLedger), false, "proof ledger disagrees with response ledger");

  const staleRegistry = structuredClone(result);
  staleRegistry.proof.registryDigest = "0".repeat(64);
  assert.equal(verifyAsOfProof(staleRegistry), false, "registry freshness gate");

  const swappedRoot = structuredClone(result);
  swappedRoot.proof.eventRoot = swappedRoot.proof.stateRoot;
  assert.equal(verifyAsOfProof(swappedRoot), false, "event root replaced");
});

test("retention window and journal floor: expired history is a clear error, boundary is served", () => {
  // Tip 15, window 5: earliest available is ledger 10.
  assert.throws(
    () => queryStreamAsOf(JOURNAL, "7", 9, { tipLedger: TIP, policy: { retentionWindowLedgers: 5 } }),
    (err: unknown) => err instanceof TimeTravelError && err.code === "history_expired",
  );
  assert.ok(queryStreamAsOf(JOURNAL, "7", 10, { tipLedger: TIP, policy: { retentionWindowLedgers: 5 } }), "boundary ledger is retained");

  // A pruned journal (floor 10) cannot prove state at 9 even with a wide window.
  assert.throws(
    () => queryStreamAsOf(JOURNAL, "7", 9, { tipLedger: TIP, journalFloorLedger: 10 }),
    (err: unknown) => err instanceof TimeTravelError && err.code === "history_expired",
  );

  assert.throws(
    () => queryStreamAsOf(JOURNAL, "7", TIP + 1, context),
    (err: unknown) => err instanceof TimeTravelError && err.code === "as_of_in_future",
  );
});

test("cost budget: folding is charged per event, the boundary passes and one over fails", () => {
  // Stream 7 has exactly 3 events at or below ledger 12.
  assert.ok(queryStreamAsOf(JOURNAL, "7", 12, { tipLedger: TIP, policy: { maxCostUnits: 3 } }));
  assert.throws(
    () => queryStreamAsOf(JOURNAL, "7", 12, { tipLedger: TIP, policy: { maxCostUnits: 2 } }),
    (err: unknown) => err instanceof TimeTravelError && err.code === "cost_budget_exceeded",
  );
  const result = queryStreamAsOf(JOURNAL, "7", 12, context);
  assert.equal(result?.costUnits, 3);
});

test("service reads the bounded journal slice from the store and portfolios reconstruct", () => {
  const store = filledStore();
  try {
    const service = new TimeTravelService(store);
    const result = service.getStreamAsOf("7", 11);
    assert.ok(result);
    assert.equal(result.stream.deposit, "1000");
    assert.equal(result.stream.withdrawn, "100");
    assert.equal(verifyAsOfProof(result), true);
    // Ledger 9 is below the journal floor (10): the service must refuse
    // with history_expired rather than guess from a pruned journal.
    assert.throws(
      () => service.getStreamAsOf("7", 9),
      (err: unknown) => err instanceof TimeTravelError && err.code === "history_expired",
    );
  } finally {
    store.close();
  }
});

test("service portfolio: the address's streams as of a ledger, role checked as of then", () => {
  const store = filledStore();
  try {
    const service = new TimeTravelService(store);
    const portfolio = service.getPortfolioAsOf(SENDER, 12);
    assert.equal(portfolio.ledger, 12);
    // Stream 7 (sender) and stream 8 (recipient) both involve SENDER at 12.
    assert.deepEqual(portfolio.streams.map((s) => s.stream.streamId).sort(), ["7", "8"]);
    for (const entry of portfolio.streams) assert.equal(verifyAsOfProof(entry), true);
  } finally {
    store.close();
  }
});

test("redaction applies to historical reads identically, and the proof flags it", () => {
  const store = filledStore();
  try {
    const service = new TimeTravelService(store);
    const redacted = service.getStreamAsOf("7", 12, { redact: true });
    assert.ok(redacted);
    assert.equal(redacted.stream.sender, `${SENDER.slice(0, 8)}...`);
    assert.equal(redacted.proof.redacted, true);
    // Inclusion still verifies against the committed roots; payload
    // re-hashing is skipped for data the client was deliberately not shown.
    assert.equal(verifyAsOfProof(redacted), true);

    const plain = service.getStreamAsOf("7", 12);
    assert.equal(plain?.stream.sender, SENDER);
    assert.equal(plain?.proof.redacted, false);
  } finally {
    store.close();
  }
});

function fetchJson(url: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}

test("HTTP as-of routes: stream, portfolio, and bounded-query status codes", async () => {
  const store = filledStore();
  const app = createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    policy: { retentionWindowLedgers: 5 },
  });
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    const ok = await fetchJson(`${base}/streams/7/as-of?ledger=12`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.stream.deposit, "1500");
    assert.equal(ok.data.proof.eventCount, 3);
    assert.equal(verifyAsOfProof(ok.data), true, "the served proof verifies from the body alone");

    const notYet = await fetchJson(`${base}/streams/8/as-of?ledger=10`);
    assert.equal(notYet.status, 404, "stream 8 did not exist at ledger 10");

    const expired = await fetchJson(`${base}/streams/7/as-of?ledger=9`);
    assert.equal(expired.status, 410);
    assert.equal(expired.data.code, "history_expired");

    const future = await fetchJson(`${base}/streams/7/as-of?ledger=99`);
    assert.equal(future.status, 400);
    assert.equal(future.data.code, "as_of_in_future");

    const invalid = await fetchJson(`${base}/streams/7/as-of`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, "invalid_ledger");

    const portfolio = await fetchJson(`${base}/address/${RECIPIENT}/as-of?ledger=12`);
    assert.equal(portfolio.status, 200);
    assert.deepEqual(portfolio.data.streams.map((s: any) => s.stream.streamId).sort(), ["7", "8"]);
  } finally {
    server.close();
    store.close();
  }
});
