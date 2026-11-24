/**
 * Share actions for payment links (issue #513).
 *
 * The canonical URL is the one defined by
 * docs/adr/0002-payment-link-reference-format.md: `<origin>/pay/<ref>`.
 * QR generation happens entirely in the browser with `uqr` (zero runtime
 * dependencies); no link is ever sent to a third-party QR service.
 */

import { renderSVG } from "uqr";

/** Path form, for a link rendered inside the app. */
export function canonicalPaymentPath(ref: string): string {
  return `/pay/${ref.trim()}`;
}

/** Absolute canonical URL, used for sharing and for the QR payload. */
export function canonicalPaymentUrl(ref: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${canonicalPaymentPath(ref)}`;
}

/** Extracts the reference from a canonical payment URL (scan-equivalent). */
export function paymentRefFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const match = pathname.match(/^\/pay\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** SVG string for the exact payload a scanner would read. */
export function shareQrSvg(url: string): string {
  return renderSVG(url, {
    ecc: "M",
    border: 2,
    pixelSize: 4,
    blackColor: "#0f172a",
    whiteColor: "#ffffff",
  });
}

export type CopyMethod = "clipboard" | "fallback";

export interface CopyDependencies {
  clipboard?: { writeText(text: string): Promise<void> } | null;
  document?: Document | null;
}

/**
 * Clipboard API first, then the legacy selection + `execCommand("copy")`
 * fallback for browsers/contexts where `navigator.clipboard` is unavailable.
 * Returns `null` when neither path worked, so the caller can announce failure.
 */
export async function copyText(
  text: string,
  deps: CopyDependencies = {}
): Promise<CopyMethod | null> {
  const clipboard =
    deps.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : null);
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return "clipboard";
    } catch {
      // Permission denied or insecure context — try the fallback below.
    }
  }

  const doc =
    deps.document ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.execCommand !== "function") return null;

  try {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    const copied = doc.execCommand("copy");
    doc.body.removeChild(area);
    return copied ? "fallback" : null;
  } catch {
    return null;
  }
}
