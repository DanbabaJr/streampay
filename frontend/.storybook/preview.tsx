import type { Preview } from "@storybook/nextjs-vite";
import { fn, mocked, sb } from "storybook/test";

import "../app/globals.css";

import {
  fetchStreamIdsPageAction,
  readAvailableAction,
  readRefundTargetAction,
  readStreamAction,
  readStreamPolicyAction,
} from "../app/actions";
import { LocaleProvider } from "../lib/i18n/provider";
import { SUPPORTED_LOCALES, localeDir, type Locale } from "../lib/i18n/locales";
import { checkWalletNetwork } from "../lib/network";
import { useWallet, type WalletState } from "../lib/wallet-context";
import { FIXED_NOW_MS, installFakeClock } from "./fake-clock";
import {
  ACTIVE_AVAILABLE,
  activeStream,
  cancelledStream,
  completedStream,
  openPolicy,
  TOKEN_CONTRACT,
  tokenStream,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Module mocks — no story ever reaches an RPC node, a wallet extension or a
// server action. Registered here so they apply to every story file.
// ---------------------------------------------------------------------------

// Server actions: replaced wholesale by app/__mocks__/actions.ts (the real
// module imports `server-only`).
sb.mock(import("../app/actions.ts"));
// Discovery service: replaced by lib/discovery/__mocks__/service.ts (the real
// module imports `node:crypto`).
sb.mock(import("../lib/discovery/service.ts"));
// Wallet context: automocked. `useWallet` answers whatever the story's
// `parameters.wallet` describes (see `beforeEach` below).
sb.mock(import("../lib/wallet-context.tsx"));
// Network check: spied, not replaced, so the badge's pure helpers stay real.
sb.mock(import("../lib/network.ts"), { spy: true });
//
// `lib/stellar.ts` is deliberately NOT mocked. The mocker rewrites a spied
// module's re-exports before TypeScript types are stripped, so its
// `export { type … } from "./pagination.ts"` turns into a value import of a
// type and fails the build (docs/STORYBOOK.md, "Known friction"). Nothing
// needs it mocked anyway: native XLM metadata is answered without RPC, token
// metadata comes from the session cache seeded below, and the write calls
// only run when someone clicks through a story by hand — where they fail fast
// against the closed RPC port pinned in main.ts.

const STREAMS_BY_ID = new Map(
  [activeStream, tokenStream, cancelledStream, completedStream].map((s) => [s.id, s])
);

const DISCONNECTED: WalletState = {
  walletId: null,
  walletName: null,
  address: null,
  network: null,
  connectionState: "idle",
  lastError: null,
};

/** Story-level parameters this preview understands. */
export interface StreamPayParameters {
  /** Wallet connection the story renders under (merged over "disconnected"). */
  wallet?: Partial<WalletState>;
  /** Start time of the frozen clock, ms since the epoch. */
  clock?: { now?: number };
}

function applyLocale(locale: Locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDir(locale);
}

const preview: Preview = {
  parameters: {
    // The components are App Router client components: `next/navigation`
    // must answer the app-router hooks (LocaleProvider calls useRouter()).
    nextjs: { appDirectory: true },
    layout: "padded",
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    // globals.css paints the app background on <body>; Storybook's own
    // backgrounds would only hide it.
    backgrounds: { disable: true },
  },

  globalTypes: {
    locale: {
      description: "UI language (the server-chosen locale in the app)",
      toolbar: {
        title: "Locale",
        icon: "globe",
        items: SUPPORTED_LOCALES.map((value) => ({ value, title: value })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { locale: "en" },

  decorators: [
    (Story, context) => {
      const locale = (context.globals.locale ?? "en") as Locale;
      applyLocale(locale);
      return (
        <LocaleProvider locale={locale}>
          <Story />
        </LocaleProvider>
      );
    },
  ],

  async beforeEach(context) {
    const params = context.parameters as StreamPayParameters;

    // Frozen clock: see .storybook/fake-clock.ts for why only `Date` is faked.
    const clock = installFakeClock(params.clock?.now ?? FIXED_NOW_MS);

    // Wallet: a plain value, so a story's wallet state is visible in its
    // parameters (and in the docs page) instead of hidden in a mock body.
    mocked(useWallet).mockReturnValue({
      ...DISCONNECTED,
      ...params.wallet,
      connect: fn().mockName("wallet.connect"),
      disconnect: fn().mockName("wallet.disconnect"),
      signTransaction: fn().mockName("wallet.signTransaction"),
    });

    // Reads: answer from the fixtures, immediately.
    mocked(readStreamAction).mockImplementation(async (id) => {
      const stream = STREAMS_BY_ID.get(id);
      if (!stream) throw new Error(`Stream #${id} not found`);
      return stream;
    });
    mocked(readAvailableAction).mockResolvedValue(ACTIVE_AVAILABLE);
    mocked(readRefundTargetAction).mockImplementation(
      async (id) => STREAMS_BY_ID.get(id)?.sender ?? activeStream.sender
    );
    mocked(fetchStreamIdsPageAction).mockResolvedValue({ ids: [], hasMore: false });
    mocked(readStreamPolicyAction).mockResolvedValue(openPolicy);
    // Token metadata: `fetchAssetMeta` answers from this session cache before
    // it would simulate `symbol()` / `decimals()` against the RPC.
    sessionStorage.setItem(
      `streampay_asset_meta_testnet_${TOKEN_CONTRACT}`,
      JSON.stringify({ code: "USDC", decimals: 7 })
    );
    // Stream ids the dashboard cached per address (lib/storage.ts) must not
    // leak from one story into the next; a story that wants some seeds them.
    // Only the app's keys: the Storybook manager shares this origin.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("streampay:")) localStorage.removeItem(key);
    }

    // The badge asks Freighter for its network on mount; with no extension
    // that is a message round-trip with nobody on the other end. The real
    // check also publishes its verdict to the store, which would clear the
    // warning a story seeded — so answer without reporting anything.
    mocked(checkWalletNetwork).mockResolvedValue({ state: "unavailable" });

    return () => {
      clock.uninstall();
    };
  },
};

export default preview;
