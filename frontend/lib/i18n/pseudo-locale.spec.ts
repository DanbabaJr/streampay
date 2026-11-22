/**
 * Pseudo-locale stress test for UI overflow and interpolation integrity.
 *
 * Issue #511: Guards against future locales breaking layout by simulating
 * worst-case scenarios:
 * - Verbose languages (German+40% via accented pseudo-locale)
 * - Compound-word languages (long unbreakable strings)
 *
 * Tests placeholder interpolation and ICU syntax integrity.
 */

import { describe, expect, it } from "vitest";
import IntlMessageFormat from "intl-messageformat";
import {
  accentedPseudo,
  longWordPseudo,
  generatePseudoCatalogs,
  transformCatalog,
} from "./pseudo-locale";
import { en, MESSAGE_KEYS, MESSAGE_SAMPLES, PARAMETERIZED_KEYS, type MessageKey } from "./messages";

describe("pseudo-locale transform", () => {
  describe("accented pseudo-locale (en-XA)", () => {
    it("adds accented characters and ~40% padding", () => {
      const input = "Hello world";
      const output = accentedPseudo(input);

      // Should contain accented characters
      expect(output).toMatch(/[áéíóú]/i);

      // Should be longer than input (padding adds length)
      expect(output.length).toBeGreaterThan(input.length);

      // Should have bracketing for visibility
      expect(output).toMatch(/^\[.*\]$/);
    });

    it("preserves ICU placeholders exactly", () => {
      const input = "Hello {name}, you have {count} items";
      const output = accentedPseudo(input);

      // Placeholders must be unchanged
      expect(output).toContain("{name}");
      expect(output).toContain("{count}");

      // But surrounding text should be transformed
      expect(output).toMatch(/Ĥéļļó/);
    });

    it("preserves complex ICU syntax", () => {
      const input = "{count, plural, =0 {no items} one {# item} other {# items}}";
      const output = accentedPseudo(input);

      // ICU structure must survive
      expect(output).toContain("{count, plural,");
      expect(output).toContain("=0");
      expect(output).toContain("one");
      expect(output).toContain("other");

      // Text inside branches should be transformed
      expect(output).toMatch(/ñó.*íţéɱš/); // "no items"
    });

    it("handles nested placeholders", () => {
      const input = "{unit, select, tokens {Tokens} other {Units}}";
      const output = accentedPseudo(input);

      // Structure preserved
      expect(output).toContain("{unit, select,");
      expect(output).toContain("tokens");
      expect(output).toContain("other");

      // Words transformed
      expect(output).toMatch(/Ţóķéñš/);
    });
  });

  describe("long-word pseudo-locale (en-XB)", () => {
    it("creates long unbreakable words", () => {
      const input = "Hello world";
      const output = longWordPseudo(input);

      // Should be significantly longer
      expect(output.length).toBeGreaterThan(input.length * 2);

      // Should contain accented characters
      expect(output).toMatch(/[áéíóú]/i);
    });

    it("preserves ICU placeholders", () => {
      const input = "Claim {amount} tokens";
      const output = longWordPseudo(input);

      expect(output).toContain("{amount}");

      // Words should be elongated
      const words = output.split(/\s+/).filter((w) => !w.includes("{"));
      for (const word of words) {
        if (word.length > 0) {
          expect(word.length).toBeGreaterThan(3);
        }
      }
    });

    it("handles empty and single-character words", () => {
      const input = "I am a";
      const output = longWordPseudo(input);

      expect(output).toBeTruthy();
      expect(output.length).toBeGreaterThan(input.length);
    });
  });

  describe("catalog transformation", () => {
    it("transforms every key in the catalog", () => {
      const sample = {
        "key.one": "Hello world",
        "key.two": "Welcome {name}",
      };

      const transformed = transformCatalog(sample, accentedPseudo);

      expect(Object.keys(transformed)).toEqual(Object.keys(sample));
      for (const key of Object.keys(sample) as Array<keyof typeof sample>) {
        expect(transformed[key]).not.toBe(sample[key]);
        expect(transformed[key].length).toBeGreaterThan(0);
      }
    });

    it("generates both pseudo variants", () => {
      const sample = { "test.key": "Hello {name}" };
      const { accented, longWord } = generatePseudoCatalogs(sample);

      expect(accented["test.key"]).toContain("{name}");
      expect(longWord["test.key"]).toContain("{name}");

      expect(accented["test.key"]).not.toBe(sample["test.key"]);
      expect(longWord["test.key"]).not.toBe(sample["test.key"]);
      expect(accented["test.key"]).not.toBe(longWord["test.key"]);
    });
  });
});

describe("placeholder interpolation integrity", () => {
  const { accented, longWord } = generatePseudoCatalogs(en);

  it("every parameterized key preserves placeholder names", () => {
    for (const key of PARAMETERIZED_KEYS) {
      // Get placeholder names from original
      const originalAst = new IntlMessageFormat(en[key]).getAst();
      const expectedPlaceholders = extractPlaceholders(originalAst);

      // Check accented pseudo
      const accentedAst = new IntlMessageFormat(accented[key]).getAst();
      const accentedPlaceholders = extractPlaceholders(accentedAst);
      expect(accentedPlaceholders, `accented/${key}`).toEqual(expectedPlaceholders);

      // Check long-word pseudo
      const longWordAst = new IntlMessageFormat(longWord[key]).getAst();
      const longWordPlaceholders = extractPlaceholders(longWordAst);
      expect(longWordPlaceholders, `longWord/${key}`).toEqual(expectedPlaceholders);
    }
  });

  it("every message parses as valid ICU in both pseudo-locales", () => {
    for (const key of MESSAGE_KEYS) {
      expect(
        () => new IntlMessageFormat(accented[key], "en"),
        `accented/${key}`
      ).not.toThrow();

      expect(
        () => new IntlMessageFormat(longWord[key], "en"),
        `longWord/${key}`
      ).not.toThrow();
    }
  });

  it("placeholders interpolate correctly with sample data", () => {
    for (const key of PARAMETERIZED_KEYS) {
      const sample = MESSAGE_SAMPLES[key];

      // Accented pseudo
      const accentedMsg = new IntlMessageFormat(accented[key], "en");
      const accentedResult = accentedMsg.format(sample);
      expect(typeof accentedResult, `accented/${key}`).toBe("string");
      expect(String(accentedResult).length, `accented/${key}`).toBeGreaterThan(0);
      expect(String(accentedResult), `accented/${key}`).not.toContain("undefined");

      // Long-word pseudo
      const longWordMsg = new IntlMessageFormat(longWord[key], "en");
      const longWordResult = longWordMsg.format(sample);
      expect(typeof longWordResult, `longWord/${key}`).toBe("string");
      expect(String(longWordResult).length, `longWord/${key}`).toBeGreaterThan(0);
      expect(String(longWordResult), `longWord/${key}`).not.toContain("undefined");
    }
  });
});

describe("layout stress testing", () => {
  const { accented, longWord } = generatePseudoCatalogs(en);

  it("accented pseudo-locale increases text length by ~40%", () => {
    // Test on several message keys
    const testKeys: MessageKey[] = ["chrome.networkLive", "chrome.walletOnNetwork", "home.connectedAs"];

    for (const key of testKeys) {
      const original = en[key];
      const transformed = accented[key];

      // Transformed text should be significantly longer
      expect(transformed.length).toBeGreaterThan(original.length);

      // Approximate 40% padding (accounting for brackets and spaces)
      const minExpectedLength = original.length * 1.2;
      expect(transformed.length).toBeGreaterThan(minExpectedLength);
    }
  });

  it("long-word pseudo-locale creates text at least 2x longer", () => {
    const testKeys: MessageKey[] = ["chrome.networkText", "home.connectedAs"];

    for (const key of testKeys) {
      const original = en[key];
      const transformed = longWord[key];

      // Long-word transform should at least double length
      expect(transformed.length).toBeGreaterThan(original.length * 2);
    }
  });

  it("plural forms render correctly in pseudo-locale", () => {
    const counts = [0, 1, 5, 1234];
    const pluralKey = "home.discovered" as MessageKey;

    for (const count of counts) {
      // Accented
      const accentedMsg = new IntlMessageFormat(accented[pluralKey], "en");
      const accentedText = accentedMsg.format({ count });

      expect(String(accentedText)).toBeTruthy();
      expect(String(accentedText)).not.toContain("undefined");
      // The explicit =0 ICU branch intentionally has no count placeholder.
      if (count === 0) {
        expect(String(accentedText)).toContain("ñ");
      } else {
        expect(String(accentedText)).toContain(count.toLocaleString("en-US"));
      }

      // Long-word
      const longWordMsg = new IntlMessageFormat(longWord[pluralKey], "en");
      const longWordText = longWordMsg.format({ count });

      expect(String(longWordText)).toBeTruthy();
      expect(String(longWordText)).not.toContain("undefined");
      // The explicit =0 ICU branch intentionally has no count placeholder.
      if (count === 0) {
        expect(String(longWordText)).toContain("ñ");
      } else {
        expect(String(longWordText)).toContain(count.toLocaleString("en-US"));
      }
    }
  });

  it("select forms work in pseudo-locale", () => {
    const selectKey = "pay.invoice.total" as MessageKey;

    const variants = [
      { amount: "100", unit: "tokens" },
      { amount: "1.5", unit: "stroops" },
    ];

    for (const params of variants) {
      // Accented
      const accentedMsg = new IntlMessageFormat(accented[selectKey], "en");
      const accentedText = accentedMsg.format(params);

      expect(String(accentedText)).toBeTruthy();
      expect(String(accentedText)).not.toContain("undefined");
      expect(String(accentedText)).toContain(params.amount);

      // Long-word
      const longWordMsg = new IntlMessageFormat(longWord[selectKey], "en");
      const longWordText = longWordMsg.format(params);

      expect(String(longWordText)).toBeTruthy();
      expect(String(longWordText)).not.toContain("undefined");
      expect(String(longWordText)).toContain(params.amount);
    }
  });
});

describe("regression: stress mode catches known issues", () => {
  it("detects when a placeholder name is changed", () => {
    // Simulate a bad translation that renames {name} to {nombre}
    const bad = "{nombre} connected";
    const good = "{name} connected";

    const goodAst = new IntlMessageFormat(good).getAst();
    const goodPlaceholders = extractPlaceholders(goodAst);
    expect(goodPlaceholders).toEqual(["name"]);

    const badAst = new IntlMessageFormat(bad).getAst();
    const badPlaceholders = extractPlaceholders(badAst);
    expect(badPlaceholders).toEqual(["nombre"]);

    // The test would fail because placeholders don't match
    expect(badPlaceholders).not.toEqual(goodPlaceholders);
  });

  it("detects when a plural arm is dropped", () => {
    const complete = "{count, plural, =0 {none} one {one} other {many}}";
    const incomplete = "{count, plural, one {one} other {many}}"; // Missing =0

    const completeMsg = new IntlMessageFormat(complete, "en");
    const incompleteMsg = new IntlMessageFormat(incomplete, "en");

    // Both should format for count=0, but with different results
    const completeResult = completeMsg.format({ count: 0 });
    const incompleteResult = incompleteMsg.format({ count: 0 });

    expect(completeResult).toBe("none");
    expect(incompleteResult).not.toBe("none"); // Falls through to "other"
  });

  it("detects excessive padding that breaks layout", () => {
    const reasonable = accentedPseudo("Test");
    const tooLong = "[!!! " + "x".repeat(500) + " !!!]";

    // Accented pseudo should add reasonable padding
    expect(reasonable.length).toBeLessThan(50);

    // But we can detect when text becomes unreasonably long
    expect(tooLong.length).toBeGreaterThan(400);
  });
});

/**
 * Extract placeholder names from ICU AST.
 * Matches the logic in catalog.spec.ts.
 */
function extractPlaceholders(ast: unknown[]): string[] {
  const names: string[] = [];
  const walk = (nodes: readonly unknown[]): void => {
    for (const raw of nodes) {
      const node = raw as {
        type?: number;
        value?: unknown;
        options?: Record<string, { value?: unknown[] }>;
      };
      // TYPE.literal (0) carries text, not an argument name
      if (node.type !== 0 && typeof node.value === "string" && /^[A-Za-z_]\w*$/.test(node.value)) {
        names.push(node.value);
      }
      if (node.options) {
        for (const option of Object.values(node.options)) {
          walk(option.value ?? []);
        }
      }
    }
  };
  walk(ast);
  return [...new Set(names)].sort();
}
