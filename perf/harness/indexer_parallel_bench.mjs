/**
 * Throughput benchmark for parallel ledger-window ingestion (issue #117).
 *
 * DECLARED SYNTHETIC. Nothing here touches a network and nothing is captured
 * from mainnet: `synthetic_archive.mjs` generates a deterministic StreamPay
 * event archive, and the Soroban endpoint is an in-process function that sleeps
 * for a configured latency before answering. What is real is everything the
 * indexer itself does — the production `RpcManager` (rate bucket, health,
 * latency EWMA), the production XDR decoder, the production SQLite store and
 * the production ingest pipeline. Read the numbers as "what the fetch strategy
 * costs at this latency", not as a mainnet measurement.
 *
 * Run: npm --prefix indexer run bench:ingest [-- --streams=2000 --latency=250]
 */

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { generateSyntheticArchive } from "./synthetic_archive.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INDEXER = path.join(REPO_ROOT, "indexer", "dist");

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
}
function argList(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3).split(",").map(Number);
}

const CONFIG = {
  streams: arg("streams", 1_500),
  span: arg("span", 150_000),
  latency: arg("latency", 250),
  maxRps: arg("max-rps", 50),
  pageLimit: arg("page-limit", 1_000),
  windowLedgers: arg("window-ledgers", 20),
  maxWindowLedgers: arg("max-window-ledgers", 20_000),
  maxWindowsPerTick: arg("max-windows-per-tick", 200),
  depths: argList("depths", [2, 4, 8]),
  seed: arg("seed", 20_261_017),
};

/**
 * The in-process stand-in for a Soroban RPC node.
 *
 * Serves `getEvents` exactly as the real endpoint does for a client that never
 * sends `endLedger`: results from `startLedger` (or a cursor) onward, at most
 * `limit` of them, with the node's own `latestLedger` on every page.
 */
function makeEndpoint(archive, { latencyMs }) {
  const ledgers = archive.events.map((event) => event.ledger);
  const lowerBound = (ledger) => {
    let lo = 0;
    let hi = ledgers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ledgers[mid] < ledger) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    requests: 0,
    url: `http://simulated/${latencyMs}ms`,
    async handle(body) {
      this.requests += 1;
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      const params = body.params ?? {};
      if (body.method === "getLatestLedger") {
        return { sequence: archive.tip, id: "simulated", protocolVersion: 22 };
      }
      if (body.method !== "getEvents") throw new Error(`simulated node: unsupported ${body.method}`);
      const pagination = params.pagination ?? {};
      const limit = pagination.limit ?? 1_000;
      // The indexer's own client sends the cursor alongside `startLedger`; a
      // stock Soroban client nests it in `pagination`. Accept either so this
      // stand-in cannot silently restart from the beginning and loop forever.
      const cursor = params.cursor ?? pagination.cursor;
      const start = cursor !== undefined && cursor !== null
        ? Number(cursor) + 1
        : lowerBound(Number(params.startLedger ?? 1));
      const events = archive.events.slice(start, start + limit);
      return {
        events,
        latestLedger: archive.tip,
        cursor: String(Math.max(0, start + events.length - 1)),
      };
    },
  };
}

function installFetch(endpoints) {
  const byUrl = new Map(endpoints.map((ep) => [ep.url, ep]));
  globalThis.fetch = async (url, init) => {
    const ep = byUrl.get(url);
    if (!ep) throw new TypeError(`fetch failed: ${url}`);
    const result = await ep.handle(JSON.parse(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Digest of everything ingestion is responsible for: journal + projection. */
function stateHash(store) {
  const hash = crypto.createHash("sha256");
  const events = store.db.prepare("SELECT id, stream_id, name, ledger FROM events ORDER BY ledger, id").all();
  const streams = store.db
    .prepare("SELECT * FROM streams ORDER BY stream_id")
    .all()
    .map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
  hash.update(JSON.stringify({ events, streams }));
  return { digest: hash.digest("hex").slice(0, 16), events: events.length, streams: streams.length };
}

/**
 * One catch-up of the whole archive, timed.
 *
 * `storeMs` is measured inside the sink, so the table can separate the cost of
 * writing SQLite rows from the cost of waiting for pages. `wallMs - storeMs` is
 * the fetch + decode side, which is what the fetch strategy changes.
 */
async function catchUp({ label, archive, decodeEvent, StreamStore, RpcManager, IngestPipeline, depth, parallel, maxRps, hedgeDelayMs }) {
  const latency = CONFIG.latency;
  const endpoints = hedgeDelayMs > 0
    ? [makeEndpoint(archive, { latencyMs: latency }), makeEndpoint(archive, { latencyMs: latency * 1.4 })]
    : [makeEndpoint(archive, { latencyMs: latency })];
  installFetch(endpoints);

  const manager = new RpcManager({
    endpoints: endpoints.map((ep) => ({ url: ep.url })),
    maxRps,
    failureThreshold: 3,
    lagThresholdSeconds: 60,
    hedgeDelayMs,
    healthCheckIntervalMs: 9_999_999,
    timeoutMs: 30_000,
  });

  const store = new StreamStore(":memory:");
  let storeMs = 0;
  const sink = {
    ingestPage(events, cursor, latestLedger) {
      const t = performance.now();
      const summary = store.ingestPage(events, cursor, latestLedger);
      storeMs += performance.now() - t;
      return summary;
    },
    getState: (key) => store.getState(key),
    setState: (key, value) => store.setState(key, value),
    maxLedgerByStream: () => store.maxLedgerByStream(),
  };

  const pipeline = new IngestPipeline({
    source: {
      getLatestLedger: () => manager.getLatestLedger(),
      getEvents: (params) => manager.getEvents(params),
      getRateBudget: () => manager.getRateBudget(),
    },
    sink,
    decode: decodeEvent,
    filters: [{ type: "contract", contractIds: [archive.events[0].contractId] }],
    initialLedger: archive.startLedger,
    pageLimit: CONFIG.pageLimit,
    windowLedgers: CONFIG.windowLedgers,
    maxWindowLedgers: CONFIG.maxWindowLedgers,
    maxWindowsPerTick: CONFIG.maxWindowsPerTick,
    maxInFlight: depth,
    parallel,
  });

  const wall = performance.now();
  let ticks = 0;
  let last;
  const totals = { requests: 0, eventsSeen: 0, eventsInserted: 0, duplicates: 0, lateEvents: 0, projectionSkips: 0, gaps: 0 };
  for (;;) {
    last = await pipeline.runTick();
    ticks += 1;
    totals.requests += last.requests;
    totals.eventsSeen += last.eventsSeen;
    totals.eventsInserted += last.eventsInserted;
    totals.duplicates += last.duplicates;
    totals.projectionSkips += last.projectionSkips;
    if (!last.ok) break;
    if (last.caughtUp) break;
    if (process.env.BENCH_DEBUG) {
      console.error(`  ${label}: tick ${ticks} at ${last.resumeAt}, ${last.requests} requests, depth ${last.depth}`);
    }
    if (ticks > 500) throw new Error("catch-up did not terminate");
  }
  const wallMs = performance.now() - wall;
  const state = stateHash(store);
  manager.stop();
  store.close();

  if (!last.ok) throw new Error(`tick failed: ${last.error}`);
  return {
    ...totals,
    ...state,
    ticks,
    wallMs,
    storeMs,
    depth: last.depth,
    windowLedgers: last.windowLedgers,
    networkMs: totals.requests * latency,
  };
}

async function main() {
  const { decodeEvent } = await import(pathToFileURL(path.join(INDEXER, "decoder.js")).href);
  const { StreamStore } = await import(pathToFileURL(path.join(INDEXER, "store.js")).href);
  const { RpcManager } = await import(pathToFileURL(path.join(INDEXER, "rpc-manager.js")).href);
  const { IngestPipeline } = await import(pathToFileURL(path.join(INDEXER, "ingest/pipeline.js")).href);

  const generated = performance.now();
  const archive = generateSyntheticArchive({ streamCount: CONFIG.streams, ledgerSpan: CONFIG.span, seed: CONFIG.seed });
  const generateMs = performance.now() - generated;
  console.log(
    `Synthetic archive: ${archive.events.length} events over ${CONFIG.span.toLocaleString()} ledgers ` +
      `(ledgers ${archive.startLedger}-${archive.tip}), generated in ${Math.round(generateMs)} ms, seed ${CONFIG.seed}.\n`
  );

  const scenarios = [
    { label: "serial cursor walk (before #117)", depth: 1, parallel: false, maxRps: CONFIG.maxRps, hedgeDelayMs: 0 },
    ...CONFIG.depths.map((d) => ({ label: `windowed depth ${d}`, depth: d, parallel: true, maxRps: CONFIG.maxRps, hedgeDelayMs: 0 })),
    {
      label: "windowed depth 8, budget-capped (maxRps 8)",
      depth: 8,
      parallel: true,
      maxRps: 8,
      hedgeDelayMs: 0,
    },
    {
      label: "windowed depth 8, hedged reads (2 endpoints)",
      depth: 8,
      parallel: true,
      maxRps: CONFIG.maxRps,
      hedgeDelayMs: 60,
    },
  ];

  const rows = [];
  let reference;
  for (const scenario of scenarios) {
    const run = await catchUp({ archive, decodeEvent, StreamStore, RpcManager, IngestPipeline, ...scenario });
    if (reference === undefined) reference = run;
    rows.push({ label: scenario.label, ...run });
    console.log(`  ${scenario.label}: ${Math.round(run.wallMs)} ms`);
  }

  const serial = rows[0];
  const table = [
    "| scenario | derived depth | window ledgers | requests | ticks | events | wall ms | network ms | store ms | events/s | vs serial |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => [
      r.label,
      r.depth,
      r.windowLedgers.toLocaleString("en-US"),
      r.requests,
      r.ticks,
      r.eventsSeen.toLocaleString("en-US"),
      Math.round(r.wallMs).toLocaleString("en-US"),
      Math.round(r.networkMs).toLocaleString("en-US"),
      Math.round(r.storeMs).toLocaleString("en-US"),
      Math.round(r.eventsSeen / (r.wallMs / 1000)).toLocaleString("en-US"),
      `${(serial.wallMs / r.wallMs).toFixed(2)}x`,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |")),
  ].join("\n");

  console.log(`\nConfig: latency ${CONFIG.latency} ms/request, pageLimit ${CONFIG.pageLimit}, maxWindowsPerTick ${CONFIG.maxWindowsPerTick}, maxRps ${CONFIG.maxRps}.\n`);
  console.log(table);

  const checks = [
    { label: "final state matches the serial cursor walk", ok: rows.every((r) => r.digest === reference.digest) },
    { label: "every event inserted exactly once", ok: rows.every((r) => r.eventsInserted + r.duplicates === r.eventsSeen && r.duplicates >= 0) },
    { label: "no projection rewinds were needed", ok: rows.every((r) => r.projectionSkips === 0) },
  ];
  console.log("\nEquivalence checks:");
  for (const check of checks) console.log(`  ${check.ok ? "PASS" : "FAIL"}: ${check.label}`);
  console.log(`\n  state digests: ${rows.map((r) => r.digest).join(", ")}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

await main();
