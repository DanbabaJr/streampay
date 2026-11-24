import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, userEvent, within } from "storybook/test";

import LocaleSwitcher from "./LocaleSwitcher";
import { LocaleProvider } from "@/lib/i18n/provider";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_LABEL,
  SUPPORTED_LOCALES,
  resolveLocale,
  type Locale,
} from "@/lib/i18n/locales";
import { de, en } from "@/lib/i18n/messages";

/**
 * Language picker. The active locale comes from the `LocaleProvider` the
 * preview wraps every story in — switch it with the toolbar's Locale menu.
 */
const meta = {
  title: "Chrome/LocaleSwitcher",
  component: LocaleSwitcher,
  tags: ["autodocs"],
} satisfies Meta<typeof LocaleSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  globals: { locale: "en" },
};

export const German: Story = {
  globals: { locale: "de" },
};

// ---------------------------------------------------------------------------
// Interaction stories
//
// In the app the locale is decided on the server: the switcher writes a cookie
// and calls `router.refresh()`, and the root layout re-renders with the locale
// it reads back from that cookie (lib/i18n/provider.tsx, lib/i18n/server.ts).
// Storybook has no server, so `refresh()` would change nothing and the strings
// could never move. `ServerLocaleHost` plays the server's part — it re-reads
// the cookie on every refresh and re-renders the provider — so the switcher's
// real output (cookie + catalog strings) is what the play functions assert.
// ---------------------------------------------------------------------------

const REFRESH_EVENT = "streampay:storybook-server-refresh";

function readLocaleCookie(): string | null {
  const entry = document.cookie.split("; ").find((c) => c.startsWith(`${LOCALE_COOKIE}=`));
  return entry ? decodeURIComponent(entry.slice(LOCALE_COOKIE.length + 1)) : null;
}

function clearLocaleCookie() {
  document.cookie = `${LOCALE_COOKIE}=;path=/;max-age=0;samesite=lax`;
}

/** What the root layout does: cookie first, then the default the story starts from. */
function serverLocale(fallback: Locale): Locale {
  return resolveLocale([readLocaleCookie(), fallback]);
}

function ServerLocaleHost({ fallback }: { fallback: Locale }) {
  const [locale, setLocale] = useState<Locale>(() => serverLocale(fallback));

  useEffect(() => {
    const onRefresh = () => setLocale(serverLocale(fallback));
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, [fallback]);

  return (
    <LocaleProvider locale={locale}>
      <LocaleSwitcher />
    </LocaleProvider>
  );
}

/** Shared setup: no stale cookie in or out, and `router.refresh()` reaches the host. */
function simulateServer() {
  clearLocaleCookie();
  getRouter().refresh.mockImplementation(() => {
    window.dispatchEvent(new Event(REFRESH_EVENT));
  });
  return clearLocaleCookie;
}

function renderHost(_args: unknown, context: { globals: Record<string, unknown> }) {
  const fallback = resolveLocale([context.globals.locale as string | undefined]);
  return <ServerLocaleHost fallback={fallback} />;
}

/** The catalogs must differ for "the strings changed" to prove anything. */
function expectCatalogsDiffer() {
  expect(de["chrome.localeLabel"]).not.toBe(en["chrome.localeLabel"]);
}

async function expectEndonyms(canvas: ReturnType<typeof within>) {
  // Option labels are endonyms: they never follow the UI language.
  for (const locale of SUPPORTED_LOCALES) {
    await expect(canvas.getByRole("option", { name: LOCALE_LABEL[locale] })).toBeInTheDocument();
  }
}

/**
 * Picks Deutsch. Ends on the same render as `German`, so it shares that
 * baseline's pixels: the label is the real German catalog string, the select
 * shows its endonym, and the choice is stored in the locale cookie.
 */
export const SwitchToGerman: Story = {
  globals: { locale: "en" },
  render: renderHost,
  beforeEach: simulateServer,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expectCatalogsDiffer();

    const select = canvas.getByRole("combobox", { name: en["chrome.localeLabel"] });
    await expect(select).toHaveValue("en");
    await expect(readLocaleCookie()).toBeNull();

    await userEvent.selectOptions(select, "de");

    // Persistence: the choice is written to the cookie the server reads.
    await expect(readLocaleCookie()).toBe("de");
    await expect(getRouter().refresh).toHaveBeenCalledTimes(1);

    // Rendered output: the label is the German catalog entry, not the English one.
    const german = await canvas.findByRole("combobox", { name: de["chrome.localeLabel"] });
    await expect(german).toHaveValue("de");
    await expect(canvas.getByText(de["chrome.localeLabel"])).toBeVisible();
    await expect(canvas.queryByText(en["chrome.localeLabel"])).not.toBeInTheDocument();
    await expectEndonyms(canvas);
    (document.activeElement as HTMLElement | null)?.blur();
  },
};

/** Starts in German, picks English. Ends on the same render as `English`. */
export const SwitchBackToEnglish: Story = {
  globals: { locale: "de" },
  render: renderHost,
  beforeEach: simulateServer,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expectCatalogsDiffer();

    const select = canvas.getByRole("combobox", { name: de["chrome.localeLabel"] });
    await expect(select).toHaveValue("de");

    await userEvent.selectOptions(select, "en");

    await expect(readLocaleCookie()).toBe("en");
    const english = await canvas.findByRole("combobox", { name: en["chrome.localeLabel"] });
    await expect(english).toHaveValue("en");
    await expect(canvas.queryByText(de["chrome.localeLabel"])).not.toBeInTheDocument();
    await expectEndonyms(canvas);
    (document.activeElement as HTMLElement | null)?.blur();
  },
};

/**
 * A returning visitor: the cookie from an earlier visit decides the very
 * first render, ahead of the story's default locale — no flash of English.
 */
export const RestoresStoredChoice: Story = {
  globals: { locale: "en" },
  render: renderHost,
  beforeEach: () => {
    const cleanup = simulateServer();
    document.cookie = `${LOCALE_COOKIE}=de;path=/;samesite=lax`;
    return cleanup;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByRole("combobox", { name: de["chrome.localeLabel"] });
    await expect(select).toHaveValue("de");
    await expect(canvas.queryByText(en["chrome.localeLabel"])).not.toBeInTheDocument();
    // Nothing was asked of the server: restoring is not a switch.
    await expect(getRouter().refresh).not.toHaveBeenCalled();
    await expect(readLocaleCookie()).toBe("de");
    // An unknown cookie value falls back to the default instead of breaking.
    await expect(resolveLocale(["xx", DEFAULT_LOCALE])).toBe(DEFAULT_LOCALE);
  },
};
