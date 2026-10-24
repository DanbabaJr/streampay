import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  decimalSeparatorFor,
  formatStroops,
  formatTokenAmount,
  localeShape,
  parseStroops,
  parseTokenAmount,
} from "./amounts.ts";

/**
 * The Stellar trap this file exists to close: a token amount is a 7-decimal
 * integer, locale display must not lose the 7th decimal, and locale input
 * parsing must not silently round or mis-read a comma.
 *
 * `stroops` = 10^-7 of a unit, so `1.2345678` units is `12_345_678n`.
 */

describe("locale shapes read out of Intl", () => {
  it("en uses dot-decimal and comma-grouping", () => {
    const shape = localeShape("en");
    assert.equal(shape.decimal, ".");
    assert.equal(shape.grouping, ",");
    assert.equal(shape.primaryGroup, 3);
  });

  it("de uses comma-decimal and dot-grouping", () => {
    const shape = localeShape("de");
    assert.equal(shape.decimal, ",");
    assert.equal(shape.grouping, ".");
  });

  it("exposes the separator actually used, for input hints", () => {
    assert.equal(decimalSeparatorFor("en"), ".");
    assert.equal(decimalSeparatorFor("de"), ",");
  });
});

describe("formatStroops keeps every digit", () => {
  it("renders the 7th decimal exactly instead of rounding it away", () => {
    assert.equal(formatStroops(1n, "en"), "0.0000001");
    assert.equal(formatStroops(12_345_678n, "en"), "1.2345678");
    assert.equal(formatStroops(12_345_678n, "de"), "1,2345678");
  });

  it("matches the locale-free machine form exactly", () => {
    for (const stroops of ["0", "1", "9999999", "10000000", "123456789012345678"]) {
      assert.equal(
        formatStroops(stroops, "en", { useGrouping: false }),
        formatTokenAmount(stroops, { locale: "en", decimals: 7, useGrouping: false })
      );
    }
  });

  it("survives magnitudes a float cannot represent", () => {
    // Above Number.MAX_SAFE_INTEGER the old `Number(x)/1e7` path silently lost
    // the last digit; BigInt division cannot.
    const huge = 90_071_992_547_409_933n;
    assert.equal(formatStroops(huge, "en", { useGrouping: false }), "9007199254.7409933");
    assert.notEqual(formatStroops(huge, "en", { useGrouping: false }), String(Number(huge) / 1e7));
  });

  it("groups with the locale's own separator and group size", () => {
    assert.equal(formatStroops(1_234_567_890_123n, "en"), "123,456.7890123");
    assert.equal(formatStroops(1_234_567_890_123n, "de"), "123.456,7890123");
  });

  it("pads to a fixed fraction for currency-style display", () => {
    assert.equal(formatStroops(15_000_000n, "de", { minFractionDigits: 2 }), "1,50");
    assert.equal(formatStroops(15_000_000n, "de", { minFractionDigits: 7 }), "1,5000000");
  });

  it("truncates only when the caller asks for display precision", () => {
    assert.equal(formatStroops(12_345_678n, "en", { maxFractionDigits: 2 }), "1.23");
    assert.equal(formatStroops(12_345_678n, "de", { maxFractionDigits: 4 }), "1,2345");
  });

  it("renders the locale's own minus sign", () => {
    assert.equal(formatStroops(-12_345_678n, "de"), "-1,2345678");
  });

  it("supports tokens with other decimal counts", () => {
    assert.equal(formatTokenAmount(12345n, { locale: "de", decimals: 2 }), "123,45");
    assert.equal(formatTokenAmount(12345n, { locale: "de", decimals: 0 }), "12.345");
  });
});

describe("parseStroops: comma vs dot, both directions", () => {
  const ok = (input: string, locale: string): bigint => {
    const result = parseStroops(input, locale);
    assert.equal(
      result.ok,
      true,
      `${input} in ${locale} failed: ${result.ok ? result.value : result.reason}`
    );
    return result.ok ? result.value : 0n;
  };

  it("reads the locale's own decimal separator", () => {
    assert.equal(ok("1,2345678", "de"), 12_345_678n);
    assert.equal(ok("1.2345678", "en"), 12_345_678n);
  });

  it("reads the *other* separator as decimal when it cannot be grouping", () => {
    // An American living in Germany types a dot; a German visitor types a comma.
    assert.equal(ok("1.5", "de"), 15_000_000n);
    assert.equal(ok("1,5", "en"), 15_000_000n);
    assert.equal(ok("0,25", "en"), 2_500_000n);
  });

  it("groups when the same number reads as a group in the other locale", () => {
    // 1 000 whole tokens = 10^10 stroops. `parseStroops` always answers in
    // smallest units, whatever the input's grouping style.
    assert.equal(ok("1.000", "de"), 10_000_000_000n);
    assert.equal(ok("1,000", "en"), 10_000_000_000n);
    assert.equal(ok("1.000.000", "de"), 10_000_000_000_000n);
    assert.equal(ok("1,000,000", "en"), 10_000_000_000_000n);
  });

  it("treats the locale's own decimal character as authoritative", () => {
    // In `de`, `,` is decimal even though `1,000` would group in `en`.
    assert.equal(ok("1,000", "de"), 10_000_000n);
    assert.equal(ok("1,500", "de"), 15_000_000n);
    // And in `en`, `.` is decimal even though `1.000` would group in `de`.
    assert.equal(ok("1.000", "en"), 10_000_000n);
  });

  it("prefers the rightmost separator when both are present", () => {
    // 1234.56789 whole tokens = 12_345_678_900 stroops.
    const expected = 12_345_678_900n;
    assert.equal(ok("1.234,56789", "de"), expected);
    assert.equal(ok("1,234.56789", "en"), expected);
    // Cross-typed: European style on an `en` locale, US style on `de`.
    assert.equal(ok("1.234,56789", "en"), expected);
    assert.equal(ok("1,234.56789", "de"), expected);
  });

  it("accepts pasted space grouping", () => {
    assert.equal(ok("1 000 000", "en"), 10_000_000_000_000n);
    assert.equal(ok("1 000 000", "de"), 10_000_000_000_000n);
    assert.equal(ok("1 234,56", "de"), 12_345_600_000n);
  });

  it("round-trips every formatted value", () => {
    const values = [
      0n, 1n, 7n, 999n, 10_000_000n, 12_345_678n, 999_999_999n,
      1_000_000_000_000n, 9_007_199_254_740_993n, 834_329_466_065_555_555n,
    ];
    for (const locale of ["en", "de"]) {
      for (const value of values) {
        assert.equal(ok(formatStroops(value, locale), locale), value, `${value} in ${locale}`);
      }
    }
  });
});

describe("parseStroops refuses to guess", () => {
  const fail = (input: string, locale: string): string => {
    const result = parseStroops(input, locale);
    assert.equal(result.ok, false, `expected ${input} in ${locale} to fail`);
    return result.ok ? "" : result.reason;
  };

  it("never rounds away precision", () => {
    assert.equal(fail("1.12345678", "en"), "too-precise");
    assert.equal(fail("1,12345678", "de"), "too-precise");
    assert.equal(fail("0.00000001", "en"), "too-precise");
  });

  it("rejects malformed grouping instead of dropping digits", () => {
    assert.equal(fail("12,34.5", "en"), "bad-grouping");
    assert.equal(fail("1.2345,6", "de"), "bad-grouping");
    assert.equal(fail("1,234,56", "en"), "bad-grouping");
  });

  it("rejects two decimal separators", () => {
    assert.equal(fail("1.234.567", "en"), "ambiguous-separator");
    assert.equal(fail("1,234,567", "de"), "ambiguous-separator");
  });

  it("rejects junk, empties and exponents", () => {
    for (const input of ["", "   ", "abc", "1e7", "12x", "--3", "1..2"]) {
      assert.ok(!parseStroops(input, "en").ok, `${input} must not parse`);
    }
  });

  it("honours allowNegative", () => {
    assert.equal(parseStroops("-1,5", "de").ok, true);
    assert.deepEqual(parseStroops("-1,5", "de", { allowNegative: false }), {
      ok: false,
      reason: "negative-not-allowed",
    });
  });

  it("keeps a bare fraction valid", () => {
    const result = parseStroops(",5", "de");
    assert.deepEqual(result, { ok: true, value: 5_000_000n });
  });
});

describe("locales outside the dot/comma pair", () => {
  // `sv` groups with a space and separates with a comma; `ar-u-nu-arab` uses
  // Arabic-Indic digits *and* its own separators (٫ / ٬). Both are folded onto
  // the same precedence rules by `canonicalize`, so the one rule set above holds.
  const stroops = 1_234_567_890n;

  it("formats and re-reads space-grouped Swedish", () => {
    const formatted = formatStroops(stroops, "sv");
    assert.equal(formatted, "123,456789");
    assert.deepEqual(parseStroops(formatted, "sv"), { ok: true, value: stroops });
  });

  it("reads a dot typed by a Swedish user who has never seen the locale", () => {
    assert.deepEqual(parseStroops("1.5", "sv"), { ok: true, value: 15_000_000n });
  });

  it("formats and re-reads Arabic-Indic digits", () => {
    const formatted = formatStroops(stroops, "ar-u-nu-arab");
    assert.equal(formatted, "١٢٣٫٤٥٦٧٨٩");
    assert.deepEqual(parseStroops(formatted, "ar-u-nu-arab"), { ok: true, value: stroops });
  });

  it("uses the locale's real group sizes, not a hard-coded 3", () => {
    // `hi` groups 3 at the right then 2s: 12345678.9012345 -> 1,23,45,678.9012345
    assert.equal(formatStroops(123_456_789_012_345n, "hi"), "1,23,45,678.9012345");
  });
});

describe("fields that already ask for smallest units", () => {
  // `decimals: 0` means "the number the user typed *is* the integer": grouping
  // still works, fractions are refused. This is what a stroop-denominated input
  // uses, so a German entering 1.000.000 gets one million stroops, not 1.
  const input = (value: string, locale: string) =>
    parseTokenAmount(value, locale, { decimals: 0 });

  it("accepts locale grouping and rejects fractions", () => {
    assert.deepEqual(input("1.000.000", "de"), { ok: true, value: 1_000_000n });
    assert.deepEqual(input("1,000,000", "en"), { ok: true, value: 1_000_000n });
    assert.deepEqual(input("1000000", "de"), { ok: true, value: 1_000_000n });
    assert.deepEqual(input("1,5", "de"), { ok: false, reason: "too-precise" });
    assert.deepEqual(input("1.5", "en"), { ok: false, reason: "too-precise" });
  });
});

describe("parseTokenAmount with non-stroop tokens", () => {
  it("uses the caller's decimal count", () => {
    assert.deepEqual(parseTokenAmount("1,23", "de", { decimals: 2 }), { ok: true, value: 123n });
    // Three fraction digits on a 2-decimal token is a rejection, not a rounding.
    assert.deepEqual(parseTokenAmount("1,234", "de", { decimals: 2 }), {
      ok: false,
      reason: "too-precise",
    });
    // A 0-decimal token reads `1.000` in `de` as one thousand, not as 1.
    assert.deepEqual(parseTokenAmount("1.000", "de", { decimals: 0 }), { ok: true, value: 1000n });
    assert.deepEqual(parseTokenAmount("1,23", "de", { decimals: 0 }), {
      ok: false,
      reason: "too-precise",
    });
  });
});
