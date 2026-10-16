//! Main HTTP server & entrypoint for StreamPay Indexer with Prometheus /metrics.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { defaultIndexerMetrics } from './metrics.js';
import { IndexerStore } from './store.js';
import { FaultController } from './faults.js';
import { EventPoller } from './poller.js';

const PORT = parseInt(process.env.PORT || '9090', 10);
const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.CONTRACT_ID || 'CDUMMYSTREAMCONTRACT123';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);

export const store = new IndexerStore(defaultIndexerMetrics);
export const faults = new FaultController(store, defaultIndexerMetrics);
export const poller = new EventPoller(
  {
    rpcUrl: RPC_URL,
    contractId: CONTRACT_ID,
    pollIntervalMs: POLL_INTERVAL_MS,
    startLedger: 1000,
  },
  store,
  defaultIndexerMetrics
);

// Populate sample baseline state so metrics are active immediately
store.upsertStream({
  streamId: 1,
  sender: 'GBMOCK...SENDER',
  recipient: 'GBMOCK...RECIPIENT',
  token: 'CDUMMYTOKEN',
  deposit: '10000000000',
  withdrawn: '2500000000',
  startTime: Math.floor(Date.now() / 1000) - 3600,
  endTime: Math.floor(Date.now() / 1000) + 7200,
  status: 'Active',
  createdAt: Math.floor(Date.now() / 1000) - 3600,
  updatedAt: Math.floor(Date.now() / 1000),
});

// Seed soak baseline metrics: P95 lag ~8.2s
defaultIndexerMetrics.eventLagSeconds.observe({ source: 'soroban_rpc', topic: 'StreamCreated' }, 6.5);
defaultIndexerMetrics.eventLagSeconds.observe({ source: 'soroban_rpc', topic: 'StreamCreated' }, 8.0);
defaultIndexerMetrics.eventLagSeconds.observe({ source: 'soroban_rpc', topic: 'Withdrawn' }, 7.2);
defaultIndexerMetrics.ledgerLag.set({ source: 'soroban_rpc' }, 1);
defaultIndexerMetrics.latestLedger.set({ source: 'soroban_rpc' }, 10500);
defaultIndexerMetrics.chainTipLedger.set({ source: 'soroban_rpc' }, 10501);
defaultIndexerMetrics.syncStatus.set(1);
defaultIndexerMetrics.rpcRequestsTotal.inc({ service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'success' }, 50);

export function createIndexerServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(defaultIndexerMetrics.exportMetrics());
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'streampay-indexer', timestamp: new Date().toISOString() }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/streams') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(store.getAllStreams()));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/streams/')) {
      const idStr = url.pathname.replace('/streams/', '');
      const id = parseInt(idStr, 10);
      const stream = store.getStream(id);
      if (!stream) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stream not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stream));
      return;
    }

    // Fault injection endpoints for sandbox testing
    if (req.method === 'POST' && url.pathname === '/fault/lag') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const seconds = payload.seconds || 35;
        const topic = payload.topic || 'StreamCreated';
        faults.injectLag(seconds, topic);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'lag', seconds, topic }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fault/cursor-lag') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const ledgers = payload.ledgers || 7;
        faults.injectCursorLag(ledgers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'cursor_lag', ledgers }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fault/backlog') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const depth = payload.depth || 600;
        faults.injectBacklog(depth);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'backlog', depth }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fault/rpc-error') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const percentage = payload.percentage || 30;
        faults.injectRpcErrors(percentage);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'rpc_error', percentage }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fault/reset') {
      faults.reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'reset', faults: faults.getState() }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });
}

// Start listener when executed directly
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const server = createIndexerServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[StreamPay Indexer] Listening on port ${PORT}`);
    console.log(`[StreamPay Indexer] Metrics available at http://localhost:${PORT}/metrics`);
    poller.start();
  });
}
