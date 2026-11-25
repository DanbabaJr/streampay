import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamStore } from "./store.js";
import {
  Tracer,
  globalIndexerTracer,
  InMemorySpanExporter,
  traceCorrelationRegistry,
  spanKindToOtlp,
} from "./telemetry.js";
import type { DecodedEvent } from "./types.js";
import { sanitizeAddress, sanitizeWebhookUrl, sanitizeAttributes } from "./privacy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Indexer Telemetry & Span Link Seam Verification", () => {
  it("ingests event and attaches SpanLink via correlation registry lookup by txHash", () => {
    const memoryExporter = new InMemorySpanExporter();
    globalIndexerTracer.addExporter(memoryExporter);

    const testDbPath = path.resolve(__dirname, `test-indexer-otel-${Date.now()}.sqlite`);
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    try {
      const store = new StreamStore(testDbPath);

      const originatingTraceId = "e10adc3949ba59abbe56e057f20f883e";
      const originatingSpanId = "20f883e56e057f20";
      const txHash = "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

      // 1. Client registers correlation for the on-chain tx
      traceCorrelationRegistry.register(txHash, {
        traceId: originatingTraceId,
        spanId: originatingSpanId,
        traceFlags: 1,
      }, "99");

      // 2. Ingest event that only has txHash (no pre-constructed linkedSpanContext)
      const event: DecodedEvent = {
        id: "evt_claim_001",
        pagingToken: "10502-0",
        ledger: 10502,
        ledgerClosedAt: new Date().toISOString(),
        contractId: "CDUMMYCONTRACT123",
        name: "withdrawn",
        streamId: "99",
        data: {
          withdrawn_total: "5000000",
          recipient: "GDJ6TEST1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12",
        },
        txHash,
      };

      store.ingest(event);

      const spans = memoryExporter.getFinishedSpans();
      const ingestSpan = spans.find((s) => s.name === "indexer.ingest_event");
      const dbSpan = spans.find((s) => s.name === "indexer.db_write");

      assert.ok(ingestSpan, "indexer.ingest_event span must be generated");
      assert.ok(dbSpan, "indexer.db_write span must be generated");

      // Verify SpanLink (asynchronous event seam automatically wired via txHash)
      assert.equal(ingestSpan.links.length, 1, "Must contain 1 SpanLink");
      assert.equal(ingestSpan.links[0].context.traceId, originatingTraceId);
      assert.equal(ingestSpan.links[0].context.spanId, originatingSpanId);
      assert.equal(ingestSpan.links[0].attributes?.["link.relationship"], "ledger_event_continuation");
      assert.equal(ingestSpan.links[0].attributes?.["soroban.tx_hash"], txHash);

      // Verify parent-child relationship: db_write is child of ingest_event
      assert.equal(dbSpan.parentSpanId, ingestSpan.context.spanId);

      // Verify history stamps correlation
      const history = store.getStreamHistory("99");
      assert.equal(history.length, 1);
      assert.equal(history[0].tx_hash, txHash);
      assert.equal(history[0].trace_id, ingestSpan.context.traceId);
      assert.equal(history[0].span_id, ingestSpan.context.spanId);

      store.close();
    } finally {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    }
  });

  it("maps OpenTelemetry span kinds correctly without collapsing CLIENT or PRODUCER", () => {
    assert.equal(spanKindToOtlp("INTERNAL"), 1);
    assert.equal(spanKindToOtlp("SERVER"), 2);
    assert.equal(spanKindToOtlp("CLIENT"), 3);
    assert.equal(spanKindToOtlp("PRODUCER"), 4);
    assert.equal(spanKindToOtlp("CONSUMER"), 5);
  });

  it("isolates active trace spans across concurrent async operations using AsyncLocalStorage", async () => {
    const memory = new InMemorySpanExporter();
    const tracer = new Tracer({
      serviceName: "concurrency-test",
      exporters: [memory],
    });

    // Run two asynchronous flows concurrently
    const flow1 = tracer.withSpan("request-1", async (span1) => {
      await new Promise((r) => setTimeout(r, 20));
      // Child span inside flow 1
      const child1 = tracer.startSpan("child-1");
      child1.end();
      return { span1, child1 };
    });

    const flow2 = tracer.withSpan("request-2", async (span2) => {
      await new Promise((r) => setTimeout(r, 10));
      // Child span inside flow 2
      const child2 = tracer.startSpan("child-2");
      child2.end();
      return { span2, child2 };
    });

    const [res1, res2] = await Promise.all([flow1, flow2]);

    assert.equal(res1.child1.parentSpanId, res1.span1.context.spanId, "child-1 must belong to request-1");
    assert.equal(res2.child2.parentSpanId, res2.span2.context.spanId, "child-2 must belong to request-2");
    assert.notEqual(res1.child1.parentSpanId, res2.span2.context.spanId, "No cross-request context pollution");
  });

  it("strictly enforces privacy line on indexer attributes and omits financial amounts", () => {
    const raw = "GBMOCK1234567890123456789012345678901234567890123456789012";
    const sanitized = sanitizeAddress(raw);
    assert.equal(sanitized, "GBMOCK12...");
    assert.ok(sanitized.length <= 11);

    const webhook = "https://receiver.internal/hook?token=supersecret";
    assert.equal(sanitizeWebhookUrl(webhook), "https://receiver.internal/***");

    // Attributes dictionary filtering: amounts and balances must be dropped
    const attrs = {
      "recipient.address": raw,
      "stream.id": "42",
      "amount": "10000000",
      "claim.amount": 500,
      "balance": 1000,
      "deposit": "50000000",
    };
    const sanitizedAttrs = sanitizeAttributes(attrs);
    assert.equal(sanitizedAttrs["recipient.address"], "GBMOCK12...");
    assert.equal(sanitizedAttrs["stream.id"], "42");
    assert.equal(sanitizedAttrs["amount"], undefined);
    assert.equal(sanitizedAttrs["claim.amount"], undefined);
    assert.equal(sanitizedAttrs["balance"], undefined);
    assert.equal(sanitizedAttrs["deposit"], undefined);
  });
});
