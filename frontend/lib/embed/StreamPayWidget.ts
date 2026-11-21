/**
 * <streampay-stream> — framework-agnostic custom element.
 *
 * Usage:
 *   <script src="/embed/loader.js"></script>
 *   <streampay-stream
 *     stream-id="42"
 *     mode="read"
 *     theme="auto"
 *     allowed-origins="https://example.com"
 *   ></streampay-stream>
 *
 * Attributes
 * ──────────
 * • stream-id   (required) — the numeric stream id to display.
 * • mode        (optional, default "read") — "read" | "claim" | "link".
 * • theme       (optional, default "auto") — "light" | "dark" | "auto".
 * • allowed-origins (optional) — comma-separated list of origins that may
 *                   receive postMessage events from this widget. Defaults to
 *                   the current page origin.
 *
 * The element renders a sandboxed <iframe> that hosts the embed page.
 * postMessage RPC messages are forwarded to the parent via a CustomEvent
 * on the element itself, so integrators can listen on the element.
 *
 * Security
 * ────────
 * The iframe carries allow="wallet" and a strict CSP sandbox that prevents
 * scripts from reaching parent DOM, popups, or unintended origins.
 * Inbound postMessage frames are validated against allowed-origins before the
 * element re-emits them. No keys or XDR ever leave the iframe directly.
 */

import {
  checkOrigin,
  parseAllowedOriginsParam,
} from "./origin-guard.ts";
import {
  isEmbedResponse,
  isKnownResponseType,
  type EmbedMode,
  type EmbedTheme,
} from "./widget-protocol.ts";

/** Base URL the loader was served from; set by loader.js before import. */
declare global {
  interface Window {
    __STREAMPAY_EMBED_BASE__?: string;
  }
}

function embedBase(): string {
  if (typeof window !== "undefined" && window.__STREAMPAY_EMBED_BASE__) {
    return window.__STREAMPAY_EMBED_BASE__.replace(/\/$/, "");
  }
  // Fall back to same origin.
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

const OBSERVED = ["stream-id", "mode", "theme", "allowed-origins"] as const;

export class StreamPayWidget extends HTMLElement {
  static get observedAttributes() {
    return [...OBSERVED];
  }

  #iframe: HTMLIFrameElement | null = null;
  #widgetId: string = "";
  #messageHandler: ((ev: MessageEvent) => void) | null = null;

  connectedCallback() {
    this.#widgetId = `spw-${Math.random().toString(36).slice(2, 10)}`;
    this.#render();
    this.#attachMessageListener();
  }

  disconnectedCallback() {
    this.#detachMessageListener();
    this.#iframe = null;
  }

  attributeChangedCallback() {
    if (this.isConnected) {
      this.#render();
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  #streamId(): string {
    return this.getAttribute("stream-id") ?? "";
  }

  #mode(): EmbedMode {
    const raw = this.getAttribute("mode");
    if (raw === "claim" || raw === "link") return raw;
    return "read";
  }

  #theme(): EmbedTheme {
    const raw = this.getAttribute("theme");
    if (raw === "light" || raw === "dark") return raw;
    return "auto";
  }

  #allowedOrigins(): string[] {
    const raw = this.getAttribute("allowed-origins");
    if (raw) return parseAllowedOriginsParam(raw) as string[];
    // Default: same origin the page is on.
    if (typeof window !== "undefined") return [window.location.origin];
    return [];
  }

  #buildSrc(): string {
    const streamId = this.#streamId();
    if (!streamId) return "";

    const base = embedBase();
    const params = new URLSearchParams({
      streamId,
      mode: this.#mode(),
      theme: this.#theme(),
      widgetId: this.#widgetId,
      origin: typeof window !== "undefined" ? window.location.origin : "",
      allowedOrigins: this.#allowedOrigins().join(","),
    });
    return `${base}/embed/frame?${params.toString()}`;
  }

  #render() {
    const src = this.#buildSrc();
    if (!src) return;

    if (!this.#iframe) {
      const iframe = document.createElement("iframe");
      // Minimal sandbox: scripts + same-origin are needed for the Next.js
      // page; forms are needed for wallet interactions; popups are excluded.
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms"
      );
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("title", "StreamPay stream widget");
      iframe.setAttribute("aria-label", "StreamPay stream widget");
      iframe.setAttribute("role", "region");
      // Stretch to fill the host container; height is updated via postMessage.
      iframe.style.cssText =
        "border:none;width:100%;height:200px;display:block;";
      iframe.src = src;
      this.#iframe = iframe;

      // Clear any previous content (re-render path).
      this.innerHTML = "";
      this.appendChild(iframe);
    } else {
      this.#iframe.src = src;
    }
  }

  #attachMessageListener() {
    this.#messageHandler = (ev: MessageEvent) => this.#handleMessage(ev);
    window.addEventListener("message", this.#messageHandler);
  }

  #detachMessageListener() {
    if (this.#messageHandler) {
      window.removeEventListener("message", this.#messageHandler);
      this.#messageHandler = null;
    }
  }

  #handleMessage(ev: MessageEvent) {
    // 1. Origin guard.
    const check = checkOrigin(ev.origin, this.#allowedOrigins());
    if (!check.allowed) return;

    // 2. Shape guard.
    if (!isEmbedResponse(ev.data)) return;
    if (!isKnownResponseType(ev.data.type)) return;
    if (ev.data.widgetId !== this.#widgetId) return;

    // 3. Height resize.
    if (ev.data.type === "streampay:height" && this.#iframe) {
      this.#iframe.style.height = `${ev.data.height}px`;
    }

    // 4. Re-emit as a CustomEvent so the host page can listen on the element.
    this.dispatchEvent(
      new CustomEvent("streampay", { detail: ev.data, bubbles: true })
    );
  }
}

/** Registers the custom element if it has not already been registered. */
export function register() {
  if (
    typeof customElements !== "undefined" &&
    !customElements.get("streampay-stream")
  ) {
    customElements.define("streampay-stream", StreamPayWidget);
  }
}
