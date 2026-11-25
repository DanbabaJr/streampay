"use client";

/**
 * Locale context.
 *
 * The locale itself is decided on the server (see lib/i18n/server.ts) so the
 * first HTML document already carries the right `<html lang>` / `dir` — a
 * client-only switch would ship English markup to a German user and then swap
 * it, which is both a flash of the wrong language and an accessibility defect
 * (the screen-reader voice is chosen from the document `lang` at parse time).
 *
 * The switcher therefore writes the cookie and asks the server to re-render
 * (`router.refresh()`), rather than keeping a second, client-side copy of the
 * truth that can disagree with the markup it just produced.
 */

import { createContext, useCallback, useContext, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  localeDir,
  type Locale,
} from "./locales";
import { makeFormatter, type Formatter } from "./format";
import {
  formatStroops,
  formatTokenAmount,
  parseStroops,
  type ParseResult,
} from "./amounts";

interface LocaleContextValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  t: Formatter;
  /** Localizes a stroop integer; never routes the value through a float. */
  formatAmount: (stroops: bigint | string) => string;
  /** Same, for a token whose decimals are not the XLM default. */
  formatToken: (raw: bigint | string, decimals: number) => string;
  /** Locale-aware amount input -> stroops, with a typed reason on failure. */
  parseAmount: (input: string) => ParseResult;
  /** Switches the locale for this browser and re-renders from the server. */
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const router = useRouter();
  const active = locale ?? DEFAULT_LOCALE;

  const setLocale = useCallback(
    (next: Locale) => {
      if (typeof document === "undefined") return;
      document.cookie =
        `${LOCALE_COOKIE}=${next};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`;
      // The server owns the locale, so re-read the document instead of keeping
      // a local copy that would drift from `<html lang>`.
      router.refresh();
    },
    [router]
  );

  const value = useMemo<LocaleContextValue>(() => {
    const t = makeFormatter(active);
    return {
      locale: active,
      dir: localeDir(active),
      t,
      formatAmount: (stroops) => formatStroops(stroops, active),
      formatToken: (raw, decimals) =>
        formatTokenAmount(raw, { locale: active, decimals }),
      parseAmount: (input) => parseStroops(input, active),
      setLocale,
    };
  }, [active, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    // Every page renders under the root layout's provider; a miss is a wiring bug.
    throw new Error("useLocale must be used inside <LocaleProvider>");
  }
  return context;
}

/** Shorthand for the common case: `const t = useT(); t("pay.loading.title")`. */
export function useT(): Formatter {
  return useLocale().t;
}
