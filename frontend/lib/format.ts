/**
 * Formatting helpers for displaying Soroban / Stellar token amounts.
 */

/**
 * Formats a raw integer token amount (in stroops or smallest units) into
 * a human-readable decimal string using the asset's configured decimal places.
 *
 * Trailing zeros in the fractional part are trimmed. If the fractional part
 * is zero, only the whole integer is returned.
 *
 * Examples:
 *   formatAmount(10_000_000n, 7)    -> "1"
 *   formatAmount(1n, 7)             -> "0.0000001"
 *   formatAmount(12_345_678n, 7)    -> "1.2345678"
 *   formatAmount(0n, 7)             -> "0"
 *   formatAmount(-5_000_000n, 7)    -> "-0.5"
 *   formatAmount(100n, 0)           -> "100"
 */
export function formatAmount(
  raw: bigint | string | number,
  decimals: number
): string {
  const val = typeof raw === "bigint" ? raw : BigInt(raw);
  if (decimals <= 0) {
    return val.toString();
  }

  const neg = val < 0n;
  const abs = neg ? -val : val;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");

  return `${neg ? "-" : ""}${whole}${fracStr ? `.${fracStr}` : ""}`;
}

/**
 * Formats a token amount alongside its asset symbol/code.
 *
 * Example:
 *   formatAmountWithSymbol(10_000_000n, 7, "XLM") -> "1 XLM"
 */
export function formatAmountWithSymbol(
  raw: bigint | string | number,
  decimals: number,
  symbol?: string
): string {
  const formatted = formatAmount(raw, decimals);
  return symbol ? `${formatted} ${symbol}` : formatted;
}
