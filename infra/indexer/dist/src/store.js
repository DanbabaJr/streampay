//! Compiled ESM store for indexer

import { defaultIndexerMetrics } from './metrics.js';

export class IndexerStore {
  constructor(metrics = defaultIndexerMetrics) {
    this.streams = new Map();
    this.events = [];
    this.uncommittedQueue = [];
    this.nextEventId = 1;
    this.metrics = metrics;
    this.syncMetrics();
  }

  enqueueEvent(event) {
    const record = {
      ...event,
      id: this.nextEventId++,
      indexedAt: Math.floor(Date.now() / 1000),
    };
    this.uncommittedQueue.push(record);
    this.syncMetrics();
    return record;
  }

  flush() {
    const count = this.uncommittedQueue.length;
    while (this.uncommittedQueue.length > 0) {
      const ev = this.uncommittedQueue.shift();
      this.events.push(ev);
    }
    this.syncMetrics();
    return count;
  }

  setQueueBacklog(depth) {
    this.metrics.dbQueueBacklog.set(depth);
    this.metrics.dbDepth.set({ table: 'uncommitted_queue', state: 'pending' }, depth);
  }

  upsertStream(stream) {
    this.streams.set(stream.streamId, stream);
    this.syncMetrics();
  }

  getStream(streamId) {
    return this.streams.get(streamId);
  }

  getAllStreams() {
    return Array.from(this.streams.values());
  }

  getEvents() {
    return [...this.events];
  }

  syncMetrics() {
    this.metrics.dbDepth.set({ table: 'streams', state: 'persisted' }, this.streams.size);
    this.metrics.dbDepth.set({ table: 'events', state: 'persisted' }, this.events.length);
    this.metrics.dbQueueBacklog.set(this.uncommittedQueue.length);
    this.metrics.dbDepth.set({ table: 'uncommitted_queue', state: 'pending' }, this.uncommittedQueue.length);
  }

  reset() {
    this.streams.clear();
    this.events = [];
    this.uncommittedQueue = [];
    this.nextEventId = 1;
    this.syncMetrics();
  }
}
