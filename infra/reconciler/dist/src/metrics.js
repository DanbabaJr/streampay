//! Compiled ESM metrics registry for reconciler

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

export class ReconcilerMetricsRegistry {
  constructor() {
    this.divergencesTotal = new Counter(
      'streampay_reconciliation_divergences_total',
      'Total count of state divergences discovered between indexed and on-chain state',
      ['check_type', 'severity']
    );

    this.divergenceCurrent = new Gauge(
      'streampay_reconciler_divergence_current',
      'Current number of unacknowledged active state divergences',
      ['check_type']
    );

    this.checkDurationSeconds = new Histogram({
      name: 'streampay_reconciler_check_duration_seconds',
      help: 'Time taken to execute a full reconciliation sweep in seconds',
      labelNames: ['scope'],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
    });

    this.lastRunTimestampSeconds = new Gauge(
      'streampay_reconciler_last_run_timestamp_seconds',
      'Unix epoch seconds when the last reconciliation sweep finished'
    );

    this.itemsAuditedTotal = new Counter(
      'streampay_reconciler_items_audited_total',
      'Total number of streams and treasury accounts verified',
      ['entity_type']
    );

    this.rpcRequestsTotal = new Counter(
      'streampay_reconciler_rpc_requests_total',
      'Total RPC verification requests issued',
      ['method', 'status']
    );

    this.rpcErrorsTotal = new Counter(
      'streampay_reconciler_rpc_errors_total',
      'Total RPC verification request errors encountered',
      ['method', 'status_code']
    );
  }

  exportMetrics() {
    return [
      this.divergencesTotal.toPrometheusString(),
      this.divergenceCurrent.toPrometheusString(),
      this.checkDurationSeconds.toPrometheusString(),
      this.lastRunTimestampSeconds.toPrometheusString(),
      this.itemsAuditedTotal.toPrometheusString(),
      this.rpcRequestsTotal.toPrometheusString(),
      this.rpcErrorsTotal.toPrometheusString(),
    ].join('\n\n') + '\n';
  }
}

export const defaultReconcilerMetrics = new ReconcilerMetricsRegistry();
