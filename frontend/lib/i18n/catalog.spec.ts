import { describe, expect, it } from "vitest";
import IntlMessageFormat from "intl-messageformat";
import { formatMessage, makeFormatter } from "./format";
import {
  CATALOGS,
  MESSAGE_KEYS,
  MESSAGE_SAMPLES,
  PARAMETERIZED_KEYS,
  en,
  de,
  type MessageKey,
} from "./messages";
import { SUPPORTED_LOCALES, localesFromAcceptLanguage, matchLocaleTag, resolveLocale } from "./locales";
import { COGNATE_SET } from "./messages/cognates";
import { describeParseFailure } from "./parse-error";
import {
  formatStroops,
  parseStroops,
  parseTokenAmount,
  type ParseFailure,
} from "./amounts";

/**
 * Snapshot suite per locale (issue #95).
 *
 * `.spec.ts` is the vitest half of this package's two-runner split: `node --test`
 * never discovers it, `vitest run` never discovers `*.test.ts`. See
 * vitest.config.mts.
 *
 * The snapshot is the regression net for *rendered output*, which is what a
 * translation review actually looks at: if someone rewrites a German message so
 * that it drops a placeholder or collapses a plural arm, the diff shows it.
 */

/**
 * Snapshot loops are dynamic over every key, so the per-key argument tuple that
 * `MessageArgs` enforces at real call sites cannot apply here. Samples come from
 * `MESSAGE_SAMPLES`, and a message whose placeholder has no sample throws in
 * development — which is what makes this loop a check rather than a no-op.
 */
const renderMessage = formatMessage as (
  locale: (typeof SUPPORTED_LOCALES)[number],
  key: MessageKey,
  params?: Record<string, unknown>
) => string;

function renderAll(locale: (typeof SUPPORTED_LOCALES)[number]): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const key of MESSAGE_KEYS) {
    const sample = (MESSAGE_SAMPLES as Record<string, unknown>)[key];
    rows[key] = sample
      ? renderMessage(locale, key, sample as Record<string, unknown>)
      : renderMessage(locale, key);
  }
  return rows;
}

describe("catalogs render per locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`matches the ${locale} snapshot`, () => {
      expect(renderAll(locale)).toMatchSnapshot();
    });
  }

  it("every key renders non-empty in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, rendered] of Object.entries(renderAll(locale))) {
        expect(rendered, `${locale}/${key}`).toBeTruthy();
        expect(rendered).not.toContain("undefined");
      }
    }
  });

  it("the German catalog is actually translated", () => {
    // A catalog that is a copy of English fails review; the exemptions live in
    // one shared allowlist (messages/cognates.ts).
    const identical = MESSAGE_KEYS.filter((key) => en[key] === de[key] && !COGNATE_SET.has(key));
    expect(identical).toEqual([]);
    expect(MESSAGE_KEYS.length).toBeGreaterThan(40);
  });
});

describe("ICU features the catalogs rely on", () => {
  it("pluralizes by grammatical number, not string concatenation", () => {
    expect(formatMessage("en", "home.discovered", { count: 0 })).toBe(
      "Discovered no streams on-chain."
    );
    expect(formatMessage("en", "home.discovered", { count: 1 })).toBe(
      "Discovered 1 stream on-chain."
    );
    expect(formatMessage("en", "home.discovered", { count: 12 })).toBe(
      "Discovered 12 streams on-chain."
    );
    // `#` is substituted with the locale-formatted count.
    expect(formatMessage("de", "home.discovered", { count: 2 })).toBe(
      "Auf der Chain 2 Streams gefunden."
    );
  });

  it("localizes the count inside the plural message", () => {
    // A thousands separator proves the number goes through Intl for the locale.
    expect(formatMessage("de", "home.discovered", { count: 12345 })).toBe(
      "Auf der Chain 12.345 Streams gefunden."
    );
  });

  it("selects a word by value", () => {
    expect(formatMessage("en", "pay.invoice.total", { amount: "10", unit: "tokens" })).toBe(
      "Total: 10 Tokens"
    );
    expect(formatMessage("de", "pay.invoice.total", { amount: "10", unit: "stroops" })).toBe(
      "Gesamt: 10 Einheiten"
    );
  });

  it("keeps a stroop amount exact through the message layer", () => {
    // The house rule: the amount arrives pre-formatted as a *string*, so ICU
    // cannot round it. 0.0000001 is the smallest possible claim.
    const stroops = 12_345_678n;
    const formatted = formatStroops(stroops, "de");
    expect(formatted).toBe("1,2345678");
    expect(formatMessage("de", "pay.action.claim", { amount: formatted })).toBe(
      "1,2345678 Tokens abheben"
    );
  });

  it("survives a magnitude above 2^53, where the float path loses a digit", () => {
    const huge = 90_071_992_547_409_933n;
    const message = formatMessage("en", "pay.action.claim", {
      amount: formatStroops(huge, "en", { useGrouping: false }),
    });
    expect(message).toBe("Claim 9007199254.7409933 Tokens");

    // The same value through the old `Number(stroops) / 1e7` display path: the
    // final digit is already wrong before ICU ever sees it.
    const viaFloat = String(Number(huge) / 1e7);
    expect(viaFloat).not.toBe("9007199254.7409933");
  });
});

describe("amount round-trip through the locale layer", () => {
  const cases = [0n, 1n, 10_000_000n, 12_345_678n, 999_999_999n, 834_329_466_065_555_555n];

  for (const locale of SUPPORTED_LOCALES) {
    it(`reads back what it wrote in ${locale}`, () => {
      for (const stroops of cases) {
        const parsed = parseStroops(formatStroops(stroops, locale), locale);
        expect(parsed, String(stroops)).toEqual({ ok: true, value: stroops });
      }
    });
  }
});

describe("locale detection", () => {
  it("matches a region subtag to its language", () => {
    expect(matchLocaleTag("de-AT")).toBe("de");
    expect(matchLocaleTag("DE-de")).toBe("de");
    expect(matchLocaleTag("en-GB")).toBe("en");
    expect(matchLocaleTag("pt-BR")).toBeNull();
  });

  it("orders Accept-Language by q-value and drops unsupported tags", () => {
    expect(localesFromAcceptLanguage("fr,de;q=0.9,en;q=0.8")).toEqual(["de", "en"]);
    expect(localesFromAcceptLanguage("en")).toEqual(["en"]);
    expect(localesFromAcceptLanguage(null)).toEqual([]);
  });

  it("prefers the stored choice over the browser", () => {
    expect(resolveLocale(["de", "en"])).toBe("de");
    expect(resolveLocale([null, "en"])).toBe("en");
    expect(resolveLocale(["", "fr"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });
});

describe("catalog key integrity", () => {
  it("declares a sample for every parameterized key", () => {
    for (const key of PARAMETERIZED_KEYS) {
      expect(MESSAGE_SAMPLES[key], key).toBeDefined();
    }
  });

  it("has no key in one catalog that is missing from the other", () => {
    const englishKeys = Object.keys(en).sort();
    const germanKeys = Object.keys(de).sort();
    expect(germanKeys).toEqual(englishKeys);
  });

  it("every message is a non-empty single line or an explicit multi-line string", () => {
    for (const key of MESSAGE_KEYS as MessageKey[]) {
      for (const catalog of [en, de]) {
        expect(typeof catalog[key]).toBe("string");
        expect(catalog[key].trim()).toBe(catalog[key]);
      }
    }
  });
});

describe("placeholder contract (the CI untranslated-key gate)", () => {
  /**
   * ICU argument names are the only thing a translation must never change, so
   * they are read from the *parsed AST* rather than from a regex: a regex cannot
   * tell `{unit, select, tokens {Tokens} other {Einheiten}}`'s case bodies from
   * arguments, and a false match here would fail a correct translation.
   */
  function placeholders(pattern: string): string[] {
    const ast = new IntlMessageFormat(pattern).getAst();
    const names: string[] = [];
    const walk = (nodes: readonly unknown[]): void => {
      for (const raw of nodes) {
        const node = raw as { type?: number; value?: unknown; options?: Record<string, { value?: unknown[] }> };
        // TYPE.literal (0) carries text, not an argument name.
        if (node.type !== 0 && typeof node.value === "string" && /^[A-Za-z_]\w*$/.test(node.value)) {
          names.push(node.value);
        }
        if (node.options) {
          for (const option of Object.values(node.options)) walk(option.value ?? []);
        }
      }
    };
    walk(ast);
    return [...new Set(names)].sort();
  }

  it("every locale uses exactly the English placeholder names", () => {
    for (const key of MESSAGE_KEYS) {
      const expected = placeholders(en[key]);
      for (const locale of SUPPORTED_LOCALES) {
        expect(placeholders(CATALOGS[locale][key]), `${locale}/${key}`).toEqual(expected);
      }
    }
  });

  it("every message parses as ICU in every locale it is used in", () => {
    // A translator who unbalances a brace fails here rather than at render time.
    for (const key of MESSAGE_KEYS) {
      for (const locale of SUPPORTED_LOCALES) {
        expect(() => new IntlMessageFormat(CATALOGS[locale][key], locale), `${locale}/${key}`).not.toThrow();
      }
    }
  });

  it("declares a parameter type for exactly the keys that interpolate", () => {
    // `MessageParams` is what makes a call site pass `amount` as a *string*;
    // a new `{placeholder}` without a declaration would silently format as
    // "undefined" in production, so the sets must be equal.
    const interpolating = MESSAGE_KEYS.filter((key) => placeholders(en[key]).length > 0);
    expect(interpolating.sort()).toEqual([...PARAMETERIZED_KEYS].sort());
  });

  it("reports untranslated keys outside the cognate allowlist", () => {
    const untranslated = MESSAGE_KEYS.filter(
      (key) => !COGNATE_SET.has(key) && SUPPORTED_LOCALES.some((locale) => locale !== "en" && CATALOGS[locale][key] === en[key])
    );
    expect(untranslated).toEqual([]);
  });
});

describe("every rejection reason has a message, in every locale", () => {
  /**
   * `parseTokenAmount` refuses rather than guessing (see amounts.ts), so a
   * refusal with no message is a dead end for the user. This list is every
   * member of `ParseFailure`, and `describeParseFailure` has no `default:` —
   * adding a reason to the parser without writing its message is a compile
   * error, which is the point of keeping the mapping in one switch.
   */
  const REASONS = [
    "empty",
    "invalid-character",
    "ambiguous-separator",
    "bad-grouping",
    "too-precise",
    "negative-not-allowed",
  ] as const satisfies readonly ParseFailure[];

  const messagesFor = (locale: (typeof SUPPORTED_LOCALES)[number]) =>
    REASONS.map((reason) =>
      describeParseFailure(makeFormatter(locale), reason, {
        input: "1,234.56",
        locale,
        decimals: 0,
      })
    );

  it("renders non-empty and distinct text per reason", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = messagesFor(locale);
      for (const [index, message] of messages.entries()) {
        expect(message.length, `${locale}/${REASONS[index]}`).toBeGreaterThan(0);
        expect(message).not.toContain("undefined");
      }
      // Two reasons sharing a string means the user cannot tell them apart.
      expect(new Set(messages).size).toBe(REASONS.length);
    }
  });

  it("covers every reason the parser can return", () => {
    const reachable = new Set<ParseFailure>();
    const probes = ["", "abc", "1,234.567.89", "1,2345", "1,5", "-3", "1.5"];
    for (const probe of probes) {
      for (const locale of SUPPORTED_LOCALES) {
        // Smallest-unit field: the shape the create form actually uses.
        const result = parseTokenAmount(probe, locale, { decimals: 0, allowNegative: false });
        if (!result.ok) reachable.add(result.reason);
      }
    }
    for (const reason of reachable) {
      expect(REASONS as readonly string[], `no message for "${reason}"`).toContain(reason);
    }
  });

  it("names the reader's own separators, not English's", () => {
    // "use a dot for thousands" is wrong advice in German: the message
    // interpolates the characters of *this* locale.
    expect(messagesFor("de")[3]).toContain(".");
    expect(messagesFor("en")[3]).toContain(",");
    expect(messagesFor("de")[2]).toContain("„1,234.56“");
  });

  it("quotes the field's own precision back to the user", () => {
    const zero = describeParseFailure(makeFormatter("en"), "too-precise", {
      input: "1.5",
      locale: "en",
      decimals: 0,
    });
    expect(zero).toContain("at most 0 decimal");
    const seven = describeParseFailure(makeFormatter("en"), "too-precise", {
      input: "1.5",
      locale: "en",
      decimals: 7,
    });
    expect(seven).toContain("at most 7 decimal");
  });
});
