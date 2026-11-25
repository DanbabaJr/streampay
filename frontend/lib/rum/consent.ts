// Telemetry consent store. Default OFF: nothing is collected until the user
// explicitly opts in, and opting out applies immediately. Only the literal
// string "granted" counts as consent (fail closed).
export const CONSENT_KEY = "streampay:telemetry-consent";

export type ConsentState = "granted" | "denied" | "unset";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Listener = (state: ConsentState) => void;

const listeners = new Set<Listener>();

function defaultStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getConsent(store: Store | null = defaultStore()): ConsentState {
  if (!store) return "unset";
  try {
    const v = store.getItem(CONSENT_KEY);
    if (v === "granted") return "granted";
    if (v === "denied") return "denied";
  } catch {
    // storage blocked: treat as unset
  }
  return "unset";
}

// True only for an explicit opt-in. unset and denied both mean no collection.
export function hasConsent(store: Store | null = defaultStore()): boolean {
  return getConsent(store) === "granted";
}

export function setConsent(
  state: "granted" | "denied",
  store: Store | null = defaultStore(),
): void {
  if (store) {
    try {
      store.setItem(CONSENT_KEY, state);
    } catch {
      // ignore
    }
  }
  listeners.forEach((l) => l(state));
}

export function clearConsent(store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(CONSENT_KEY);
  } catch {
    // ignore
  }
  listeners.forEach((l) => l("unset"));
}

export function onConsentChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
