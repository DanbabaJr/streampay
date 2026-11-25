/**
 * Network identity: which Stellar network and streaming contract this dApp
 * talks to, and how to tell when the connected wallet points somewhere else.
 *
 * The env reads here mirror the signing path (lib/stellar.ts), so the badge
 * can never claim a network the transactions are not built for. The SDK is
 * deliberately not imported: this module has to load in a server render and in
 * a plain Node test runner, where `@stellar/stellar-sdk` does not resolve as
 * ESM. lib/network.test.ts pins the passphrases against the SDK instead.
 */

export type NetworkLabel = "testnet" | "public" | "unknown";

/**
 * The two SDF network passphrases. They are what Freighter reports from
 * `getNetwork()`, and they match `Networks.TESTNET` / `Networks.PUBLIC` in the
 * SDK that signs the transactions.
 */
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const PUBLIC_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

/** `TESTNET` / `PUBLIC` from `NEXT_PUBLIC_NETWORK`; anything else is testnet. */
export const APP_NETWORK_LABEL: "testnet" | "public" =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC" ? "public" : "testnet";

/** Uppercase form shown in the badge chip. */
export const APP_NETWORK_BADGE =
  APP_NETWORK_LABEL === "public" ? "PUBLIC" : "TESTNET";

export const APP_CONTRACT_ID =
  process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "";

/**
 * Maps a wallet-reported passphrase to a network label. Freighter answers with
 * its own network selection, which is independent of this app's env config —
 * a custom/futurenet passphrase lands in `"unknown"` and still counts as a
 * mismatch, because transactions signed for it cannot land here.
 */
export function labelForPassphrase(passphrase: string): NetworkLabel {
  if (passphrase === TESTNET_PASSPHRASE) return "testnet";
  if (passphrase === PUBLIC_PASSPHRASE) return "public";
  return "unknown";
}

/** Human-readable network name for warning text. */
export function networkDisplayName(label: NetworkLabel): string {
  if (label === "testnet") return "Testnet";
  if (label === "public") return "Public Network (mainnet)";
  return "another network";
}

export interface NetworkMismatch {
  appLabel: "testnet" | "public";
  walletLabel: NetworkLabel;
  walletPassphrase: string;
}

/**
 * Compares the wallet's network passphrase with the configured one. Returns
 * `null` when the wallet is on the right network or when Freighter did not
 * answer with a usable passphrase (nothing to compare, so no false alarm).
 */
export function findNetworkMismatch(
  wallet: { networkPassphrase?: string; error?: unknown } | null | undefined,
  appLabel: "testnet" | "public" = APP_NETWORK_LABEL
): NetworkMismatch | null {
  const passphrase = wallet?.networkPassphrase;
  if (!passphrase || wallet?.error) return null;
  const walletLabel = labelForPassphrase(passphrase);
  if (walletLabel === appLabel) return null;
  return { appLabel, walletLabel, walletPassphrase: passphrase };
}

/** Wallet instructions for a mismatch — naming the exact toggle to fix. */
export function mismatchHint(mismatch: NetworkMismatch): string {
  const fix = `Open the Freighter extension, switch to ${networkDisplayName(
    mismatch.appLabel
  )} in its network picker, then reconnect.`;
  return mismatch.walletLabel === "unknown"
    ? `${fix} The wallet reported an unrecognized network (passphrase "${mismatch.walletPassphrase}").`
    : fix;
}

/** `CAAP5FRQ…AB4D` — keeps a 56-char contract id usable on a phone screen. */
export function truncateContractId(
  contractId: string,
  head = 8,
  tail = 4
): string {
  if (!contractId) return "";
  if (contractId.length <= head + tail + 1) return contractId;
  return `${contractId.slice(0, head)}…${contractId.slice(-tail)}`;
}

export function explorerContractUrl(
  contractId = APP_CONTRACT_ID,
  label: "testnet" | "public" = APP_NETWORK_LABEL
): string {
  if (!contractId) return "";
  return `https://stellar.expert/explorer/${label}/contract/${contractId}`;
}

/** Result of reading the wallet's network, for the badge to render. */
export type NetworkCheck =
  | { state: "match" }
  | { state: "mismatch"; mismatch: NetworkMismatch }
  | { state: "unavailable" };

/** What the badge renders: the current mismatch (if any) and its dismissal. */
export interface NetworkWarningState {
  warning: NetworkMismatch | null;
  dismissed: boolean;
}

export interface NetworkWarningStore {
  /**
   * Stable object identity between reports/dismissals, so it can be fed
   * straight to `useSyncExternalStore`.
   */
  getState: () => NetworkWarningState;
  /** Publishes a fresh check; a new mismatch is always shown again. */
  report: (check: NetworkCheck) => void;
  dismiss: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createNetworkWarningStore(): NetworkWarningStore {
  let snapshot: NetworkWarningState = { warning: null, dismissed: false };
  const listeners = new Set<() => void>();

  function set(next: NetworkWarningState): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  return {
    getState: () => snapshot,
    report(check) {
      set({ warning: check.state === "mismatch" ? check.mismatch : null, dismissed: false });
    },
    dismiss() {
      set({ ...snapshot, dismissed: true });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const defaultNetworkWarningStore = createNetworkWarningStore();

interface WalletNetworkAnswer {
  networkPassphrase?: string;
  error?: unknown;
}

/**
 * Asks Freighter which network it is on and publishes the verdict to the
 * store the badge renders from. Call this after a successful connect so the
 * user learns about a wrong network before their first signing error.
 *
 * `fetchNetwork` is injectable so the comparison can be tested without the
 * extension present.
 */
export async function checkWalletNetwork(
  store: NetworkWarningStore = defaultNetworkWarningStore,
  fetchNetwork: () => Promise<WalletNetworkAnswer> = async () => {
    const { getNetwork } = await import("@stellar/freighter-api");
    return getNetwork();
  }
): Promise<NetworkCheck> {
  let answer: WalletNetworkAnswer;
  try {
    answer = await fetchNetwork();
  } catch {
    answer = { error: true };
  }
  const mismatch = findNetworkMismatch(answer);
  const check: NetworkCheck = mismatch
    ? { state: "mismatch", mismatch }
    : answer.error || !answer.networkPassphrase
      ? { state: "unavailable" }
      : { state: "match" };
  store.report(check);
  return check;
}
