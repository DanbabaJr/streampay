/**
 * FreighterAdapter — WalletAdapter implementation backed by
 * `@stellar/freighter-api`.
 *
 * All Freighter-specific concerns are contained here:
 *  - `isConnected` / `requestAccess` call-sequence
 *  - Passing `networkPassphrase` to `signTransaction`
 *  - Surfacing Freighter's structured error objects as plain strings
 */

import freighterApi from "@stellar/freighter-api";
const {
  isConnected,
  requestAccess,
  signTransaction,
  getNetworkDetails,
} = freighterApi;
import { Networks } from "@stellar/stellar-sdk";
import type { WalletAdapter } from "../wallet-adapter";

const EXPECTED_NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

/**
 * Returns true when the Freighter extension is detectable.
 *
 * Freighter injects a `window.freighter` object in the page.  We proxy
 * through the API's `isConnected()` lazily instead of reading
 * `window.freighter` directly so we avoid referencing the global in
 * SSR contexts.
 */
function freighterAvailable(): boolean {
  if (typeof window === "undefined") return false;
  // Freighter injects `window.freighter` synchronously.
  return Boolean((window as unknown as Record<string, unknown>).freighter);
}

export class FreighterAdapter implements WalletAdapter {
  readonly id = "freighter" as const;
  readonly name = "Freighter";
  readonly installUrl = "https://www.freighter.app/";

  isAvailable(): boolean {
    return freighterAvailable();
  }

  async connect(): Promise<{ address: string; network: string }> {
    const { isConnected: connected, error: connErr } = await isConnected();
    if (connErr || !connected) {
      throw new Error(
        "Freighter extension not detected. Install it and reload."
      );
    }

    const { address, error: accErr } = await requestAccess();
    if (accErr || !address) {
      throw new Error(
        `Freighter did not grant access: ${accErr?.message ?? "no address returned."}`
      );
    }

    // Verify network passphrase matches what the dApp targets.
    const { networkPassphrase, error: netErr } = await getNetworkDetails();
    if (netErr) {
      throw new Error(`Could not read Freighter network: ${netErr.message}`);
    }
    if (networkPassphrase !== EXPECTED_NETWORK) {
      const label =
        EXPECTED_NETWORK === Networks.PUBLIC ? "Mainnet" : "Testnet";
      throw new Error(
        `Freighter is on the wrong network. Switch to Stellar ${label} and try again.`
      );
    }

    return { address, network: networkPassphrase };
  }

  async signTransaction(txXdr: string, network: string): Promise<string> {
    const { signedTxXdr, error } = await signTransaction(txXdr, {
      networkPassphrase: network,
    });
    if (error) {
      throw new Error(`Freighter signing failed: ${error.message}`);
    }
    return signedTxXdr;
  }

  disconnect(): void {
    // Freighter manages its own session; nothing to tear down client-side.
  }
}
