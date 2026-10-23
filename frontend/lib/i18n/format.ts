/**
 * The ICU MessageFormat runtime.
 *
 * `intl-messageformat` (FormatJS) is used rather than hand-rolled `{x}`
 * substitution or bare `Intl.NumberFormat`, for the reasons in docs/I18N.md:
 * grammatical number and choice have to come from the *message*, not from the
 * component, or every locale ends up as an if-chain in JSX. Compilation is
 * cached per (locale, pattern) because parsing is not free and the same message
 * is formatted on every tick of the live accrual counter.
 */

import IntlMessageFormat from "intl-messageformat";
import { catalogFor, type MessageArgs, type MessageKey } from "./messages";
import { DEFAULT_LOCALE, type Locale } from "./locales";

const LOCALE_SEPARATOR = "\u0000";
const compiled = new Map<string, IntlMessageFormat>();

function compile(locale: Locale, pattern: string): IntlMessageFormat {
  const cacheKey = `${locale}${LOCALE_SEPARATOR}${pattern}`;
  const existing = compiled.get(cacheKey);
  if (existing) return existing;
  const created = new IntlMessageFormat(pattern, locale);
  compiled.set(cacheKey, created);
  return created;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Formats a catalog entry for `locale`.
 *
 * `key` only exists as a `MessageKey`, and the argument tuple is derived from
 * `MessageParams`, so a typo'd key or a missing/wrongly-typed value is a
 * compile error rather than a blank string at runtime.
 */
export function formatMessage<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...args: MessageArgs<K>
): string {
  const pattern = catalogFor(locale)[key];
  const values = (args[0] ?? {}) as Record<string, unknown>;

  try {
    return String(compile(locale, pattern).format(values));
  } catch (error) {
    if (!isProduction()) {
      throw new Error(
        `i18n: cannot format "${key}" for locale "${locale}" — ${String(error)}`,
        { cause: error }
      );
    }
    // In production a broken translation must not blank out a claim button:
    // fall back to English, and only then to the key itself.
    if (locale !== DEFAULT_LOCALE) return formatMessage(DEFAULT_LOCALE, key, ...args);
    return key;
  }
}

/** Formats a message in the locale the caller is rendering for. */
export function makeFormatter(locale: Locale) {
  return <K extends MessageKey>(key: K, ...args: MessageArgs<K>): string =>
    formatMessage(locale, key, ...args);
}

export type Formatter = ReturnType<typeof makeFormatter>;
