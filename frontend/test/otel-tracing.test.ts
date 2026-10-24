import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  Tracer,
  InMemorySpanExporter,
  W3CTraceContextPropagator,
  traceCorrelationRegistry,
} from "../lib/telemetry.ts";
import {
  sanitizeAddress,
  sanitizeWebhookUrl,
  sanitizeEmail,
  sanitizeTelegramChatId,
  sanitizeError,
  sanitizeAttributes,
} from "../lib/privacy.ts";

describe("OpenTelemetry Distributed Tracing & Async Seams", () => {
  let memoryExporter: InMemorySpanExporter;
  let tracer: Tracer;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    tracer = new Tracer({
      serviceName: "streampay-test",
      exporters: [memoryExporter],
    });
  });

  describe("1. W3C TraceContext Propagation", () => {
    it("formats and parses valid W3C traceparent headers", () => {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const spanId = "00f067aa0ba902b7";
      const context = { traceId, spanId, traceFlags: 1 };

      const header = W3CTraceContextPropagator.formatTraceParent(context);
      assert.equal(header, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

      const parsed = W3CTraceContextPropagator.parseTraceParent(header);
      assert.ok(parsed);
      assert.equal(parsed.traceId, traceId);
      assert.equal(parsed.spanId, spanId);
      assert.equal(parsed.traceFlags, 1);
    });

    it("injects and extracts trace context across HTTP carrier headers", () => {
      const span = tracer.startSpan("test.http_request");
      const carrier: Record<string, string> = {};

      W3CTraceContextPropagator.inject(span.context, carrier);
      assert.ok(carrier["traceparent"]);
      assert.ok(carrier["traceparent"].includes(span.context.traceId));

      const extracted = W3CTraceContextPropagator.extract(carrier);
      assert.ok(extracted);
      assert.equal(extracted.traceId, span.context.traceId);
      assert.equal(extracted.spanId, span.context.spanId);
      span.end();
    });

    it("rejects all-zero or malformed traceparent headers safely", () => {
      assert.equal(W3CTraceContextPropagator.parseTraceParent(""), null);
      assert.equal(W3CTraceContextPropagator.parseTraceParent("invalid-header"), null);
      assert.equal(
        W3CTraceContextPropagator.parseTraceParent("00-00000000000000000000000000000000-0000000000000000-01"),
        null
      );
    });
  });

  describe("2. Privacy Line Enforcement (Address Prefixes & Redaction)", () => {
    it("truncates Stellar account addresses to 8-character prefixes", () => {
      const fullAddress = "GDJ61234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234";
      const sanitized = sanitizeAddress(fullAddress);
      assert.equal(sanitized, "GDJ61234...");
      assert.equal(sanitized.length, 11);
      assert.ok(!sanitized.includes("ABCDEF"));
    });

    it("masks webhook URLs, stripping secret tokens and query parameters", () => {
      const secretUrl = "https://hooks.example.com/v1/sink?token=secret123&user=admin";
      const sanitized = sanitizeWebhookUrl(secretUrl);
      assert.equal(sanitized, "https://hooks.example.com/***");
      assert.ok(!sanitized.includes("secret123"));
    });

    it("masks email destinations to domain only", () => {
      const email = "alice.smith@streampay.finance";
      const sanitized = sanitizeEmail(email);
      assert.equal(sanitized, "***@streampay.finance");
      assert.ok(!sanitized.includes("alice"));
    });

    it("masks Telegram chat IDs to last 4 characters", () => {
      assert.equal(sanitizeTelegramChatId("987654321"), "chat_***4321");
      assert.equal(sanitizeTelegramChatId("12"), "chat_***");
    });

    it("strictly redacts Stellar secret keys (S...) from error messages", () => {
      const errorMsg = "Revert error occurred with signer SBBBBB1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234 in context";
      const sanitized = sanitizeError(errorMsg);
      assert.ok(!sanitized.includes("SBBBBB"));
      assert.ok(sanitized.includes("[REDACTED_SECRET_KEY]"));
    });

    it("strictly omits financial amounts from span attributes according to PRIVACY.md", () => {
      const rawAttrs = {
        "recipient.address": "GBMOCK1234567890123456789012345678901234567890123456789012",
        "webhook.url": "https://service.org/push/token123",
        "user.email": "bob@org.io",
        "stream.id": "42",
        "amount": 5000000,
        "deposit": 10000000,
        "balance": 2500000,
      };

      const sanitized = sanitizeAttributes(rawAttrs);
      assert.equal(sanitized["recipient.address"], "GBMOCK12...");
      assert.equal(sanitized["webhook.url"], "https://service.org/***");
      assert.equal(sanitized["user.email"], "***@org.io");
      assert.equal(sanitized["stream.id"], "42");
      assert.equal(sanitized["amount"], undefined, "Financial amount must not be exported in traces");
      assert.equal(sanitized["deposit"], undefined, "Financial deposit must not be exported in traces");
      assert.equal(sanitized["balance"], undefined, "Financial balance must not be exported in traces");
    });
  });

  describe("3. End-to-End Claim Flow with Event Seam Span Link", () => {
    it("traces browser claim -> on-chain submit -> event ingest (span-linked) -> push dispatch", async () => {
      const recipientAddress = "GDJ6TEST1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";
      const streamId = "101";
      const txHash = "0x4f8c2b7e1234567890abcdef1234567890abcdef1234567890abcdef12345678";

      // ─── STEP 1: BROWSER CLAIM CLICK & ON-CHAIN SUBMISSION ────────────────
      const browserSpan = tracer.startSpan("browser.claim_click", {
        kind: "CLIENT",
        attributes: {
          "user.action": "claim_max",
          "stream.id": streamId,
          "recipient.address": recipientAddress,
        },
      });

      // Child span for Soroban RPC transaction simulation & submission
      const rpcSpan = tracer.startSpan("soroban.rpc.call", {
        parent: browserSpan,
        kind: "CLIENT",
        attributes: {
          "rpc.system": "soroban",
          "rpc.service": "SorobanRpc",
          "rpc.method": "withdraw_max",
          "soroban.contract_id": "CDUMMYCONTRACT123",
          "soroban.stream_id": streamId,
        },
      });

      rpcSpan.setAttribute("soroban.tx_hash", txHash);
      rpcSpan.setStatus("OK");
      rpcSpan.end();

      browserSpan.setAttribute("soroban.tx_hash", txHash);
      browserSpan.setStatus("OK");
      browserSpan.end();

      // Register trace correlation for the asynchronous event seam
      traceCorrelationRegistry.register(txHash, browserSpan.context, streamId);

      // ─── STEP 2: HARD ASYNC SEAM (LEDGER DELAY & SPAN LINK) ───────────────
      // After consensus delay, indexer ingests the contract event
      const linkedContext = traceCorrelationRegistry.get(txHash);
      assert.ok(linkedContext, "Indexer must find originating trace context from correlation registry");
      assert.equal(linkedContext.traceId, browserSpan.context.traceId);

      // Indexer starts a NEW trace/span representing the ledger ingestion
      // CRITICAL REQUIREMENT: Span link, NOT parent-child, for ledger-delayed work!
      const indexerSpan = tracer.startSpan("indexer.ingest_event", {
        kind: "CONSUMER",
        attributes: {
          "event.name": "withdrawn",
          "ledger.sequence": 10502,
          "stream.id": streamId,
          "soroban.tx_hash": txHash,
        },
      });

      // Add SpanLink to the originating claim trace
      indexerSpan.addLink({
        context: linkedContext,
        attributes: {
          "link.relationship": "ledger_event_continuation",
          "event.name": "withdrawn",
          "ledger.sequence": 10502,
          "soroban.tx_hash": txHash,
        },
      });

      // Ingestion DB write child span
      const dbSpan = tracer.startSpan("indexer.db_write", {
        parent: indexerSpan,
        kind: "INTERNAL",
        attributes: {
          "db.system": "sqlite",
          "stream.id": streamId,
          "table": "streams",
        },
      });
      dbSpan.setStatus("OK");
      dbSpan.end();

      // ─── STEP 3: PUSH NOTIFICATION DISPATCH ───────────────────────────────
      const pushSpan = tracer.startSpan("push.dispatch", {
        parent: indexerSpan,
        kind: "PRODUCER",
        attributes: {
          "notification.event_type": "claim",
          "stream.id": streamId,
        },
      });

      const webhookSpan = tracer.startSpan("push.deliver_webhook", {
        parent: pushSpan,
        kind: "CLIENT",
        attributes: {
          "notification.channel": "webhook",
          "notification.destination": sanitizeWebhookUrl("https://merchant.example.com/webhook?token=xyz"),
          "recipient.address": sanitizeAddress(recipientAddress),
        },
      });

      // Inject traceparent into outgoing webhook request
      const webhookHeaders: Record<string, string> = {};
      W3CTraceContextPropagator.inject(webhookSpan.context, webhookHeaders);
      assert.ok(webhookHeaders["traceparent"]);
      assert.ok(webhookHeaders["traceparent"].includes(webhookSpan.context.traceId));

      webhookSpan.setStatus("OK");
      webhookSpan.end();

      pushSpan.setStatus("OK");
      pushSpan.end();

      indexerSpan.setStatus("OK");
      indexerSpan.end();

      // ─── VERIFICATIONS ───────────────────────────────────────────────────
      const spans = memoryExporter.getFinishedSpans();
      assert.equal(spans.length, 6);

      const sBrowser = spans.find((s) => s.name === "browser.claim_click");
      const sRpc = spans.find((s) => s.name === "soroban.rpc.call");
      const sIndexer = spans.find((s) => s.name === "indexer.ingest_event");
      const sDb = spans.find((s) => s.name === "indexer.db_write");
      const sPush = spans.find((s) => s.name === "push.dispatch");
      const sWebhook = spans.find((s) => s.name === "push.deliver_webhook");

      assert.ok(sBrowser && sRpc && sIndexer && sDb && sPush && sWebhook);

      // Verify Parent-Child Hierarchy for synchronous request:
      assert.equal(sRpc.context.traceId, sBrowser.context.traceId);
      assert.equal(sRpc.parentSpanId, sBrowser.context.spanId);

      // Verify Asynchronous Seam (SpanLink instead of parent-child):
      assert.notEqual(
        sIndexer.parentSpanId,
        sBrowser.context.spanId,
        "Indexer span MUST NOT be a direct child of the synchronous browser span"
      );
      assert.equal(sIndexer.links.length, 1, "Indexer span must contain exactly one SpanLink");
      assert.equal(
        sIndexer.links[0].context.traceId,
        sBrowser.context.traceId,
        "SpanLink must point to originating traceId"
      );
      assert.equal(
        sIndexer.links[0].context.spanId,
        browserSpan.context.spanId,
        "SpanLink must point to originating browser spanId"
      );
      assert.equal(
        sIndexer.links[0].attributes?.["link.relationship"],
        "ledger_event_continuation"
      );

      // Verify Push dispatch is a child of the indexer ingestion
      assert.equal(sPush.parentSpanId, sIndexer.context.spanId);
      assert.equal(sWebhook.parentSpanId, sPush.context.spanId);

      // Verify Privacy Line across all spans:
      for (const span of spans) {
        for (const [k, v] of Object.entries(span.attributes)) {
          if (typeof v === "string" && v.startsWith("G") && v.length === 56) {
            assert.fail(`Span ${span.name} leaked raw Stellar address in attribute ${k}: ${v}`);
          }
        }
      }
    });
  });

  describe("4. Tail-Sampling Guarantee (Error Traces Never Dropped)", () => {
    it("tags failed spans with error=true to guarantee 100% tail-sampling retention", () => {
      const span = tracer.startSpan("soroban.rpc.call");
      span.recordException(new Error("RPC 429: Rate limit exceeded"));
      span.end();

      const finished = memoryExporter.getFinishedSpans()[0];
      assert.equal(finished.status.code, "ERROR");
      assert.equal(finished.attributes["error"], true);
      assert.ok(finished.attributes["error.message"]);

      const exceptionEvent = finished.events.find((e) => e.name === "exception");
      assert.ok(exceptionEvent);
      assert.equal(exceptionEvent.attributes?.["exception.type"], "Error");
    });
  });
});
