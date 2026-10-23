import type { MessageKey } from "./en";

/**
 * Keys whose text is *intentionally* identical across locales: brand names,
 * the network pill, the technical kicker, and words that are the same word in
 * German. The catalog gate in lib/i18n/catalog.spec.ts fails the test run on
 * any other key that still matches English, so "untranslated" cannot sneak in
 * as a silent copy — but this is the one list that says "a copy is correct here".
 *
 * `satisfies` means renaming or deleting a catalog key breaks the build instead
 * of quietly disabling its exemption.
 */
export const COGNATE_KEYS = [
  "brand.name",
  "chrome.networkLive",
  "chrome.networkText",
  "home.kicker",
  "home.title",
  "pay.invoice.title",
  "pay.invoice.unit.tokens",
  "pay.terminal.status",
  // "Asset" is the word used in German UI copy, and "/s" is a unit symbol.
  "form.asset",
  "form.unitPerSecond",
] as const satisfies readonly MessageKey[];

export const COGNATE_SET: ReadonlySet<string> = new Set(COGNATE_KEYS);
