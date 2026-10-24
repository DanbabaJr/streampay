import type {
  RateBucket,
  DurationBucket,
  PublicListingView,
  AnonymityFlag,
} from "./types.ts";

/**
 * Standard token decimals on Stellar (e.g. XLM is 7 decimals).
 */
export const DEFAULT_DECIMALS = 7;

/**
 * Compute the daily flow rate band from raw on-chain deposit and duration.
 * Flow rate is calculated as: (deposit / duration_seconds) * 86,400 seconds.
 */
export function computeRateBucket(
  depositRaw: string | bigint,
  durationSecs: number,
  decimals: number = DEFAULT_DECIMALS
): RateBucket {
  const deposit = BigInt(depositRaw);
  const duration = BigInt(Math.max(1, Math.floor(durationSecs)));
  const scale = 10n ** BigInt(decimals);

  // Daily flow in base units (scaled by 10^decimals)
  // dailyUnits = (deposit * 86400) / duration
  const dailyBaseUnits = (deposit * 86_400n) / duration;

  // Flow rate in human-readable whole tokens
  const dailyTokens = dailyBaseUnits / scale;

  if (dailyTokens < 10n) {
    return "RATE_MICRO";
  }
  if (dailyTokens < 100n) {
    return "RATE_LOW";
  }
  if (dailyTokens < 1000n) {
    return "RATE_MEDIUM";
  }
  if (dailyTokens < 10000n) {
    return "RATE_HIGH";
  }
  return "RATE_WHALE";
}

/**
 * Compute the duration band from stream duration in seconds.
 */
export function computeDurationBucket(durationSecs: number): DurationBucket {
  const sec = Math.max(0, Math.floor(durationSecs));

  const ONE_DAY = 86_400;
  const ONE_WEEK = 7 * ONE_DAY;      // 604,800
  const ONE_MONTH = 30 * ONE_DAY;    // 2,592,000
  const THREE_MONTHS = 90 * ONE_DAY; // 7,776,000

  if (sec < ONE_DAY) {
    return "DUR_FLASH";
  }
  if (sec < ONE_WEEK) {
    return "DUR_WEEK";
  }
  if (sec < ONE_MONTH) {
    return "DUR_MONTH";
  }
  if (sec < THREE_MONTHS) {
    return "DUR_QUARTER";
  }
  return "DUR_LONG";
}

/**
 * Deterministic equivalence class identifier: asset + rateBucket + durationBucket.
 */
export function computeEquivalenceClass(
  asset: string,
  rateBucket: RateBucket,
  durationBucket: DurationBucket
): string {
  return `${asset.toLowerCase()}::${rateBucket}::${durationBucket}`;
}

/**
 * Coarsen a Unix epoch timestamp (seconds) to a UTC calendar date string (YYYY-MM-DD).
 * Purges hours, minutes, and seconds to mitigate block-time correlation attacks.
 */
export function coarsenToUtcDay(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return date.toISOString().slice(0, 10);
}

/**
 * Annotates listings with dynamic k-anonymity set sizes and privacy flags.
 * Equivalence class is partitioned across all active listings.
 */
export function applyKAnonymity(
  listings: PublicListingView[],
  kThreshold: number
): PublicListingView[] {
  const counts = new Map<string, number>();

  for (const listing of listings) {
    const key = computeEquivalenceClass(
      listing.asset,
      listing.rateBucket,
      listing.durationBucket
    );
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return listings.map((listing) => {
    const key = computeEquivalenceClass(
      listing.asset,
      listing.rateBucket,
      listing.durationBucket
    );
    const size = counts.get(key) || 1;
    const flag: AnonymityFlag = size >= kThreshold ? "normal" : "low";

    return {
      ...listing,
      anonymitySetSize: size,
      anonymityFlag: flag,
    };
  });
}
