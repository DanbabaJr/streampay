/**
 * Pseudo-locale transform for stress-testing layout fragility.
 *
 * Generates synthetic catalogs that simulate worst-case localization scenarios:
 * - en-XA: Accented characters with ~40% padding (simulates verbose languages)
 * - en-XB: Long unbreakable words (simulates compound-word languages)
 *
 * These are test-only transforms, never shipped to production.
 */

const ACCENT_MAP: Record<string, string> = {
  a: "á", A: "Á", b: "ƀ", B: "Ɓ", c: "ç", C: "Ç", d: "ð", D: "Ð",
  e: "é", E: "É", f: "ƒ", F: "Ƒ", g: "ĝ", G: "Ĝ", h: "ĥ", H: "Ĥ",
  i: "í", I: "Í", j: "ĵ", J: "Ĵ", k: "ķ", K: "Ķ", l: "ļ", L: "Ļ",
  m: "ɱ", M: "Ɱ", n: "ñ", N: "Ñ", o: "ó", O: "Ó", p: "þ", P: "Þ",
  q: "ǫ", Q: "Ǫ", r: "ŕ", R: "Ŕ", s: "š", S: "Š", t: "ţ", T: "Ţ",
  u: "ú", U: "Ú", v: "ṽ", V: "Ṽ", w: "ŵ", W: "Ŵ", x: "ẋ", X: "Ẋ",
  y: "ý", Y: "Ý", z: "ž", Z: "Ž",
};

function accentText(text: string): string {
  return Array.from(text, (char) => ACCENT_MAP[char] ?? char).join("");
}

function findMatchingBrace(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    if (input[i] === "{") depth++;
    else if (input[i] === "}" && --depth === 0) return i;
  }
  return input.length - 1;
}

/**
 * Transform only ICU message literals. Argument names, formatter keywords,
 * plural selectors (=0/one/other), and brace structure remain byte-for-byte.
 */
function transformIcuLiterals(
  input: string,
  transformText: (text: string) => string
): string {
  let output = "";
  let textStart = 0;
  let i = 0;

  while (i < input.length) {
    if (input[i] !== "{") {
      i++;
      continue;
    }

    output += transformText(input.slice(textStart, i));
    const close = findMatchingBrace(input, i);
    const argument = input.slice(i + 1, close);
    const firstComma = argument.indexOf(",");
    const typeEnd = firstComma < 0 ? -1 : argument.indexOf(",", firstComma + 1);
    const type = firstComma < 0
      ? ""
      : argument.slice(firstComma + 1, typeEnd < 0 ? argument.length : typeEnd).trim();

    if (typeEnd >= 0 && (type === "plural" || type === "select" || type === "selectordinal")) {
      const header = input.slice(i, i + 1 + typeEnd + 1);
      output += header;
      let cursor = i + 1 + typeEnd + 1;
      while (cursor < close) {
        if (input[cursor] !== "{") {
          output += input[cursor];
          cursor++;
          continue;
        }
        const optionClose = findMatchingBrace(input, cursor);
        output += "{" + transformIcuLiterals(
          input.slice(cursor + 1, optionClose),
          transformText
        ) + "}";
        cursor = optionClose + 1;
      }
      output += "}";
    } else {
      output += input.slice(i, close + 1);
    }

    i = close + 1;
    textStart = i;
  }

  output += transformText(input.slice(textStart));
  return output;
}

/** Transform a message to accented pseudo-locale with visible padding. */
export function accentedPseudo(message: string): string {
  const transformed = transformIcuLiterals(message, accentText);
  const padding = " !!!".repeat(Math.ceil(transformed.length * 0.1));
  return `[${padding} ${transformed}${padding}]`;
}

/** Transform each literal word into a long, unbreakable compound. */
export function longWordPseudo(message: string): string {
  return transformIcuLiterals(message, (text) =>
    text.replace(/[A-Za-z]+/g, (word) => {
      let expanded = accentText(word);
      // Expand each literal word enough to double the complete message even
      // when ICU placeholders account for most of its original length.
      const repeat = expanded.slice(-1);
      while (expanded.length < word.length * 4) expanded += repeat;
      return expanded;
    })
  );
}

/** Apply pseudo-locale transform to an entire catalog. */
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

/** Generate pseudo-locale catalogs for testing. */
export function generatePseudoCatalogs<T extends Record<string, string>>(
  baseCatalog: T
): { accented: T; longWord: T } {
  return {
    accented: transformCatalog(baseCatalog, accentedPseudo),
    longWord: transformCatalog(baseCatalog, longWordPseudo),
  };
}
