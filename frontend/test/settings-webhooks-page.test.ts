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
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:3000/settings/webhooks",
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
global.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
global.cancelAnimationFrame = (id: number) => clearTimeout(id);

// Mock confirm and clipboard globally
const mockConfirm = () => true;
global.confirm = mockConfirm;
globalThis.confirm = mockConfirm;
dom.window.confirm = mockConfirm;

Object.defineProperty(dom.window.navigator, "clipboard", {
  value: {
    writeText: async () => {},
  },
  configurable: true,
  writable: true,
});

// Dynamically import dependencies via loader
const webhooksMod = await import("../app/settings/webhooks/page.tsx");
const WebhooksSettingsPage = webhooksMod.default;

const { LocaleProvider } = await import("../lib/i18n/provider.tsx");
const { ToastProvider, createToastStore } = await import("../components/toast.tsx");
type ToastStore = ReturnType<typeof createToastStore>;

describe("WebhooksSettingsPage", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  let toastStore: ToastStore;
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
    fetchHandlers = [];
    toastStore = createToastStore();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);

    global.confirm = () => true;
    globalThis.confirm = () => true;
    dom.window.confirm = () => true;

    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const handler of fetchHandlers) {
        const res = await handler(url, init);
        if (res !== null) return res;
      }
      return jsonResponse([]);
    };
  });

  afterEach(async () => {
    if (toastStore) {
      toastStore.clear();
    }
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = "";
  });

  async function renderPage() {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(
          LocaleProvider,
          { locale: "en" },
          React.createElement(ToastProvider, { store: toastStore }, React.createElement(WebhooksSettingsPage))
        )
      );
    });
  }

  function fireChange(element: HTMLElement, value: string) {
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

  it("initial load populates webhook endpoints from the API", async () => {
    mockRoute(async (url) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        return jsonResponse([
          {
            id: "ep_abc123",
            url: "https://myservice.org/webhooks/payouts",
            secret: "whsec_hidden_secret_value",
            events: ["stream_created", "withdrawn"],
            status: "active",
            created_at: "2026-11-20T12:00:00Z",
          },
        ]);
      }
      return null;
    });

    await renderPage();

    assert.ok(container.textContent?.includes("https://myservice.org/webhooks/payouts"));
    assert.ok(container.textContent?.includes("ep_abc123"));
    assert.ok(container.textContent?.includes("active"));
    assert.ok(container.textContent?.includes("stream_created"));
    assert.ok(container.textContent?.includes("withdrawn"));
  });

  it("surfaces recoverable error via toast when initial endpoint load fails", async () => {
    mockRoute(async (url) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        throw new Error("503 Service Unavailable");
      }
      return null;
    });

    await renderPage();

    assert.ok(document.body.textContent?.includes("Failed to load webhook data: Error: 503 Service Unavailable"));
    assert.ok(container.textContent?.includes("No webhook endpoints registered yet."));
  });

  it("invalid input shows field errors and blocks save", async () => {
    let postCalled = false;
    mockRoute(async (url, init) => {
      if (url === "/api/webhooks" && init?.method === "POST") {
        postCalled = true;
        return jsonResponse({ error: "SSRF guard: Destination URL resolves to a private IP range." }, 400);
      }
      return null;
    });

    await renderPage();

    const urlInput = container.querySelector("#webhook-url") as HTMLInputElement;
    assert.ok(urlInput);
    assert.equal(urlInput.required, true, "Endpoint URL must have HTML5 required constraint");

    // Empty URL blocks submission in handleRegisterEndpoint
    await act(async () => {
      fireChange(urlInput, "   ");
    });
    await act(async () => {
      const form = container.querySelector("form")!;
      fireSubmit(form);
    });
    assert.equal(postCalled, false, "Empty URL must not trigger POST");

    // Enter disallowed URL that server rejects
    await act(async () => {
      const input = container.querySelector("#webhook-url") as HTMLInputElement;
      fireChange(input, "https://192.168.1.1/hook");
    });
    await act(async () => {
      const form = container.querySelector("form")!;
      fireSubmit(form);
    });

    assert.equal(postCalled, true);
    assert.ok(document.body.textContent?.includes("SSRF guard: Destination URL resolves to a private IP range."));
  });

  it("successful save persists and reflects the new state", async () => {
    const endpointsList = [
      {
        id: "ep_1",
        url: "https://initial.com/hook",
        secret: "whsec_111",
        events: ["stream_created"],
        status: "active",
        created_at: "2026-11-20T00:00:00Z",
      },
    ];

    let createdPayload: { action: string; url: string; events: string[] } | null = null;
    mockRoute(async (url, init) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        return jsonResponse([...endpointsList]);
      }
      if (url === "/api/webhooks" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "create") {
          createdPayload = body;
          endpointsList.push({
            id: "ep_new_99",
            url: body.url,
            secret: "whsec_brand_new_secret",
            events: body.events,
            status: "active",
            created_at: new Date().toISOString(),
          });
          return jsonResponse({
            id: "ep_new_99",
            secret: "whsec_brand_new_secret",
          });
        }
      }
      return null;
    });

    await renderPage();

    const urlInput = container.querySelector("#webhook-url") as HTMLInputElement;

    await act(async () => {
      fireChange(urlInput, "https://api.merchant.com/streampay-inbound");
    });
    await act(async () => {
      const form = container.querySelector("form")!;
      fireSubmit(form);
    });

    assert.ok(document.body.textContent?.includes("Webhook endpoint registered successfully!"));
    assert.equal(createdPayload?.url, "https://api.merchant.com/streampay-inbound");

    const updatedUrlInput = container.querySelector("#webhook-url") as HTMLInputElement;
    assert.equal(updatedUrlInput.value, "");

    // Reflected in the configured endpoints list
    assert.ok(container.textContent?.includes("https://api.merchant.com/streampay-inbound"));
    assert.ok(container.textContent?.includes("ep_new_99"));
  });

  it("Webhook secret handling: asserts secrets are never rendered back in full after save (mask behavior)", async () => {
    const rawSecret = "whsec_top_secret_entropy_never_show_again_789";
    const endpoints = [
      {
        id: "ep_secured_1",
        url: "https://payments.example.com/webhook",
        secret: rawSecret,
        events: ["stream_created"],
        status: "active",
        created_at: "2026-11-20T00:00:00Z",
      },
    ];

    mockRoute(async (url, init) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        return jsonResponse(endpoints);
      }
      if (url === "/api/webhooks" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "create") {
          return jsonResponse({ id: "ep_secured_1", secret: rawSecret });
        }
      }
      return null;
    });

    await renderPage();

    // 1. In configured endpoints list, secret is masked / never rendered in full
    assert.ok(container.textContent?.includes("https://payments.example.com/webhook"));
    assert.equal(
      container.textContent?.includes(rawSecret),
      false,
      "Configured endpoints list must never expose secret in plain text"
    );

    // 2. Trigger creation to verify one-time banner disclosure contract
    const urlInput = container.querySelector("#webhook-url") as HTMLInputElement;
    await act(async () => {
      fireChange(urlInput, "https://payments.example.com/webhook");
    });
    await act(async () => {
      const form = container.querySelector("form")!;
      fireSubmit(form);
    });

    // One-time banner displays secret for copying
    assert.ok(container.textContent?.includes("Webhook Signing Secret Generated"));
    assert.ok(container.textContent?.includes("Copy this secret now. It will not be shown again in plain text."));
    assert.ok(container.textContent?.includes(rawSecret));

    // Dismiss banner
    const dismissBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Dismiss")
    );
    assert.ok(dismissBtn);
    await act(async () => {
      fireClick(dismissBtn!);
    });

    // After dismiss, secret is no longer anywhere in the DOM
    assert.equal(
      container.textContent?.includes(rawSecret),
      false,
      "Dismissed secret must be completely removed from DOM"
    );
  });

  it("secret rotation shows one-time secret and keeps endpoint list masked", async () => {
    const rotatedSecret = "whsec_newly_rotated_secret_val_456";
    mockRoute(async (url, init) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        return jsonResponse([
          {
            id: "ep_rot_1",
            url: "https://rot.example.com/hook",
            secret: "whsec_old_secret",
            events: ["stream_created"],
            status: "active",
            created_at: "2026-11-20T00:00:00Z",
          },
        ]);
      }
      if (url === "/api/webhooks" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "rotate") {
          return jsonResponse({ id: "ep_rot_1", secret: rotatedSecret });
        }
      }
      return null;
    });

    await renderPage();

    const rotateBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rotate Secret")
    );
    assert.ok(rotateBtn);

    await act(async () => {
      fireClick(rotateBtn!);
    });

    assert.ok(document.body.textContent?.includes("Signing secret rotated successfully!"));
    assert.ok(container.textContent?.includes(rotatedSecret));
  });

  it("endpoint deletion removes item and surfaces error gracefully on failure", async () => {
    let endpoints = [
      {
        id: "ep_del_1",
        url: "https://delete.example.com/hook",
        secret: "whsec_del",
        events: ["stream_created"],
        status: "active",
        created_at: "2026-11-20T00:00:00Z",
      },
    ];

    let deleteCalled = false;
    let shouldFail = false;

    mockRoute(async (url, init) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        return jsonResponse([...endpoints]);
      }
      if (url === "/api/webhooks" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "delete") {
          deleteCalled = true;
          if (shouldFail) {
            return jsonResponse({ error: "Failed to delete endpoint" }, 500);
          }
          endpoints = [];
          return jsonResponse({ success: true });
        }
      }
      return null;
    });

    await renderPage();

    const deleteBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete")
    );
    assert.ok(deleteBtn);

    // 1. Success deletion
    await act(async () => {
      fireClick(deleteBtn!);
    });

    assert.equal(deleteCalled, true);
    assert.ok(document.body.textContent?.includes("Webhook endpoint deleted"));
    assert.ok(container.textContent?.includes("No webhook endpoints registered yet."));

    // 2. Failure path
    shouldFail = true;
    endpoints = [
      {
        id: "ep_del_2",
        url: "https://fail-delete.com/hook",
        secret: "whsec_del2",
        events: ["stream_created"],
        status: "active",
        created_at: "2026-11-20T00:00:00Z",
      },
    ];
    await renderPage();

    const deleteBtn2 = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete")
    );
    assert.ok(deleteBtn2);

    await act(async () => {
      fireClick(deleteBtn2!);
    });

    assert.ok(document.body.textContent?.includes("Failed to delete endpoint"));
    assert.ok(container.textContent?.includes("https://fail-delete.com/hook"));
  });

  it("test fire triggers test ping and surfaces toast feedback", async () => {
    mockRoute(async (url, init) => {
      if (url.includes("/api/webhooks?type=endpoints")) {
        return jsonResponse([
          {
            id: "ep_test_1",
            url: "https://testfire.org/hook",
            secret: "whsec_t",
            events: ["stream_created"],
            status: "active",
            created_at: "2026-11-20T00:00:00Z",
          },
        ]);
      }
      if (url === "/api/webhooks" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "test") {
          return jsonResponse({ success: true, statusCode: 200 });
        }
      }
      return null;
    });

    await renderPage();

    const testFireBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Test Fire")
    );
    assert.ok(testFireBtn);

    await act(async () => {
      fireClick(testFireBtn!);
    });

    assert.ok(document.body.textContent?.includes("Test ping delivered! HTTP 200"));
  });

  it("navigates tabs and handles DLQ items replay", async () => {
    let dlqItems = [
      {
        id: "dlq_item_1",
        delivery_id: "del_1",
        endpoint_id: "ep_1",
        event_id: "evt_1",
        stream_id: "42",
        event_type: "stream_created",
        attempts_count: 5,
        last_error: "Connection refused",
        last_status_code: 502,
        created_at: "2026-11-20T00:00:00Z",
      },
    ];

    let replayCalled = false;
    mockRoute(async (url, init) => {
      if (url.includes("/api/webhooks?type=dlq")) {
        return jsonResponse([...dlqItems]);
      }
      if (url === "/api/webhooks" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.action === "replay_dlq") {
          replayCalled = true;
          dlqItems = [];
          return jsonResponse({ success: true });
        }
      }
      return null;
    });

    await renderPage();

    // Switch to DLQ tab
    const dlqTabBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Dead-Letter Queue")
    );
    assert.ok(dlqTabBtn);

    await act(async () => {
      fireClick(dlqTabBtn!);
    });

    assert.ok(container.textContent?.includes("Connection refused"));
    assert.ok(container.textContent?.includes("Stream #42"));
    assert.ok(container.textContent?.includes("5 / 5 Exhausted"));

    // Click Replay
    const replayBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Replay / Retry")
    );
    assert.ok(replayBtn);

    await act(async () => {
      fireClick(replayBtn!);
    });

    assert.equal(replayCalled, true);
    assert.ok(document.body.textContent?.includes("Event re-enqueued for fresh delivery!"));
    assert.ok(container.textContent?.includes("No dead-letter items. All webhooks delivered successfully."));
  });
});
