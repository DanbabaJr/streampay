/**
 * Locale-aware, precision-preserving token amount formatting and parsing.
 *
 * This module exists because a Stellar amount is a 7-decimal integer (stroops)
 * and the usual tools destroy it:
 *
 *   - `Number(1_234_567n) / 1e7` is a float; `0.1234567` survives, but
 *     `9007199254740993 / 1e7` does not, and any value above 2^53 stroops
 *     (~9.0e16 tokens) silently loses its last digits.
 *   - `new Intl.NumberFormat(locale).format(theFloat)` rounds to the
 *     formatting precision, so it cannot even be repaired afterwards.
 *   - `parseFloat("1 234,5")` throws or mis-reads depending on the locale.
 *
 * The rule this file enforces: **the value never leaves `BigInt`.** `Intl` is
 * consulted only for the *shape* of a locale (separators, group sizes, digit
 * glyphs) by probing fixed integers whose exactness is guaranteed; the actual
 * digits are then laid out by hand. Parsing is the mirror image — it splits on
 * the locale's shape and returns stroops, and rejects input it would have to
 * round instead of guessing.
 *
 * See docs/I18N.md for the comma-vs-dot precedence rules and lib/i18n/amounts.test.ts
 * for the proofs.
 */

import type { Locale } from "./locales";

/** Stellar's native asset has 7 decimal places; so does Soroban USDC here. */
export const STROOP_DECIMALS = 7;

export interface AmountFormatOptions {
  readonly locale: Locale | string;
  /** Decimal places the raw integer is scaled by. Defaults to 7 (stroops). */
  readonly decimals?: number;
  /** Fraction digits kept even when they are zero (currency-style display). */
  readonly minFractionDigits?: number;
  /** Truncate the exact fraction to this many digits (display only, never for amounts to sign). */
  readonly maxFractionDigits?: number;
  /** Insert the locale's grouping separator. Default true. */
  readonly useGrouping?: boolean;
}

export type ParseFailure =
  | "empty"
  | "invalid-character"
  | "ambiguous-separator"
  | "bad-grouping"
  | "too-precise"
  | "negative-not-allowed";

export type ParseResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: ParseFailure };

export interface LocaleShape {
  readonly decimal: string;
  readonly grouping: string;
  readonly minus: string;
  readonly primaryGroup: number;
  readonly secondaryGroup: number;
  /** Index i holds the glyph this locale renders for the ASCII digit i. */
  readonly digitGlyphs: readonly string[];
}

const shapeCache = new Map<string, LocaleShape>();

/** Space-like characters a user may paste in place of a grouping separator. */
const SPACE_LIKE = ["\u00A0", "\u2009", "\u202F", "\u2007"];

function buildShape(locale: Locale | string): LocaleShape {
  const nf = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 1 });
  // 12 digits is enough to expose a secondary grouping size (hi-IN), and every
  // probe value below is exactly representable as a Number, so Intl's own
  // rounding can never distort the shape we are reading out of it.
  const parts = nf.formatToParts(123456789012.5);

  let decimal = ".";
  let grouping = ",";
  let minus = "-";
  for (const part of parts) {
    if (part.type === "decimal") decimal = part.value;
    else if (part.type === "group") grouping = part.value;
    else if (part.type === "minusSign") minus = part.value;
  }

  const digitGlyphs = Array.from({ length: 10 }, (_, i) => {
    const glyphParts = new Intl.NumberFormat(locale, { useGrouping: false }).formatToParts(i);
    return glyphParts.find((p) => p.type === "integer")?.value ?? String(i);
  });

  // Recover the group sizes by stripping the locale's own glyphs back to ASCII.
  const toAscii = (input: string) => {
    let out = "";
    for (const ch of input) {
      const index = digitGlyphs.indexOf(ch);
      out += index >= 0 ? String(index) : ch;
    }
    return out;
  };
  const grouped = toAscii(
    parts.filter((p) => p.type === "integer" || p.type === "group").map((p) => p.value).join("")
  );
  const segments = grouped.split(grouping);
  const primaryGroup = segments[segments.length - 1]?.length ?? 3;
  const secondaryGroup = segments.length > 1 ? (segments[segments.length - 2]?.length ?? primaryGroup) : primaryGroup;

  return {
    decimal,
    grouping,
    minus,
    primaryGroup: Math.max(1, primaryGroup),
    secondaryGroup: Math.max(1, secondaryGroup),
    digitGlyphs,
  };
}

export function localeShape(locale: Locale | string): LocaleShape {
  const cached = shapeCache.get(locale);
  if (cached) return cached;
  const shape = buildShape(locale);
  shapeCache.set(locale, shape);
  return shape;
}

/** Maps an ASCII digit string into the locale's own digit glyphs. */
function toLocaleDigits(ascii: string, shape: LocaleShape): string {
  if (shape.digitGlyphs[0] === "0") return ascii;
  let out = "";
  for (const ch of ascii) {
    const index = ch.charCodeAt(0) - 48;
    out += index >= 0 && index <= 9 ? shape.digitGlyphs[index] : ch;
  }
  return out;
}

function groupIntegerDigits(digits: string, shape: LocaleShape): string {
  const { primaryGroup, secondaryGroup, grouping } = shape;
  if (digits.length <= primaryGroup) return digits;
  const chunks: string[] = [];
  let end = digits.length;
  let size = primaryGroup;
  while (end > 0) {
    const start = Math.max(0, end - size);
    chunks.unshift(digits.slice(start, end));
    end = start;
    size = secondaryGroup;
  }
  return chunks.join(grouping);
}

/**
 * Formats an integer amount in the token's smallest unit as a localized,
 * exact decimal string. BigInt all the way through: no digit is ever produced
 * by floating-point arithmetic, so the 7th decimal survives a value of any size.
 */
export function formatTokenAmount(raw: bigint | string, options: AmountFormatOptions): string {
  const shape = localeShape(options.locale);
  const decimals = options.decimals ?? STROOP_DECIMALS;
  const useGrouping = options.useGrouping ?? true;

  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;

  let whole: string;
  let exactFraction: string;
  if (decimals <= 0) {
    whole = abs.toString();
    exactFraction = "";
  } else {
    const divisor = 10n ** BigInt(decimals);
    whole = (abs / divisor).toString();
    exactFraction = (abs % divisor).toString().padStart(decimals, "0");
  }

  const maxFraction = Math.min(options.maxFractionDigits ?? decimals, decimals);
  const minFraction = Math.min(options.minFractionDigits ?? 0, maxFraction);
  let fraction = exactFraction.slice(0, maxFraction).replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");

  const groupedWhole = useGrouping ? groupIntegerDigits(whole, shape) : whole;
  const body = fraction ? `${groupedWhole}${shape.decimal}${fraction}` : groupedWhole;
  return `${negative ? shape.minus : ""}${toLocaleDigits(body, shape)}`;
}

/** `formatTokenAmount` specialised to stroops — the common case in this app. */
export function formatStroops(
  raw: bigint | string,
  locale: Locale | string,
  options: Omit<AmountFormatOptions, "locale" | "decimals"> = {}
): string {
  return formatTokenAmount(raw, { ...options, locale, decimals: STROOP_DECIMALS });
}

/**
 * Localizes an ordinary finite number (percentages, durations, counts).
 * Deliberately separate from `formatTokenAmount`: this one *may* go through
 * `Intl`, because nothing here is a signed amount.
 */
export function formatNumber(
  value: number,
  locale: Locale | string,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatPercent(value: number, locale: Locale | string, digits = 0): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value / 100);
}

export function formatDateTime(unixSeconds: number, locale: Locale | string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(unixSeconds * 1000));
}

export function formatDate(unixSeconds: number, locale: Locale | string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(unixSeconds * 1000)
  );
}

/**
 * Normalizes locale digit glyphs, spaces and minus signs down to ASCII, and
 * folds the locale's separators onto the two characters the precedence rules
 * reason about: `.` always means "this is the locale's decimal separator" and
 * `,` always means "this is the locale's grouping separator". Locales whose real
 * separators are those two characters (`en`, `de`) pass through untouched; a
 * locale with Arabic-Indic separators (`ar`, `٫` and `٬`) or a space grouping
 * (`sv`) is normalized into the same alphabet, so one rule set covers them all.
 */
function canonicalize(input: string, shape: LocaleShape): string {
  const decimalIsAscii = shape.decimal === "." || shape.decimal === ",";
  const groupingIsAscii = shape.grouping === "." || shape.grouping === ",";

  let out = "";
  for (const ch of input.trim()) {
    const digit = shape.digitGlyphs.indexOf(ch);
    if (digit >= 0) {
      out += String(digit);
      continue;
    }
    if (ch === shape.minus || ch === "-") out += "-";
    else if (ch === shape.decimal) out += decimalIsAscii ? ch : ".";
    else if (ch === shape.grouping) out += groupingIsAscii ? ch : "";
    else if (ch === " " || SPACE_LIKE.includes(ch)) out += groupingIsAscii ? shape.grouping : "";
    else out += ch;
  }
  return out;
}

/**
 * Parses user input into an integer amount in the token's smallest unit.
 *
 * Separator precedence, `D` = the locale's decimal separator and `G` its
 * grouping separator (full table and rationale in docs/I18N.md):
 *   1. Both `.` and `,` present → the **rightmost** is the decimal separator and
 *      the other is grouping. A number cannot have two decimal points, so this
 *      is never a guess: `1.234,56` and `1,234.56` both read as 1234.56 in
 *      *either* locale, so a German typing US style and an American typing
 *      European style both get the number they meant.
 *   2. One character repeated → grouping, and every group after the first must
 *      be exactly 3 digits. A repeated decimal separator is refused, not guessed.
 *   3. One character, once, and it is `D` → decimal. `D` beats the heuristic.
 *   4. One character, once, and it is `G` → grouping when exactly 3 digits follow
 *      it, decimal otherwise. So `1.000` in `de` is one thousand while `1.00` is
 *      one: for a stroop integer, a 3-digit group is the common case and a
 *      3-digit fraction is the rare one.
 *   5. One character, once, that is neither `D` nor `G` (e.g. `.` in `sv`, whose
 *      separators are `,` and a space) → decimal. `"1,5"` in `en` and `"1.5"` in
 *      `de` both mean one and a half.
 *
 * Precision is never traded away: more than `decimals` fraction digits is a
 * `too-precise` failure, because rounding here would change the amount the user
 * is about to sign for.
 */
export function parseTokenAmount(
  input: string,
  locale: Locale | string,
  options: { readonly decimals?: number; readonly allowNegative?: boolean } = {}
): ParseResult {
  const decimals = options.decimals ?? STROOP_DECIMALS;
  const shape = localeShape(locale);
  const text = canonicalize(input, shape);
  if (!text) return { ok: false, reason: "empty" };

  const negative = text.startsWith("-");
  if (negative && options.allowNegative === false) return { ok: false, reason: "negative-not-allowed" };

  const body = negative ? text.slice(1) : text;
  if (!body) return { ok: false, reason: "empty" };
  if (!/^[\d.,]+$/.test(body)) return { ok: false, reason: "invalid-character" };

  const dotCount = body.split(".").length - 1;
  const commaCount = body.split(",").length - 1;
  const lastIndex = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));

  let integerDigits: string;
  let fractionDigits: string;

  if (lastIndex < 0) {
    integerDigits = body;
    fractionDigits = "";
  } else if (dotCount > 0 && commaCount > 0) {
    // Rule 1: with both characters present the rightmost one is the only
    // possible decimal separator, so no heuristic is involved.
    const decimalChar = body[lastIndex];
    const groupingChar = decimalChar === "." ? "," : ".";
    const head = body.slice(0, lastIndex);
    if (!validGroups(head, groupingChar)) return { ok: false, reason: "bad-grouping" };
    integerDigits = head.split(groupingChar).join("");
    fractionDigits = body.slice(lastIndex + 1);
  } else {
    const char = body[lastIndex];
    const tail = body.slice(lastIndex + 1);
    const repeated = (char === "." ? dotCount : commaCount) > 1;
    const isDecimalChar = char === shape.decimal;
    const isGroupingChar = char === shape.grouping;

    if (repeated && isDecimalChar) return { ok: false, reason: "ambiguous-separator" };
    // Rule 2: a repeated character can only be grouping. Rule 3: the locale's own
    // decimal character always wins over the triplet heuristic. Rule 4: otherwise
    // a single trailing triplet groups and anything else is a decimal point
    // (rules 4 and 5 are the same branch — `!isDecimalChar` covers a character
    // that is neither `D` nor `G`, e.g. `.` in `sv`).
    const asGrouping = repeated || (!isDecimalChar && isGroupingChar && tail.length === 3);

    if (asGrouping) {
      if (!validGroups(body, char)) return { ok: false, reason: "bad-grouping" };
      integerDigits = body.split(char).join("");
      fractionDigits = "";
    } else {
      integerDigits = body.slice(0, lastIndex);
      fractionDigits = tail;
    }
  }

  if (integerDigits === "" && fractionDigits === "") return { ok: false, reason: "empty" };
  if (!/^\d*$/.test(integerDigits) || !/^\d*$/.test(fractionDigits)) {
    return { ok: false, reason: "invalid-character" };
  }
  if (fractionDigits.length > decimals) return { ok: false, reason: "too-precise" };

  const paddedFraction = fractionDigits.padEnd(decimals, "0");
  const value = BigInt(`${integerDigits || "0"}${paddedFraction}`);
  return { ok: true, value: negative ? -value : value };
}

/** True when `head` is 1..3 digits followed by zero or more exact 3-digit groups. */
function validGroups(head: string, groupingChar: string): boolean {
  if (head === "") return false;
  const groups = head.split(groupingChar);
  if (groups.some((group) => !/^\d+$/.test(group))) return false;
  if (groups.length === 1) return true;
  if (groups[0]!.length > 3) return false;
  return groups.slice(1).every((group) => group.length === 3);
}

/**
 * `parseTokenAmount` specialised to stroops: the input is read as a whole-token
 * amount (`1,23` in `de` is 1.23 tokens) and the answer is the stroop integer
 * (12_300_000n). For a field that already asks the user for smallest units, pass
 * `{ decimals: 0 }` to `parseTokenAmount` instead — the grouping rules still apply.
 */
export function parseStroops(
  input: string,
  locale: Locale | string,
  options: { readonly allowNegative?: boolean } = {}
): ParseResult {
  return parseTokenAmount(input, locale, { ...options, decimals: STROOP_DECIMALS });
}

/**
 * The locale's decimal separator as a single character, for `<input inputmode>`
 * hints and inline validation copy. Never infer it from the user's keystrokes.
 */
export function decimalSeparatorFor(locale: Locale | string): string {
  return localeShape(locale).decimal;
}

export function groupingSeparatorFor(locale: Locale | string): string {
  return localeShape(locale).grouping;
}
