/**
 * Server-side locale resolution.
 *
 * Kept separate from provider.tsx (which is `"use client"`) so the root layout
 * can read the cookie without pulling `next/headers` into a client bundle.
 */

import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  localesFromAcceptLanguage,
  resolveLocale,
  type Locale,
} from "./locales";

/**
 * Explicit choice (cookie) beats browser preference, which beats the default.
 * Reading both here means the very first request from a German browser is
 * already rendered in German, with no JavaScript required.
 */
export async function resolveRequestLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const [preferred] = localesFromAcceptLanguage(headerStore.get("accept-language"));
  return resolveLocale([cookieStore.get(LOCALE_COOKIE)?.value, preferred]);
}

export { DEFAULT_LOCALE };
