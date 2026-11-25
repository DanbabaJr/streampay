// Forecast helpers: projected exhaustion, shortfall and runway. They reuse the
// simulator math so overlay and forecast can never disagree.
import { streamedAt, type StreamParams } from "./simulator";

export interface Forecast {
  /** Seconds from start until the deposit is fully streamed (equals duration for a linear stream). */
  exhaustionSeconds: bigint;
  /** Seconds remaining at `elapsed` (0 once exhausted). */
  runwaySeconds: bigint;
  /** Unstreamed balance at `elapsed`. */
  remaining: bigint;
  /** Amount a recipient obligation exceeds the deposit by, 0 if covered. */
  shortfall: bigint;
  /** Rounding: floor() drops < 1 unit per accrual query; max error in units. */
  maxRoundingErrorUnits: bigint;
}

export function forecast(p: StreamParams, elapsed: bigint, obligation: bigint = 0n): Forecast {
  const e = elapsed < 0n ? 0n : elapsed > p.duration ? p.duration : elapsed;
  const accrued = streamedAt(p.deposit, p.duration, e);
  return {
    exhaustionSeconds: p.duration,
    runwaySeconds: p.duration - e,
    remaining: p.deposit - accrued,
    shortfall: obligation > p.deposit ? obligation - p.deposit : 0n,
    maxRoundingErrorUnits: 1n,
  };
}

export const FORECAST_CAVEATS: readonly string[] = [
  "Accrual is floored to whole token units, so any single reading can be up to 1 unit below the exact linear value.",
  "Runway assumes no withdrawals change the schedule, no top-ups and no cancellation.",
  "Hypothetical streams are simulated in your browser. Nothing is sent on-chain.",
  "Fees are estimates from the parameters you enter, not quotes from the network.",
];
