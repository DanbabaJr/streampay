/**
 * OpenTelemetry Distributed Tracing Core for StreamPay Indexer.
 *
 * Implements:
 * 1. Event Seam Span Links: Links ledger-delayed event ingestion back to the originating
 *    client/server transaction trace without parent-child timeline distortion.
 * 2. Downstream Push Trace Continuation: Injects W3C TraceContext into push notifications
 *    (webhooks) dispatched upon event ingestion.
 * 3. Tail-Sampling Tags: Error spans are tagged to guarantee zero dropped error traces.
 * 4. Privacy Line Enforcement: Stellar addresses truncated to 8-character prefixes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sanitizeAttributes, sanitizeError } from "./privacy.js";

export type SpanKind = "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";
export type SpanStatusCode = "UNSET" | "OK" | "ERROR";

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
}

export interface SpanLink {
  context: SpanContext;
  attributes?: Record<string, string | number | boolean>;
}

export interface SpanEvent {
  name: string;
  timeEpochMs: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface ReadableSpan {
  name: string;
  kind: SpanKind;
  context: SpanContext;
  parentSpanId?: string;
  startTimeEpochMs: number;
  endTimeEpochMs?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  links: SpanLink[];
  resource: Record<string, string>;
}

export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class W3CTraceContextPropagator {
  static parseTraceParent(headerValue?: string | null): SpanContext | null {
    if (!headerValue) return null;
    const match = headerValue.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
    if (!match) return null;

    const traceId = match[1].toLowerCase();
    const spanId = match[2].toLowerCase();
    const traceFlags = parseInt(match[3], 16);

    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
    return { traceId, spanId, traceFlags };
  }

  static formatTraceParent(context: SpanContext): string {
    const flags = context.traceFlags.toString(16).padStart(2, "0");
    return `00-${context.traceId}-${context.spanId}-${flags}`;
  }

  static inject(context: SpanContext, carrier: Record<string, string>): void {
    carrier["traceparent"] = this.formatTraceParent(context);
    if (context.traceState) {
      carrier["tracestate"] = context.traceState;
    }
  }

  static extract(carrier: Record<string, string | string[] | undefined>): SpanContext | null {
    const rawTp = carrier["traceparent"] || carrier["TRACEPARENT"];
    const tp = Array.isArray(rawTp) ? rawTp[0] : rawTp;
    const rawTs = carrier["tracestate"] || carrier["TRACESTATE"];
    const ts = Array.isArray(rawTs) ? rawTs[0] : rawTs;

    const ctx = this.parseTraceParent(tp);
    if (ctx && ts) ctx.traceState = ts;
    return ctx;
  }
}

export class Span {
  public readonly context: SpanContext;
  public readonly parentSpanId?: string;
  public readonly name: string;
  public readonly kind: SpanKind;
  public readonly startTimeEpochMs: number;
  public endTimeEpochMs?: number;
  public status: SpanStatus = { code: "UNSET" };
  public readonly attributes: Record<string, string | number | boolean> = {};
  public readonly events: SpanEvent[] = [];
  public readonly links: SpanLink[] = [];
  private readonly tracer: Tracer;

  constructor(
    tracer: Tracer,
    name: string,
    context: SpanContext,
    parentSpanId?: string,
    kind: SpanKind = "INTERNAL",
    attributes: Record<string, unknown> = {}
  ) {
    this.tracer = tracer;
    this.name = name;
    this.context = context;
    this.parentSpanId = parentSpanId;
    this.kind = kind;
    this.startTimeEpochMs = Date.now();
    this.setAttributes(attributes);
  }

  setAttribute(key: string, value: unknown): this {
    const sanitized = sanitizeAttributes({ [key]: value });
    Object.assign(this.attributes, sanitized);
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    const sanitized = sanitizeAttributes(attributes);
    Object.assign(this.attributes, sanitized);
    return this;
  }

  addEvent(name: string, attributes: Record<string, unknown> = {}): this {
    this.events.push({
      name,
      timeEpochMs: Date.now(),
      attributes: sanitizeAttributes(attributes),
    });
    return this;
  }

  addLink(link: SpanLink): this {
    this.links.push({
      context: link.context,
      attributes: link.attributes ? sanitizeAttributes(link.attributes) : undefined,
    });
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    this.status = { code, message };
    if (code === "ERROR") {
      this.attributes["error"] = true;
      if (message) {
        this.attributes["error.message"] = sanitizeError(message);
      }
    }
    return this;
  }

  recordException(err: unknown): this {
    this.setStatus("ERROR", err instanceof Error ? err.message : String(err));
    this.addEvent("exception", {
      "exception.type": err instanceof Error ? err.name : typeof err,
      "exception.message": sanitizeError(err),
      "exception.stacktrace": err instanceof Error && err.stack ? sanitizeError(err.stack) : "",
    });
    return this;
  }

  end(): void {
    if (this.endTimeEpochMs) return;
    this.endTimeEpochMs = Date.now();
    this.tracer.recordSpanEnd(this);
  }

  toReadableSpan(): ReadableSpan {
    return {
      name: this.name,
      kind: this.kind,
      context: { ...this.context },
      parentSpanId: this.parentSpanId,
      startTimeEpochMs: this.startTimeEpochMs,
      endTimeEpochMs: this.endTimeEpochMs,
      durationMs: (this.endTimeEpochMs ?? Date.now()) - this.startTimeEpochMs,
      status: { ...this.status },
      attributes: { ...this.attributes },
      events: [...this.events],
      links: [...this.links],
      resource: { ...this.tracer.resource },
    };
  }
}

export interface SpanExporter {
  export(spans: ReadableSpan[]): Promise<void> | void;
}

export class InMemorySpanExporter implements SpanExporter {
  public spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[]): void {
    this.spans.push(...spans);
  }

  getFinishedSpans(): ReadableSpan[] {
    return this.spans;
  }

  reset(): void {
    this.spans = [];
  }
}

export function spanKindToOtlp(kind: SpanKind): number {
  switch (kind) {
    case "INTERNAL":
      return 1;
    case "SERVER":
      return 2;
    case "CLIENT":
      return 3;
    case "PRODUCER":
      return 4;
    case "CONSUMER":
      return 5;
    default:
      return 1;
  }
}

export class OtlpHttpSpanExporter implements SpanExporter {
  private endpoint: string;

  constructor(endpoint?: string) {
    const raw = endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
    this.endpoint = raw.endsWith("/v1/traces") ? raw : `${raw.replace(/\/$/, "")}/v1/traces`;
  }

  async export(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: Object.entries(spans[0]?.resource || {}).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) },
            })),
          },
          scopeSpans: [
            {
              scope: { name: "streampay-indexer", version: "0.1.0" },
              spans: spans.map((s) => ({
                traceId: s.context.traceId,
                spanId: s.context.spanId,
                parentSpanId: s.parentSpanId || "",
                name: s.name,
                kind: spanKindToOtlp(s.kind),
                startTimeUnixNano: String(BigInt(s.startTimeEpochMs) * 1_000_000n),
                endTimeUnixNano: String(BigInt(s.endTimeEpochMs || s.startTimeEpochMs) * 1_000_000n),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: typeof value === "boolean"
                    ? { boolValue: value }
                    : typeof value === "number"
                    ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
                    : { stringValue: String(value) },
                })),
                status: {
                  code: s.status.code === "OK" ? 1 : s.status.code === "ERROR" ? 2 : 0,
                  message: s.status.message || "",
                },
                links: s.links.map((link) => ({
                  traceId: link.context.traceId,
                  spanId: link.context.spanId,
                  attributes: link.attributes
                    ? Object.entries(link.attributes).map(([k, v]) => ({
                        key: k,
                        value: { stringValue: String(v) },
                      }))
                    : [],
                })),
              })),
            },
          ],
        },
      ],
    };

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch {
      // Non-blocking telemetry
    }
  }
}

export class Tracer {
  public readonly serviceName: string;
  public readonly resource: Record<string, string>;
  private readonly exporters: SpanExporter[] = [];
  private readonly asyncLocalStorage = new AsyncLocalStorage<Span>();

  constructor(options: { serviceName: string; exporters?: SpanExporter[]; resource?: Record<string, string> }) {
    this.serviceName = options.serviceName;
    this.resource = {
      "service.name": options.serviceName,
      "service.version": "0.1.0",
      ...options.resource,
    };
    if (options.exporters) this.exporters.push(...options.exporters);
  }

  addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  getActiveSpan(): Span | undefined {
    return this.asyncLocalStorage.getStore();
  }

  startSpan(
    name: string,
    options: {
      parent?: SpanContext | Span | null;
      kind?: SpanKind;
      attributes?: Record<string, unknown>;
      links?: SpanLink[];
    } = {}
  ): Span {
    let parentCtx: SpanContext | null = null;
    let parentSpanId: string | undefined = undefined;

    if (options.parent instanceof Span) {
      parentCtx = options.parent.context;
      parentSpanId = options.parent.context.spanId;
    } else if (options.parent) {
      parentCtx = options.parent;
      parentSpanId = options.parent.spanId;
    } else {
      const active = this.getActiveSpan();
      if (active) {
        parentCtx = active.context;
        parentSpanId = active.context.spanId;
      }
    }

    const traceId = parentCtx ? parentCtx.traceId : generateTraceId();
    const spanId = generateSpanId();
    const traceFlags = parentCtx ? parentCtx.traceFlags : 1;

    const context: SpanContext = { traceId, spanId, traceFlags, traceState: parentCtx?.traceState };
    const span = new Span(this, name, context, parentSpanId, options.kind, options.attributes);

    if (options.links) {
      for (const link of options.links) {
        span.addLink(link);
      }
    }

    return span;
  }

  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options: {
      parent?: SpanContext | Span | null;
      kind?: SpanKind;
      attributes?: Record<string, unknown>;
      links?: SpanLink[];
    } = {}
  ): Promise<T> {
    const span = this.startSpan(name, options);
    return this.asyncLocalStorage.run(span, async () => {
      try {
        const result = await fn(span);
        if (span.status.code === "UNSET") span.setStatus("OK");
        return result;
      } catch (err) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  recordSpanEnd(span: Span): void {
    const readable = span.toReadableSpan();
    for (const exporter of this.exporters) {
      try {
        void exporter.export([readable]);
      } catch {}
    }
  }
}

/**
 * Cross-Process Event Seam Correlation Registry.
 *
 * Stores the originating trace context for transactions (keyed by transaction hash or stream ID),
 * allowing the asynchronous Indexer to look up originating trace context when events are
 * ingested from Soroban RPC and attach a SpanLink!
 */
export class TraceCorrelationRegistry {
  private correlations = new Map<string, { context: SpanContext; timestamp: number; streamId?: string }>();

  register(
    txHash: string,
    context: SpanContext,
    streamId?: string
  ): void {
    const cleanHash = txHash.trim().toLowerCase();
    this.correlations.set(cleanHash, {
      context: { ...context },
      timestamp: Date.now(),
      streamId,
    });

    if (streamId) {
      this.correlations.set(`stream:${streamId}`, {
        context: { ...context },
        timestamp: Date.now(),
        streamId,
      });
    }

    // Keep registry bounded (evict entries older than 30 minutes)
    if (this.correlations.size > 5000) {
      const cutoff = Date.now() - 1800000;
      for (const [k, v] of this.correlations.entries()) {
        if (v.timestamp < cutoff) this.correlations.delete(k);
      }
    }
  }

  get(txHash?: string | null): SpanContext | null {
    if (!txHash) return null;
    const entry = this.correlations.get(txHash.trim().toLowerCase());
    return entry ? entry.context : null;
  }

  getByStream(streamId?: string | number | null): SpanContext | null {
    if (!streamId) return null;
    const entry = this.correlations.get(`stream:${streamId}`);
    return entry ? entry.context : null;
  }

  clear(): void {
    this.correlations.clear();
  }
}

export const traceCorrelationRegistry = new TraceCorrelationRegistry();

export const globalIndexerTracer = new Tracer({
  serviceName: "streampay-indexer",
  exporters: [new OtlpHttpSpanExporter()],
});
