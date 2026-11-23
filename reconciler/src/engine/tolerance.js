//! Rounding-tolerance and as-of alignment primitives shared by the
//! two-way and three-way reconciliation engines.

const SCALE = 10_000_000n; // Stellar assets carry 7 decimal places.
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal amount into integer stroops without floating point loss.
 * Returns null when the value is not a finite decimal.
 */
export function parseAmount(value) {
  if (typeof value === "bigint") return value * SCALE;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "0000000").slice(0, 7);
  let scaled = BigInt(whole) * SCALE + BigInt(padded || "0");
  if (fraction.length > 7) {
    const roundDigit = fraction.charCodeAt(7) - 48;
    if (roundDigit >= 5) scaled += 1n;
  }
  return sign === "-" ? -scaled : scaled;
}

export function formatAmount(scaled) {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / SCALE;
  const fraction = absolute % SCALE;
  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;
  const padded = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${padded}`;
}

/**
 * Amounts are equivalent when their difference fits inside the configured
 * rounding budget. `relativePpm` is parts-per-million of the larger value.
 */
export function amountsEquivalent(left, right, tolerance = {}) {
  const absolute = BigInt(tolerance.absolute ?? 0);
  const relativePpm = BigInt(tolerance.relativePpm ?? 0);
  const a = parseAmount(left);
  const b = parseAmount(right);
  if (a === null || b === null) return { equal: false, delta: null, tolerated: false };
  const delta = a > b ? a - b : b - a;
  const largest = (a < 0n ? -a : a) > (b < 0n ? -b : b) ? (a < 0n ? -a : a) : (b < 0n ? -b : b);
  const budget = largest * relativePpm / 1_000_000n > absolute
    ? largest * relativePpm / 1_000_000n
    : absolute;
  return {
    equal: delta <= budget,
    delta: delta.toString(),
    budget: budget.toString(),
    tolerated: delta > 0n && delta <= budget,
  };
}

const STATUS_ALIASES = new Map([
  ["active", "Active"],
  ["cancelled", "Cancelled"],
  ["canceled", "Cancelled"],
  ["depleted", "Depleted"],
  ["paused", "Paused"],
]);

export function normalizeStatus(value) {
  if (typeof value !== "string") return value;
  return STATUS_ALIASES.get(value.trim().toLowerCase()) ?? value;
}

export function statusesEquivalent(left, right) {
  return normalizeStatus(left) === normalizeStatus(right);
}

const COMPARED_FIELDS = ["deposit", "withdrawn", "status"];

/**
 * Compare two stream records field by field. Amounts use the rounding
 * tolerance; statuses use the canonical vocabulary shared with the indexer.
 */
export function compareStates(left, right, tolerance = {}) {
  const fields = [];
  for (const field of COMPARED_FIELDS) {
    const a = left?.data?.[field];
    const b = right?.data?.[field];
    let comparison;
    if (field === "status") {
      const equal = statusesEquivalent(a, b);
      comparison = { field, left: a, right: b, equal, tolerated: false };
    } else {
      const result = amountsEquivalent(a, b, tolerance);
      comparison = {
        field,
        left: a,
        right: b,
        equal: result.equal,
        tolerated: result.tolerated,
        delta: result.delta,
        budget: result.budget,
      };
    }
    fields.push(comparison);
  }
  const mismatches = fields.filter((field) => !field.equal);
  return {
    equal: mismatches.length === 0,
    tolerated: mismatches.length === 0 && fields.some((field) => field.tolerated),
    fields,
    mismatches: mismatches.map((field) => field.field),
  };
}

/**
 * Decide whether a source snapshot can take part in the pinned comparison.
 * `lagLedgers` is how far the source trails the pinned ledger; negative means
 * the source has already advanced past the pinned point.
 */
export function alignToAsOf(snapshot, pinnedLedger, maxLagLedgers = 5) {
  const observed = snapshot.asOfLedger;
  if (!Number.isFinite(observed)) {
    return { aligned: false, reason: "unknown_as_of_ledger", lagLedgers: null };
  }
  const lagLedgers = pinnedLedger - observed;
  if (lagLedgers > maxLagLedgers) {
    return { aligned: false, reason: "behind_as_of", lagLedgers };
  }
  if (lagLedgers < -maxLagLedgers) {
    return { aligned: false, reason: "ahead_of_as_of", lagLedgers };
  }
  return {
    aligned: true,
    lagLedgers,
    lagging: lagLedgers > 0,
    ahead: lagLedgers < 0,
  };
}

export function pinLedger(snapshots, requested) {
  if (Number.isFinite(requested)) return requested;
  const observed = snapshots
    .filter((snapshot) => snapshot.available && Number.isFinite(snapshot.asOfLedger))
    .map((snapshot) => snapshot.asOfLedger);
  if (observed.length === 0) return null;
  return Math.max(...observed);
}
