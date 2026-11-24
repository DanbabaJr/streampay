"use client";

/**
 * /embed/frame — the sandboxed iframe page loaded by <streampay-stream>.
 *
 * This page is intentionally minimal: it reads stream data via server actions
 * and communicates results to the host via postMessage. It never accesses
 * parent DOM, never navigates the top frame, and never exposes signing keys.
 *
 * URL parameters
 * ──────────────
 * • streamId       — numeric stream id.
 * • mode           — "read" | "claim" | "link".
 * • theme          — "light" | "dark" | "auto".
 * • widgetId       — opaque id echoed back in every postMessage.
 * • origin         — the host page's origin (validated on every postMessage).
 * • allowedOrigins — comma-separated additional origins.
 *
 * The inner component is split into <EmbedFrameInner> so the
 * <Suspense> boundary required by useSearchParams() sits at the page level.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { readStreamAction, readAvailableAction } from "@/app/actions";
import { formatAmount } from "@/lib/format";
import { checkOrigin, parseAllowedOriginsParam } from "@/lib/embed/origin-guard";
import {
  isEmbedRequest,
  isKnownRequestType,
  type EmbedResponse,
} from "@/lib/embed/widget-protocol";
import type { StreamView } from "@/lib/stream-types";
import { useToast } from "@/components/toast";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(target: Window, origin: string, msg: EmbedResponse) {
  try {
    target.postMessage(msg, origin);
  } catch {
    // Parent may be gone; ignore.
  }
}

// ---------------------------------------------------------------------------
// Inner component (uses useSearchParams — needs Suspense boundary above)
// ---------------------------------------------------------------------------

function EmbedFrameInner() {
  const toast = useToast();
  const params = useSearchParams();
  const streamId = params?.get("streamId") ?? "";
  const mode = params?.get("mode") ?? "read";
  const theme = params?.get("theme") ?? "auto";
  const widgetId = params?.get("widgetId") ?? "";
  const hostOrigin = params?.get("origin") ?? "";
  const allowedOriginsParam = params?.get("allowedOrigins") ?? "";

  // Build the definitive allow-list: host origin + extra comma-separated list.
  const allowedOrigins = [
    ...(hostOrigin ? [hostOrigin] : []),
    ...parseAllowedOriginsParam(allowedOriginsParam),
  ].filter((o, i, a) => a.indexOf(o) === i); // deduplicate

  const [stream, setStream] = useState<StreamView | null>(null);
  const [available, setAvailable] = useState<string>("0");
  const [error, setError] = useState<string | null>(null);
  const readyRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ---------------------------------------------------------------------------
  // Announce ready to parent.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!widgetId || readyRef.current) return;
    readyRef.current = true;
    if (!hostOrigin || allowedOrigins.length === 0) return;
    post(window.parent, hostOrigin, { type: "streampay:ready", widgetId });
    // allowedOrigins.length is derived from params — stable for the lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetId, hostOrigin]);

  // ---------------------------------------------------------------------------
  // Load stream data.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!streamId || !widgetId) return;
    let cancelled = false;

    readStreamAction(streamId)
      .then((s) => {
        if (cancelled) return;
        setStream(s);
        return readAvailableAction(streamId).then((a) => {
          if (cancelled) return;
          setAvailable(a);
          const availableFormatted = formatAmount(BigInt(a), 7);
          post(window.parent, hostOrigin, {
            type: "streampay:stream_loaded",
            widgetId,
            streamId,
            status: s.status,
            availableFormatted,
          });
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error(message);
        post(window.parent, hostOrigin, {
          type: "streampay:error",
          widgetId,
          code: "STREAM_LOAD_FAILED",
          message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [streamId, widgetId, hostOrigin, toast]);

  // ---------------------------------------------------------------------------
  // Handle inbound postMessage (host → guest).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!widgetId) return;

    function onMessage(ev: MessageEvent) {
      // Origin guard.
      const check = checkOrigin(ev.origin, allowedOrigins);
      if (!check.allowed) return;

      // Shape guard.
      if (!isEmbedRequest(ev.data)) return;
      if (!isKnownRequestType(ev.data.type)) return;
      if (ev.data.widgetId !== widgetId) return;

      // Currently no host→guest requests require action in read mode.
      // Claim mode extensions would handle "streampay:claim" here.
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // allowedOriginsKey is a stable string derived from params each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetId, allowedOrigins.join(",")]);

  // ---------------------------------------------------------------------------
  // Notify parent of height changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || !widgetId || !hostOrigin) return;
    const ro = new ResizeObserver(() => {
      const height = containerRef.current?.scrollHeight ?? 0;
      post(window.parent, hostOrigin, {
        type: "streampay:height",
        widgetId,
        height,
      });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [widgetId, hostOrigin]);

  // ---------------------------------------------------------------------------
  // Apply theme to <html>.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "dark") el.setAttribute("data-theme", "dark");
    else if (theme === "light") el.setAttribute("data-theme", "light");
    else el.removeAttribute("data-theme");
  }, [theme]);

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------
  const availableBigInt = (() => {
    try {
      return BigInt(available);
    } catch {
      return 0n;
    }
  })();

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="StreamPay stream widget"
      style={{ fontFamily: "system-ui, sans-serif", padding: "12px 16px" }}
    >
      {error && (
        <p
          style={{ color: "var(--color-error, #c0392b)" }}
        >
          {error}
        </p>
      )}

      {!stream && !error && (
        <p
          aria-busy="true"
          aria-label="Loading stream"
          style={{ color: "var(--color-muted, #666)" }}
        >
          Loading stream…
        </p>
      )}

      {stream && (
        <table
          aria-label={`Stream #${stream.id} details`}
          style={{ width: "100%", borderCollapse: "collapse" }}
        >
          <tbody>
            <tr>
              <th
                scope="row"
                style={{
                  textAlign: "left",
                  padding: "4px 8px 4px 0",
                  whiteSpace: "nowrap",
                }}
              >
                Stream
              </th>
              <td style={{ padding: "4px 0" }}>#{stream.id}</td>
            </tr>
            <tr>
              <th
                scope="row"
                style={{
                  textAlign: "left",
                  padding: "4px 8px 4px 0",
                  whiteSpace: "nowrap",
                }}
              >
                Status
              </th>
              <td style={{ padding: "4px 0" }}>{stream.status}</td>
            </tr>
            {mode !== "link" && (
              <tr>
                <th
                  scope="row"
                  style={{
                    textAlign: "left",
                    padding: "4px 8px 4px 0",
                    whiteSpace: "nowrap",
                  }}
                >
                  Available
                </th>
                <td
                  aria-label={`Available balance: ${formatAmount(availableBigInt, 7)}`}
                  style={{ padding: "4px 0" }}
                >
                  {formatAmount(availableBigInt, 7)}
                </td>
              </tr>
            )}
            {mode === "link" && (
              <tr>
                <th
                  scope="row"
                  style={{
                    textAlign: "left",
                    padding: "4px 8px 4px 0",
                    whiteSpace: "nowrap",
                  }}
                >
                  Recipient
                </th>
                <td style={{ padding: "4px 0", wordBreak: "break-all" }}>
                  {stream.recipient}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export (Suspense boundary required by useSearchParams)
// ---------------------------------------------------------------------------

export default function EmbedFrame() {
  return (
    <Suspense
      fallback={
        <p
          aria-busy="true"
          aria-label="Loading stream"
          style={{ fontFamily: "system-ui, sans-serif", padding: "12px 16px" }}
        >
          Loading…
        </p>
      }
    >
      <EmbedFrameInner />
    </Suspense>
  );
}
