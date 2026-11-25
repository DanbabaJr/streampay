"use client";

/**
 * QR + copy actions for a canonical payment link.
 *
 * The absolute URL is resolved after mount because the server does not know
 * the browser origin. Both actions are native buttons, so they are reachable
 * and operable with Tab/Enter/Space; the copy result uses the shared live region.
 */

import { useId, useState, useSyncExternalStore } from "react";
import { useToast } from "./toast";
import { canonicalPaymentUrl, copyText, shareQrSvg } from "../lib/share";
import { useT } from "../lib/i18n/provider";

/** The origin is fixed for the lifetime of the document. */
const subscribeToOrigin = () => () => {};

interface PaymentShareActionsProps {
  /** Canonical reference, i.e. the `[ref]` segment. */
  refValue: string;
  /** The stream page already has a "Shareable Payment Link" heading. */
  showHeading?: boolean;
}

export default function PaymentShareActions({
  refValue,
  showHeading = true,
}: PaymentShareActionsProps) {
  const t = useT();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const titleId = useId();

  // Server render has no origin; the client snapshot supplies it without a
  // post-mount state update (and therefore without a hydration mismatch).
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    () => window.location.origin,
    () => ""
  );

  const url = origin ? canonicalPaymentUrl(refValue, origin) : "";
  const qr = url ? shareQrSvg(url) : "";

  async function handleCopy() {
    if (!url) return;
    const method = await copyText(url);
    if (method) {
      setCopied(true);
      toast.success(t("share.copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t("share.copyFailed"));
    }
  }

  return (
    <section
      className="share-actions"
      aria-labelledby={showHeading ? titleId : undefined}
      aria-label={showHeading ? undefined : t("share.heading")}
    >
      {showHeading && (
        <h2 id={titleId} style={{ marginTop: 0 }}>
          {t("share.heading")}
        </h2>
      )}
      <p className="muted">{t("share.body")}</p>

      <div
        className="share-qr"
        role="img"
        aria-label={t("share.qrLabel")}
        style={{
          width: 176,
          minHeight: 176,
          background: "#fff",
          borderRadius: 8,
          padding: 8,
          marginBottom: 12,
        }}
        // The SVG is generated locally from the canonical URL; no third party.
        dangerouslySetInnerHTML={{ __html: qr }}
      />

      <div className="row" style={{ alignItems: "center" }}>
        <code
          className="mono"
          style={{ wordBreak: "break-all", flex: 1, fontSize: 12 }}
        >
          {url || "…"}
        </code>
        <button
          type="button"
          className="copy-btn"
          onClick={handleCopy}
          aria-label={t("share.copyLabel")}
        >
          {copied ? t("share.copiedButton") : t("share.copy")}
        </button>
      </div>
    </section>
  );
}
