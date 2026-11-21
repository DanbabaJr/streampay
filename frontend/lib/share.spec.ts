import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { encode as encodeQr } from "uqr";

// LocaleProvider reads the router only to refresh after a locale switch.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import PaymentShareActions from "../components/PaymentShareActions";
import { ToastProvider } from "../components/toast";
import { LocaleProvider } from "./i18n/provider";
import { decodePaymentLinkRef, encodePaymentLinkRef } from "./payment-link.ts";
import {
  canonicalPaymentUrl,
  copyText,
  paymentRefFromUrl,
  shareQrSvg,
} from "./share.ts";

const RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// The provider components require `children`; React 19's types do not merge
// child arguments into the props object, so this test-only helper keeps the
// children as createElement arguments (also what react/no-children-prop wants).
const h = React.createElement as unknown as (
  type: React.ElementType,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

describe("canonical payment URLs", () => {
  it("builds the ADR-0002 path and normalizes the origin", () => {
    expect(canonicalPaymentUrl("abc", "https://pay.example")).toBe(
      "https://pay.example/pay/abc"
    );
    expect(canonicalPaymentUrl("abc", "https://pay.example/")).toBe(
      "https://pay.example/pay/abc"
    );
  });

  it("extracts only a single-ref /pay/ path", () => {
    expect(paymentRefFromUrl("https://pay.example/pay/abc")).toBe("abc");
    expect(paymentRefFromUrl("https://pay.example/pay/abc/extra")).toBeNull();
    expect(paymentRefFromUrl("https://pay.example/stream/1")).toBeNull();
    expect(paymentRefFromUrl("not a url")).toBeNull();
  });
});

describe("QR payload", () => {
  it("round-trips the exact reference a scanner would decode", async () => {
    const ref = await encodePaymentLinkRef({
      streamId: "1042",
      recipient: RECIPIENT,
      salt: "a1b2c3d4",
    });
    const url = canonicalPaymentUrl(ref, "https://pay.example");

    // Scanning yields the URL; the app then extracts and decodes the ref.
    const scannedRef = paymentRefFromUrl(url);
    expect(scannedRef).toBe(ref);

    const decoded = await decodePaymentLinkRef(scannedRef ?? "");
    expect(decoded?.streamId).toBe("1042");
    expect(decoded?.salt).toBe("a1b2c3d4");
  });

  it("encodes the canonical URL into a real QR matrix and SVG", async () => {
    const ref = await encodePaymentLinkRef({
      streamId: "7",
      recipient: RECIPIENT,
      salt: "deadbeef",
    });
    const url = canonicalPaymentUrl(ref, "https://pay.example");

    expect(encodeQr(url).size).toBeGreaterThan(0);
    expect(shareQrSvg(url)).toContain("<svg");
    expect(shareQrSvg(url)).toBe(shareQrSvg(url));
  });
});

describe("copy feedback", () => {
  it("uses the Clipboard API when it is available", async () => {
    const written: string[] = [];
    const method = await copyText("https://pay.example/pay/abc", {
      clipboard: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });

    expect(method).toBe("clipboard");
    expect(written).toEqual(["https://pay.example/pay/abc"]);
  });

  it("falls back to execCommand when the Clipboard API fails", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const doc = dom.window.document as Document & {
      execCommand: (command: string) => boolean;
    };
    doc.execCommand = () => true;

    const method = await copyText("https://pay.example/pay/abc", {
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
      document: doc,
    });

    expect(method).toBe("fallback");
    expect(doc.querySelector("textarea")).toBeNull();
  });

  it("reports failure when neither path works", async () => {
    const method = await copyText("https://pay.example/pay/abc", {
      clipboard: null,
      document: null,
    });
    expect(method).toBeNull();
  });
});

describe("share actions markup", () => {
  it("exposes native keyboard-operable actions and accessible labels", () => {
    const html = renderToStaticMarkup(
      h(
        LocaleProvider,
        { locale: "en" },
        h(ToastProvider, null, h(PaymentShareActions, { refValue: "abc" }))
      )
    );

    // Real <button>, so Enter and Space work without extra key handlers.
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Copy payment link to clipboard"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="QR code for this payment link"');
    expect(html).toContain('aria-live="polite"');
  });
});
