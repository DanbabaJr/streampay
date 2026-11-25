/**
 * WalletAdapter — the stable interface every wallet integration must satisfy.
 *
 * Design rationale
 * ----------------
 * The original codebase called `@stellar/freighter-api` directly at the
 * call-sites in `stellar.ts` and `page.tsx`. That made adding a second signer
 * (Albedo, xBull, Ledger …) impossible without forking the signing path.
 *
 * The adapter pattern is the minimal interface that:
 *  1. Lets callers stay ignorant of which wallet is active.
 *  2. Keeps XDR / network-verification differences *inside* each adapter.
 *  3. Avoids over-abstraction — we only expose primitives that every signer
 *     we plan to support actually has (connect / sign / address / network).
 *
 * Why not a class hierarchy?
 * A plain TypeScript interface plus concrete factory functions is enough here.
 * Class hierarchies impose an inheritance contract that is hard to evolve
 * once third-party adapters appear.
 */

/** Identifies which adapter the user chose. */
export type WalletId = "freighter" | "albedo";

/**
 * Minimal per-wallet state that every component needs.
 * Implementations must compute `address` and `network` lazily on `connect`.
 */
export interface WalletAdapter {
  /** Stable ID for this adapter (used in localStorage, analytics, etc.). */
  readonly id: WalletId;

  /**
   * Human-readable name shown in the wallet picker UI.
   * Should match the wallet's brand name exactly.
   */
  readonly name: string;

  /**
   * URL of the wallet's browser extension / install page.
   * Shown in the picker when the wallet is not yet installed.
   */
  readonly installUrl: string;

  /**
   * Returns true when this wallet is detectable in the current browser
   * context (extension injected, page loaded over the right origin, etc.).
   *
   * NOTE: Must be synchronous — the picker needs to render before any
   * async operations run.  Albedo uses window.location checks; Freighter
   * inspects `window.freighter`.
   */
  isAvailable(): boolean;

  /**
   * Opens the wallet's permission dialog, acquires a public key, and
   * verifies that the wallet is on the expected network.
   *
   * Resolves with `{ address, network }` on success.
   * Rejects (throws) on user denial or network mismatch.
   */
  connect(): Promise<{ address: string; network: string }>;

  /**
   * Signs a base64-encoded transaction XDR and returns the signed XDR.
   *
   * Network verification is adapter-internal:
   *  - Freighter: passes `networkPassphrase` to `signTransaction`.
   *  - Albedo: passes `network` hint + verifies in the response.
   *
   * Callers hand in the raw transaction XDR produced by `stellar.ts`;
   * they never deal with network labels or passphrase routing.
   *
   * @param txXdr   Base64 transaction XDR to sign.
   * @param network The Stellar network passphrase (e.g. `Networks.TESTNET`).
   * @returns       Signed transaction XDR (base64).
   */
  signTransaction(txXdr: string, network: string): Promise<string>;

  /**
   * Disconnects / clears cached session state.
   * Implementations that have no persistent session state may no-op here.
   */
  disconnect(): void;
}

/**
 * Minimal description used to populate the wallet-picker UI before an
 * adapter is instantiated (avoids loading all adapter modules eagerly).
 */
export interface WalletDescriptor {
  id: WalletId;
  name: string;
  /** SVG icon path rendered in the picker button. */
  iconPath: string;
  installUrl: string;
}

export const WALLET_DESCRIPTORS: WalletDescriptor[] = [
  {
    id: "freighter",
    name: "Freighter",
    iconPath: "/icons/freighter.svg",
    installUrl:
      "https://www.freighter.app/",
  },
  {
    id: "albedo",
    name: "Albedo",
    iconPath: "/icons/albedo.svg",
    installUrl: "https://albedo.link/",
  },
];
