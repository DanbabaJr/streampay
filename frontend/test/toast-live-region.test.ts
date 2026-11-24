import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToastStore } from "../lib/toast";

register(pathToFileURL(path.resolve(import.meta.dirname, "loader.mjs")).href);

const dom = new JSDOM("<!DOCTYPE html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:3000/",
  pretendToBeVisual: true,
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
global.window = dom.window as unknown as Window & typeof globalThis;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const { LocaleProvider } = await import("../lib/i18n/provider.tsx");
const {
  ToastProvider,
  announcementPoliteness,
  createToastStore,
} = await import("../components/toast.tsx");
const { useStreamStatusAnnouncements } = await import("../lib/use-stream-status-announcements.ts");
const { setMockPathname } = await import("./mocks/navigation.ts");

function StatusProbe({
  streams,
}: {
  streams: ReadonlyArray<{ id: string; status: string }>;
}) {
  useStreamStatusAnnouncements(streams);
  return null;
}

describe("shared toast and status live region", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  let store: ToastStore;

  beforeEach(() => {
    document.body.innerHTML = "<div id='root'></div>";
    container = document.getElementById("root")!;
    store = createToastStore();
    setMockPathname("/");
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
  });

  async function render(
    streams: ReadonlyArray<{ id: string; status: string }> = [],
    locale: "en" | "de" = "en"
  ) {
    if (!root) root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(
          LocaleProvider,
          { locale },
          React.createElement(
            ToastProvider,
            { store },
            React.createElement(StatusProbe, { streams })
          )
        )
      );
    });
  }

  function liveRegion(): HTMLElement {
    const region = container.querySelector<HTMLElement>("[data-live-region]");
    assert.ok(region);
    return region;
  }

  it("mounts one region and maps info/success to polite and errors to assertive", async () => {
    await render();
    assert.equal(container.querySelectorAll("[data-live-region]").length, 1);
    assert.equal(announcementPoliteness("info"), "polite");
    assert.equal(announcementPoliteness("success"), "polite");
    assert.equal(announcementPoliteness("error"), "assertive");

    await act(async () => store.success("Stream #1 created.", 0));
    assert.equal(liveRegion().textContent, "Stream #1 created.");
    assert.equal(liveRegion().getAttribute("aria-live"), "polite");
    assert.equal(liveRegion().getAttribute("aria-atomic"), "true");
    assert.equal(container.querySelectorAll("[aria-live]").length, 1);
    assert.equal(container.querySelector(".toast-item")?.getAttribute("role"), null);

    await act(async () => store.error("Transaction failed.", 0));
    assert.equal(liveRegion().textContent, "Transaction failed.");
    assert.equal(liveRegion().getAttribute("aria-live"), "assertive");
    assert.equal(container.querySelectorAll("[aria-live]").length, 1);
  });

  it("dedupes consecutive identical toasts and clears stale text on navigation", async () => {
    await render();
    let updates = 0;
    store.subscribeToAnnouncements(() => updates++);

    await act(async () => {
      store.info("Stream #1 is active.", 0);
      store.info("Stream #1 is active.", 0);
    });
    assert.equal(updates, 1);
    assert.equal(liveRegion().textContent, "Stream #1 is active.");
    assert.equal(container.querySelectorAll(".toast-item").length, 2);

    setMockPathname("/stream/2");
    await render();
    assert.equal(liveRegion().textContent, "");

    await act(async () => store.info("Stream #1 is active.", 0));
    assert.equal(liveRegion().textContent, "Stream #1 is active.");
  });

  it("announces normalized status changes once and uses the active locale", async () => {
    await render([{ id: "1", status: "Active" }], "de");
    assert.equal(liveRegion().textContent, "");

    await render([{ id: "1", status: "active" }], "de");
    assert.equal(liveRegion().textContent, "");

    let updates = 0;
    store.subscribeToAnnouncements(() => updates++);
    await render([{ id: "1", status: "Cancelled" }], "de");
    assert.equal(liveRegion().textContent, "Stream #1 storniert.");
    assert.equal(updates, 1);

    await render([{ id: "1", status: "cancelled" }], "de");
    assert.equal(updates, 1);
    assert.equal(liveRegion().textContent, "Stream #1 storniert.");

    await render([{ id: "1", status: "Depleted" }], "de");
    assert.equal(liveRegion().textContent, "Stream #1 ist jetzt ausgeschöpft.");
    assert.equal(liveRegion().getAttribute("aria-live"), "polite");
  });
});
