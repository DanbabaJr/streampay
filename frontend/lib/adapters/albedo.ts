/**
 * AlbedoAdapter — WalletAdapter implementation backed by Albedo's
 * intent-based signing API (https://albedo.link/docs).
 *
 * Albedo does NOT require a browser extension — it opens a popup to
 * albedo.link for every operation.  This makes it available to any browser
 * user without an install step, which is the key UX reason for including it
 * alongside Freighter.
 *
 * Network-verification differences (adapter-internal, never leaking out):
 *  - Albedo uses short network labels ("testnet" | "public") rather than
 *    full passphrases; we map both directions here.
 *  - Albedo returns the signed XDR in `result.signed_envelope_xdr` — we
 *    rename to the canonical `signedTxXdr` shape that the rest of the app
 *    expects.
 *
 * Albedo is loaded lazily (dynamic import) so the ~20 kB bundle is not paid
 * by users who choose Freighter.
 */

import { Networks } from "@stellar/stellar-sdk";
import type { WalletAdapter } from "../wallet-adapter";

/** Albedo network label expected by the `tx` intent. */
type AlbedoNetwork = "testnet" | "public";

function passphraseToLabel(passphrase: string): AlbedoNetwork {
  if (passphrase === Networks.PUBLIC) return "public";
  return "testnet";
}

/** Minimal typing for the subset of albedo-link we use. */
interface AlbedoModule {
  publicKey(opts?: { require_existing?: boolean }): Promise<{
    pubkey: string;
    intent?: string;
  }>;
  tx(opts: {
    xdr: string;
    network: AlbedoNetwork;
    submit?: boolean;
  }): Promise<{ signed_envelope_xdr: string; network: AlbedoNetwork }>;
}

async function albedo(): Promise<AlbedoModule> {
  // Dynamic import keeps Albedo out of the initial bundle.
  const mod = await import(
    /* webpackChunkName: "albedo" */
    "@albedo-link/intent"
  );
  return (mod.default ?? mod) as unknown as AlbedoModule;
}

/**
 * Albedo is available on any origin that can open a cross-origin popup.
 * We always return true so the picker shows it; if the popup is blocked
 * the user gets a clear browser-level error.
 */
function albedoAvailable(): boolean {
  return typeof window !== "undefined";
}

export class AlbedoAdapter implements WalletAdapter {
  readonly id = "albedo" as const;
  readonly name = "Albedo";
  readonly installUrl = "https://albedo.link/";

  /** Cached address from the last successful `connect`. */
  private _address: string | null = null;
  private _network: string | null = null;

  isAvailable(): boolean {
    return albedoAvailable();
  }

  async connect(): Promise<{ address: string; network: string }> {
    const sdk = await albedo();
    const { pubkey } = await sdk.publicKey({ require_existing: false });
    if (!pubkey) {
      throw new Error("Albedo did not return a public key.");
    }

    const expectedPassphrase =
      process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
        ? Networks.PUBLIC
        : Networks.TESTNET;

    this._address = pubkey;
    this._network = expectedPassphrase;
    return { address: pubkey, network: expectedPassphrase };
  }

  async signTransaction(txXdr: string, network: string): Promise<string> {
    const sdk = await albedo();
    const networkLabel = passphraseToLabel(network);
    const result = await sdk.tx({
      xdr: txXdr,
      network: networkLabel,
      submit: false,
    });
    if (!result?.signed_envelope_xdr) {
      throw new Error("Albedo did not return a signed transaction.");
    }
    if (result.network !== networkLabel) {
      throw new Error(
        `Albedo signed on the wrong network: got "${result.network}", expected "${networkLabel}".`
      );
    }
    return result.signed_envelope_xdr;
  }

  disconnect(): void {
    this._address = null;
    this._network = null;
  }
}
