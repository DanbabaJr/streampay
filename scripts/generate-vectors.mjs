/**
 * Differential Vector Generator for StreamPay Accrual Math
 *
 * Reproducibly generates test vectors for `streamed_at` differential tests between
 * the TypeScript oracle (`frontend/lib/oracle.ts`) and the Soroban smart contract.
 *
 * Seed: 0xdeadbeef12345678n (XORShift64 PRNG)
 * Modes:
 *   --seed-only: writes the minimal curated regression/boundary corpus (~50 vectors)
 *   (default / --all): generates the full suite including boundary combinations and PRNG fuzz vectors
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Exact contract specification for `streamed_at` (from stream.rs):
//   if elapsed == 0 || deposit <= 0 || duration == 0 { return Ok(0); }
//   product = (deposit as u128) * (elapsed as u128) -> fail if > u128::MAX
//   streamed = min((product / duration), deposit)
function contractStreamedAt(depositStr, durationStr, elapsedStr) {
  const deposit = BigInt(depositStr);
  const duration = BigInt(durationStr);
  const elapsed = BigInt(elapsedStr);

  if (elapsed <= 0n || deposit <= 0n || duration <= 0n) {
    return { ok: "0" };
  }

  const u128Max = (1n << 128n) - 1n;
  const product = deposit * elapsed;
  if (product > u128Max) {
    return { err: "MathOverflow" };
  }

  const streamed = product / duration;
  const clamped = streamed > deposit ? deposit : streamed;
  return { ok: clamped.toString() };
}

// 1. Curated boundary regression seeds (zero duration, end_time edges, i128 saturation, product overflows)
const SEED_CASES = [
  // Degenerate & zero-duration streams
  { deposit: "0", duration: "0", elapsed: "0" },
  { deposit: "0", duration: "100", elapsed: "50" },
  { deposit: "1000", duration: "0", elapsed: "0" },
  { deposit: "1000", duration: "0", elapsed: "10" },
  { deposit: "1000", duration: "100", elapsed: "0" },
  { deposit: "-100", duration: "100", elapsed: "50" },
  { deposit: "1000", duration: "100", elapsed: "-10" },

  // Exact boundary edges: elapsed vs duration
  { deposit: "1000", duration: "100", elapsed: "1" },
  { deposit: "1000", duration: "100", elapsed: "99" },
  { deposit: "1000", duration: "100", elapsed: "100" }, // elapsed == duration (100% streamed)
  { deposit: "1000", duration: "100", elapsed: "101" }, // elapsed > duration (clamped to deposit)
  { deposit: "1000", duration: "100", elapsed: "100000" }, // elapsed >> duration (clamped)

  // Standard linear milestones
  { deposit: "10000", duration: "100", elapsed: "25" }, // 25%
  { deposit: "10000", duration: "100", elapsed: "50" }, // 50%
  { deposit: "10000", duration: "100", elapsed: "75" }, // 75%
  { deposit: "3", duration: "10", elapsed: "1" }, // Floor division check: 3 * 1 / 10 = 0
  { deposit: "3", duration: "10", elapsed: "4" }, // Floor division check: 3 * 4 / 10 = 1

  // u64 & i128 saturation / extreme boundaries
  { deposit: "170141183460469231731687303715884105727", duration: "18446744073709551615", elapsed: "0" }, // i128::MAX, u64::MAX, 0
  { deposit: "170141183460469231731687303715884105727", duration: "18446744073709551615", elapsed: "1" }, // i128::MAX, u64::MAX, 1
  { deposit: "170141183460469231731687303715884105727", duration: "18446744073709551615", elapsed: "18446744073709551615" }, // Overflow: i128::MAX * u64::MAX > u128::MAX
  { deposit: "170141183460469231731687303715884105727", duration: "100", elapsed: "100" }, // Overflow on product
  { deposit: "85070591730234615865843651857942052863", duration: "1000", elapsed: "2" }, // (i128::MAX/2) * 2 fits in u128
  { deposit: "85070591730234615865843651857942052863", duration: "1000", elapsed: "5" }, // Overflow
  { deposit: "340282366920938463463374607431768211455", duration: "1000", elapsed: "1" }, // u128::MAX * 1 fits
  { deposit: "340282366920938463463374607431768211455", duration: "1000", elapsed: "2" }, // u128::MAX * 2 overflows

  // Sub-second rate & rounding boundary cases
  { deposit: "1", duration: "1000000000", elapsed: "999999999" }, // rounds down to 0
  { deposit: "1", duration: "1000000000", elapsed: "1000000000" }, // reaches 1
  { deposit: "9999999999", duration: "10000000000", elapsed: "9999999999" }, // (N-1)*(N-1)/N
];

function buildEntries(isSeedOnly) {
  const entries = [];

  for (const c of SEED_CASES) {
    const res = contractStreamedAt(c.deposit, c.duration, c.elapsed);
    entries.push({
      deposit: c.deposit,
      duration: c.duration,
      elapsed: c.elapsed,
      expected_result: res.ok ?? null,
      expected_error: res.err ?? null,
    });
  }

  if (isSeedOnly) {
    return entries;
  }

  // Combinatorial grid across key scales
  const deposits = [
    "-100", "-1", "0", "1", "100", "1000000", "10000000000",
    "170141183460469231731687303715884105727", // i128::MAX
    "85070591730234615865843651857942052863", // i128::MAX / 2
  ];
  const durations = ["0", "1", "2", "10", "100", "86400", "604800", "18446744073709551615"];
  const elapseds = ["0", "1", "2", "50", "100", "86400", "18446744073709551615"];

  for (const deposit of deposits) {
    for (const duration of durations) {
      for (const elapsed of elapseds) {
        const res = contractStreamedAt(deposit, duration, elapsed);
        entries.push({
          deposit,
          duration,
          elapsed,
          expected_result: res.ok ?? null,
          expected_error: res.err ?? null,
        });
      }
    }
  }

  // Reproducible PRNG fuzz cases with fixed seed 0xdeadbeef12345678n
  let seed = 0xdeadbeef12345678n;
  function nextBig() {
    seed ^= (seed << 13n) & 0xffffffffffffffffn;
    seed ^= seed >> 7n;
    seed ^= (seed << 17n) & 0xffffffffffffffffn;
    return seed;
  }

  for (let i = 0; i < 1500; i++) {
    const dLow = nextBig();
    const dHigh = nextBig() & 0x7fffffffffffffffn;
    const deposit = (dHigh << 64n) | dLow;
    const duration = nextBig();
    const elapsed = duration > 0n ? nextBig() % (duration * 2n) : nextBig();

    const dStr = deposit.toString();
    const durStr = duration.toString();
    const elStr = elapsed.toString();

    const res = contractStreamedAt(dStr, durStr, elStr);
    entries.push({
      deposit: dStr,
      duration: durStr,
      elapsed: elStr,
      expected_result: res.ok ?? null,
      expected_error: res.err ?? null,
    });
  }

  return entries;
}

const args = process.argv.slice(2);
const isSeedOnly = args.includes("--seed-only");
const entries = buildEntries(isSeedOnly);

const outDir = join(__dirname, "../tests/vectors");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "accrual_vectors.json");
writeFileSync(outPath, JSON.stringify(entries, null, 2), "utf-8");
console.log(
  `Generated ${entries.length} differential test vectors (${isSeedOnly ? "seed corpus" : "full corpus"}) to ${outPath}`
);
