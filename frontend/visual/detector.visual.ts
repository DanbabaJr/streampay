/**
 * Self-tests for the visual gate. A screenshot comparison that cannot fail is
 * green forever, and a story that only looks stable because nothing moved
 * proves nothing about the clock — so both properties are checked directly:
 *
 *  1. A real one-line stylesheet regression fails the comparison against the
 *     committed baseline (and leaves expected / actual / diff images in
 *     test-results/, which CI uploads — the demo diff).
 *  2. The live-accrual counter is frozen by the injected clock: two captures
 *     seconds apart are byte-identical, and advancing the fake clock changes
 *     the render (so (1)'s stability is not an accident of a static page).
 *     When (2) does fail it records what moved — the DOM mutations inside the
 *     window, the height, scroll offset, focus and animation state each capture
 *     saw, and both PNGs — because a drift that cannot be explained cannot be
 *     fixed. (It has been: the first run of that instrumentation showed the
 *     only DOM changes were the caret-hiding styles Playwright writes around its
 *     own captures, and the two images turned out to be identical in every pixel
 *     they shared — the "drift" was one extra row of background added by the
 *     viewport resize a `fullPage` capture performs. So the captures are taken
 *     through a viewport pinned to the page instead, which never resizes under
 *     them.)
 */

import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { renderStory } from "./storybook";

/** The regression: someone "tightens" the status pills in app/globals.css. */
const STATUS_BADGE_REGRESSION = `.status-badge { padding: 0.1rem 0.4rem; }`;
const REGRESSION_STORY = "streams-streamlist--populated";

const LIVE_STORY = "pages-streamdetail--connected-recipient";

test.describe("visual gate self-test", () => {
  test("a one-line CSS regression fails the screenshot comparison", async ({ page }, testInfo) => {
    const name = `${REGRESSION_STORY}.png`;
    const baseline = testInfo.snapshotPath(name, { kind: "screenshot" });

    // Updating baselines must never record the deliberately broken render.
    test.skip(
      testInfo.config.updateSnapshots === "all" || testInfo.config.updateSnapshots === "changed",
      "baseline update run: the regressed render must not become the baseline"
    );
    // Without a baseline toHaveScreenshot would *write* the regressed render.
    expect(fs.existsSync(baseline), `no baseline at ${baseline} to compare against`).toBe(true);

    await renderStory(page, REGRESSION_STORY);
    await page.addStyleTag({ content: STATUS_BADGE_REGRESSION });

    const failure = await expect(page)
      .toHaveScreenshot(name, { fullPage: true, timeout: 5_000 })
      .then(
        () => null,
        (error: Error) => error
      );

    expect(failure, "the visual gate accepted a changed stylesheet").not.toBeNull();
    expect(failure?.message).toMatch(/pixels? .*different|Screenshot comparison failed/i);
  });

  test("the injected clock freezes the live-accrual counter", async ({ page }, testInfo) => {
    await renderStory(page, LIVE_STORY);
    const counter = page.getByLabel(/^Available balance:/);

    // Evidence capture, not a relaxation: the byte comparison below is exactly
    // as strict as it was. What it adds is the answer to *why* two captures of
    // a frozen clock can differ, because "Received: -1" on its own does not
    // say. Every DOM mutation inside the window is recorded (a remount shows up
    // as removed+added nodes, a ticking value as one characterData record, a
    // re-render that only touches attributes as an attribute record), along
    // with the document height each capture saw — `fullPage` output changes
    // size with the height, so a one-pixel layout shift rewrites the whole
    // image — and the animations still alive behind the pin. When the bytes
    // differ, both PNGs are attached to the report, which CI uploads as the
    // `visual-diffs` artifact, so the drift can be read pixel by pixel instead
    // of guessed at.
    await page.evaluate(() => {
      const host = globalThis as unknown as { __STREAMPAY_VISUAL_EVIDENCE__?: string[] };
      const log: string[] = [];
      host.__STREAMPAY_VISUAL_EVIDENCE__ = log;
      const t0 = performance.now();
      const label = (node: Node | null): string => {
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        if (!el) return "(detached)";
        const id = el.id ? `#${el.id}` : "";
        const classes = el.classList.length > 0 ? `.${[...el.classList].join(".")}` : "";
        return `${el.nodeName.toLowerCase()}${id}${classes}`;
      };
      const clip = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").slice(0, 60);
      new MutationObserver((records) => {
        for (const record of records) {
          if (log.length >= 200) return;
          const at = `+${Math.round(performance.now() - t0)}ms`;
          if (record.type === "childList") {
            const added = [...record.addedNodes].map(label).join(",");
            const removed = [...record.removedNodes].map(label).join(",");
            log.push(`${at} children of ${label(record.target)} removed[${removed}] added[${added}]`);
          } else if (record.type === "characterData") {
            log.push(`${at} text of ${label(record.target)} "${clip(record.oldValue)}" -> "${clip(record.target.nodeValue)}"`);
          } else {
            const el = record.target as Element;
            log.push(`${at} ${label(el)} @${record.attributeName} = "${clip(el.getAttribute(record.attributeName ?? ""))}" (was "${clip(record.oldValue)}")`);
          }
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeOldValue: true,
        characterDataOldValue: true,
      });
    });

    interface Capture {
      png: Buffer;
      height: number;
      scrollY: number;
      focus: string;
      animations: string[];
    }

    // The page is read as one snapshot *before* the image, never alongside it,
    // so the numbers describe the state the image was taken from rather than
    // whichever step of a parallel batch happened to finish first.
    const capture = async (): Promise<Capture> => {
      const state = await page.evaluate(() => {
        // Duplicated from the evidence recorder because Playwright serialises an
        // evaluate callback without its Node closures.
        const label = (node: Node | null): string => {
          const el = node instanceof Element ? node : (node?.parentElement ?? null);
          if (!el) return "(detached)";
          const id = el.id ? `#${el.id}` : "";
          const classes = el.classList.length > 0 ? `.${[...el.classList].join(".")}` : "";
          return `${el.nodeName.toLowerCase()}${id}${classes}`;
        };
        return {
          height: document.documentElement.scrollHeight,
          scrollY: window.scrollY,
          focus: label(document.activeElement),
          animations: document.getAnimations().map((a) =>
            `${a instanceof CSSAnimation ? a.animationName : a.constructor.name}:${a.playState}`
          ),
        };
      });
      const png = await page.screenshot({ animations: "disabled" });
      return { png, ...state };
    };

    // Drop focus and reset the scroll before the first capture, because
    // Playwright hides the caret by writing `caret-color: transparent
    // !important` on the *focused element* and restoring it after the shot: the
    // CI mutation log for this test contained exactly those four records and
    // nothing else, which means the only thing that moved the render was the
    // screenshot machinery itself. This normalises the harness once, before any
    // measurement — it is not a re-normalisation between captures. A focus or
    // scroll change inside the window is real drift, so the second capture
    // simply reports what it found (the values are in the failure message)
    // instead of being quietly reset to match the first.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });

    // Pin the viewport, then shoot the viewport instead of the page.
    //
    // `fullPage` is what made this test fail, and the CI evidence says so
    // exactly: of the 1,088,512 pixels the two images shared (1024 × 1063), zero
    // differed — not by a shade, not by one byte — and the whole difference was
    // that the second image carried one extra row, painted `rgb(10, 14, 22)`,
    // the page background. Nothing in the render moved; the *canvas* grew.
    //
    // A document's scroll height is never smaller than its viewport, and a
    // `fullPage` capture resizes the viewport to the document to frame it before
    // restoring it. The 1063 → 1064 step is consistent with that round trip
    // leaving the viewport one CSS pixel taller than it was — which is enough to
    // make `scrollHeight`, and therefore the next full-page image, a pixel taller
    // with the content unchanged. Either way the point stands: a `fullPage`
    // capture reshapes the page it is measuring, so two of them are not
    // comparable.
    //
    // A pinned viewport takes the resize out of the capture path entirely, and
    // the strictness is untouched: the viewport is the whole page plus a margin,
    // so every pixel of content is still in the compared image, the comparison is
    // still byte-for-byte, and a render that genuinely moved would still fail.
    const contentHeight = await page.evaluate(() => {
      const bottom = document.body.getBoundingClientRect().bottom + window.scrollY;
      const last = [...document.body.children].reduce(
        (max, el) => Math.max(max, el.getBoundingClientRect().bottom + window.scrollY),
        0
      );
      return Math.ceil(Math.max(bottom, last));
    });
    await page.setViewportSize({ width: 1024, height: contentHeight + 60 });
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done(null)))
        )
    );

    const first = await capture();
    const before = await counter.textContent();
    // The engine's local ticker fires every second; let it fire a few times.
    await page.waitForTimeout(2_500);
    const second = await capture();

    const mutations = await page.evaluate(
      () =>
        (globalThis as unknown as { __STREAMPAY_VISUAL_EVIDENCE__?: string[] })
          .__STREAMPAY_VISUAL_EVIDENCE__ ?? []
    );

    expect(await counter.textContent()).toBe(before);

    let evidence = "";
    const drift =
      `render drifted while the clock was frozen: ${first.png.length} vs ${second.png.length} bytes, ` +
      `scrollHeight ${first.height} -> ${second.height}, ` +
      `scrollY ${first.scrollY} -> ${second.scrollY}, ` +
      `focus ${first.focus} -> ${second.focus}, ` +
      `animations ${first.animations.join(",") || "none"} -> ${second.animations.join(",") || "none"}, ` +
      `${mutations.length} DOM mutations [${mutations.slice(0, 25).join(" ;; ").slice(0, 1_500)}]`;

    // Attaching by `body` rather than by `path`: the test's output directory is
    // not created until Playwright itself writes to it, so writing a file there
    // from the test body fails with ENOENT — and an evidence bug that throws
    // replaces the very failure the evidence exists to explain. So nothing
    // touches the filesystem, and the whole capture is wrapped anyway: if it
    // ever does go wrong the message says so and the assertion still runs.
    if (Buffer.compare(first.png, second.png) !== 0) {
      try {
        await Promise.all([
          testInfo.attach("drift-before", { body: first.png, contentType: "image/png" }),
          testInfo.attach("drift-after", { body: second.png, contentType: "image/png" }),
          testInfo.attach("drift-dom-mutations", {
            body: Buffer.from(
              [
                drift,
                `capture 1 animations: ${first.animations.join(", ") || "none"}`,
                `capture 2 animations: ${second.animations.join(", ") || "none"}`,
                ...mutations,
              ].join("\n"),
              "utf8"
            ),
            contentType: "text/plain",
          }),
        ]);
      } catch (e) {
        evidence = `evidence capture failed: ${String(e)}`;
      }
    }

    expect(Buffer.compare(first.png, second.png), [drift, evidence].filter(Boolean).join(" — ")).toBe(0);

    // Positive control: the counter is clock-driven, so moving the fake clock
    // a minute forward must move it on the next tick.
    await page.evaluate(() => {
      const host = globalThis as unknown as {
        __STREAMPAY_FAKE_CLOCK__?: { tick(ms: number): void };
      };
      host.__STREAMPAY_FAKE_CLOCK__?.tick(60_000);
    });
    await expect(counter).not.toHaveText(before ?? "", { timeout: 5_000 });
  });
});
