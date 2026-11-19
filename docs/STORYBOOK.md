# Storybook and visual regression

The frontend's components are documented in Storybook, and every story is
screenshotted in CI and compared, pixel for pixel, against a committed baseline.
A UI change shows up in the pull request as an image diff, not as something a
reviewer has to spot by eye.

- Stories: `frontend/components/**/*.stories.tsx`, next to the component they cover.
- Storybook config: `frontend/.storybook/` (`main.ts`, `preview.tsx`,
  `fake-clock.ts`, `fixtures.ts`).
- Visual suite: `frontend/visual/` (Playwright), baselines in
  `frontend/visual/__screenshots__/linux/`.
- CI: the `storybook-visual` job in [`ci.yml`](../.github/workflows/ci.yml).

## Everyday use

```bash
cd frontend
npm run storybook            # http://localhost:6006, hot reload
npm run build-storybook      # static build into storybook-static/
```

The toolbar's **Locale** menu switches every story between `en` and `de`.

### Adding a story

Put `Thing.stories.tsx` next to `Thing.tsx`. A composite (anything that loads
data, talks to the wallet, or has an async phase) gets one story per state,
at minimum **loading**, **connected** (or populated) and **error**. Look at
`Dashboard.stories.tsx` and `StreamDetailClient.stories.tsx` for the pattern:

- **Wallet state** is a parameter, not a mock body:
  `parameters: { wallet: { connectionState: "connected", address: RECIPIENT } }`.
  Anything left out defaults to "disconnected".
- **Server actions** (`@/app/actions`) are spies with fixture-backed defaults.
  Override the one the story is about in its `beforeEach`:
  `mocked(readStreamAction).mockRejectedValue(new Error("…"))` for an error,
  `mockReturnValue(new Promise(() => {}))` for a loading state that never ends.
- **Interactions** go in `play`, and should end by asserting the state the
  screenshot is meant to show (`await canvas.findByRole("alert")`). The
  screenshot is taken only after `play` has finished, so a play function that
  waits for the final state is what makes an async story stable.
- Use the constants in `.storybook/fixtures.ts`. Never `Math.random()`, never a
  fresh `Date.now()`-relative value outside the frozen clock.
- A story that is useful as documentation but cannot be made stable can be
  tagged `no-visual`. Say why in a comment.

## Deterministic rendering

A baseline is only useful if the same story renders the same pixels on every
run. Four things make that so:

1. **Injected fake clock.** `.storybook/fake-clock.ts` replaces `Date` before
   every story with one frozen at `2026-01-15T12:00:00Z`. The live-accrual
   engine still ticks every second, but every tick sees the same instant, so
   the "Available now" counter on the stream page renders the same digits on
   every run. Timers are left real on purpose: React and Storybook keep
   working, and only the observed time is fixed. A story can start elsewhere
   with `parameters: { clock: { now } }`.
2. **No network.** Server actions, the discovery service and the wallet
   context are mocked in `preview.tsx`. Every `NEXT_PUBLIC_*` value is pinned in
   `main.ts`, including an RPC URL that points at a closed local port, and the
   visual suite aborts and fails on any request that leaves the Storybook server.
3. **One renderer.** Baselines are rendered and compared inside
   `mcr.microsoft.com/playwright:v1.64.1-noble`, the image tag that matches the
   pinned `@playwright/test`. Fonts and anti-aliasing differ between operating
   systems; inside one image they do not, so the comparison runs at
   `maxDiffPixels: 0`. A CI step fails if the package and the image tag drift
   apart.
4. **A settled page.** The suite waits for Storybook to report the story
   `finished` (render, `play`, `afterEach`), then for web fonts and two
   animation frames. CSS animations are disabled and the caret is hidden in
   the capture. Locale `en-US` and time zone `UTC` are fixed for the few
   components that format dates with the runtime's settings.

### The gate tests itself

`frontend/visual/detector.visual.ts` runs with the suite on every PR:

- **A real style change is caught.** It renders the stream list, applies a
  one-line edit to `.status-badge` padding (the kind of change that would land
  in `app/globals.css`), and requires the comparison against the committed
  baseline to *fail*. The expected, actual and diff images it leaves behind are
  part of the `visual-diffs` artifact on every run, so the artifact always
  shows what a caught regression looks like.
- **The clock really is frozen.** It captures the live stream page twice,
  2.5 s apart (two or more ticker ticks), and requires byte-identical images.
  As a positive control it then advances the fake clock one minute and requires
  the counter to change. Without that control, a broken engine and a frozen
  clock would look the same.

## Baselines

Baselines live in `frontend/visual/__screenshots__/linux/<story-id>.png`. CI
never writes one (`updateSnapshots: "none"`): a story with no baseline fails,
so a baseline is always something someone chose to commit.

To add or update baselines after a deliberate UI change:

```bash
# With Docker: renders in the pinned image; your node_modules is untouched.
bash frontend/scripts/visual-baselines.sh
# Compare only, exactly like CI:
bash frontend/scripts/visual-baselines.sh --check
```

Without Docker, push the branch. When the comparison fails, the
`storybook-visual` job re-renders every missing or changed baseline in the same
image and uploads them as the `visual-baselines-linux` artifact. Download it and
unpack it into `frontend/visual/__screenshots__/linux/`. The first baseline for
a new story is produced the same way.

Then **look at the images** before committing them, and say in the PR which
stories changed and why. A baseline commit that nobody looked at is how a
regression becomes the new truth.

### Local runs on macOS / Windows

`npm run test:visual` works locally, but it writes and compares against
`__screenshots__/<your-platform>/`, which is git-ignored. Use it to check that
a story renders and its `play` passes, not to produce baselines. Playwright
1.64 ships no Chromium build for macOS 12; set `PLAYWRIGHT_CHANNEL=chrome` to
drive an installed Google Chrome instead.

When a CI comparison fails, download the `visual-diffs` artifact: each failed
story has `<id>-expected.png`, `<id>-actual.png` and `<id>-diff.png`, and
`playwright-report/index.html` shows them side by side.

## Next 16 / React 19 notes

Storybook builds against the app's own `next@16`, `react@19` and
`react-dom@19`, with no second copy of either. These are the problems hit on
the way and how each was resolved, so nobody has to rediscover them.

| Symptom | Cause | Resolution |
|---|---|---|
| Choosing a framework | Next 16 builds with Turbopack, so the webpack-based `@storybook/nextjs` has no app webpack config to reuse, and it would add a second bundler to the lockfile. | `@storybook/nextjs-vite@10.6.5`, whose peer range covers Next 16, React 19 and Vite 8. It resolves the same `vite@8` that `vitest` already pins, so the lockfile gains no second Vite. It reads `next.config.ts` and mocks `next/link`, `next/navigation` and `next/image`. `parameters.nextjs.appDirectory: true` is required: `LocaleProvider` calls the App Router's `useRouter()`. |
| Build error: `server-only` throws in the browser | `app/actions.ts` is a `"use server"` module over `lib/stellar-read.ts`, which imports `server-only`. An automock still evaluates the original module. | `app/__mocks__/actions.ts` replaces it completely (`sb.mock` picks up an adjacent `__mocks__/` file). The leading underscore makes it a private folder, so the App Router never routes it. |
| Build warning, then runtime failure, for `node:crypto` | `DiscoveryConsentModal` imports two defaults from `lib/discovery/service.ts`, which uses `node:crypto` for HMACs. | `lib/discovery/__mocks__/service.ts` provides only those two exports. If a component starts importing anything else from the service, the build fails instead of bundling server code. |
| `MISSING_EXPORT "StreamRoleFilter" … lib/pagination.ts` | `sb.mock(…, { spy: true })` rewrites a module's re-exports **before** TypeScript types are stripped, so `export { type T } from` (and `export type { T } from`) become value imports of types. `lib/stellar.ts` has one. | `lib/stellar.ts` is not mocked. Native-XLM metadata needs no RPC, and token metadata is served from the session cache that `fetchAssetMeta` already checks first; the preview seeds it. App code is unchanged. |
| A local `.env.local` changed the network badge | `vite-plugin-storybook-nextjs` defines each `process.env.NEXT_PUBLIC_*` separately from Next's `loadEnvConfig` (`.env*` files and the shell). Those per-key defines beat Storybook's `env` option. | `main.ts` adds a small Vite plugin with `enforce: "post"` whose `define` is merged last. Verified: building with `NEXT_PUBLIC_STREAMING_CONTRACT_ID` set in the shell leaves no trace in the bundle. |
| `.storybook/main.ts` and `preview.tsx` were never type-checked | TypeScript's `**` globs skip dot-directories. | `tsconfig.json` includes `.storybook/**/*.ts(x)` explicitly, so `npm run typecheck` (and `next build`) covers the config as well as the stories. |
| `MODULE_LEVEL_DIRECTIVE "use client"` warnings during the build | Rolldown notes that it does not preserve `"use client"` in Next's own client files. | Harmless here: the preview is a client bundle with no server components. |
| `node:async_hooks` "externalized for browser compatibility" | `lib/telemetry.ts` (imported by `lib/stellar.ts`) references it behind a runtime guard. | Harmless. The visual suite fails on any uncaught page error, and none is raised. |
| Waiting for a story to be "done" | Storybook 10's terminal render phase is `finished`, after render, `play` and `afterEach`. `completed` is an intermediate phase. | `visual/storybook.ts` waits for `__STORYBOOK_PREVIEW__.currentRender.phase === "finished"` and fails on `errored` or `aborted`. |
