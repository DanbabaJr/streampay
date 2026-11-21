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

/**
 * Transform a message to accented pseudo-locale with padding.
 * Preserves ICU placeholders and adds ~40% length expansion.
 *
 * @example
 * accentedPseudo("Hello {name}!") // "[!!! Ĥéļļó {name}! !!!]"
 */
export function accentedPseudo(message: string): string {
  // Preserve ICU placeholders: {name}, {count, plural, ...}, etc.
  const parts: Array<{ text: string; isPlaceholder: boolean }> = [];
  let currentText = "";
  let depth = 0;
  let inPlaceholder = false;

  for (let i = 0; i < message.length; i++) {
    const char = message[i];
    if (char === "{") {
      if (depth === 0 && currentText) {
        parts.push({ text: currentText, isPlaceholder: false });
        currentText = "";
      }
      depth++;
      inPlaceholder = true;
      currentText += char;
    } else if (char === "}") {
      depth--;
      currentText += char;
      if (depth === 0 && inPlaceholder) {
        parts.push({ text: currentText, isPlaceholder: true });
        currentText = "";
        inPlaceholder = false;
      }
    } else {
      currentText += char;
    }
  }

  if (currentText) {
    parts.push({ text: currentText, isPlaceholder: inPlaceholder });
  }

  // Transform non-placeholder parts
  const transformed = parts
    .map((part) => {
      if (part.isPlaceholder) {
        return part.text; // Keep placeholders unchanged
      }

      // Accent the text
      let accented = "";
      for (const char of part.text) {
        accented += ACCENT_MAP[char] ?? char;
      }

      return accented;
    })
    .join("");

  // Add ~40% padding with bracketing for visibility
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
  // Preserve ICU placeholders
  const parts: Array<{ text: string; isPlaceholder: boolean }> = [];
  let currentText = "";
  let depth = 0;
  let inPlaceholder = false;

  for (let i = 0; i < message.length; i++) {
    const char = message[i];
    if (char === "{") {
      if (depth === 0 && currentText) {
        parts.push({ text: currentText, isPlaceholder: false });
        currentText = "";
      }
      depth++;
      inPlaceholder = true;
      currentText += char;
    } else if (char === "}") {
      depth--;
      currentText += char;
      if (depth === 0 && inPlaceholder) {
        parts.push({ text: currentText, isPlaceholder: true });
        currentText = "";
        inPlaceholder = false;
      }
    } else {
      currentText += char;
    }
  }

  if (currentText) {
    parts.push({ text: currentText, isPlaceholder: inPlaceholder });
  }

  // Transform non-placeholder parts
  return parts
    .map((part) => {
      if (part.isPlaceholder) {
        return part.text;
      }

      // Replace each word with a long compound
      return part.text.replace(/\b(\w+)\b/g, (word) => {
        if (word.length === 0) return word;

        // Accent first character
        let longWord = ACCENT_MAP[word[0]] ?? word[0];

        // Elongate by repeating vowel-like characters
        for (let i = 1; i < word.length; i++) {
          const char = word[i];
          const accented = ACCENT_MAP[char] ?? char;
          longWord += accented;

          // Add extra characters to make it long and unbreakable
          if ("aeiouAEIOU".includes(char)) {
            longWord += accented.repeat(Math.min(4, word.length));
          }
        }

        return longWord;
      });
    })
    .join("");
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
