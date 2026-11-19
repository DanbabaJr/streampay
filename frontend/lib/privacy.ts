/**
 * StreamPay Telemetry Privacy Line Enforcement.
 *
 * Implements strict sanitization rules to guarantee that:
 * 1. Stellar wallet addresses never enter traces in full (8-character prefix only).
 * 2. Secrets, seeds (S...), private keys, and auth tokens are strictly redacted.
 * 3. Notification destinations (webhooks, email, telegram) have sensitive paths and IDs masked.
 * 4. Error messages are sanitized before attaching to spans.
 *
 * See docs/PRIVACY.md for the full specification.
 */

const STELLAR_ADDRESS_REGEX = /^[GCB][A-Z2-7]{55}$/;
const STELLAR_SECRET_REGEX = /S[A-Za-z0-9]{30,60}/g;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * Truncates a Stellar address to an 8-character prefix + ellipsis.
 * e.g. "GBMOCK1234567890..." -> "GBMOCK12..."
 */
export function sanitizeAddress(address?: string | null): string {
  if (!address) return "unknown";
  const trimmed = address.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 8)}...`;
}

/**
 * Masks a webhook destination URL down to its origin + mask,
 * completely stripping secret paths, tokens, and query parameters.
 * e.g. "https://api.example.com/v1/webhook?secret=123" -> "https://api.example.com/***"
 */
export function sanitizeWebhookUrl(rawUrl?: string | null): string {
  if (!rawUrl) return "unknown";
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "invalid_url";
  }
}

/**
 * Masks an email destination, preserving only the domain for operational routing analysis.
 * e.g. "alice@streampay.org" -> "***@streampay.org"
 */
export function sanitizeEmail(email?: string | null): string {
  if (!email || !email.includes("@")) return "unknown";
  const parts = email.split("@");
  return `***@${parts[1]}`;
}

/**
 * Masks a Telegram chat ID, preserving only the last 4 characters for debugging.
 * e.g. "987654321" -> "chat_***4321"
 */
export function sanitizeTelegramChatId(chatId?: string | number | null): string {
  if (!chatId) return "unknown";
  const str = String(chatId).trim();
  if (str.length <= 4) return "chat_***";
  return `chat_***${str.slice(-4)}`;
}

/**
 * Sanitizes error messages to ensure accidental secret keys or bearer tokens
 * never leak into span descriptions or exception events.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? (err.stack || err.message) : String(err);
  return raw
    .replace(STELLAR_SECRET_REGEX, "[REDACTED_SECRET_KEY]")
    .replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED_TOKEN]");
}

/**
 * Validates and sanitizes a dictionary of span attributes according to the Privacy Line.
 */
export function sanitizeAttributes(
  attributes: Record<string, unknown>
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;

    // Financial data protection: omit financial amounts from exported telemetry attributes
    if (
      key.toLowerCase() === "amount" ||
      key.toLowerCase().endsWith(".amount") ||
      key.toLowerCase().includes("balance") ||
      key.toLowerCase().includes("deposit") ||
      key.toLowerCase().includes("withdrawn")
    ) {
      continue;
    }

    // Check for address fields
    if (
      key.toLowerCase().includes("address") ||
      key.toLowerCase().includes("sender") ||
      key.toLowerCase().includes("recipient") ||
      key.toLowerCase().includes("wallet")
    ) {
      if (typeof value === "string") {
        sanitized[key] = sanitizeAddress(value);
      } else {
        sanitized[key] = String(value);
      }
      continue;
    }

    // Check for webhook URL
    if (key.toLowerCase().includes("webhook") || key.toLowerCase().includes("url")) {
      if (typeof value === "string") {
        sanitized[key] = sanitizeWebhookUrl(value);
      } else {
        sanitized[key] = String(value);
      }
      continue;
    }

    // Check for email
    if (key.toLowerCase().includes("email")) {
      sanitized[key] = sanitizeEmail(String(value));
      continue;
    }

    // Check for telegram
    if (key.toLowerCase().includes("telegram") || key.toLowerCase().includes("chat_id")) {
      sanitized[key] = sanitizeTelegramChatId(value as string | number);
      continue;
    }

    // Direct string values that look like full Stellar addresses
    if (typeof value === "string" && STELLAR_ADDRESS_REGEX.test(value)) {
      sanitized[key] = sanitizeAddress(value);
      continue;
    }

    // Pass-through primitives
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else {
      sanitized[key] = JSON.stringify(value);
    }
  }

  return sanitized;
}
