/**
 * Locale registry.
 *
 * A locale here is a BCP 47 language tag with no region subtag (`de`, not
 * `de-AT`): the catalog is keyed by language, and regional differences are the
 * job of `Intl` (which resolves separators from the full tag the browser offers).
 *
 * `LOCALE_DIR` is the piece an RTL locale plugs into: direction is data, not a
 * per-component `dir="rtl"` sprinkle, so adding `ar` means one row here plus a
 * catalog — see docs/I18N.md.
 */

export const SUPPORTED_LOCALES = ["en", "de"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie written by the switcher and read by the root layout before render. */
export const LOCALE_COOKIE = "streampay_locale";

/** One year: the choice is not session-scoped. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_DIR: Record<Locale, "ltr" | "rtl"> = {
  en: "ltr",
  de: "ltr",
};

/** Endonym — always shown in its own language, never translated. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
};

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function localeDir(locale: Locale): "ltr" | "rtl" {
  return LOCALE_DIR[locale];
}

/**
 * Strips the region subtag and walks the remaining prefixes back until one is
 * supported, so `de-AT` and `de-419` both resolve to `de` while `pt-BR` falls
 * through to the default rather than being guessed.
 */
export function matchLocaleTag(tag: string): Locale | null {
  const parts = tag.toLowerCase().split("-").filter(Boolean);
  const language = parts[0];
  if (!language) return null;
  const exact = parts.length > 1 ? `${language}-${parts[1]}` : language;
  if (isSupportedLocale(exact)) return exact;
  return isSupportedLocale(language) ? language : null;
}

/**
 * Parses an `Accept-Language` header (or a `navigator.languages` array) into
 * supported locales ordered by the client's own q-value priority.
 */
export function localesFromAcceptLanguage(header: string | null | undefined): Locale[] {
  if (!header) return [];
  return header
    .split(",")
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag, quality: Number.isFinite(quality) ? quality : 0 };
    })
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => matchLocaleTag(entry.tag))
    .filter((locale): locale is Locale => locale !== null);
}

/**
 * Picks the effective locale from candidates already ordered by authority:
 * explicit choice (cookie) first, then the browser's preference list.
 * The caller supplies values in that order; this function only validates.
 */
export function resolveLocale(candidates: readonly (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matched = matchLocaleTag(candidate);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}
