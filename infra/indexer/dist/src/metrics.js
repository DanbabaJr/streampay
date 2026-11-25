//! Compiled ESM export for Indexer Metrics

export class Histogram {
  constructor(config) {
    this.name = config.name;
    this.help = config.help;
    this.labelNames = config.labelNames;
    this.buckets = [...config.buckets].sort((a, b) => a - b);
    this.entries = new Map();
  }

  labelsKey(labels) {
    return this.labelNames.map(k => `${k}="${labels[k] ?? ''}"`).join(',');
  }

  observe(labels, value) {
    const key = this.labelsKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.entries.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.counts[i] += 1;
      }
    }
  }

  reset() {
    this.entries.clear();
  }

  toPrometheusString() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const [key, entry] of this.entries.entries()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.counts[i];
        const leLabel = `le="${this.buckets[i]}"`;
        const labelStr = key ? `{${key},${leLabel}}` : `{${leLabel}}`;
        lines.push(`${this.name}_bucket${labelStr} ${cumulative}`);
      }
      const infLabel = key ? `{${key},le="+Inf"}` : `{le="+Inf"}`;
      lines.push(`${this.name}_bucket${infLabel} ${entry.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ''} ${entry.sum.toFixed(3)}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ''} ${entry.count}`);
    }

    return lines.join('\n');
  }
}

export class Gauge {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  labelsKey(labels = {}) {
    return this.labelNames.map(k => `${k}="${labels[k] ?? ''}"`).join(',');
  }

  set(labels, val) {
    if (typeof labels === 'number') {
      this.values.set('', labels);
    } else {
      const key = this.labelsKey(labels);
      this.values.set(key, val ?? 0);
    }
  }

  inc(labels = {}, delta = 1) {
    if (typeof labels === 'number') {
      const curr = this.values.get('') ?? 0;
      this.values.set('', curr + labels);
    } else {
      const key = this.labelsKey(labels);
      const curr = this.values.get(key) ?? 0;
      this.values.set(key, curr + delta);
    }
  }

  reset() {
    this.values.clear();
  }

  get(labels = {}) {
    return this.values.get(this.labelsKey(labels)) ?? 0;
  }

  toPrometheusString() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values.entries()) {
        const labelStr = key ? `{${key}}` : '';
        lines.push(`${this.name}${labelStr} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

export class Counter {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  labelsKey(labels = {}) {
    return this.labelNames.map(k => `${k}="${labels[k] ?? ''}"`).join(',');
  }

  inc(labels = {}, delta = 1) {
    if (typeof labels === 'number') {
      const curr = this.values.get('') ?? 0;
      this.values.set('', curr + labels);
    } else {
      const key = this.labelsKey(labels);
      const curr = this.values.get(key) ?? 0;
      this.values.set(key, curr + delta);
    }
  }

  get(labels = {}) {
    return this.values.get(this.labelsKey(labels)) ?? 0;
  }

  reset() {
    this.values.clear();
  }

  toPrometheusString() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values.entries()) {
        const labelStr = key ? `{${key}}` : '';
        lines.push(`${this.name}${labelStr} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

export class IndexerMetricsRegistry {
  constructor() {
    this.eventLagSeconds = new Histogram({
      name: 'streampay_indexer_event_lag_seconds',
      help: 'Per-source lag between event ledger timestamp and index time in seconds',
      labelNames: ['source', 'topic'],
      buckets: [0.5, 1, 2.5, 5, 10, 15, 30, 60, 120, 300],
    });

    this.ledgerLag = new Gauge(
      'streampay_indexer_ledger_lag',
      'Number of ledgers the indexer is behind the chain tip',
      ['source']
    );

    this.latestLedger = new Gauge(
      'streampay_indexer_latest_ledger',
      'Latest ledger indexed by the service',
      ['source']
    );

    this.chainTipLedger = new Gauge(
      'streampay_chain_tip_ledger',
      'Latest known ledger produced on the blockchain',
      ['source']
    );

    this.dbDepth = new Gauge(
      'streampay_indexer_db_depth',
      'Total count of entities stored in the indexer database',
      ['table', 'state']
    );

    this.dbQueueBacklog = new Gauge(
      'streampay_indexer_db_queue_backlog',
      'Number of events in memory awaiting persistence to SQLite'
    );

    this.rpcRequestsTotal = new Counter(
      'streampay_indexer_rpc_requests_total',
      'Total Soroban RPC requests made by indexer',
      ['service', 'endpoint', 'method', 'status']
    );

    this.rpcErrorsTotal = new Counter(
      'streampay_indexer_rpc_errors_total',
      'Total Soroban RPC request errors encountered',
      ['service', 'endpoint', 'method', 'status_code']
    );

    this.eventsProcessedTotal = new Counter(
      'streampay_indexer_events_processed_total',
      'Total contract events ingested and indexed',
      ['topic', 'status']
    );

    this.syncStatus = new Gauge(
      'streampay_indexer_sync_status',
      'Current synchronization status (1 = synced, 0 = lagging/stalled)'
    );
  }

  exportMetrics() {
    return [
      this.eventLagSeconds.toPrometheusString(),
      this.ledgerLag.toPrometheusString(),
      this.latestLedger.toPrometheusString(),
      this.chainTipLedger.toPrometheusString(),
      this.dbDepth.toPrometheusString(),
      this.dbQueueBacklog.toPrometheusString(),
      this.rpcRequestsTotal.toPrometheusString(),
      this.rpcErrorsTotal.toPrometheusString(),
      this.eventsProcessedTotal.toPrometheusString(),
      this.syncStatus.toPrometheusString(),
    ].join('\n\n') + '\n';
  }
}

export const defaultIndexerMetrics = new IndexerMetricsRegistry();
