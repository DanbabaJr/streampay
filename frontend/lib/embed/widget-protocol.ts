/**
 * StreamPay Embed Widget — postMessage RPC protocol.
 *
 * Shared between the web component (host side) and the sandboxed iframe page
 * (guest side). The host sends `EmbedRequest` frames; the guest replies with
 * `EmbedResponse` frames. All messages carry a `widgetId` so a page with
 * multiple widgets can route replies correctly.
 *
 * Security model
 * ──────────────
 * • The host validates every inbound frame's `event.origin` against an
 *   explicit allow-list before acting on it.
 * • The guest validates `event.origin` against the parent origin encoded in
 *   its URL `?origin=` parameter, plus the same allow-list.
 * • Neither side processes messages whose `type` is not in this union.
 * • The protocol carries no signing keys; signing stays in the user's wallet.
 */

/** Modes the widget can operate in. */
export type EmbedMode = "read" | "claim" | "link";

/** Theme tokens exposed to the host page. */
export type EmbedTheme = "light" | "dark" | "auto";

// ---------------------------------------------------------------------------
// Host → Guest (requests)
// ---------------------------------------------------------------------------

export interface EmbedRequestInit {
  type: "streampay:init";
  widgetId: string;
  streamId: string;
  mode: EmbedMode;
  theme: EmbedTheme;
}

export interface EmbedRequestClaim {
  type: "streampay:claim";
  widgetId: string;
  /** Recipient Stellar address the wallet provided. */
  claimantAddress: string;
}

export type EmbedRequest = EmbedRequestInit | EmbedRequestClaim;

// ---------------------------------------------------------------------------
// Guest → Host (responses / events)
// ---------------------------------------------------------------------------

export interface EmbedResponseReady {
  type: "streampay:ready";
  widgetId: string;
}

export interface EmbedResponseStreamLoaded {
  type: "streampay:stream_loaded";
  widgetId: string;
  streamId: string;
  status: string;
  /** Human-readable available balance for the host to display outside the frame. */
  availableFormatted: string;
}

export interface EmbedResponseError {
  type: "streampay:error";
  widgetId: string;
  code: string;
  message: string;
}

export interface EmbedResponseClaimSuccess {
  type: "streampay:claim_success";
  widgetId: string;
  txHash: string;
}

export interface EmbedResponseHeightChange {
  type: "streampay:height";
  widgetId: string;
  height: number;
}

export type EmbedResponse =
  | EmbedResponseReady
  | EmbedResponseStreamLoaded
  | EmbedResponseError
  | EmbedResponseClaimSuccess
  | EmbedResponseHeightChange;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isEmbedRequest(value: unknown): value is EmbedRequest {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  return (
    typeof msg.type === "string" &&
    msg.type.startsWith("streampay:") &&
    typeof msg.widgetId === "string" &&
    msg.widgetId.length > 0
  );
}

export function isEmbedResponse(value: unknown): value is EmbedResponse {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  return (
    typeof msg.type === "string" &&
    msg.type.startsWith("streampay:") &&
    typeof msg.widgetId === "string" &&
    msg.widgetId.length > 0
  );
}

const REQUEST_TYPES = new Set(["streampay:init", "streampay:claim"]);
const RESPONSE_TYPES = new Set([
  "streampay:ready",
  "streampay:stream_loaded",
  "streampay:error",
  "streampay:claim_success",
  "streampay:height",
]);

/** Returns true only when `type` is a known request type. */
export function isKnownRequestType(type: string): boolean {
  return REQUEST_TYPES.has(type);
}

/** Returns true only when `type` is a known response type. */
export function isKnownResponseType(type: string): boolean {
  return RESPONSE_TYPES.has(type);
}
