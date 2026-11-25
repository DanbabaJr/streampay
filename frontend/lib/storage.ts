/**
 * Session persistence for the stream list.
 *
 * The on-chain indexes (`fetchStreamsFor`) are the canonical discovery path;
 * this localStorage cache is a UX convenience so the list survives page
 * reloads without a chain scan for returning users. Keys are scoped by
 * network and wallet address — ids from testnet never show up on publicnet.
 */
const NETWORK_LABEL =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC" ? "public" : "testnet";

/**
 * Telemetry defaults to enabled to preserve the tracing behavior that existed
 * before the consent control. Stored values are intentionally site-wide.
 */
export const TELEMETRY_CONSENT_STORAGE_KEY = "streampay:telemetryConsent";
let telemetryConsentOverride: boolean | undefined;
const telemetryConsentSubscribers = new Set<() => void>();

export function subscribeTelemetryConsent(subscriber: () => void): () => void {
  telemetryConsentSubscribers.add(subscriber);
  return () => telemetryConsentSubscribers.delete(subscriber);
}

export function loadTelemetryConsent(): boolean {
  if (telemetryConsentOverride !== undefined) return telemetryConsentOverride;
  if (typeof window === "undefined") return true;
  try {
    const value = window.localStorage.getItem(TELEMETRY_CONSENT_STORAGE_KEY);
    return value === null || value === "true" ? true : value === "false" ? false : true;
  } catch {
    return true;
  }
}

export function saveTelemetryConsent(enabled: boolean): void {
  telemetryConsentOverride = enabled;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TELEMETRY_CONSENT_STORAGE_KEY, String(enabled));
  } catch {
    // Keep the live toggle usable when browser storage is unavailable.
  }
  telemetryConsentSubscribers.forEach((subscriber) => subscriber());
}

const keyFor = (address: string) =>
  `streampay:${NETWORK_LABEL}:${address}:streamIds`;

/** Stream ids previously saved for this address (oldest first). */
export function loadStreamIds(address: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** Remembers a stream id (deduplicated, insertion-ordered). */
export function saveStreamId(address: string, id: string): void {
  if (typeof window === "undefined") return;
  const ids = loadStreamIds(address);
  if (!ids.includes(id)) {
    ids.push(id);
    window.localStorage.setItem(keyFor(address), JSON.stringify(ids));
  }
}
