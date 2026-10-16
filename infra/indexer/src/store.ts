//! Storage interface and memory/sqlite backed store for StreamPay events.

import { defaultIndexerMetrics, type IndexerMetricsRegistry } from './metrics.js';

export interface StreamRecord {
  streamId: number;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  status: 'Active' | 'Cancelled' | 'Depleted';
  createdAt: number;
  updatedAt: number;
}

export interface EventRecord {
  id: number;
  streamId: number;
  topic: string;
  data: string;
  ledger: number;
  ledgerTimestamp: number;
  indexedAt: number;
}

export class IndexerStore {
  private streams: Map<number, StreamRecord> = new Map();
  private events: EventRecord[] = [];
  private uncommittedQueue: EventRecord[] = [];
  private nextEventId = 1;
  private metrics: IndexerMetricsRegistry;

  constructor(metrics: IndexerMetricsRegistry = defaultIndexerMetrics) {
    this.metrics = metrics;
    this.syncMetrics();
  }

  public enqueueEvent(event: Omit<EventRecord, 'id' | 'indexedAt'>): EventRecord {
    const record: EventRecord = {
      ...event,
      id: this.nextEventId++,
      indexedAt: Math.floor(Date.now() / 1000),
    };
    this.uncommittedQueue.push(record);
    this.syncMetrics();
    return record;
  }

  public flush(): number {
    const count = this.uncommittedQueue.length;
    while (this.uncommittedQueue.length > 0) {
      const ev = this.uncommittedQueue.shift()!;
      this.events.push(ev);
    }
    this.syncMetrics();
    return count;
  }

  public setQueueBacklog(depth: number): void {
    // Used for fault injection & capacity simulation
    this.metrics.dbQueueBacklog.set(depth);
    this.metrics.dbDepth.set({ table: 'uncommitted_queue', state: 'pending' }, depth);
  }

  public upsertStream(stream: StreamRecord): void {
    this.streams.set(stream.streamId, stream);
    this.syncMetrics();
  }

  public getStream(streamId: number): StreamRecord | undefined {
    return this.streams.get(streamId);
  }

  public getAllStreams(): StreamRecord[] {
    return Array.from(this.streams.values());
  }

  public getEvents(): EventRecord[] {
    return [...this.events];
  }

  public syncMetrics(): void {
    this.metrics.dbDepth.set({ table: 'streams', state: 'persisted' }, this.streams.size);
    this.metrics.dbDepth.set({ table: 'events', state: 'persisted' }, this.events.length);
    this.metrics.dbQueueBacklog.set(this.uncommittedQueue.length);
    this.metrics.dbDepth.set({ table: 'uncommitted_queue', state: 'pending' }, this.uncommittedQueue.length);
  }

  public reset(): void {
    this.streams.clear();
    this.events = [];
    this.uncommittedQueue = [];
    this.nextEventId = 1;
    this.syncMetrics();
  }
}
