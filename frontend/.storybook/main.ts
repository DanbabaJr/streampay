import type { StorybookConfig } from "@storybook/nextjs-vite";

/**
 * Storybook for the StreamPay component set (docs/STORYBOOK.md).
 *
 * Framework: `@storybook/nextjs-vite`, not the webpack `@storybook/nextjs`.
 * The app builds with Turbopack on Next 16, so there is no webpack config to
 * share, and the Vite builder resolves the same `vite@8` the vitest suites
 * already pin — one bundler toolchain in the lockfile instead of two. The
 * framework reads `next.config.ts`, so `@/` paths, `next/link`,
 * `next/navigation` and `next/image` behave as they do in the app.
 *
 * Stories are colocated with their component (`components/**\/*.stories.tsx`)
 * so a component and its states are reviewed in the same diff.
 */
const PINNED_PUBLIC_ENV: Record<string, string> = {
  NEXT_PUBLIC_NETWORK: "TESTNET",
  // Matches STREAMING_CONTRACT in .storybook/fixtures.ts.
  NEXT_PUBLIC_STREAMING_CONTRACT_ID:
    "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
  NEXT_PUBLIC_SOROBAN_RPC_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_NATIVE_XLM_CONTRACT_ID: "",
  NEXT_PUBLIC_BATCH_CLAIM: "",
  NEXT_PUBLIC_SPONSOR_ADDRESS: "",
  NEXT_PUBLIC_SPONSOR_RELAY_URL: "",
  NEXT_PUBLIC_PASSKEY_CONTRACT_ID: "",
  NEXT_PUBLIC_PASSKEY_ORIGIN: "",
  NEXT_PUBLIC_PASSKEY_RP_ID: "",
};

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx)"],
  framework: {
    name: "@storybook/nextjs-vite",
    options: {},
  },
  // Wallet icons and other assets the components reference by URL.
  staticDirs: ["../public"],
  core: {
    disableTelemetry: true,
  },
  // Every `NEXT_PUBLIC_*` the components read is pinned here, so a baseline
  // never depends on whose machine built it: the network badge, the native-XLM
  // contract id and the contract link all render from these. The RPC URL
  // points at a closed port on purpose — every read is mocked in preview.tsx,
  // so a call that slips past the mocks fails fast instead of reaching testnet.
  //
  // Storybook's own `env` option cannot do this. The framework's Vite plugin
  // (vite-plugin-storybook-nextjs) defines each `process.env.NEXT_PUBLIC_*`
  // individually from Next's `loadEnvConfig` — `.env.local` *and* the shell —
  // and those per-key defines win over `env`. A post-enforced plugin's
  // `config` hook is merged after it, so these values are the ones compiled in.
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    plugins: [
      ...(viteConfig.plugins ?? []),
      {
        name: "streampay:pinned-public-env",
        enforce: "post",
        config: () => ({
          define: Object.fromEntries(
            Object.entries(PINNED_PUBLIC_ENV).map(([key, value]) => [
              `process.env.${key}`,
              JSON.stringify(value),
            ])
          ),
        }),
      },
    ],
  }),
  typescript: {
    // The prop tables come from react-docgen; the type check itself is
    // `npm run typecheck`, which already covers every story file.
    reactDocgen: "react-docgen",
  },
};

export default config;
