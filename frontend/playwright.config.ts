import { defineConfig, devices } from "@playwright/test";

/**
 * Visual regression over the static Storybook build (docs/STORYBOOK.md).
 *
 * Baselines are only meaningful for the renderer that produced them: font
 * hinting and anti-aliasing differ between macOS, Windows and Linux. The
 * committed baselines are rendered inside the pinned Playwright container
 * (`mcr.microsoft.com/playwright:v<@playwright/test version>-noble`), which is
 * also where CI compares, so a diff is always a change in the UI and never a
 * change in the machine. `{platform}` stays in the snapshot path so a local
 * macOS run writes to its own (git-ignored) directory instead of silently
 * "updating" the Linux baselines.
 */

const CI = Boolean(process.env.CI);
const PORT = 6007;

export default defineConfig({
  testDir: "visual",
  testMatch: "**/*.visual.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  outputDir: "test-results",

  fullyParallel: true,
  forbidOnly: CI,
  // A flaky screenshot is a determinism bug in a story, not something to retry.
  retries: 0,
  workers: CI ? 2 : undefined,
  reporter: CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],

  // CI never writes a baseline: a story without one fails, and the baseline is
  // added deliberately (`npm run test:visual:baselines`, or the candidate set
  // a failed CI run uploads, then reviewed and committed). Locally, a missing
  // baseline is written and its test fails, so the first run is never a
  // silent pass.
  updateSnapshots: CI ? "none" : "default",

  expect: {
    toHaveScreenshot: {
      // Same renderer, same pixels: any changed pixel is a real change.
      maxDiffPixels: 0,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    // Dates and numbers are formatted with the runtime's locale/zone in a few
    // components (e.g. TimeSeriesChart's axis labels).
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    // Escape hatch for hosts the bundled Chromium does not support (macOS 12):
    // PLAYWRIGHT_CHANNEL=chrome uses the installed Google Chrome. Such runs are
    // for local iteration only — they never produce committed baselines.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: "off",
  },

  webServer: {
    // Serves the output of `npm run build-storybook`; the visual suite never
    // runs against the dev server, whose HMR client injects its own DOM.
    command: `npx vite preview --outDir storybook-static --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
});
