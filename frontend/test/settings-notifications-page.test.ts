import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Register custom ESM loader for TSX and @/ resolution
register(pathToFileURL(path.resolve(import.meta.dirname, "loader.mjs")).href);

// Setup JSDOM environment
const dom = new JSDOM("<!DOCTYPE html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:3000/settings/notifications",
  pretendToBeVisual: true,
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
global.window = dom.window as unknown as Window & typeof globalThis;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLInputElement = dom.window.HTMLInputElement;
global.HTMLSelectElement = dom.window.HTMLSelectElement;
global.HTMLButtonElement = dom.window.HTMLButtonElement;
global.HTMLFormElement = dom.window.HTMLFormElement;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.KeyboardEvent = dom.window.KeyboardEvent;

// Dynamically import dependencies via loader
const notifMod = await import("../app/settings/notifications/page.tsx");
const NotificationsSettingsPage = notifMod.default;

const { LocaleProvider } = await import("../lib/i18n/provider.tsx");
const { ToastProvider } = await import("../components/toast.tsx");
const { setMockFreighter, resetMockFreighter } = await import("./mocks/freighter.ts");

const TEST_ADDR = "GBZXN7PIRZGNMHGA72ST2EQTV6QGQUVIBGF72ST2EQTV6QGQUVIBGF72";

describe("NotificationsSettingsPage", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  let fetchHandlers: Array<(url: string, init?: RequestInit) => Promise<Response | null>> = [];

  function mockRoute(handler: (url: string, init?: RequestInit) => Promise<Response | null>) {
    fetchHandlers.unshift(handler);
  }

  function jsonResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as unknown as Response;
  }

  beforeEach(() => {
    resetMockFreighter();
    fetchHandlers = [];
    document.body.innerHTML = "<div id='root'></div>";
    container = document.getElementById("root")!;

    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const handler of fetchHandlers) {
        const res = await handler(url, init);
        if (res !== null) return res;
      }
      return jsonResponse({ subscriptions: [] });
    };
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    resetMockFreighter();
  });

  async function renderPage() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(
          LocaleProvider,
          { locale: "en" },
          React.createElement(ToastProvider, null, React.createElement(NotificationsSettingsPage))
        )
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function fireChange(element: HTMLElement, value: string) {
    if (!element) throw new Error("fireChange called on null element");
    (element as HTMLInputElement).value = value;
    const propKey = Object.keys(element).find((k) => k.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propKey] : null;
    if (props?.onChange) {
      props.onChange({
        target: element,
        currentTarget: element,
        preventDefault: () => {},
        stopPropagation: () => {},
      });
    } else {
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function fireClick(element: HTMLElement) {
    const propKey = Object.keys(element).find((k) => k.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, { onClick?: (e: unknown) => void }>)[propKey] : null;
    if (props?.onClick) {
      props.onClick({
        preventDefault: () => {},
        stopPropagation: () => {},
        target: element,
        currentTarget: element,
      });
    } else {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
  }

  function fireSubmit(element: HTMLFormElement) {
    const propKey = Object.keys(element).find((k) => k.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, { onSubmit?: (e: unknown) => void }>)[propKey] : null;
    if (props?.onSubmit) {
      props.onSubmit({
        preventDefault: () => {},
        stopPropagation: () => {},
        target: element,
        currentTarget: element,
      });
    } else {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
  }

  it("renders unauthenticated wallet connect prompt initially", async () => {
    setMockFreighter({ connected: false });
    await renderPage();

    assert.ok(container.textContent?.includes("Connect your Stellar wallet to manage alert channels."));
    const connectBtn = container.querySelector("button");
    assert.equal(connectBtn?.textContent?.trim(), "Connect Freighter Wallet");
    assert.equal(container.querySelector("form"), null);
  });

  it("surfaces recoverable error when wallet connection fails", async () => {
    setMockFreighter({ connected: false });
    await renderPage();

    const connectBtn = container.querySelector("button");
    assert.ok(connectBtn);

    await act(async () => {
      fireClick(connectBtn!);
    });

    assert.ok(container.textContent?.includes("Freighter wallet extension not found. Please install Freighter."));
  });

  it("initial load populates subscriptions from the API when wallet is connected", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signedMessage: "mock_signature_base64",
    });

    let requestedAddress: string | null = null;
    mockRoute(async (url) => {
      if (url.startsWith("/api/notifications?address=")) {
        requestedAddress = new URL(url, "http://localhost").searchParams.get("address");
        return jsonResponse({
          subscriptions: [
            {
              id: "sub_existing_1",
              channel: "webhook",
              config: { webhook: { url: "https://myapi.example.com/stream-hook" } },
              eventTypes: ["claim", "liveness"],
              status: "active",
            },
          ],
        });
      }
      return null;
    });

    await renderPage();

    assert.equal(requestedAddress, TEST_ADDR);
    assert.ok(container.textContent?.includes("https://myapi.example.com/stream-hook"));
    assert.ok(container.textContent?.includes("active"));
    assert.ok(container.textContent?.toLowerCase().includes("webhook"));
  });

  it("surfaces recoverable error when address challenge request fails", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
    });

    mockRoute(async (url, init) => {
      if (url === "/api/notifications" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "challenge") {
          return jsonResponse({ error: "Too many verification requests. Please try again later." }, 429);
        }
      }
      return null;
    });

    await renderPage();

    const signBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sign Verification Challenge")
    );
    assert.ok(signBtn);

    await act(async () => {
      fireClick(signBtn!);
    });

    assert.ok(container.textContent?.includes("Too many verification requests. Please try again later."));
    assert.equal(container.querySelector("form"), null);
  });

  it("surfaces recoverable error when user rejects signature", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signError: { message: "User rejected signature request." },
    });

    mockRoute(async (url, init) => {
      if (url === "/api/notifications" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "challenge") {
          return jsonResponse({ challenge: { message: "challenge_nonce_12345" } });
        }
      }
      return null;
    });

    await renderPage();

    const signBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sign Verification Challenge")
    );
    assert.ok(signBtn);

    await act(async () => {
      fireClick(signBtn!);
    });

    assert.ok(container.textContent?.includes("User rejected signature request."));
    assert.equal(container.querySelector("form"), null);
  });

  it("invalid input shows field errors and blocks save", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signedMessage: "valid_sig",
    });

    mockRoute(async (url, init) => {
      if (url === "/api/notifications" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "challenge") {
          return jsonResponse({ challenge: { message: "msg" } });
        }
        if (body.action === "subscribe") {
          return jsonResponse({ error: "Invalid webhook URL." }, 400);
        }
      }
      return null;
    });

    await renderPage();

    const signBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sign Verification Challenge")
    );
    if (signBtn) {
      await act(async () => {
        fireClick(signBtn);
      });
    }

    const form = container.querySelector("form");
    assert.ok(form, "Registration form should be rendered");

    const urlInput = container.querySelector("#webhook-url") as HTMLInputElement;
    assert.ok(urlInput);
    assert.equal(urlInput.required, true, "Endpoint URL must have HTML5 required attribute");

    await act(async () => {
      fireChange(urlInput, "ftp://bad-url");
    });

    await act(async () => {
      fireSubmit(form);
    });

    assert.ok(container.textContent?.includes("Invalid webhook URL."));
  });

  it("successful save persists, reflects new state, and clears inputs", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signedMessage: "valid_sig",
    });

    const currentSubs = [
      {
        id: "sub_1",
        channel: "webhook",
        config: { webhook: { url: "https://initial.com/hook" } },
        eventTypes: ["claim"],
        status: "active",
      },
    ];

    let subscribeBody: {
      address: string;
      channel: string;
      config: { webhook?: { url: string; secret: string } };
      eventTypes: string[];
    } | null = null;

    mockRoute(async (url, init) => {
      if (url.startsWith("/api/notifications?address=")) {
        return jsonResponse({ subscriptions: [...currentSubs] });
      }
      if (url === "/api/notifications" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "challenge") {
          return jsonResponse({ challenge: { message: "msg" } });
        }
        if (body.action === "subscribe") {
          subscribeBody = body;
          currentSubs.push({
            id: "sub_new_2",
            channel: body.channel,
            config: body.config,
            eventTypes: body.eventTypes,
            status: "active",
          });
          return jsonResponse({
            subscription: {
              id: "sub_new_2",
              channel: body.channel,
              config: body.config,
              eventTypes: body.eventTypes,
              status: "active",
            },
          });
        }
      }
      return null;
    });

    await renderPage();

    const signBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sign Verification Challenge")
    );
    if (signBtn) {
      await act(async () => {
        fireClick(signBtn);
      });
    }

    const form = container.querySelector("form")!;
    const urlInput = container.querySelector("#webhook-url") as HTMLInputElement;
    const secretInput = container.querySelector("#webhook-secret") as HTMLInputElement;

    await act(async () => {
      fireChange(urlInput, "https://api.acme.corp/streampay-hook");
      fireChange(secretInput, "whsec_supersecretkey999");
    });

    await act(async () => {
      fireSubmit(form);
    });

    assert.ok(container.textContent?.includes("✓ Subscription registered successfully!"));
    assert.equal(subscribeBody?.address, TEST_ADDR);
    assert.equal(subscribeBody?.config?.webhook?.url, "https://api.acme.corp/streampay-hook");
    assert.equal(urlInput.value, "");
    assert.equal(secretInput.value, "");

    // Persisted subscription is displayed in the list
    assert.ok(container.textContent?.includes("https://api.acme.corp/streampay-hook"));
  });

  it("Webhook secret handling: asserts secrets are never rendered back in full after save", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signedMessage: "valid_sig",
    });

    const secretValue = "whsec_ultra_confidential_token_xyz_456";
    mockRoute(async (url) => {
      if (url.startsWith("/api/notifications?address=")) {
        return jsonResponse({
          subscriptions: [
            {
              id: "sub_masked_1",
              channel: "webhook",
              config: {
                webhook: {
                  url: "https://audit.example.com/notify",
                  secret: secretValue,
                },
              },
              eventTypes: ["claim"],
              status: "active",
            },
          ],
        });
      }
      return null;
    });

    await renderPage();

    assert.ok(container.textContent?.includes("https://audit.example.com/notify"));
    assert.equal(
      container.textContent?.includes(secretValue),
      false,
      "Webhook secret must never be rendered back in full"
    );
  });

  it("API failure surfaces a recoverable error rather than crashing", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signedMessage: "valid_sig",
    });

    mockRoute(async (url, init) => {
      if (url === "/api/notifications" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "challenge") {
          return jsonResponse({ challenge: { message: "msg" } });
        }
        if (body.action === "subscribe") {
          throw new Error("Network timeout: 504 Gateway Timeout");
        }
      }
      return null;
    });

    await renderPage();

    const signBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sign Verification Challenge")
    );
    if (signBtn) {
      await act(async () => {
        fireClick(signBtn);
      });
    }

    const form = container.querySelector("form")!;
    const urlInput = container.querySelector("#webhook-url") as HTMLInputElement;
    await act(async () => {
      fireChange(urlInput, "https://api.example.com/hook");
    });

    await act(async () => {
      fireSubmit(form);
    });

    assert.ok(container.textContent?.includes("Subscription error: Error: Network timeout: 504 Gateway Timeout"));
    assert.ok(container.querySelector("form") !== null);
  });

  it("handles subscription deletion gracefully", async () => {
    setMockFreighter({
      connected: true,
      address: TEST_ADDR,
      signedMessage: "valid_sig",
    });

    let deletedId: string | null = null;
    let subs = [
      {
        id: "sub_del_123",
        channel: "webhook",
        config: { webhook: { url: "https://delete-me.com/hook" } },
        eventTypes: ["claim"],
        status: "active",
      },
    ];

    mockRoute(async (url, init) => {
      if (init?.method === "DELETE" && url.startsWith("/api/notifications?")) {
        const u = new URL(url, "http://localhost");
        deletedId = u.searchParams.get("id");
        subs = [];
        return jsonResponse({ success: true });
      }
      if (url.startsWith("/api/notifications?address=")) {
        return jsonResponse({ subscriptions: subs });
      }
      return null;
    });

    await renderPage();

    assert.ok(container.textContent?.includes("https://delete-me.com/hook"));
    const deleteBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete")
    );
    assert.ok(deleteBtn);

    await act(async () => {
      fireClick(deleteBtn!);
    });

    assert.equal(deletedId, "sub_del_123");
    assert.ok(container.textContent?.includes("Subscription removed."));
    assert.ok(container.textContent?.includes("No notification channels registered for this address yet."));
  });
});
