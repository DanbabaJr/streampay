/**
 * Loader for the recorded fee-series fixture.
 *
 * The JSON records a single observed series (the Soroban inclusion-fee `p50`)
 * per scenario, in stroops, at a fixed cadence. The scheduler only ever reads
 * the policy-selected percentile, so recording that one number keeps the
 * fixture readable while exercising exactly the same decision path. This
 * module reconstructs a nominal {@link FeeSnapshot} distribution around each
 * recorded level.
 */
import raw from "./fee-series.json";
import { FEE_PERCENTILE_KEYS, type FeePercentiles, type FeeSnapshot } from "../fee-stats";

interface RawSeries {
  name: string;
  note: string;
  startedAtMs: number;
  sorobanP50: number[];
}

const FIXTURE = raw as {
  meta: { cadenceMs: number };
  baselineClassic: FeePercentiles;
  series: RawSeries[];
};

/** Names of the scenarios in the fixture. */
export const FEE_SERIES_NAMES: readonly string[] = FIXTURE.series.map((s) => s.name);

/** Cadence between samples, ms. */
export const FEE_SERIES_CADENCE_MS: number = FIXTURE.meta.cadenceMs;

/** The scenario with the given name. Throws if absent (test-time only). */
export function getSeries(name: string): RawSeries {
  const series = FIXTURE.series.find((s) => s.name === name);
  if (!series) throw new Error(`Unknown fee series: ${name}`);
  return series;
}

/** Builds a nominal distribution whose percentiles all sit at `level`. */
function distributionAt(level: number): FeePercentiles {
  const dist = {} as FeePercentiles;
  for (const key of FEE_PERCENTILE_KEYS) {
    dist[key] = level;
  }
  dist.min = Math.min(100, level);
  return dist;
}

/** Expands a recorded series into the {@link FeeSnapshot}s the scheduler takes. */
export function loadFeeSeries(name: string): FeeSnapshot[] {
  const series = getSeries(name);
  return series.sorobanP50.map((level, index) => ({
    ledger: 3_730_870 + index,
    observedAt: series.startedAtMs + index * FIXTURE.meta.cadenceMs,
    soroban: distributionAt(level),
    classic: { ...FIXTURE.baselineClassic },
  }));
}

/** Unix seconds of the series' first sample. */
export function seriesStartSeconds(name: string): number {
  return Math.floor(getSeries(name).startedAtMs / 1000);
}
