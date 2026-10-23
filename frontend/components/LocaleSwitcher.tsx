"use client";

import { useLocale } from "@/lib/i18n/provider";
import { LOCALE_LABEL, SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/locales";

/**
 * Language picker. Labels are endonyms (`Deutsch`, never `German`) so a user who
 * cannot read the current UI language can still read theirs.
 */
export default function LocaleSwitcher() {
  const { locale, setLocale, t } = useLocale();

  return (
    <span className="locale-switcher" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <label htmlFor="locale-select" style={{ fontSize: 12, color: "var(--muted, #93a1b8)" }}>
        {t("chrome.localeLabel")}
      </label>
      <select
        id="locale-select"
        name="locale"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        style={{ fontSize: 12, padding: "4px 6px" }}
      >
        {SUPPORTED_LOCALES.map((candidate) => (
          <option key={candidate} value={candidate}>
            {/* Endonym on purpose: a user who cannot read the current UI
                language can still read their own. */}
            {LOCALE_LABEL[candidate]}
          </option>
        ))}
      </select>
    </span>
  );
}
