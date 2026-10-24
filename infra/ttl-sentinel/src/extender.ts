//! OPTIONAL funded TTL extender — **disabled by default and never part of the
//! read-only core**.
//!
//! Why it is a separate component: extending a TTL from off-chain requires
//! *signing* a transaction (`ExtendFootprintTTL`) with a funded account, so it
//! raises questions the alerting core deliberately avoids:
//!
//! - **who pays** — the extender account pays rent + fees for entries it may
//!   not own; the protocol allows this (TTL extension is permissionless and
//!   sets a floor, never an exact value), but the spend is the operator's.
//! - **key custody** — a hot key is required. Loaded only here, from an env
//!   var named in config (`extender.secretKeyEnv`), never from a CLI flag
//!   (argv is world-readable via `ps`), never logged, never read by `scan`.
//!
//! Protections: explicit `enabled` opt-in, dry-run by default, a monthly XLM
//! budget, per-transaction batch cap, and a threshold policy that only touches
//! entries already inside their class cliff. Plan construction is pure and
//! fully unit-tested; submission is behind an injectable interface.

import {
  Account,
  BASE_FEE,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Keypair,
  type Transaction,
} from '@stellar/stellar-sdk';

import { rentStroops, extensionOverheadStroops, stroopsToXlm } from './rent.js';
import type { EntryClass } from './cliff.js';
import type { ExtenderSection } from './config.js';

export interface ExtendTarget {
  id: string;
  cls: EntryClass;
  keyB64: string;
  remainingLedgers: number;
  sizeBytes: number | null;
}

export interface ExtensionBatch {
  targets: ExtendTarget[];
  /** Ledgers each entry in the batch gains (extendTo − remaining, per entry). */
  estimatedRentStroops: bigint;
}

export interface ExtensionPlan {
  extendTo: number;
  thresholdLedgers: number;
  batches: ExtensionBatch[];
  /** Entries already healthy (above the threshold). */
  healthy: number;
  estimatedTotalStroops: bigint;
}

export class ExtenderDisabledError extends Error {
  constructor() {
    super(
      'the extender is disabled (extender.enabled = false). The core sentinel is read-only by design; ' +
        'enable the extender and provide its key deliberately.',
    );
    this.name = 'ExtenderDisabledError';
  }
}

/**
 * Select everything inside its class cliff and chunk it into transactions.
 * Pure: no keys, no network. Entries are ordered most-urgent-first so a budget
 * stop still covers the worst offenders.
 */
export function buildExtensionPlan(
  targets: ExtendTarget[],
  cfg: ExtenderSection,
  feePer1Kb: bigint = 1000n,
): ExtensionPlan {
  const below = targets
    .filter((t) => t.remainingLedgers <= cfg.thresholdLedgers && t.remainingLedgers < cfg.extendTo)
    .sort((a, b) => a.remainingLedgers - b.remainingLedgers);

  const maxPerTx = Math.max(1, cfg.maxEntriesPerTx);
  const batches: ExtensionBatch[] = [];
  for (let i = 0; i < below.length; i += maxPerTx) {
    const group = below.slice(i, i + maxPerTx);
    let rent = 0n;
    for (const t of group) {
      const ledgersAdded = BigInt(Math.max(0, cfg.extendTo - t.remainingLedgers));
      const size = BigInt(t.sizeBytes ?? 400);
      rent += rentStroops(size, ledgersAdded, feePer1Kb);
    }
    // Each batch pays one TTL-entry write + per-entry write fee on submission.
    rent += extensionOverheadStroops() * BigInt(group.length);
    batches.push({ targets: group, estimatedRentStroops: rent });
  }

  return {
    extendTo: cfg.extendTo,
    thresholdLedgers: cfg.thresholdLedgers,
    batches,
    healthy: targets.length - below.length,
    estimatedTotalStroops: batches.reduce((sum, b) => sum + b.estimatedRentStroops, 0n),
  };
}

/** Build the (unsigned) `ExtendFootprintTTL` transaction for a batch of keys. */
export function buildExtendTransaction(
  source: Account,
  keyBase64s: string[],
  extendTo: number,
  networkPassphrase: string,
): Transaction {
  const keys = keyBase64s.map((b64) => xdr.LedgerKey.fromXDR(b64, 'base64'));
  const sorobanData = new SorobanDataBuilder().setReadOnly(keys).build();
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setTimeout(30);
  builder.setSorobanData(sorobanData);
  return builder.build();
}

export interface SubmitResult {
  status: string;
  hash: string | null;
  feeStroops: bigint | null;
}

/** How the extender submits a batch. Production uses `SdkExtendSubmitter`. */
export interface ExtendSubmitter {
  submit(keyBase64s: string[], extendTo: number): Promise<SubmitResult>;
}

/** Injectable subset of the SDK RPC `Server` (so tests never hit the network). */
export interface ServerLike {
  getAccount(publicKey: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<{ status: string; hash?: string }>;
}

/**
 * Signs with the extender's own key. The secret is captured here only — the
 * sentinel's scan path never constructs this class.
 */
export class SdkExtendSubmitter implements ExtendSubmitter {
  constructor(private readonly opts: { networkPassphrase: string; server: ServerLike; keypair: Keypair }) {}

  async submit(keyBase64s: string[], extendTo: number): Promise<SubmitResult> {
    const account = await this.opts.server.getAccount(this.opts.keypair.publicKey());
    const tx = buildExtendTransaction(account, keyBase64s, extendTo, this.opts.networkPassphrase);
    const prepared = await this.opts.server.prepareTransaction(tx);
    // `prepareTransaction` runs simulation and fills in the resource fee; read
    // it back so the budget meter tracks real spend. Falls back to the plan's
    // estimate when the shape is unavailable.
    const minFee = minResourceFeeStroops(prepared);
    prepared.sign(this.opts.keypair);
    const res = await this.opts.server.sendTransaction(prepared);
    return { status: res.status, hash: res.hash ?? null, feeStroops: minFee };
  }
}

/**
 * Resource fee that simulation filled in during `prepareTransaction`, read
 * straight from the envelope (the `Transaction` class does not expose it and
 * rebuilding a `TransactionBuilder` from a template drops the Soroban data).
 */
export function minResourceFeeStroops(prepared: Transaction): bigint | null {
  try {
    const data = sorobanDataOf(prepared);
    return data ? BigInt(data.resourceFee) : null;
  } catch {
    return null;
  }
}

/** Read-only footprint (LedgerKeys) carried by a prepared transaction. */
export function readOnlyFootprint(prepared: Transaction): xdr.LedgerKey[] {
  const data = sorobanDataOf(prepared);
  return data ? [...data.resources.footprint.readOnly] : [];
}

/** Soroban data (resources + fee) carried in a v1 envelope's transaction ext. */
function sorobanDataOf(prepared: Transaction): xdr.SorobanTransactionData | null {
  const env = xdr.TransactionEnvelope.fromXDR(prepared.toXDR(), 'base64');
  if (env.type !== 'envelopeTypeTx') return null;
  const ext = env.v1.tx.ext;
  return ext.type === 'sorobanData' ? ext.sorobanData : null;
}

/** Spend meter persisted between runs so the monthly budget actually binds. */
export interface SpenderState {
  /** `YYYY-MM` (UTC) of the metered month. */
  month: string;
  spentStroops: bigint;
}

export function newSpenderState(now: Date = new Date()): SpenderState {
  return { month: monthKey(now), spentStroops: 0n };
}

export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface ExtensionRunResult {
  dryRun: boolean;
  submitted: { batch: ExtensionBatch; result: SubmitResult }[];
  planned: ExtensionBatch[];
  stoppedBy: 'budget' | 'submission-failed' | null;
  budgetStroops: bigint;
  spentStroops: bigint;
  failedBatches?: { batch: ExtensionBatch; error: string }[];
  quarantinedAccounts?: string[];
}

/**
 * Execute an extension plan with failure isolation. Off unless `enabled`; `dryRun` reports the plan
 * without submitting; the monthly budget is enforced using actual fees when
 * the submitter reports them and estimates otherwise.
 */
export class Extender {
  private failureLadder = new Map<string, number>();
  private quarantined = new Set<string>();

  constructor(
    private readonly cfg: ExtenderSection,
    private readonly submitter: ExtendSubmitter,
    private readonly spender: SpenderState,
    private readonly opts: {
      dryRun?: boolean;
      now?: () => Date;
      feePer1Kb?: bigint;
      isolateFailures?: boolean;
      quarantineThreshold?: number;
    } = {},
  ) {}

  getQuarantinedAccounts(): string[] {
    return Array.from(this.quarantined);
  }

  async run(plan: ExtensionPlan): Promise<ExtensionRunResult> {
    if (!this.cfg.enabled) throw new ExtenderDisabledError();

    const now = this.opts.now ?? (() => new Date());
    const month = monthKey(now());
    if (this.spender.month !== month) {
      // New month: reset the meter.
      this.spender.month = month;
      this.spender.spentStroops = 0n;
    }

    const dryRun = this.opts.dryRun ?? this.cfg.dryRun;
    const budgetStroops = xlmToStroops(this.cfg.monthlyBudgetXlm);
    const submitted: ExtensionRunResult['submitted'] = [];
    const planned: ExtensionBatch[] = [];
    const failedBatches: { batch: ExtensionBatch; error: string }[] = [];
    let stoppedBy: ExtensionRunResult['stoppedBy'] = null;
    const isolateFailures = this.opts.isolateFailures ?? (this.cfg as any).isolateFailures ?? false;
    const quarantineThreshold = this.opts.quarantineThreshold ?? 3;

    const ok = new Set(['pending', 'duplicate', 'success', 'tryagainlater']);
    for (let i = 0; i < plan.batches.length; i++) {
      const batch = plan.batches[i] as ExtensionBatch;
      const account = (batch as any).account ?? batch.targets[0]?.id ?? `batch-${i}`;

      if (this.quarantined.has(account)) {
        failedBatches.push({ batch, error: `Account ${account} is in poison quarantine` });
        continue;
      }

      if (this.spender.spentStroops + batch.estimatedRentStroops > budgetStroops) {
        stoppedBy = 'budget';
        planned.push(...plan.batches.slice(i));
        break;
      }

      if (dryRun) {
        planned.push(batch);
        continue;
      }

      try {
        const result = await this.submitter.submit(
          batch.targets.map((t) => t.keyB64),
          plan.extendTo,
        );

        if (!ok.has(result.status.toLowerCase())) {
          const failures = (this.failureLadder.get(account) ?? 0) + 1;
          this.failureLadder.set(account, failures);
          if (failures >= quarantineThreshold) {
            this.quarantined.add(account);
          }
          failedBatches.push({ batch, error: `Submission returned status: ${result.status}` });

          if (!isolateFailures) {
            // Non-isolated mode: halt queue
            stoppedBy = 'submission-failed';
            break;
          }
          // Failure isolation: log and continue to remaining batches
          continue;
        }

        // Success: reset retry ladder for account
        this.failureLadder.delete(account);
        this.spender.spentStroops += result.feeStroops ?? batch.estimatedRentStroops;
        submitted.push({ batch, result });
      } catch (err: any) {
        const failures = (this.failureLadder.get(account) ?? 0) + 1;
        this.failureLadder.set(account, failures);
        if (failures >= quarantineThreshold) {
          this.quarantined.add(account);
        }
        failedBatches.push({ batch, error: String(err?.message ?? err) });

        if (!isolateFailures) {
          stoppedBy = 'submission-failed';
          break;
        }
      }
    }

    return {
      dryRun,
      submitted,
      planned,
      stoppedBy,
      budgetStroops,
      spentStroops: this.spender.spentStroops,
      failedBatches,
      quarantinedAccounts: Array.from(this.quarantined),
    };
  }
}

export function xlmToStroops(xlm: string): bigint {
  const [whole = '0', frac = ''] = xlm.trim().split('.');
  const fracPadded = (frac + '0000000').slice(0, 7);
  return BigInt(whole || '0') * 10_000_000n + BigInt(fracPadded || '0');
}

export function formatPlanBudget(plan: ExtensionPlan): string {
  return `${stroopsToXlm(plan.estimatedTotalStroops)} XLM across ${plan.batches.length} tx`;
}
