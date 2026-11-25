//! Rent cost projection — the exact `fees.rs` model, sized by measured
//! entry bytes.
//!
//! Formula (rs-soroban-env `fees.rs::rent_fee_for_size_and_ledgers`):
//!
//! ```text
//! rent_stroops = ceil(size_bytes × fee_per_rent_1kb × ledgers
//!                    ÷ (1024 × persistent_rent_rate_denominator))
//! ```
//!
//! `fee_per_rent_1kb = compute_rent_write_fee_per_1kb(state_size)`:
//!
//! ```text
//! below target: max(1000, ceil((high − low) × state / target) + low)
//! at/above:     high + ceil((high − low) × (state − target) × growth / target)
//! ```
//!
//! Rent is charged for the *incremental* ledgers an extension grants
//! (`extension_ledgers` in fees.rs), so steady-state monthly upkeep ≈
//! `rent(size, ledgers in a month)` — rent is linear per ledger, not
//! compounding. Code entries pay 1/3 (`CODE_ENTRY_RENT_DISCOUNT_FACTOR`).
//!
//! Parameter values: CAP-0066 protocol-23 settings (see constants.ts).
//! Always sanity-check against the live network config before publishing
//! production numbers (README "Cost projection").

import {
  CODE_ENTRY_RENT_DISCOUNT_FACTOR,
  FEE_WRITE_PER_1KB,
  LEDGERS_PER_30_DAY_MONTH,
  MIN_RENT_WRITE_FEE_PER_1KB,
  PERSISTENT_RENT_RATE_DENOMINATOR,
  RENT_FEE_1KB_HIGH,
  RENT_FEE_1KB_LOW,
  RENT_STATE_GROWTH_FACTOR,
  RENT_STATE_TARGET_BYTES,
  STROOPS_PER_XLM,
  TTL_ENTRY_SIZE_BYTES,
} from './constants.js';
import type { EntryClass } from './cliff.js';

function divCeil(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('divisor must be positive');
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

export interface RentCurveParams {
  low: bigint;
  high: bigint;
  targetBytes: bigint;
  growth: bigint;
  floor: bigint;
}

export const DEFAULT_RENT_CURVE: RentCurveParams = {
  low: RENT_FEE_1KB_LOW,
  high: RENT_FEE_1KB_HIGH,
  targetBytes: RENT_STATE_TARGET_BYTES,
  growth: RENT_STATE_GROWTH_FACTOR,
  floor: MIN_RENT_WRITE_FEE_PER_1KB,
};

/** Dynamic per-1KB rent fee for a given live Soroban state size (fees.rs). */
export function rentFeePer1Kb(stateSizeBytes: bigint, params: RentCurveParams = DEFAULT_RENT_CURVE): bigint {
  if (stateSizeBytes < 0n) throw new Error('state size must be >= 0');
  const multiplier = params.high - params.low;
  let fee: bigint;
  if (stateSizeBytes < params.targetBytes) {
    fee = divCeil(multiplier * stateSizeBytes, params.targetBytes) + params.low;
  } else {
    fee =
      params.high +
      divCeil(multiplier * (stateSizeBytes - params.targetBytes) * params.growth, params.targetBytes);
  }
  return fee < params.floor ? params.floor : fee;
}

/** Rent for keeping `sizeBytes` alive for `ledgers` more ledgers (stroops). */
export function rentStroops(
  sizeBytes: bigint,
  ledgers: bigint,
  feePer1Kb: bigint,
  denominator: bigint = PERSISTENT_RENT_RATE_DENOMINATOR,
): bigint {
  if (sizeBytes < 0n || ledgers < 0n) throw new Error('size and ledgers must be >= 0');
  return divCeil(sizeBytes * feePer1Kb * ledgers, 1024n * denominator);
}

/** Wasm code entries pay one third of computed rent. */
export function codeRentStroops(sizeBytes: bigint, ledgers: bigint, feePer1Kb: bigint): bigint {
  return divCeil(rentStroops(sizeBytes, ledgers, feePer1Kb), CODE_ENTRY_RENT_DISCOUNT_FACTOR);
}

/** One-off fee every TTL extension pays for rewriting its 48-byte TTL entry. */
export function extensionOverheadStroops(feeWrite1Kb: bigint = FEE_WRITE_PER_1KB, feeWriteEntry: bigint = 0n): bigint {
  return feeWriteEntry + divCeil(BigInt(TTL_ENTRY_SIZE_BYTES) * feeWrite1Kb, 1024n);
}

/** Stroops → XLM decimal string (7 dp, trailing zeros trimmed). */
export function stroopsToXlm(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = abs % STROOPS_PER_XLM;
  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${fracStr ? `.${fracStr}` : ''}`;
}

export type RentClassCounts = Partial<Record<EntryClass, number>>;
export type RentClassSizes = Partial<Record<EntryClass, number>>;

export interface RentRow {
  cls: EntryClass;
  count: number;
  bytesEach: number;
  /** Monthly rent at the floor fee (state ≤ 2 GB). */
  monthlyXlmAtFloor: string;
  /** Monthly rent at the fee for the configured/queried state size. */
  monthlyXlmAtState: string;
  /** Monthly rent at the 3 GB-target ceiling fee (upper bound). */
  monthlyXlmAtCeiling: string;
}

export interface RentProjection {
  /** Ledgers in the projection window (30-day month at 5 s/ledger). */
  monthlyLedgers: number;
  stateSizeBytes: string;
  feePer1KbAtFloor: string;
  feePer1KbAtState: string;
  feePer1KbAtCeiling: string;
  rows: RentRow[];
  totalXlmAtFloor: string;
  totalXlmAtState: string;
  totalXlmAtCeiling: string;
  /** Per-stream marginal monthly cost at the configured state size. */
  perStreamMonthlyXlmAtState: string;
}

export interface ProjectRentInput {
  counts: RentClassCounts;
  /** Representative measured XDR size per class (bytes). */
  sizes: RentClassSizes;
  stateSizeBytes?: bigint;
  monthlyLedgers?: number;
}

/**
 * Monthly rent table at current scale. Sizes should be *measured* from real
 * ledger entries (`Buffer.byteLength(entryXdr, 'base64')`) — the scanner does
 * this during every pass; estimates only apply when an entry isn't readable.
 */
export function projectMonthlyRent(input: ProjectRentInput): RentProjection {
  const monthly = BigInt(input.monthlyLedgers ?? LEDGERS_PER_30_DAY_MONTH);
  const state = input.stateSizeBytes ?? 0n;
  const feeFloor = rentFeePer1Kb(0n); // 1000 — constant below 2 GB
  const feeState = rentFeePer1Kb(state);
  const feeCeiling = rentFeePer1Kb(RENT_STATE_TARGET_BYTES);

  const monthlyFor = (cls: EntryClass, bytes: number, count: number, fee: bigint): bigint => {
    if (count <= 0 || bytes <= 0) return 0n;
    const size = BigInt(bytes);
    const perEntry = cls === 'code' ? codeRentStroops(size, monthly, fee) : rentStroops(size, monthly, fee);
    return perEntry * BigInt(count);
  };

  const classes: EntryClass[] = ['stream', 'index', 'counter', 'instance', 'code'];
  const rows: RentRow[] = [];
  let totalFloor = 0n;
  let totalState = 0n;
  let totalCeiling = 0n;
  let streamState = 0n;

  for (const cls of classes) {
    const count = input.counts[cls] ?? 0;
    const bytes = input.sizes[cls] ?? 0;
    if (count <= 0) continue; // a class with no live entries costs nothing
    const f = monthlyFor(cls, bytes, count, feeFloor);
    const s = monthlyFor(cls, bytes, count, feeState);
    const c = monthlyFor(cls, bytes, count, feeCeiling);
    totalFloor += f;
    totalState += s;
    totalCeiling += c;
    if (cls === 'stream') streamState = count > 0 ? s / BigInt(count) : 0n;
    rows.push({
      cls,
      count,
      bytesEach: bytes,
      monthlyXlmAtFloor: stroopsToXlm(f),
      monthlyXlmAtState: stroopsToXlm(s),
      monthlyXlmAtCeiling: stroopsToXlm(c),
    });
  }

  return {
    monthlyLedgers: Number(monthly),
    stateSizeBytes: state.toString(),
    feePer1KbAtFloor: feeFloor.toString(),
    feePer1KbAtState: feeState.toString(),
    feePer1KbAtCeiling: feeCeiling.toString(),
    rows,
    totalXlmAtFloor: stroopsToXlm(totalFloor),
    totalXlmAtState: stroopsToXlm(totalState),
    totalXlmAtCeiling: stroopsToXlm(totalCeiling),
    perStreamMonthlyXlmAtState: stroopsToXlm(streamState),
  };
}
