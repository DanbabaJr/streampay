import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamStore } from "../store.js";
import { redactStream } from "../redaction.js";
import { sanitizeAddress } from "../privacy.js";
import { buildCorruptCorpus } from "../corrupt-fixtures.js";
import { DecodeError, decodeEvent } from "../decoder.js";
import {
  ArrayReplaySource,
  ReplayEngine,
  ReplayFixtureError,
  computeReplayStateRoot,
  type ReplayEventRow,
} from "./engine.js";

interface ReplayCorpus {
  contractId: string;
  rangeSize: number;
  concurrency: number;
  goldenStateRoot: string;
  events: ReplayEventRow[];
}

function locateCorpus(): string {
  const candidates = [
    new URL("../../fixtures/replay-corpus.json", import.meta.url),
    new URL("../../../fixtures/replay-corpus.json", import.meta.url),
    new URL("fixtures/replay-corpus.json", `file://${process.cwd()}/`),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error("cannot locate indexer/fixtures/replay-corpus.json");
}

const corpus: ReplayCorpus = JSON.parse(readFileSync(locateCorpus(), "utf8")) as ReplayCorpus;
const ledgers = corpus.events.map((event) => event.ledger);
const LEDGER_RANGE = { fromLedger: Math.min(...ledgers), toLedger: Math.max(...ledgers) };

function replayInto(store: StreamStore, redact: boolean, job = "replay-gate") {
  return new ReplayEngine(store, new ArrayReplaySource(corpus.events)).run({
    job,
    contractId: corpus.contractId,
    ...LEDGER_RANGE,
    rangeSize: corpus.rangeSize,
    concurrency: corpus.concurrency,
    redact,
  });
}

test("CI gate: the pinned historical corpus replays to its golden state root", async () => {
  const store = new StreamStore(":memory:");
  try {
    const result = await replayInto(store, false);

    assert.match(corpus.goldenStateRoot, /^[0-9a-f]{64}$/, "the corpus pins a 32-byte Merkle root");
    assert.equal(result.stateRoot, corpus.goldenStateRoot);
    assert.equal(result.events, corpus.events.length);
    assert.equal(result.upcast, 3, "the three pre-registry rows must cross the upcaster chain");

    assert.equal(store.listAllStreams().length, 2);
    const cancelled = store.getStream("1001")!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.deposit, "1500");
    assert.equal(cancelled.withdrawn, "400");
    assert.equal(cancelled.lastLedger, 104);

    const active = store.getStream("1002")!;
    assert.equal(active.status, "active");
    assert.equal(active.withdrawn, "50");
    assert.equal(active.cancelable, false);
    assert.ok(active.refund_target, "the refund target routing was projected");
    assert.equal(active.lastLedger, 108);
  } finally {
    store.close();
  }
});

test("replaying the corpus is reproducible across stores and range layouts", async () => {
  const first = new StreamStore(":memory:");
  const second = new StreamStore(":memory:");
  try {
    const one = await replayInto(first, false, "layout-a");
    const two = await new ReplayEngine(second, new ArrayReplaySource([...corpus.events].reverse())).run({
      job: "layout-b",
      contractId: corpus.contractId,
      ...LEDGER_RANGE,
      rangeSize: 2,
      concurrency: 3,
      redact: false,
    });

    assert.equal(two.stateRoot, one.stateRoot);
    assert.equal(computeReplayStateRoot(first.listAllStreams()), one.stateRoot);
  } finally {
    first.close();
    second.close();
  }
});

test("privacy redaction during replay produces exactly the live read path's state", async () => {
  const plain = new StreamStore(":memory:");
  const redacted = new StreamStore(":memory:");
  try {
    await replayInto(plain, false, "plain");
    const result = await replayInto(redacted, true, "redacted");

    const plainStreams = plain.listAllStreams();
    const projected = redacted.listAllStreams();
    assert.equal(projected.length, plainStreams.length);
    for (const [index, plainStream] of plainStreams.entries()) {
      const masked = redactStream(plainStream, true);
      const { token: redactedToken, ...redactedRest } = projected[index];
      const { token: maskedToken, ...maskedRest } = masked;
      assert.deepEqual(redactedRest, maskedRest, "replay redaction must match the live redactStream projection");
      assert.equal(redactedToken, sanitizeAddress(plainStream.token ?? ""));
      assert.equal(maskedToken, plainStream.token, "redactStream leaves the asset identifier alone");
    }
    assert.notEqual(result.stateRoot, computeReplayStateRoot(plainStreams));
  } finally {
    plain.close();
    redacted.close();
  }
});

test("truncated and malformed fixtures fail closed, in the decoder and in replay", async () => {
  const truncated = buildCorruptCorpus().filter((fixture) => fixture.category === "truncated_xdr");
  assert.ok(truncated.length > 0, "reuse the #486 truncated-XDR corpus");
  for (const fixture of truncated) {
    assert.throws(
      () => decodeEvent(fixture.event),
      (err: unknown) => err instanceof DecodeError && err.code === fixture.expectedErrorCode,
      `${fixture.id} must still be rejected by the decoder`,
    );
  }

  const store = new StreamStore(":memory:");
  try {
    const rows: ReplayEventRow[] = corpus.events.map((event) => ({ ...event }));
    rows[4] = { ...rows[4], payload: "" };
    const engine = new ReplayEngine(store, new ArrayReplaySource(rows));
    await assert.rejects(
      engine.run({ job: "truncated", contractId: corpus.contractId, ...LEDGER_RANGE, rangeSize: 3, concurrency: 2 }),
      (err: unknown) => err instanceof ReplayFixtureError && err.eventId === rows[4].id,
    );
    // Ranges before the broken one are genuinely committed; the broken range and
    // everything after it are not, so the checkpoint can never claim the window.
    assert.equal(engine.checkpoint("truncated")!.watermark, 102);
    assert.ok(engine.checkpoint("truncated")!.watermark < LEDGER_RANGE.toLedger);
  } finally {
    store.close();
  }
});
