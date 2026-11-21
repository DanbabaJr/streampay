/**
 * StreamPay Embed Widget — origin validation.
 *
 * Both the host-side web component and the guest-side iframe page run this
 * guard. It is intentionally pure and dependency-free so it is testable
 * without a DOM.
 *
 * Security properties
 * ───────────────────
 * • An empty allow-list rejects every origin (fail-closed).
 * • `null` origins (opaque, e.g. file://) are always rejected.
 * • The wildcard `"*"` is never accepted as an allow-list entry; callers
 *   must enumerate real origins.
 * • Origins are compared case-insensitively after lower-casing, matching
 *   the URL spec's origin serialisation rules.
 */

export type AllowedOrigins = readonly string[];

/** Canonical result of an origin check. */
export type OriginCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Returns `{ allowed: true }` when `origin` appears in `allowedOrigins`,
 * or `{ allowed: false, reason }` otherwise.
 *
 * @param origin        The `MessageEvent.origin` string to validate.
 * @param allowedOrigins Non-empty list of fully-qualified origins, e.g.
 *                       `["https://example.com", "https://app.example.com"]`.
 */
export function checkOrigin(
  origin: string | null | undefined,
  allowedOrigins: AllowedOrigins
): OriginCheckResult {
  if (!origin || origin === "null") {
    return { allowed: false, reason: "opaque or missing origin" };
  }
  if (allowedOrigins.length === 0) {
    return { allowed: false, reason: "allow-list is empty" };
  }

  const normalised = origin.toLowerCase();
  for (const allowed of allowedOrigins) {
    if (allowed === "*") {
      // Wildcard entries are configuration errors; skip them defensively.
      continue;
    }
    if (allowed.toLowerCase() === normalised) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `origin "${origin}" is not in the allow-list`,
  };
}

/**
 * Parses the `?allowedOrigins=` URL param into a validated allow-list.
 *
 * The guest iframe receives its parent's origin via this parameter so it can
 * validate inbound postMessage frames. Each entry must start with `https://`
 * (or `http://localhost`); anything else is silently dropped to prevent a
 * misconfigured host from widening the allow-list.
 */
export function parseAllowedOriginsParam(raw: string | null): AllowedOrigins {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 0 &&
        s !== "*" &&
        (s.startsWith("https://") || s.startsWith("http://localhost"))
    );
}
