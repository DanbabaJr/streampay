//! Configuration: defaults derived from the cliff model, JSON file, env.
//!
//! Precedence: built-in defaults < config file < environment < CLI flags.

import { readFileSync } from 'node:fs';

import { CLASS_CLIFFS, type EntryClass } from './cliff.js';
import {
  CONTRACT_TTL_EXTEND_LEDGERS,
  CONTRACT_TTL_THRESHOLD_LEDGERS,
  FASTEST_CREDIBLE_LEDGER_SECONDS,
  MIN_PERSISTENT_ENTRY_TTL,
  TARGET_LEDGER_SECONDS,
} from './constants.js';

export interface ExtenderSection {
  /** Master switch. Off by default: the core sentinel is read-only. */
  enabled: boolean;
  /** Env var holding the extender's secret key (never a CLI flag/file default). */
  secretKeyEnv: string;
  /** Extend entries whose remaining TTL is below this (ledger units). */
  thresholdLedgers: number;
  /** Extend target past the current ledger (floor, not exact). */
  extendTo: number;
  /** Max ledger keys per ExtendFootprintTTL transaction. */
  maxEntriesPerTx: number;
  /** Compute and report the plan but submit nothing. */
  dryRun: boolean;
  /** Monthly spend cap in XLM across all extension fees. */
  monthlyBudgetXlm: string;
}

export interface SentinelConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Wall seconds between scans. */
  scanIntervalSec: number;
  /** Fastest credible ledger close time; drives worst-case schedule math. */
  floorLedgerSec: number;
  /** Protocol target ledger close time (display estimates). */
  targetLedgerSec: number;
  /** Per-class alert thresholds (ledgers remaining). */
  schedules: Record<EntryClass, { warnLedgers: number; critLedgers: number }>;
  /** Re-fire crit/expired alerts every N ledgers of observation age. */
  reAlertEveryLedgers: number;
  /** Persist observed state (last counter value, addresses) here. */
  statePath: string;
  /** Append alerts as JSON lines here ("" disables). */
  alertsJsonlPath: string;
  /** Generic webhook receiving POSTed alert batches ("" disables). */
  webhookUrl: string;
  /** Probe the contract instance + Wasm code entries too. */
  monitorContractEntries: boolean;
  /** Max stream ids to enumerate per scan (safety valve). */
  maxStreams: number;
  /**
   * When the counter entry is unreadable (archived), probe this many ids past
   * the cached high-water mark to discover streams created while down. Ids in
   * the probe window that are absent are treated as never-created.
   */
  counterFallbackProbeRun: number;
  /** Current Soroban state size in bytes for the rent curve (0 → floor fee). */
  sorobanStateSizeBytes: string;
  extender: ExtenderSection;
}

const DEFAULT_SCHEDULES: Record<EntryClass, { warnLedgers: number; critLedgers: number }> = {
  // Extended classes: warn fires at 75% of the 200k worst-case cliff, well
  // inside it with margin (see cliff.ts / README "Schedule vs. cliff").
  stream: { warnLedgers: 150_000, critLedgers: 60_000 },
  index: { warnLedgers: 150_000, critLedgers: 60_000 },
  // Never-extended classes: the true cliff is only min_persistent_ttl - 1
  // = 4095 ledgers, so thresholds must sit far lower.
  counter: { warnLedgers: 3_000, critLedgers: 1_200 },
  instance: { warnLedgers: 3_000, critLedgers: 1_200 },
  code: { warnLedgers: 3_000, critLedgers: 1_200 },
};

export function defaultConfig(overrides: Partial<SentinelConfig> = {}): SentinelConfig {
  return {
    contractId: '',
    rpcUrl: 'https://soroban-rpc.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    scanIntervalSec: 300,
    floorLedgerSec: FASTEST_CREDIBLE_LEDGER_SECONDS,
    targetLedgerSec: TARGET_LEDGER_SECONDS,
    schedules: DEFAULT_SCHEDULES,
    reAlertEveryLedgers: 8_640, // 12 h at the 5 s target
    statePath: '.ttl-sentinel.state.json',
    alertsJsonlPath: '',
    webhookUrl: '',
    monitorContractEntries: true,
    maxStreams: 100_000,
    counterFallbackProbeRun: 200,
    sorobanStateSizeBytes: '0',
    extender: {
      enabled: false,
      secretKeyEnv: 'TTL_SENTINEL_EXTENDER_SECRET',
      thresholdLedgers: CONTRACT_TTL_THRESHOLD_LEDGERS,
      extendTo: CONTRACT_TTL_EXTEND_LEDGERS,
      maxEntriesPerTx: 20,
      dryRun: true,
      monthlyBudgetXlm: '1',
    },
    ...overrides,
  };
}

export class ConfigError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge a parsed JSON file over the defaults, validating shapes. */
export function mergeConfig(file: unknown, base: SentinelConfig = defaultConfig()): SentinelConfig {
  if (file === undefined || file === null) return base;
  if (!isRecord(file)) throw new ConfigError('config file must contain a JSON object');

  const merged: SentinelConfig = { ...base };
  for (const key of Object.keys(file) as (keyof SentinelConfig)[]) {
    const value = file[key];
    if (key === 'schedules') {
      if (!isRecord(value)) throw new ConfigError('schedules must be an object');
      for (const cls of Object.keys(value) as EntryClass[]) {
        if (!(cls in CLASS_CLIFFS)) throw new ConfigError(`unknown schedule class: ${cls}`);
        const s = value[cls];
        if (!isRecord(s)) throw new ConfigError(`schedules.${cls} must be an object`);
        const prev = base.schedules[cls];
        merged.schedules[cls] = {
          warnLedgers: numberOf(s.warnLedgers, `schedules.${cls}.warnLedgers`, prev.warnLedgers),
          critLedgers: numberOf(s.critLedgers, `schedules.${cls}.critLedgers`, prev.critLedgers),
        };
      }
      continue;
    }
    if (key === 'extender') {
      if (!isRecord(value)) throw new ConfigError('extender must be an object');
      merged.extender = { ...base.extender, ...(value as Partial<ExtenderSection>) };
      continue;
    }
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }

  validateConfig(merged);
  return merged;
}

function numberOf(v: unknown, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ConfigError(`${name} must be a finite number`);
  return v;
}

export function validateConfig(cfg: SentinelConfig): void {
  if (cfg.scanIntervalSec <= 0) throw new ConfigError('scanIntervalSec must be > 0');
  if (cfg.floorLedgerSec <= 0 || cfg.targetLedgerSec <= 0) throw new ConfigError('ledger cadence bounds must be > 0');
  if (cfg.floorLedgerSec > cfg.targetLedgerSec) {
    throw new ConfigError('floorLedgerSec must not exceed targetLedgerSec');
  }
  for (const [cls, s] of Object.entries(cfg.schedules)) {
    if (s.critLedgers <= 0 || s.warnLedgers <= s.critLedgers) {
      throw new ConfigError(`schedules.${cls}: need 0 < critLedgers < warnLedgers`);
    }
    if (s.warnLedgers >= CLASS_CLIFFS[cls as EntryClass].worstCaseLedgers) {
      throw new ConfigError(
        `schedules.${cls}: warnLedgers (${s.warnLedgers}) must stay below the worst-case cliff ` +
          `(${CLASS_CLIFFS[cls as EntryClass].worstCaseLedgers}) so warnings fire inside the cliff window`,
      );
    }
  }
  if (cfg.extender.extendTo <= cfg.extender.thresholdLedgers) {
    throw new ConfigError('extender.extendTo must exceed extender.thresholdLedgers');
  }
  if (!Number.isFinite(cfg.counterFallbackProbeRun) || cfg.counterFallbackProbeRun < 0) {
    throw new ConfigError('counterFallbackProbeRun must be a non-negative number');
  }
  if (cfg.extender.extendTo > 6_312_000) {
    throw new ConfigError('extender.extendTo exceeds network max_entry_ttl (6_312_000)');
  }
  if (Number(cfg.sorobanStateSizeBytes) < 0) throw new ConfigError('sorobanStateSizeBytes must be >= 0');
  if (!Number.isFinite(Number(cfg.extender.monthlyBudgetXlm)) || Number(cfg.extender.monthlyBudgetXlm) < 0) {
    throw new ConfigError('extender.monthlyBudgetXlm must be a non-negative number');
  }
}

/** Load config: defaults ← optional JSON file ← env overrides. */
export function loadConfig(opts: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): SentinelConfig {
  const env = opts.env ?? process.env;
  let file: unknown;
  if (opts.configPath) {
    let raw: string;
    try {
      raw = readFileSync(opts.configPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`cannot read config file ${opts.configPath}: ${(err as Error).message}`);
    }
    try {
      file = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new ConfigError(`config file ${opts.configPath} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const cfg = mergeConfig(file);

  if (env['STREAMPAY_CONTRACT_ID']) cfg.contractId = env['STREAMPAY_CONTRACT_ID'];
  if (env['TTL_SENTINEL_RPC_URL']) cfg.rpcUrl = env['TTL_SENTINEL_RPC_URL'];
  if (env['TTL_SENTINEL_WEBHOOK_URL']) cfg.webhookUrl = env['TTL_SENTINEL_WEBHOOK_URL'];
  if (env['TTL_SENTINEL_STATE_PATH']) cfg.statePath = env['TTL_SENTINEL_STATE_PATH'];

  validateConfig(cfg);
  return cfg;
}

/** Network parameters relevant to reports, for echoing in scan output. */
export function networkEcho(cfg: SentinelConfig): Record<string, number> {
  return {
    contractTtlThresholdLedgers: CONTRACT_TTL_THRESHOLD_LEDGERS,
    contractTtlExtendLedgers: CONTRACT_TTL_EXTEND_LEDGERS,
    minPersistentEntryTtl: MIN_PERSISTENT_ENTRY_TTL,
    floorLedgerSec: cfg.floorLedgerSec,
    targetLedgerSec: cfg.targetLedgerSec,
  };
}
