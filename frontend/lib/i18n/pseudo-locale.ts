/**
 * Pseudo-locale transform for stress-testing layout fragility.
 *
 * Generates synthetic catalogs that simulate worst-case localization scenarios:
 * - en-XA: Accented characters with ~40% padding (simulates verbose languages)
 * - en-XB: Long unbreakable words (simulates compound-word languages)
 *
 * These are test-only transforms, never shipped to production.
 */

/**
 * Character map for accented pseudo-locale (en-XA).
 * Maps ASCII characters to accented Unicode equivalents to test
 * font rendering and character encoding without changing readability.
 */
const ACCENT_MAP: Record<string, string> = {
  a: "á",
  A: "Á",
  b: "ƀ",
  B: "Ɓ",
  c: "ç",
  C: "Ç",
  d: "ð",
  D: "Ð",
  e: "é",
  E: "É",
  f: "ƒ",
  F: "Ƒ",
  g: "ĝ",
  G: "Ĝ",
  h: "ĥ",
  H: "Ĥ",
  i: "í",
  I: "Í",
  j: "ĵ",
  J: "Ĵ",
  k: "ķ",
  K: "Ķ",
  l: "ļ",
  L: "Ļ",
  m: "ɱ",
  M: "Ɱ",
  n: "ñ",
  N: "Ñ",
  o: "ó",
  O: "Ó",
  p: "þ",
  P: "Þ",
  q: "ǫ",
  Q: "Ǫ",
  r: "ŕ",
  R: "Ŕ",
  s: "š",
  S: "Š",
  t: "ţ",
  T: "Ţ",
  u: "ú",
  U: "Ú",
  v: "ṽ",
  V: "Ṽ",
  w: "ŵ",
  W: "Ŵ",
  x: "ẋ",
  X: "Ẋ",
  y: "ý",
  Y: "Ý",
  z: "ž",
  Z: "Ž",
};

/** Transform only ICU message text while preserving argument syntax and selectors. */
function transformIcuLiterals(message: string, transformLiteral: (literal: string) => string): string {
  const matchingBrace = (input: string, start: number): number => {
    let depth = 0;
    for (let i = start; i < input.length; i++) {
      if (input[i] === "{") depth++;
      else if (input[i] === "}" && --depth === 0) return i;
    }
    return -1;
  };
  const transform = (input: string): string => {
    let output = "";
    let cursor = 0;
    while (cursor < input.length) {
      const open = input.indexOf("{", cursor);
      if (open === -1) { output += transformLiteral(input.slice(cursor)); break; }
      output += transformLiteral(input.slice(cursor, open));
      const close = matchingBrace(input, open);
      if (close === -1) { output += transformLiteral(input.slice(open)); break; }
      const inner = input.slice(open + 1, close);
      const nestedOpen = inner.indexOf("{");
      if (nestedOpen === -1) {
        if (/^[A-Za-z_]\w*(?:\s*,\s*[A-Za-z]+(?:\s*,[^{}]*)?)?$/.test(inner.trim())) {
          output += input.slice(open, close + 1);
        } else {
          output += "{" + transform(inner) + "}";
        }
      } else {
        output += "{" + inner.slice(0, nestedOpen);
        const branches = inner.slice(nestedOpen);
        let branchCursor = 0;
        while (branchCursor < branches.length) {
          const branchOpen = branches.indexOf("{", branchCursor);
          if (branchOpen === -1) { output += branches.slice(branchCursor); break; }
          output += branches.slice(branchCursor, branchOpen);
          const branchClose = matchingBrace(branches, branchOpen);
          if (branchClose === -1) { output += branches.slice(branchOpen); break; }
          output += "{" + transform(branches.slice(branchOpen + 1, branchClose)) + "}";
          branchCursor = branchClose + 1;
        }
        output += "}";
      }
      cursor = close + 1;
    }
    return output;
  };
  return transform(message);
}

/**
 * Transform a message to accented pseudo-locale with padding.
 * Preserves ICU placeholders and adds ~40% length expansion.
 *
 * @example
 * accentedPseudo("Hello {name}!") // "[!!! Ĥéļļó {name}! !!!]"
 */
export function accentedPseudo(message: string): string {
  const transformed = transformIcuLiterals(message, (literal) =>
    Array.from(literal, (char) => ACCENT_MAP[char] ?? char).join("")
  );
  const padding = " !!!".repeat(Math.ceil(transformed.length * 0.1));
  return `[${padding} ${transformed}${padding}]`;
}

/**
 * Transform a message to long-word pseudo-locale.
 * Converts words to long, unbreakable compounds to test overflow handling.
 *
 * @example
 * longWordPseudo("Hello world") // "Ħēļļōōōōō ŵōŕļðððððð"
 */
export function longWordPseudo(message: string): string {
  return transformIcuLiterals(message, (literal) =>
    literal.replace(/\b(\w+)\b/g, (word) => {
      let result = "";
      for (const char of Array.from(word)) {
        const accented = ACCENT_MAP[char] ?? char;
        result += accented.repeat(4);
      }
      return result;
    })
  );
}

/**
 * Apply pseudo-locale transform to an entire catalog.
 */
export function transformCatalog<T extends Record<string, string>>(
  catalog: T,
  transform: (message: string) => string
): T {
  const result = {} as T;
  for (const key in catalog) {
    result[key] = transform(catalog[key]) as T[Extract<keyof T, string>];
  }
  return result;
}

/**
 * Generate pseudo-locale catalogs for testing.
 */
export function generatePseudoCatalogs<T extends Record<string, string>>(
  baseCatalog: T
): {
  accented: T;
  longWord: T;
} {
  return {
    accented: transformCatalog(baseCatalog, accentedPseudo),
    longWord: transformCatalog(baseCatalog, longWordPseudo),
  };
}
