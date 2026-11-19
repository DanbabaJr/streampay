/**
 * One full-page screenshot per story, compared against the committed
 * baseline in visual/__screenshots__/linux/<story-id>.png.
 */

import { expect, test } from "@playwright/test";
import { loadStories, renderStory } from "./storybook";

for (const story of loadStories()) {
  test(`${story.title} › ${story.name}`, async ({ page }) => {
    await renderStory(page, story.id);
    await expect(page).toHaveScreenshot(`${story.id}.png`, { fullPage: true });
  });
}
