// Comparison model: up to MAX_ITEMS streams (live or hypothetical) overlaid on
// a shared time axis, with forecast and fees per item. Pure and deterministic.
import { estimateFees, type FeeAssumptions, type FeeBreakdown, DEFAULT_FEES } from "./fees";
import { forecast, type Forecast } from "./forecast";
import { accrualCurve, ratePerSecond, type CurvePoint } from "./simulator";

export const MAX_ITEMS = 5;
export const CURVE_POINTS = 24;

export interface CompareItem {
  /** Stable key: "s:<id>" for a live stream, "h:<n>" for a hypothetical one. */
  key: string;
  label: string;
  kind: "stream" | "hypothetical";
  deposit: bigint;
  /** Seconds. */
  duration: bigint;
}

export interface ItemResult {
  item: CompareItem;
  rate: bigint;
  curve: CurvePoint[];
  forecast: Forecast;
  fees: FeeBreakdown;
}

export interface Comparison {
  results: ItemResult[];
  /** Longest duration among items: the shared x-axis end. */
  horizon: bigint;
  /** Max deposit among items: the shared y-axis end. */
  maxDeposit: bigint;
}

/** Adds an item unless the cap is reached or the key already exists. */
export function addItem(items: CompareItem[], item: CompareItem): CompareItem[] {
  if (items.length >= MAX_ITEMS) return items;
  if (items.some((i) => i.key === item.key)) return items;
  return [...items, item];
}

export function removeItem(items: CompareItem[], key: string): CompareItem[] {
  return items.filter((i) => i.key !== key);
}

export function compare(
  items: CompareItem[],
  fees: FeeAssumptions = DEFAULT_FEES,
  elapsed: bigint = 0n,
): Comparison {
  // Curves are sampled on a shared horizon so overlays line up; each item
  // simply stops accruing at its own duration.
  const results = items.map((item) => ({
    item,
    rate: ratePerSecond(item),
    curve: accrualCurve(item, CURVE_POINTS),
    forecast: forecast(item, elapsed),
    fees: estimateFees(item.deposit, fees),
  }));
  return {
    results,
    horizon: items.reduce((m, i) => (i.duration > m ? i.duration : m), 0n),
    maxDeposit: items.reduce((m, i) => (i.deposit > m ? i.deposit : m), 0n),
  };
}
