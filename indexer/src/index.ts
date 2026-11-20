import express from "express";
import { Keypair, Networks, nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent } from "./decoder.js";
import { generateStreamProof } from "./proof.js";
import { StreamStore } from "./store.js";
import { getGlobalRpcManager } from "./rpc-manager.js";
import type { EndpointHealth, RateBudgetSnapshot } from "./rpc-manager.js";
import { IngestPipeline, type EventsPage, type TickReport } from "./ingest/pipeline.js";
import type { SequencerMetrics } from "./ingest/sequencer.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { validateWebhookUrl } from "./webhooks/ssrf.js";
import { OutboxDispatcher } from "./outbox/dispatcher.js";
import { OutboxMetrics } from "./outbox/metrics.js";
import { httpPushTransport } from "./outbox/http-transport.js";
import { traceCorrelationRegistry } from "./telemetry.js";
import { createGracefulShutdown, installShutdownHandlers } from "./shutdown.js";
import { GrpcIndexerServer } from "./grpc/server.js";
import { registerGraphQLRoutes, type GraphQLHandlerOptions } from "./graphql/index.js";
import { WasmPluginHost } from "./wasm/host.js";
import { PluginDispatcher } from "./wasm/dispatcher.js";
import type { DecodedEvent, EventValue, Stream } from "./types.js";

function parseCursor(raw: unknown): number {
  const value = Number(raw ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function parseLimit(raw: unknown, def: number, max: number): number {
  const value = Number(raw ?? def);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : def;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Same as `envInt`, but 0 is a legitimate value. */
function envNonNegativeInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/** Ledger to index from on a fresh database; unset means "start at the tip". */
function configuredStartLedger(): number | undefined {
  const raw = process.env.START_LEDGER;
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("START_LEDGER must be an integer ledger sequence");
  return Number(raw) > 0 ? Number(raw) : undefined;
}

/** What the ingestion pipelines report on `/health` and `/api/ingest/stats`. */
export interface IngestStats {
  lastTick: TickReport | null;
  sequencer: SequencerMetrics;
  budget: RateBudgetSnapshot;
}

/**
 * Signing material for `/streams/:id/proof` (issue #182). The proof endpoint is
 * only meaningful with a checkpoint signer, so it is supplied by `run()` from
 * the environment and left out of `createApp` calls from tests — an unconfigured
 * app answers 503 on that route instead of failing to boot.
 */
export interface ProofConfig {
  networkPassphrase: string;
  contractId: string;
  signer: Keypair;
}

/**
 * WASM plugin dispatch for the HTTP API (issue #580). When absent, no
 * `/api/wasm/*` routes exist and SSE behaves exactly as before.
 */
export interface WasmOptions {
  dispatcher: PluginDispatcher;
}

export function createApp(
  store: StreamStore,
  dispatcher?: WebhookDispatcher,
  outboxDispatcher?: OutboxDispatcher,
  outboxMetrics?: OutboxMetrics,
  rpcHealth?: () => EndpointHealth[],
  ingestStats?: () => IngestStats,
  proofConfig?: ProofConfig,
  graphqlOptions?: GraphQLHandlerOptions,
  wasmOptions?: WasmOptions,
): express.Express {
  const app = express();
  app.use(express.json());

  // GraphQL read API over the same projections (#576). REST routes below
  // are unchanged; GraphQL is an additional read surface only.
  registerGraphQLRoutes(app, store, graphqlOptions);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      status: "ok",
      lastLedger: store.getState("lastLedger") ?? null,
      cursor: store.getState("cursor") ?? null,
      ingest: ingestStats?.() ?? null,
      rpcEndpoints: rpcHealth?.() ?? [],
      checkpointSigner: proofConfig?.signer.publicKey() ?? null,
    });
  });

  // GET /events/stream (SSE push endpoint)
  app.get("/events/stream", (req, res) => {
    const address = req.query.address as string | undefined;
    const streamId = req.query.streamId as string | undefined;
    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? (req.query.lastEventId as string | undefined);

    if (address && !/^[GCB][A-Z2-7]{55}$/.test(address)) {
      return res.status(400).json({ error: "invalid Stellar address" });
    }
    if (streamId && !/^\d+$/.test(streamId)) {
      return res.status(400).json({ error: "stream id must be an unsigned integer" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    // Initial keepalive greeting
    res.write(": ok\n\n");

    const formatSse = (evt: {
      id: string;
      /** Null for an event the registry decoded without a stream id binding. */
      streamId: string | null;
      name: string;
      ledger: number;
      ledgerClosedAt: string;
      payload: Record<string, unknown>;
      stream?: unknown;
    }): string => {
      const data = JSON.stringify({
        id: evt.id,
        streamId: evt.streamId,
        eventType: evt.name,
        ledger: evt.ledger,
        ledgerClosedAt: evt.ledgerClosedAt,
        data: evt.payload,
        stream: evt.stream,
      });
      return `id: ${evt.id}\nevent: ${evt.name}\ndata: ${data}\n\n`;
    };

    // Heartbeat ping every 15 seconds to prevent reverse proxy/load-balancer timeouts
    const pingInterval = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    // WASM plugin dispatch (#580): opt-in per connection with
    // `?tenant=<tenant>&plugin=<digest>`. When both are present (and a
    // dispatcher was configured), live *and* replayed events for this
    // connection run through the tenant's approved plugin — in order, via
    // a promise chain, with live events that arrive during the replay
    // buffered rather than reordered. Dropped events are not written;
    // a failed plugin falls back to the raw (redacted) event. Without
    // those query params the path below is the historical behaviour.
    const wasmTenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
    const wasmDigest = typeof req.query.plugin === "string" ? req.query.plugin : undefined;
    const wasm =
      wasmOptions && wasmTenant && wasmDigest
        ? { dispatcher: wasmOptions.dispatcher, tenant: wasmTenant, pluginDigest: wasmDigest }
        : undefined;

    let onLiveEvent: ((event: DecodedEvent, stream?: Stream) => void) | undefined;

    if (wasm) {
      const subscriptionId = `sse:${streamId ?? address ?? "all"}:${wasm.tenant}`;
      wasm.dispatcher.subscribe(subscriptionId, wasm.tenant, wasm.pluginDigest);
      // Serialise dispatch so one connection's events keep journal order
      // even though each transform runs in its own worker thread.
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>): void => {
        chain = chain.then(async () => {
          try {
            await fn();
          } catch (err) {
            console.error("[wasm] SSE dispatch failed:", err);
          }
        });
      };
      const dispatchAndWrite = async (event: DecodedEvent, stream?: Stream): Promise<void> => {
        if (streamId && event.streamId !== streamId) return;
        if (address && stream && stream.sender !== address && stream.recipient !== address) return;
        const result = await wasm.dispatcher.dispatch(event, subscriptionId);
        if (!result.event) return; // dropped by the plugin
        res.write(
          formatSse({
            id: result.event.id,
            streamId: result.event.streamId,
            name: result.event.name,
            ledger: result.event.ledger,
            ledgerClosedAt: result.event.ledgerClosedAt,
            payload: result.event.data as Record<string, unknown>,
            stream,
          }),
        );
      };
      let replayDone = false;
      const pending: Array<{ event: DecodedEvent; stream?: Stream }> = [];
      onLiveEvent = (event, stream) => {
        if (!replayDone) {
          pending.push({ event, stream });
          return;
        }
        enqueue(() => dispatchAndWrite(event, stream));
      };
      store.on("event", onLiveEvent);
      void (async () => {
        if (lastEventId) {
          const historical = store.getEventsAfter(lastEventId, address, streamId);
          for (const evt of historical) {
            await dispatchAndWrite(
              {
                id: evt.id,
                pagingToken: evt.id,
                ledger: evt.ledger,
                ledgerClosedAt: evt.ledgerClosedAt,
                contractId: "",
                name: evt.name,
                streamId: evt.streamId,
                data: evt.payload as Record<string, EventValue>,
              },
              evt.stream,
            );
          }
        }
        replayDone = true;
        for (const item of pending.splice(0)) {
          enqueue(() => dispatchAndWrite(item.event, item.stream));
        }
      })();
      req.on("close", () => {
        clearInterval(pingInterval);
        if (onLiveEvent) store.off("event", onLiveEvent);
        wasm.dispatcher.unsubscribe(subscriptionId);
        res.end();
      });
      return;
    }

    // Replay historical events if lastEventId was supplied
    if (lastEventId) {
      const historical = store.getEventsAfter(lastEventId, address, streamId);
      for (const evt of historical) {
        res.write(formatSse(evt));
      }
    }

    // Subscribe to live events
    onLiveEvent = (event: DecodedEvent, stream?: Stream) => {
      if (streamId && event.streamId !== streamId) {
        return;
      }
      if (address && stream && stream.sender !== address && stream.recipient !== address) {
        return;
      }
      res.write(
        formatSse({
          id: event.id,
          streamId: event.streamId,
          name: event.name,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          payload: event.data as Record<string, unknown>,
          stream,
        }),
      );
    };

    store.on("event", onLiveEvent);

    req.on("close", () => {
      clearInterval(pingInterval);
      if (onLiveEvent) store.off("event", onLiveEvent);
      res.end();
    });
  });

  // Trace correlation endpoints for distributed tracing across the async event seam
  app.post("/api/traces/correlate", (req, res) => {
    const { txHash, traceContext, streamId } = req.body || {};
    if (!txHash || !traceContext?.traceId || !traceContext?.spanId) {
      return res.status(400).json({ error: "txHash, traceContext.traceId, and traceContext.spanId are required" });
    }
    traceCorrelationRegistry.register(String(txHash), traceContext, streamId ? String(streamId) : undefined);
    return res.status(200).json({ ok: true, txHash, streamId });
  });

  app.get("/api/traces/correlate", (req, res) => {
    const txHash = req.query.txHash as string | undefined;
    const streamId = req.query.streamId as string | undefined;
    const context = (txHash ? traceCorrelationRegistry.get(txHash) : null) || (streamId ? traceCorrelationRegistry.getByStream(streamId) : null);
    if (!context) {
      return res.status(404).json({ error: "correlation not found" });
    }
    return res.json({ ok: true, context });
  });

  // Full ingestion accounting for the parallel ingester (issue #117): the depth
  // the budget allowed, how deep the reorder buffer actually got, and the
  // late/duplicate/gap counters that tell an operator whether the ordering
  // guards are being exercised in production.
  app.get("/api/ingest/stats", (_req, res) => {
    const stats = ingestStats?.();
    return stats ? res.json(stats) : res.status(503).json({ error: "ingestion not running" });
  });

  // GET /streams?recipient=<address>
  app.get("/streams", (req, res) => {
    const recipient = req.query.recipient as string | undefined;
    if (!recipient) {
      return res.json([]);
    }
    const streams = store.listStreamsByRecipient(recipient);
    return res.json(streams);
  });

  // GET /streams/:id/history
  app.get("/streams/:id/history", (req, res) => {
    const streamId = req.params.id;
    if (!streamId) {
      return res.json([]);
    }
    const history = store.getStreamHistory(streamId);
    return res.json(history);
  });

  // GET /streams/:id
  app.get("/streams/:id", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const stream = store.getStream(req.params.id);
    return stream ? res.json(stream) : res.status(404).json({ error: "stream not found" });
  });

  // GET /streams/:id/proof — light-client checkpoint proof (#182). The indexer
  // hashes every stream it has projected into a Merkle state root and signs the
  // checkpoint, so a client can verify one stream's state against the signed root
  // instead of trusting this endpoint's word for it. `streamToProofEntry` builds
  // the canonical ledger-entry XDR, so the leaf the client re-hashes is the leaf
  // the chain would have produced.
  app.get("/streams/:id/proof", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    if (!proofConfig) return res.status(503).json({ error: "proof endpoint is not configured: set CHECKPOINT_SIGNER_SECRET" });
    const stream = store.getStream(req.params.id);
    if (!stream) return res.status(404).json({ error: "stream not found" });
    const ledger = Number(store.getState("lastLedger") ?? stream.lastLedger);
    const ledgerCloseTime = Math.floor(new Date(stream.updatedAt).getTime() / 1000) || Math.floor(Date.now() / 1000);
    const proof = generateStreamProof({
      networkPassphrase: proofConfig.networkPassphrase,
      contractId: proofConfig.contractId,
      ledger,
      ledgerCloseTime,
      streams: store.listAllStreams(),
      targetStreamId: req.params.id,
      signer: proofConfig.signer,
    });
    return res.json(proof);
  });

  // GET /streams/:id/events?after=<seq>&limit=<n> — transactional-outbox replay.
  // Consumers replay from their last durable cursor; duplicates (at-least-once
  // transport) are detectable via the per-row idempotency_key and seq ordering.
  app.get("/streams/:id/events", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const after = parseCursor(req.query.after);
    if (after < 0) return res.status(400).json({ error: "after must be a non-negative integer cursor" });
    const limit = parseLimit(req.query.limit, 100, 1000);
    return res.json(store.outbox.replayEvents(req.params.id, after, limit));
  });

  // ---------- outbox management API ----------

  app.get("/api/outbox/consumers", (_req, res) => res.json(store.outbox.listConsumers()));

  app.post("/api/outbox/consumers", async (req, res) => {
    const { id, kind, url, secret, max_attempts: maxAttempts, rate_limit_per_sec: rateLimit } = req.body || {};
    if (kind !== "push" && kind !== "pull") return res.status(400).json({ error: "kind must be push or pull" });
    if (kind === "push") {
      if (!url || typeof url !== "string") return res.status(400).json({ error: "push consumers require a url" });
      const ssrf = await validateWebhookUrl(url);
      if (!ssrf.safe) return res.status(400).json({ error: `SSRF validation failed: ${ssrf.reason}` });
    }
    try {
      const consumer = store.outbox.createConsumer({
        id: typeof id === "string" ? id : undefined,
        kind,
        url: typeof url === "string" ? url : null,
        secret: typeof secret === "string" ? secret : null,
        max_attempts: typeof maxAttempts === "number" ? maxAttempts : undefined,
        rate_limit_per_sec: typeof rateLimit === "number" && rateLimit > 0 ? rateLimit : null,
      });
      return res.status(201).json(consumer);
    } catch (err: unknown) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/outbox/consumers/:id", (req, res) => {
    const consumer = store.outbox.getConsumer(req.params.id);
    return consumer ? res.json(consumer) : res.status(404).json({ error: "consumer not found" });
  });

  app.post("/api/outbox/consumers/:id/status", (req, res) => {
    const status = req.body?.status;
    if (status !== "active" && status !== "disabled") return res.status(400).json({ error: "status must be active or disabled" });
    const ok = store.outbox.setConsumerStatus(req.params.id, status);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "consumer not found" });
  });

  app.delete("/api/outbox/consumers/:id", (req, res) => {
    const deleted = store.outbox.deleteConsumer(req.params.id);
    return deleted ? res.json({ ok: true }) : res.status(404).json({ error: "consumer not found" });
  });

  app.get("/api/outbox/intents", (req, res) => {
    const state = req.query.state as string | undefined;
    if (state && !["pending", "in_flight", "delivered", "dead"].includes(state)) {
      return res.status(400).json({ error: "invalid state filter" });
    }
    const limit = parseLimit(req.query.limit, 50, 500);
    return res.json(store.outbox.listIntents({
      state: state as "pending" | undefined,
      consumerId: typeof req.query.consumer === "string" ? req.query.consumer : undefined,
      limit,
    }));
  });

  app.post("/api/outbox/intents/:id/replay", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "intent id must be a positive integer" });
    const replayed = store.outbox.replayIntent(id);
    return replayed ? res.json({ ok: true }) : res.status(404).json({ error: "dead-letter intent not found" });
  });

  // Reorg retraction hook, called by the dual-read reconciliation service when
  // the indexer journal diverges from on-chain truth above a ledger boundary.
  app.post("/api/outbox/retract", (req, res) => {
    const afterLedger = Number(req.body?.after_ledger);
    if (!Number.isInteger(afterLedger) || afterLedger < 0) return res.status(400).json({ error: "after_ledger must be a non-negative integer" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "reorg";
    const result = store.outbox.retractAfterLedger(afterLedger, reason);
    outboxMetrics?.observeRetract(result.events_retracted, result.intents_retracted);
    return res.json(result);
  });

  app.get("/api/outbox/stats", (_req, res) => res.json(store.outbox.stats()));

  app.post("/api/outbox/flush", async (_req, res) => {
    if (!outboxDispatcher) return res.status(503).json({ error: "outbox dispatcher not configured" });
    return res.json(await outboxDispatcher.tick());
  });

  // Prometheus text exposition on the indexer's own surface.
  app.get("/metrics", (_req, res) => {
    const body = outboxMetrics
      ? outboxMetrics.render(store.outbox.stats())
      : "# no outbox metrics configured\n";
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    return res.send(body);
  });

  // GET /address/:addr/streams
  app.get("/address/:addr/streams", (req, res) => {
    const address = req.params.addr;
    if (!/^[GCB][A-Z2-7]{55}$/.test(address)) return res.status(400).json({ error: "invalid Stellar address" });
    const streams = store.listAddress(address);
    return res.json({ address, count: streams.length, streams });
  });

  // Webhook management API
  app.get("/api/webhooks/endpoints", (_req, res) => {
    res.json(store.webhooks.listEndpoints());
  });

  app.post("/api/webhooks/endpoints", async (req, res) => {
    const { url, events, secret } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }
    const ssrf = await validateWebhookUrl(url);
    if (!ssrf.safe) {
      return res.status(400).json({ error: `SSRF validation failed: ${ssrf.reason}` });
    }
    const endpoint = store.webhooks.createEndpoint({
      url,
      events: Array.isArray(events) ? events : ["*"],
      secret: typeof secret === "string" ? secret : undefined,
    });
    return res.status(201).json(endpoint);
  });

  app.get("/api/webhooks/endpoints/:id", (req, res) => {
    const ep = store.webhooks.getEndpoint(req.params.id);
    if (!ep) return res.status(404).json({ error: "Endpoint not found" });
    return res.json(ep);
  });

  app.post("/api/webhooks/endpoints/:id/rotate-secret", (req, res) => {
    try {
      const result = store.webhooks.rotateEndpointSecret(req.params.id);
      return res.json(result);
    } catch (err: unknown) {
      return res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/webhooks/endpoints/:id", (req, res) => {
    const deleted = store.webhooks.deleteEndpoint(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Endpoint not found" });
    return res.json({ ok: true });
  });

  app.post("/api/webhooks/endpoints/:id/test", async (req, res) => {
    if (!dispatcher) {
      return res.status(500).json({ error: "Webhook dispatcher not configured" });
    }
    const result = await dispatcher.testFireEndpoint(req.params.id);
    return res.json(result);
  });

  app.get("/api/webhooks/deliveries", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    return res.json(store.webhooks.listDeliveries(limit));
  });

  app.get("/api/webhooks/dlq", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    return res.json(store.webhooks.listDLQ(limit));
  });

  app.post("/api/webhooks/dlq/:id/retry", (req, res) => {
    const success = store.webhooks.replayDLQItem(req.params.id);
    if (!success) return res.status(404).json({ error: "DLQ item not found" });
    return res.json({ ok: true, replayed: true });
  });

  // ---------- WASM plugin management API (#580) ----------
  // Only present when a dispatcher was configured. Plugins are registered
  // by content digest and must be approved per tenant before they can run;
  // see indexer/README.md ("WASM plugin filters") for the full flow.
  if (wasmOptions) {
    const { dispatcher: wasmDispatcher } = wasmOptions;
    const digestParam = (req: express.Request, res: express.Response): string | undefined => {
      const digest = req.params.digest;
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
        res.status(400).json({ error: "digest must be a lowercase hex sha256" });
        return undefined;
      }
      return digest;
    };

    app.get("/api/wasm/plugins", (_req, res) => res.json(store.wasm.listPlugins()));

    app.post("/api/wasm/plugins", (req, res) => {
      const { bytesBase64, version, name } = req.body || {};
      if (typeof bytesBase64 !== "string" || typeof version !== "string") {
        return res.status(400).json({ error: "bytesBase64 and version are required" });
      }
      try {
        const bytes = Buffer.from(bytesBase64, "base64");
        const record = store.wasm.register(bytes, version, typeof name === "string" ? name : undefined);
        return res.status(201).json({ digest: record.digest, version: record.version, name: record.name, size: record.bytes.length });
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post("/api/wasm/plugins/:digest/approve", (req, res) => {
      const digest = digestParam(req, res);
      if (!digest) return;
      const tenant = req.body?.tenant;
      if (typeof tenant !== "string" || !tenant) return res.status(400).json({ error: "tenant is required" });
      try {
        return res.json(store.wasm.approve(tenant, digest));
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post("/api/wasm/plugins/:digest/revoke", (req, res) => {
      const digest = digestParam(req, res);
      if (!digest) return;
      const tenant = req.body?.tenant;
      if (typeof tenant !== "string" || !tenant) return res.status(400).json({ error: "tenant is required" });
      return res.json({ ok: true, revoked: store.wasm.revoke(tenant, digest) });
    });

    app.post("/api/wasm/subscriptions", (req, res) => {
      const { subscriptionId, tenant, pluginDigest } = req.body || {};
      if (typeof subscriptionId !== "string" || typeof tenant !== "string" || typeof pluginDigest !== "string") {
        return res.status(400).json({ error: "subscriptionId, tenant and pluginDigest are required" });
      }
      try {
        wasmDispatcher.subscribe(subscriptionId, tenant, pluginDigest);
        return res.status(201).json({ subscriptionId, tenant, pluginDigest });
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.delete("/api/wasm/subscriptions/:id", (req, res) => {
      const id = req.params.id;
      if (typeof id !== "string") return res.status(400).json({ error: "subscription id must be a string" });
      return res.json({ ok: true, removed: wasmDispatcher.unsubscribe(id) });
    });

    app.get("/api/wasm/fallbacks", (_req, res) => {
      return res.json(wasmDispatcher.fallbackLog.slice(-100));
    });
  }

  return app;
}

export async function run(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
  const contractId = process.env.CONTRACT_ID;
  const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = process.env.DATABASE_PATH ?? "./data/streampay.sqlite";

  if (!contractId) throw new Error("CONTRACT_ID is required");
  if (!Number.isFinite(pollInterval) || pollInterval < 250) throw new Error("POLL_INTERVAL_MS must be at least 250");

  const store = new StreamStore(dbPath);

  // ── Checkpoint signer for `/streams/:id/proof` (#182) ──────────────────────
  // An ephemeral `Keypair.random()` keeps a throwaway indexer running, but its
  // signatures die with the process and a client cannot pin them, so a real
  // deploy must set CHECKPOINT_SIGNER_SECRET.
  const checkpointSigner = process.env.CHECKPOINT_SIGNER_SECRET
    ? Keypair.fromSecret(process.env.CHECKPOINT_SIGNER_SECRET)
    : Keypair.random();
  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;

  // ── RPC manager: shared across the indexer, replaces the ad-hoc fetch helper.
  // Additional endpoints can be added via RPC_URL_FALLBACK_1, RPC_URL_FALLBACK_2 env vars.
  const rpcEndpoints = [{ url: rpcUrl }];
  for (let i = 1; i <= 5; i++) {
    const extra = process.env[`RPC_URL_FALLBACK_${i}`];
    if (extra) rpcEndpoints.push({ url: extra });
  }
  const manager = getGlobalRpcManager({
    endpoints: rpcEndpoints,
    maxRps: Number(process.env.RPC_MAX_RPS ?? "10"),
    failureThreshold: 3,
    lagThresholdSeconds: 60,
    hedgeDelayMs: 300,
    healthCheckIntervalMs: 15_000,
    timeoutMs: 20_000,
  });

  const dispatcher = new WebhookDispatcher(store.webhooks);
  dispatcher.start();

  const outboxMetrics = new OutboxMetrics({
    alarmWindow: envInt("OUTBOX_ALARM_WINDOW", 8),
    alarmMinDepth: envInt("OUTBOX_ALARM_MIN_DEPTH", 1000),
  });
  const outboxDispatcher = new OutboxDispatcher(store.outbox, httpPushTransport, outboxMetrics, {
    tickMs: envInt("OUTBOX_TICK_MS", 1000),
    batchSize: Math.min(1000, envInt("OUTBOX_BATCH_SIZE", 200)),
    claimTimeoutMs: envInt("OUTBOX_CLAIM_TIMEOUT_MS", 60_000),
    maxDepth: process.env.OUTBOX_MAX_DEPTH ? envInt("OUTBOX_MAX_DEPTH", 1) : undefined,
  });
  outboxDispatcher.start();

  // ── WASM plugin filters (#580) ──────────────────────────────────────────
  // Plugins run sandboxed per subscription; a runaway plugin falls back to
  // the raw stream (see src/wasm/). Redaction of delivered events is opt-in
  // via WASM_REDACTION_ENABLED=1 and always runs after plugin transforms.
  const wasmHost = new WasmPluginHost({
    timeoutMs: Number(process.env.WASM_PLUGIN_TIMEOUT_MS ?? "500"),
  });
  const wasmDispatcher = new PluginDispatcher(store.wasm, wasmHost, {
    redactionEnabled: process.env.WASM_REDACTION_ENABLED === "1",
    onFallback: (alert) =>
      console.warn(
        `[wasm] fallback subscription=${alert.subscriptionId} event=${alert.eventId} reason=${alert.reason}`,
      ),
  });

  // `stream_refund_target_changed` (#204) is projected into `streams.refund_target`
  // by the store, so it has to be fetched for that column to ever be filled.
  // `batch_withdraw_summary` (#205) names no single stream — it is keyed by the
  // recipient and covers the whole `withdraw_many` call. The per-stream
  // `withdrawn` events the same call publishes remain the authoritative source
  // for the projections, so subscribing to the summary adds the batch record to
  // the journal without touching any row.
  const eventNames = [
    "stream_created",
    "withdrawn",
    "stream_cancelled",
    "stream_topped_up",
    "stream_paused",
    "stream_resumed",
    "stream_refund_target_changed",
    "batch_withdraw_summary",
  ];
  const topicFilters = eventNames.map((name) => [nativeToScVal(name, { type: "symbol" }).toXDR("base64")]);

  // ── Parallel ledger-window ingestion (issue #117) ──────────────────────────
  // Concurrency is not a constant here: the pipeline reads the same rate budget
  // the RPC manager enforces (issue #56/#100) and never plans more in-flight
  // requests than that budget can fund. INGEST_MAX_IN_FLIGHT only lowers the
  // ceiling, it cannot raise the budget.
  let lastTick: TickReport | undefined;
  const pipeline = new IngestPipeline({
    source: {
      getLatestLedger: () => manager.getLatestLedger(),
      getEvents: (params) => manager.getEvents(params) as Promise<EventsPage>,
      getRateBudget: () => manager.getRateBudget(),
    },
    sink: store,
    decode: (event) => decodeEvent(event, { contractId }),
    filters: [{ type: "contract", contractIds: [contractId], topics: topicFilters }],
    initialLedger: configuredStartLedger(),
    pageLimit: envInt("INGEST_PAGE_LIMIT", 1000),
    windowLedgers: envInt("INGEST_WINDOW_LEDGERS", 20),
    maxWindowLedgers: envInt("INGEST_MAX_WINDOW_LEDGERS", 5_000),
    maxWindowsPerTick: envInt("INGEST_MAX_WINDOWS_PER_TICK", 200),
    maxInFlight: envInt("INGEST_MAX_IN_FLIGHT", 8),
    confirmations: envNonNegativeInt("INGEST_CONFIRMATIONS", 0),
    maxPagesPerWindow: envInt("INGEST_MAX_PAGES_PER_WINDOW", 8),
    parallel: process.env.INGEST_PARALLEL !== "0",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const app = createApp(
    store,
    dispatcher,
    outboxDispatcher,
    outboxMetrics,
    () => manager.getHealth(),
    () => ({
      lastTick: lastTick ?? null,
      sequencer: pipeline.metrics(),
      budget: manager.getRateBudget(),
    }),
    { networkPassphrase, contractId, signer: checkpointSigner },
    undefined,
    { dispatcher: wasmDispatcher },
  );

  async function poll(): Promise<void> {
    lastTick = await pipeline.runTick();
    if (!lastTick.ok) throw new Error(`ingest tick failed: ${lastTick.error ?? "unknown error"}`);
    if (!lastTick.caughtUp) {
      console.warn(`[indexer] tick stopped at ledger ${lastTick.resumeAt ?? "?"} with a lagging endpoint or dense window; resuming next tick`);
    }
  }

  const server = app.listen(port, () => console.log(`StreamPay indexer listening on http://localhost:${port}`));

  // gRPC streaming transport (issue #579): server-streaming Subscribe on
  // node:http2, alongside REST/SSE. Disabled with GRPC_PORT=0.
  const grpcPort = Number(process.env.GRPC_PORT ?? 8788);
  let grpcServer: GrpcIndexerServer | undefined;
  if (grpcPort > 0) {
    grpcServer = new GrpcIndexerServer(store, {
      port: grpcPort,
      maxSubscriptionsPerTenant: envInt("GRPC_MAX_SUBSCRIPTIONS_PER_TENANT", 5),
      maxEventsPerSecondPerTenant: envInt("GRPC_MAX_EVENTS_PER_SECOND_PER_TENANT", 100),
      maxQueuePerSubscription: envInt("GRPC_MAX_QUEUE_PER_SUBSCRIPTION", 100),
    });
    const actualGrpcPort = await grpcServer.listen(grpcPort);
    console.log(`StreamPay indexer gRPC listening on http://localhost:${actualGrpcPort} (streampay.indexer.v1.StreamPayIndexer/Subscribe)`);
  }
  let inFlightPoll: Promise<void> | null = null;
  let shuttingDown = false;

  async function pollSafely(): Promise<void> {
    if (inFlightPoll || shuttingDown) return;
    inFlightPoll = (async () => {
      try {
        await poll();
      } catch (error) {
        console.error("Indexer poll failed:", error);
      }
    })();
    try {
      await inFlightPoll;
    } finally {
      inFlightPoll = null;
    }
  }

  void pollSafely();
  const pollTimer = setInterval(() => void pollSafely(), pollInterval);

  // SIGTERM/SIGINT: drain in-flight ingest and outbox dispatch, bounded by
  // SHUTDOWN_DRAIN_MS, before closing the store (see ./shutdown.ts).
  const shutdown = createGracefulShutdown({
    drainMs: envInt("SHUTDOWN_DRAIN_MS", 10_000),
    stopAccepting: () => {
      shuttingDown = true;
      clearInterval(pollTimer);
      server.close();
      // SSE streams never end on their own; without this `close()` would wait forever.
      server.closeAllConnections();
      void grpcServer?.close();
    },
    pipeline,
    inFlightIngest: () => inFlightPoll,
    outbox: outboxDispatcher,
    webhooks: dispatcher,
    store,
    exit: (code) => process.exit(code),
    log: (message) => console.warn(message),
  });
  installShutdownHandlers(process, ["SIGINT", "SIGTERM"], shutdown);
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"))) {
  void run();
}
