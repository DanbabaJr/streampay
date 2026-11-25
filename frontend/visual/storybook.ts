/**
 * Helpers shared by the visual suites: discover stories from the static
 * Storybook build and render one to a settled, screenshot-ready state.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const STATIC_DIR = path.join(__dirname, "..", "storybook-static");

/** Stories tagged with this are documented but never screenshotted. */
export const SKIP_TAG = "no-visual";

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  tags: string[];
}

/**
 * Every story in the built index, minus docs pages and `no-visual` stories.
 * Read at collection time so each story is its own test (and its own line in
 * the report); a missing build is an error, not an empty suite.
 */
export function loadStories(): StoryEntry[] {
  const indexPath = path.join(STATIC_DIR, "index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `${indexPath} is missing. Build Storybook first: npm run build-storybook`
    );
  }
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    entries: Record<string, StoryEntry & { type: string }>;
  };
  return Object.values(index.entries)
    .filter((entry) => entry.type === "story" && !entry.tags.includes(SKIP_TAG))
    .sort((a, b) => a.id.localeCompare(b.id));
}

type RenderPhase = string | undefined;

/**
 * Terminal phases of Storybook's StoryRender (storybook/preview runtime):
 * `finished` once render, `play` and `afterEach` are all done; the others are
 * failures. Handed to the page as an argument: the predicate below runs in
 * the browser and cannot see this module's scope.
 */
const SETTLED_PHASES = ["finished", "errored", "aborted"];

declare global {
  interface Window {
    __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: RenderPhase } };
  }
}

/**
 * A settled render is not yet a *pinned* one: elements can still be animating.
 * A baseline has exactly one committed state, and an infinite CSS animation has
 * none. Playwright's `animations: "disabled"` pauses or cancels an animation at
 * capture time rather than removing it, so what lands in the PNG depends on
 * where in its cycle the animation happened to be (`pulse` and `wallet-spin` in
 * app/globals.css are both infinite, and a transition that a re-render restarts
 * mid-flight behaves the same way). Declaring the animation away instead — the
 * same thing the app's own `prefers-reduced-motion` block does to `.live-dot` —
 * pins every element to its static specified style, which is the only state a
 * baseline can commit to. The caret is hidden the same way, so a focused field
 * cannot blink between two captures of the same render.
 */
const PIN_RENDERED_STATE = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}`;

/**
 * Opens a story in the bare preview iframe and waits until it is settled:
 * the render (including its `play` function) has completed, the animation and
 * transition state is pinned, web fonts have loaded, and two animation frames
 * have passed so the last commit is painted.
 *
 * Fails the test if the story errored, threw an uncaught exception, or tried
 * to reach anything other than the local Storybook server.
 */
export async function renderStory(page: Page, id: string): Promise<void> {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  // A story must be hermetic: no RPC node, no Horizon, no CDN.
  const external: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => {
    external.push(route.request().url());
    return route.abort();
  });

  await page.goto(`/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`);

  const handle = await page.waitForFunction(
    (settled) => {
      const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase;
      return phase !== undefined && settled.includes(phase) ? phase : false;
    },
    SETTLED_PHASES,
    { timeout: 20_000 }
  );
  const phase = await handle.jsonValue();

  expect(phase, `story ${id} did not render (phase: ${phase})`).toBe("finished");
  await expect(
    page.locator(".sb-show-errordisplay"),
    `story ${id} rendered Storybook's error display`
  ).toHaveCount(0);

  await page.addStyleTag({ content: PIN_RENDERED_STATE });

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });

  expect(pageErrors.map(String), `uncaught errors in story ${id}`).toEqual([]);
  expect(external, `story ${id} reached outside the Storybook server`).toEqual([]);
}
