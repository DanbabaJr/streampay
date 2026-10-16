//! Prometheus metrics registry and collectors for StreamPay Reconciler.
//! Measures state truth: reconciliation divergences, cycle duration, and audit depth.

export interface HistogramConfig {
  name: string;
  help: string;
  labelNames: string[];
  buckets: number[];
}

export interface MetricLabels {
  [key: string]: string | number;
}

export class Histogram {
  public readonly name: string;
  public readonly help: string;
  public readonly labelNames: string[];
  public readonly buckets: number[];
  private entries: Map<string, { counts: number[]; sum: number; count: number }> = new Map();

  constructor(config: HistogramConfig) {
    this.name = config.name;
    this.help = config.help;
    this.labelNames = config.labelNames;
    this.buckets = [...config.buckets].sort((a, b) => a - b);
  }

  private labelsKey(labels: MetricLabels): string {
    return this.labelNames.map(k => `${k}="${labels[k] ?? ''}"`).join(',');
  }

  public observe(labels: MetricLabels, value: number): void {
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

  public reset(): void {
    this.entries.clear();
  }

  public toPrometheusString(): string {
    const lines: string[] = [
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
  public readonly name: string;
  public readonly help: string;
  public readonly labelNames: string[];
  private values: Map<string, number> = new Map();

  constructor(name: string, help: string, labelNames: string[] = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  private labelsKey(labels: MetricLabels = {}): string {
    return this.labelNames.map(k => `${k}="${labels[k] ?? ''}"`).join(',');
  }

  public set(labels: MetricLabels | number, val?: number): void {
    if (typeof labels === 'number') {
      this.values.set('', labels);
    } else {
      const key = this.labelsKey(labels);
      this.values.set(key, val ?? 0);
    }
  }

  public inc(labels: MetricLabels | number = {}, delta = 1): void {
    if (typeof labels === 'number') {
      const curr = this.values.get('') ?? 0;
      this.values.set('', curr + labels);
    } else {
      const key = this.labelsKey(labels);
      const curr = this.values.get(key) ?? 0;
      this.values.set(key, curr + delta);
    }
  }

  public reset(): void {
    this.values.clear();
  }

  public get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsKey(labels)) ?? 0;
  }

  public toPrometheusString(): string {
    const lines: string[] = [
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
  public readonly name: string;
  public readonly help: string;
  public readonly labelNames: string[];
  private values: Map<string, number> = new Map();

  constructor(name: string, help: string, labelNames: string[] = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  private labelsKey(labels: MetricLabels = {}): string {
    return this.labelNames.map(k => `${k}="${labels[k] ?? ''}"`).join(',');
  }

  public inc(labels: MetricLabels | number = {}, delta = 1): void {
    if (typeof labels === 'number') {
      const curr = this.values.get('') ?? 0;
      this.values.set('', curr + labels);
    } else {
      const key = this.labelsKey(labels);
      const curr = this.values.get(key) ?? 0;
      this.values.set(key, curr + delta);
    }
  }

  public get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsKey(labels)) ?? 0;
  }

  public reset(): void {
    this.values.clear();
  }

  public toPrometheusString(): string {
    const lines: string[] = [
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
  // 1. Reconciliation Divergences (THE critical metric for truth)
  public readonly divergencesTotal = new Counter(
    'streampay_reconciliation_divergences_total',
    'Total count of state divergences discovered between indexed and on-chain state',
    ['check_type', 'severity']
  );

  public readonly divergenceCurrent = new Gauge(
    'streampay_reconciler_divergence_current',
    'Current number of unacknowledged active state divergences',
    ['check_type']
  );

  // 2. Audit Run Health & Cadence
  public readonly checkDurationSeconds = new Histogram({
    name: 'streampay_reconciler_check_duration_seconds',
    help: 'Time taken to execute a full reconciliation sweep in seconds',
    labelNames: ['scope'],
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  });

  public readonly lastRunTimestampSeconds = new Gauge(
    'streampay_reconciler_last_run_timestamp_seconds',
    'Unix epoch seconds when the last reconciliation sweep finished'
  );

  public readonly itemsAuditedTotal = new Counter(
    'streampay_reconciler_items_audited_total',
    'Total number of streams and treasury accounts verified',
    ['entity_type']
  );

  // 3. RPC Activity
  public readonly rpcRequestsTotal = new Counter(
    'streampay_reconciler_rpc_requests_total',
    'Total RPC verification requests issued',
    ['method', 'status']
  );

  public readonly rpcErrorsTotal = new Counter(
    'streampay_reconciler_rpc_errors_total',
    'Total RPC verification request errors encountered',
    ['method', 'status_code']
  );

  public exportMetrics(): string {
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
