import express from "express";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent } from "./decoder.js";
import { StreamStore } from "./store.js";
import type { RpcEvent } from "./types.js";

const rpcUrl = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const contractId = process.env.CONTRACT_ID;
const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DATABASE_PATH ?? "./data/streampay.sqlite";
if (!contractId) throw new Error("CONTRACT_ID is required");
if (!Number.isFinite(pollInterval) || pollInterval < 250) throw new Error("POLL_INTERVAL_MS must be at least 250");

const store = new StreamStore(dbPath);
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, lastLedger: store.getState("lastLedger") ?? null }));
app.get("/streams/:id", (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
  const stream = store.getStream(req.params.id);
  return stream ? res.json(stream) : res.status(404).json({ error: "stream not found" });
});
app.get("/address/:addr/streams", (req, res) => {
  const address = req.params.addr;
  if (!/^[GCB][A-Z2-7]{55}$/.test(address)) return res.status(400).json({ error: "invalid Stellar address" });
  const streams = store.listAddress(address);
  return res.json({ address, count: streams.length, streams });
});

const eventNames = ["stream_created", "withdrawn", "stream_cancelled", "stream_topped_up", "stream_paused", "stream_resumed"];
const topicFilters = eventNames.map((name) => [nativeToScVal(name, { type: "symbol" }).toXDR("base64")]);
let rpcId = 0;
async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  if (!body.result) throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

interface EventsResult { events: RpcEvent[]; cursor: string; latestLedger: number; }
async function poll(): Promise<void> {
  let cursor = store.getState("cursor");
  let startLedger: number | undefined;
  if (!cursor) {
    const configured = process.env.START_LEDGER;
    if (configured && !/^\d+$/.test(configured)) throw new Error("START_LEDGER must be an integer ledger sequence");
    startLedger = configured ? Number(configured) : (await rpc<{ sequence: number }>("getLatestLedger", {})).sequence;
  }
  for (;;) {
    const params = {
      ...(cursor ? { cursor } : { startLedger }),
      filters: [{ type: "contract", contractIds: [contractId], topics: topicFilters }],
      pagination: { limit: 1000 },
      xdrFormat: "base64",
    };
    const page = await rpc<EventsResult>("getEvents", params);
    const nextCursor = page.cursor || cursor;
    store.ingestPage(page.events.map(decodeEvent), nextCursor, page.latestLedger);
    cursor = nextCursor;
    if (page.events.length < 1000 || !cursor) break;
  }
}

app.listen(port, () => console.log(`StreamPay indexer listening on http://localhost:${port}`));
let polling = false;
async function pollSafely(): Promise<void> {
  if (polling) return;
  polling = true;
  try { await poll(); }
  catch (error) { console.error("Indexer poll failed:", error); }
  finally { polling = false; }
}
void pollSafely();
setInterval(() => void pollSafely(), pollInterval);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { store.close(); process.exit(0); });
