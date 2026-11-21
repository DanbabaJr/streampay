/**
 * Simple unit tests for pseudo-locale transforms (node --test runner).
 * The full overflow testing suite is in pseudo-locale.spec.ts (vitest).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import IntlMessageFormat from "intl-messageformat";
import {
  accentedPseudo,
  longWordPseudo,
  generatePseudoCatalogs,
} from "./pseudo-locale.ts";
import { en, MESSAGE_KEYS, MESSAGE_SAMPLES, PARAMETERIZED_KEYS } from "./messages/index.ts";

describe("pseudo-locale core transforms", () => {
  it("accented pseudo preserves ICU placeholders", () => {
    const input = "Hello {name}, you have {count} items";
    const output = accentedPseudo(input);

    assert(output.includes("{name}"), "Should preserve {name}");
    assert(output.includes("{count}"), "Should preserve {count}");
    assert(output.length > input.length, "Should add padding");
  });

  it("long-word pseudo creates elongated words", () => {
    const input = "Hello world";
    const output = longWordPseudo(input);

    assert(output.length > input.length * 2, "Should create long words");
  });

  it("preserves complex ICU plural syntax", () => {
    const input = "{count, plural, =0 {no items} one {# item} other {# items}}";
    const accented = accentedPseudo(input);
    const longWord = longWordPseudo(input);

    // Both should parse as valid ICU
    assert.doesNotThrow(() => new IntlMessageFormat(accented, "en"));
    assert.doesNotThrow(() => new IntlMessageFormat(longWord, "en"));
  });

  it("every catalog key transforms successfully", () => {
    const { accented, longWord } = generatePseudoCatalogs(en);

    for (const key of MESSAGE_KEYS) {
      assert(accented[key], `accented/${key} should exist`);
      assert(longWord[key], `longWord/${key} should exist`);
      assert(accented[key].length > 0, `accented/${key} should be non-empty`);
      assert(longWord[key].length > 0, `longWord/${key} should be non-empty`);
    }
  });

  it("parameterized keys parse and interpolate correctly", () => {
    const { accented, longWord } = generatePseudoCatalogs(en);

    for (const key of PARAMETERIZED_KEYS) {
      const sample = MESSAGE_SAMPLES[key];

      // Accented variant
      const accentedMsg = new IntlMessageFormat(accented[key], "en");
      const accentedResult = accentedMsg.format(sample);
      assert(
        typeof accentedResult === "string",
        `accented/${key} should format to string`
      );
      assert(
        !String(accentedResult).includes("undefined"),
        `accented/${key} should not contain undefined`
      );

      // Long-word variant
      const longWordMsg = new IntlMessageFormat(longWord[key], "en");
      const longWordResult = longWordMsg.format(sample);
      assert(
        typeof longWordResult === "string",
        `longWord/${key} should format to string`
      );
      assert(
        !String(longWordResult).includes("undefined"),
        `longWord/${key} should not contain undefined`
      );
    }
  });

  it("preserves select syntax", () => {
    const input = "{unit, select, tokens {Tokens} other {Units}}";
    const accented = accentedPseudo(input);

    assert(accented.includes("{unit, select,"), "Should preserve select structure");
    assert(accented.includes("tokens"), "Should preserve case labels");
    assert(accented.includes("other"), "Should preserve other case");

    // Should parse
    assert.doesNotThrow(() => new IntlMessageFormat(accented, "en"));
  });
});

describe("placeholder extraction integrity", () => {
  function extractPlaceholders(ast: unknown[]): string[] {
    const names: string[] = [];
    const walk = (nodes: readonly unknown[]): void => {
      for (const raw of nodes) {
        const node = raw as {
          type?: number;
          value?: unknown;
          options?: Record<string, { value?: unknown[] }>;
        };
        if (
          node.type !== 0 &&
          typeof node.value === "string" &&
          /^[A-Za-z_]\w*$/.test(node.value)
        ) {
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

  it("pseudo-locales preserve placeholder names exactly", () => {
    const { accented, longWord } = generatePseudoCatalogs(en);

    for (const key of PARAMETERIZED_KEYS) {
      const originalAst = new IntlMessageFormat(en[key]).getAst();
      const expected = extractPlaceholders(originalAst);

      const accentedAst = new IntlMessageFormat(accented[key]).getAst();
      const accentedPlaceholders = extractPlaceholders(accentedAst);
      assert.deepStrictEqual(
        accentedPlaceholders,
        expected,
        `accented/${key} placeholders should match`
      );

      const longWordAst = new IntlMessageFormat(longWord[key]).getAst();
      const longWordPlaceholders = extractPlaceholders(longWordAst);
      assert.deepStrictEqual(
        longWordPlaceholders,
        expected,
        `longWord/${key} placeholders should match`
      );
    }
  });
});
