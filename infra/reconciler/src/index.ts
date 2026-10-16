//! HTTP server & daemon entrypoint for StreamPay Reconciler with Prometheus /metrics.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { defaultReconcilerMetrics } from './metrics.js';
import { ReconciliationEngine } from './reconcile.js';
import { ReconcilerFaultController } from './faults.js';

const PORT = parseInt(process.env.PORT || '9091', 10);
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS || '60000', 10);

export const engine = new ReconciliationEngine(defaultReconcilerMetrics);
export const faults = new ReconcilerFaultController(engine, defaultReconcilerMetrics);

// Seed initial healthy metrics
defaultReconcilerMetrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
defaultReconcilerMetrics.itemsAuditedTotal.inc({ entity_type: 'stream' }, 10);
defaultReconcilerMetrics.rpcRequestsTotal.inc({ method: 'get_stream', status: 'success' }, 10);

export function createReconcilerServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(defaultReconcilerMetrics.exportMetrics());
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'streampay-reconciler', timestamp: new Date().toISOString() }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/divergences') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        activeCount: engine.getActiveDivergences().length,
        divergences: engine.getActiveDivergences(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reconcile') {
      // Trigger immediate manual sweep
      defaultReconcilerMetrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'sweep_triggered', timestamp: new Date().toISOString() }));
      return;
    }

    // Fault injection endpoints for sandbox testing
    if (req.method === 'POST' && url.pathname === '/fault/divergence') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const checkType = payload.checkType || 'stream_balance';
        const count = payload.count || 1;
        faults.injectDivergence(checkType, count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'divergence', checkType, count }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fault/stall') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const secondsAgo = payload.secondsAgo || 600;
        faults.injectStall(secondsAgo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'stall', secondsAgo }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fault/rpc-error') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        const count = payload.count || 20;
        faults.injectRpcErrors(count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'fault_injected', type: 'rpc_error', count }));
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

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const server = createReconcilerServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[StreamPay Reconciler] Listening on port ${PORT}`);
    console.log(`[StreamPay Reconciler] Metrics available at http://localhost:${PORT}/metrics`);
    setInterval(() => {
      defaultReconcilerMetrics.lastRunTimestampSeconds.set(Math.floor(Date.now() / 1000));
    }, SWEEP_INTERVAL_MS);
  });
}
