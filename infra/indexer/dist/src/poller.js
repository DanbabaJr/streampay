//! Compiled ESM poller for indexer

import { defaultIndexerMetrics } from './metrics.js';

export class EventPoller {
  constructor(config, store, metrics = defaultIndexerMetrics) {
    this.config = config;
    this.store = store;
    this.metrics = metrics;
    this.currentLedger = config.startLedger;
    this.running = false;
    this.timer = null;
  }

  async pollOnce(mockEvents) {
    try {
      this.metrics.rpcRequestsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'attempt' },
        1
      );

      const events = mockEvents ?? [];
      const tipLedger = Math.max(this.currentLedger + 1, events.length > 0 ? events[events.length - 1].ledger : this.currentLedger);
      const lagLedgers = Math.max(0, tipLedger - this.currentLedger);

      this.metrics.ledgerLag.set({ source: 'soroban_rpc' }, lagLedgers);
      this.metrics.latestLedger.set({ source: 'soroban_rpc' }, this.currentLedger);
      this.metrics.chainTipLedger.set({ source: 'soroban_rpc' }, tipLedger);
      this.metrics.syncStatus.set(lagLedgers > 5 ? 0 : 1);

      const nowSeconds = Math.floor(Date.now() / 1000);

      for (const ev of events) {
        const eventLag = Math.max(0, nowSeconds - ev.ledgerTimestamp);
        this.metrics.eventLagSeconds.observe(
          { source: 'soroban_rpc', topic: ev.topic },
          eventLag
        );

        this.store.enqueueEvent({
          streamId: 1,
          topic: ev.topic,
          data: ev.data,
          ledger: ev.ledger,
          ledgerTimestamp: ev.ledgerTimestamp,
        });

        this.metrics.eventsProcessedTotal.inc({ topic: ev.topic, status: 'success' }, 1);
        this.currentLedger = Math.max(this.currentLedger, ev.ledger);
      }

      this.store.flush();
      this.metrics.rpcRequestsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'success' },
        1
      );
    } catch (err) {
      this.metrics.rpcErrorsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status_code: '500' },
        1
      );
      this.metrics.rpcRequestsTotal.inc(
        { service: 'indexer', endpoint: 'soroban_rpc', method: 'getEvents', status: 'error' },
        1
      );
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.pollOnce();
      this.timer = setTimeout(loop, this.config.pollIntervalMs);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
