#!/usr/bin/env node
//! StreamPay TTL sentinel CLI.
//!
//! ```
//! ttl-sentinel scan [--watch] [--json]        # read-only monitoring core
//! ttl-sentinel rent [--streams N] [--json]    # monthly rent projection
//! ttl-sentinel extend [--execute] [--json]    # OPTIONAL funded extender
//! ```
//!
//! Common options: `--config`, `--contract`, `--rpc`, `--state`.

import { Keypair } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { parseArgs } from 'node:util';

import { AlertEngine, buildSinks, type AlertSink } from './alerts.js';
import { CadenceMeter, formatDuration } from './cadence.js';
import { CLASS_CLIFFS, assertScheduleSafety, type EntryClass } from './cliff.js';
import { loadConfig, type SentinelConfig } from './config.js';
import { LEDGERS_PER_30_DAY_MONTH, STROOPS_PER_XLM } from './constants.js';
import { Extender, ExtendSubmitter, buildExtensionPlan, formatPlanBudget, newSpenderState, SdkExtendSubmitter, type ExtendTarget } from './extender.js';
import { projectMonthlyRent, rentFeePer1Kb, stroopsToXlm, type RentProjection } from './rent.js';
import { HttpRpcClient } from './rpc.js';
import { Scanner, type EntryFacts, type ScanReport } from './scanner.js';
import { estimatedSizes, MEASURED_ENTRY_BYTES } from './sizes.js';
import { loadAlertStore, loadSpender, loadState, saveAlertStore, saveSpender, saveState } from './state.js';
import type { Projection } from './project.js';

const USAGE = `Usage: ttl-sentinel <command> [options]

Commands:
  scan     Scan every stream entry's TTL, project expiry, alert   (default)
  rent     Print the monthly rent projection (feeds pricing/dust economics)
  extend   OPTIONAL funded auto-extender (disabled by default; --execute to submit)

Options:
  --config <path>     JSON config file
  --contract <C...>   contract id (or STREAMPAY_CONTRACT_ID)
  --rpc <url>         Stellar RPC endpoint (or TTL_SENTINEL_RPC_URL)
  --state <path>      state file path
  --json              machine-readable output
  --watch             loop forever at scanIntervalSec
  --streams <n>       rent: stream count (default: state file / measured)
  --addresses <n>     rent: distinct addresses holding index lists
  --code-bytes <n>    rent: Wasm code entry size in bytes
  --state-size <n>    rent: live Soroban state size in bytes (drives the rent curve)
  --live              rent: read real sizes from chain via one scan
  --execute           extend: actually sign and submit (default is dry-run)
  --help              this text
`;

interface Flags {
  config?: string;
  contract?: string;
  rpc?: string;
  state?: string;
  json: boolean;
  watch: boolean;
  streams?: number;
  addresses?: number;
  codeBytes?: number;
  stateSize?: string;
  live: boolean;
  execute: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): { command: string; flags: Flags } {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      contract: { type: 'string' },
      rpc: { type: 'string' },
      state: { type: 'string' },
      json: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      streams: { type: 'string' },
      addresses: { type: 'string' },
      'code-bytes': { type: 'string' },
      'state-size': { type: 'string' },
      live: { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  const f = parsed.values;
  return {
    command: parsed.positionals[0] ?? 'scan',
    flags: {
      config: f.config,
      contract: f.contract,
      rpc: f.rpc,
      state: f.state,
      json: f.json ?? false,
      watch: f.watch ?? false,
      streams: num(f.streams, '--streams'),
      addresses: num(f.addresses, '--addresses'),
      codeBytes: num(f['code-bytes'], '--code-bytes'),
      stateSize: f['state-size'],
      live: f.live ?? false,
      execute: f.execute ?? false,
      help: f.help ?? false,
    },
  };
}

function configFor(flags: Flags): SentinelConfig {
  const cfg = loadConfig({ configPath: flags.config });
  if (flags.contract) cfg.contractId = flags.contract;
  if (flags.rpc) cfg.rpcUrl = flags.rpc;
  if (flags.state) cfg.statePath = flags.state;
  if (flags.stateSize !== undefined) cfg.sorobanStateSizeBytes = flags.stateSize;
  return cfg;
}

function requireContract(cfg: SentinelConfig): void {
  if (!cfg.contractId) {
    throw new Error('no contract id: pass --contract, set STREAMPAY_CONTRACT_ID, or put it in the config file');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countsFromReport(report: ScanReport): Partial<Record<EntryClass, number>> {
  return {
    stream: report.streams.present,
    index: report.indexes.filter((i) => i.present).length,
    counter: 1,
    instance: report.instance?.present ? 1 : 0,
    code: report.code?.present ? 1 : 0,
  };
}

function sizesFromReport(report: ScanReport): Record<EntryClass, number> {
  const fallback = estimatedSizes();
  const out = {} as Record<EntryClass, number>;
  for (const cls of Object.keys(report.sizes) as EntryClass[]) {
    out[cls] = report.sizes[cls] > 0 ? report.sizes[cls] : fallback[cls];
  }
  return out;
}

function rentForReport(cfg: SentinelConfig, report: ScanReport): RentProjection {
  return projectMonthlyRent({
    counts: countsFromReport(report),
    sizes: sizesFromReport(report),
    stateSizeBytes: BigInt(cfg.sorobanStateSizeBytes || '0'),
  });
}

function severityRollup(projections: Projection[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const p of projections) {
    out[p.cls] = out[p.cls] ?? {};
    const bucket = out[p.cls] as Record<string, number>;
    bucket[p.severity] = (bucket[p.severity] ?? 0) + 1;
  }
  return out;
}

function worstByClass(projections: Projection[]): Projection[] {
  const worst = new Map<EntryClass, Projection>();
  for (const p of projections) {
    const cur = worst.get(p.cls);
    if (!cur || p.remainingLedgers < cur.remainingLedgers) worst.set(p.cls, p);
  }
  return [...worst.values()].sort((a, b) => a.remainingLedgers - b.remainingLedgers);
}

function printScanHuman(report: ScanReport, projections: Projection[], rent: RentProjection, cfg: SentinelConfig, fireCount: number): void {
  const lines: string[] = [];
  lines.push(`TTL sentinel — ${cfg.contractId} @ ledger ${report.atLedger} (${report.atIso})`);
  if (report.usedCounterFallback) {
    lines.push('  !! counter entry unreadable: enumeration fell back to the cached high-water mark');
  }
  lines.push(
    `  entries: ${report.streams.present}/${report.streams.enumerated} streams live, ` +
      `${report.indexes.length} index keys, counter=${report.counter.present ? 'live' : 'MISSING'}, ` +
      `instance=${report.instance ? (report.instance.present ? 'live' : 'MISSING') : 'skipped'}`,
  );

  for (const cls of ['counter', 'instance', 'code', 'stream', 'index'] as EntryClass[]) {
    const worst = worstByClass(projections).find((p) => p.cls === cls);
    if (!worst) continue;
    const eta = worst.etaSecondsFastest !== null ? `~${formatDuration(worst.etaSecondsFastest)} to archive (fastest cadence)` : '';
    const cliff = CLASS_CLIFFS[cls].worstCaseLedgers;
    lines.push(
      `  ${cls.padEnd(8)} worst=${worst.severity.toUpperCase().padEnd(7)} ${worst.id.padEnd(24)} ` +
        `remaining=${String(worst.remainingLedgers).padStart(8)} of ${cliff} worst-case cliff  ${eta}`,
    );
  }

  const roll = severityRollup(projections);
  const summary = Object.entries(roll)
    .map(([cls, bySeverity]) => `${cls}:${Object.entries(bySeverity).map(([s, n]) => `${s}=${n}`).join(',')}`)
    .join('  ');
  lines.push(`  severities: ${summary}`);
  lines.push(`  alerts this scan: ${fireCount}`);

  lines.push(
    `  rent (30 d @ 5 s/ledger): ${rent.totalXlmAtState} XLM at configured state ` +
      `(fee/1KB=${rent.feePer1KbAtState}); floor ${rent.totalXlmAtFloor}, ceiling ${rent.totalXlmAtCeiling}; ` +
      `marginal ${rent.perStreamMonthlyXlmAtState} XLM per live stream`,
  );
  process.stdout.write(lines.join('\n') + '\n');
}

async function runScan(cfg: SentinelConfig, flags: Flags): Promise<number> {
  requireContract(cfg);
  const margins = assertScheduleSafety(cfg.schedules, cfg.scanIntervalSec, cfg.floorLedgerSec);

  const cadence = new CadenceMeter({ floorSec: cfg.floorLedgerSec, targetSec: cfg.targetLedgerSec });
  const state = loadState(cfg.statePath);
  const alertStatePath = `${cfg.statePath}.alerts.json`;
  const spenderPath = `${cfg.statePath}.spender.json`;
  const sinks: AlertSink[] = buildSinks({ alertsJsonlPath: cfg.alertsJsonlPath, webhookUrl: cfg.webhookUrl });
  const engine = new AlertEngine({ reAlertEveryLedgers: cfg.reAlertEveryLedgers }, sinks, loadAlertStore(alertStatePath));
  const scanner = new Scanner({ rpc: new HttpRpcClient(cfg.rpcUrl), cfg, state, cadence });

  do {
    const { report, projections } = await scanner.scan();
    cadence.record(report.atLedger, Date.now());
    const events = engine.evaluate(projections, {
      atLedger: report.atLedger,
      atIso: report.atIso,
      contractId: cfg.contractId,
    });
    const rent = rentForReport(cfg, report);

    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            contractId: cfg.contractId,
            atLedger: report.atLedger,
            atIso: report.atIso,
            cadence: cadence.stats(),
            scheduleMargins: margins,
            report,
            projections,
            rent,
            alerts: events,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      printScanHuman(report, projections, rent, cfg, events.length);
    }

    saveState(cfg.statePath, state);
    saveAlertStore(alertStatePath, engine.snapshot());
    if (!loadSpender(spenderPath).month) saveSpender(spenderPath, newSpenderState());

    if (!flags.watch) return 0;
    await sleep(cfg.scanIntervalSec * 1000);
  } while (true);
}

function runRent(cfg: SentinelConfig, flags: Flags): Promise<number> {
  const state = loadState(cfg.statePath);
  const streams = flags.streams ?? state.maxStreamId;
  // Default to the pessimistic layout: every stream has its own address pair,
  // so each index entry holds a single id (2 index entries per stream).
  const addresses = flags.addresses ?? Math.max(streams, 0);
  const sizes = estimatedSizes({ indexesPerAddressIds: addresses > 0 ? Math.ceil(streams / addresses) : 1 });
  if (flags.codeBytes !== undefined) sizes.code = flags.codeBytes;

  const projection = projectMonthlyRent({
    counts: { stream: streams, index: addresses * 2, counter: 1, instance: 1, code: 1 },
    sizes,
    stateSizeBytes: BigInt(cfg.sorobanStateSizeBytes || '0'),
  });

  if (flags.json) {
    process.stdout.write(JSON.stringify({ streams, addresses, sizes, rent: projection }, null, 2) + '\n');
    return Promise.resolve(0);
  }

  const rows = projection.rows.map(
    (r) =>
      `  ${r.cls.padEnd(8)} count=${String(r.count).padStart(6)} bytes=${String(r.bytesEach).padStart(8)}  ` +
      `${r.monthlyXlmAtFloor.padStart(12)} XLM/mo (floor)  ${r.monthlyXlmAtState.padStart(12)} (at state)  ${r.monthlyXlmAtCeiling.padStart(12)} (ceiling)`,
  );
  process.stdout.write(
    `Monthly rent projection — ${streams} streams, ${addresses} addresses, ` +
      `${projection.monthlyLedgers} ledgers/month (~30 d @ 5 s)\n` +
      `  rent fee per 1KB: floor ${projection.feePer1KbAtFloor} stroops, at configured state (${projection.stateSizeBytes} B) ` +
      `${projection.feePer1KbAtState}, target-state ceiling ${projection.feePer1KbAtCeiling}\n` +
      rows.join('\n') +
      `\n  TOTAL ${projection.totalXlmAtFloor} (floor) / ${projection.totalXlmAtState} (state) / ` +
      `${projection.totalXlmAtCeiling} (ceiling) XLM per month\n` +
      `  marginal per live stream: ${projection.perStreamMonthlyXlmAtState} XLM/month\n` +
      `  (sizes are measured XDR byte lengths; code rent includes the 1/3 code-entry discount)\n`,
  );
  return Promise.resolve(0);
}

async function runExtend(cfg: SentinelConfig, flags: Flags): Promise<number> {
  requireContract(cfg);
  if (!cfg.extender.enabled) {
    throw new Error(
      'the extender is disabled. The core sentinel is read-only by design; enable it in config ' +
        '(`extender.enabled = true`) and provide its key before running this command.',
    );
  }

  const cadence = new CadenceMeter({ floorSec: cfg.floorLedgerSec, targetSec: cfg.targetLedgerSec });
  const state = loadState(cfg.statePath);
  const scanner = new Scanner({ rpc: new HttpRpcClient(cfg.rpcUrl), cfg, state, cadence });
  const { report, projections } = await scanner.scan();
  cadence.record(report.atLedger, Date.now());

  const factsById = new Map<string, EntryFacts>();
  factsById.set(report.counter.id, report.counter);
  if (report.instance) factsById.set(report.instance.id, report.instance);
  if (report.code) factsById.set(report.code.id, report.code);
  for (const s of report.streams.entries) factsById.set(s.id, s);
  for (const ix of report.indexes) factsById.set(ix.id, ix);

  const targets: ExtendTarget[] = projections
    .map((p) => {
      const f = factsById.get(p.id);
      return f
        ? { id: p.id, cls: p.cls, keyB64: f.keyB64, remainingLedgers: p.remainingLedgers, sizeBytes: f.sizeBytes }
        : null;
    })
    .filter((t): t is ExtendTarget => t !== null);

  const feePer1Kb = rentFeePer1Kb(BigInt(cfg.sorobanStateSizeBytes || '0'));
  const plan = buildExtensionPlan(targets, cfg.extender, feePer1Kb);
  const spenderPath = `${cfg.statePath}.spender.json`;
  const spender = loadSpender(spenderPath);

  const dryRun = !flags.execute;
  let submitter: ExtendSubmitter | null = null;
  if (!dryRun) {
    const secret = process.env[cfg.extender.secretKeyEnv];
    if (!secret) throw new Error(`--execute needs the extender key in $${cfg.extender.secretKeyEnv}`);
    submitter = new SdkExtendSubmitter({
      networkPassphrase: cfg.networkPassphrase,
      server: new Server(cfg.rpcUrl),
      keypair: Keypair.fromSecret(secret),
    });
  }

  const extender = new Extender(
    cfg.extender,
    submitter ?? { submit: () => Promise.reject(new Error('dry-run submitter must not be called')) },
    spender,
    { dryRun, feePer1Kb },
  );
  const result = await extender.run(plan);
  const out = {
    contractId: cfg.contractId,
    atLedger: report.atLedger,
    dryRun: result.dryRun,
    plan: {
      extendTo: plan.extendTo,
      thresholdLedgers: plan.thresholdLedgers,
      batches: plan.batches.length,
      targets: plan.batches.flatMap((b) => b.targets.map((t) => ({ id: t.id, cls: t.cls, remainingLedgers: t.remainingLedgers }))),
      healthy: plan.healthy,
      estimated: `${stroopsToXlm(plan.estimatedTotalStroops)} XLM`,
    },
    result: {
      submitted: result.submitted.map((s) => ({
        ids: s.batch.targets.map((t) => t.id),
        status: s.result.status,
        hash: s.result.hash,
        feeStroops: s.result.feeStroops === null ? null : s.result.feeStroops.toString(),
      })),
      stoppedBy: result.stoppedBy,
      budgetStroops: result.budgetStroops.toString(),
      spentStroops: result.spentStroops.toString(),
    },
  };
  saveSpender(spenderPath, spender);
  saveState(cfg.statePath, state);

  if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else {
    process.stdout.write(
      `TTL extender (${result.dryRun ? 'DRY RUN — nothing submitted' : 'SUBMITTING'})\n` +
        `  contract ${cfg.contractId} @ ledger ${report.atLedger}\n` +
        `  ${plan.batches.length} tx planned for ${plan.batches.reduce((n, b) => n + b.targets.length, 0)} entries ` +
        `(${formatPlanBudget(plan)}), extendTo=${plan.extendTo}, threshold=${plan.thresholdLedgers}\n` +
        (plan.batches.length > 0
          ? plan.batches
              .map((b, i) => `    tx${i}: ${b.targets.map((t) => `${t.id}(${t.remainingLedgers})`).join(', ')}`)
              .join('\n') + '\n'
          : '    nothing below the extension threshold\n') +
        `  spent ${stroopsToXlm(result.spentStroops)} XLM of ${stroopsToXlm(result.budgetStroops)} XLM monthly budget` +
        (result.stoppedBy ? ` (stopped by ${result.stoppedBy})` : '') +
        '\n',
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseFlags(argv);
  if (flags.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const cfg = configFor(flags);
  switch (command) {
    case 'scan':
      return await runScan(cfg, flags);
    case 'rent':
      return await runRent(cfg, flags);
    case 'extend':
      return await runExtend(cfg, flags);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.on('SIGINT', () => process.exit(0));
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`ttl-sentinel: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}

export { MEASURED_ENTRY_BYTES, STROOPS_PER_XLM, LEDGERS_PER_30_DAY_MONTH };
