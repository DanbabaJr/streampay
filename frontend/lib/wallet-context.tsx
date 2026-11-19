"use client";

/**
 * WalletContext — global per-wallet connection state.
 *
 * This module provides:
 *  - `WalletProvider`: wraps the app, holds one active `WalletAdapter`
 *    instance plus the derived { address, network } once connected.
 *  - `useWallet`: hook for consuming the connection state and actions.
 *
 * State machine:
 *   idle ──connect(id)──► connecting ──ok──► connected
 *                                    └─err─► idle  (toast shown)
 *   connected ──disconnect()──► idle
 *
 * The `adapter` ref is kept separately from React state so that calling
 * adapter methods during a render cycle is always safe (no stale closure
 * on a previous instance).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { WalletAdapter, WalletId } from "./wallet-adapter";
import { createAdapter } from "./adapters/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionState = "idle" | "connecting" | "connected";

export interface WalletState {
  /** Which wallet the user picked — null when idle. */
  walletId: WalletId | null;
  /** Human-readable wallet name for display. */
  walletName: string | null;
  /** Stellar G… public key once connected. */
  address: string | null;
  /** The active network passphrase. */
  network: string | null;
  /** Current phase of the connection lifecycle. */
  connectionState: ConnectionState;
  /** Error from the last failed connect attempt. */
  lastError: string | null;
}

export interface WalletActions {
  /**
   * Instantiates and connects the adapter for the given wallet id.
   * Updates state reactively; throws are caught and surfaced via `lastError`.
   */
  connect(id: WalletId): Promise<void>;
  /** Tears down the current session and resets to idle. */
  disconnect(): void;
  /**
   * Signs a transaction XDR using the active adapter.
   * Throws if no wallet is connected.
   */
  signTransaction(txXdr: string): Promise<string>;
}

type WalletContextValue = WalletState & WalletActions;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WalletContext = createContext<WalletContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const adapterRef = useRef<WalletAdapter | null>(null);

  const [state, setState] = useState<WalletState>({
    walletId: null,
    walletName: null,
    address: null,
    network: null,
    connectionState: "idle",
    lastError: null,
  });

  const connect = useCallback(async (id: WalletId) => {
    setState((s) => ({ ...s, connectionState: "connecting", lastError: null }));
    try {
      const adapter = await createAdapter(id);
      const { address, network } = await adapter.connect();
      adapterRef.current = adapter;
      setState({
        walletId: id,
        walletName: adapter.name,
        address,
        network,
        connectionState: "connected",
        lastError: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      adapterRef.current = null;
      setState((s) => ({
        ...s,
        connectionState: "idle",
        lastError: msg,
      }));
      throw err; // re-throw so callers can show toasts
    }
  }, []);

  const disconnect = useCallback(() => {
    adapterRef.current?.disconnect();
    adapterRef.current = null;
    setState({
      walletId: null,
      walletName: null,
      address: null,
      network: null,
      connectionState: "idle",
      lastError: null,
    });
  }, []);

  const signTransaction = useCallback(
    async (txXdr: string): Promise<string> => {
      const adapter = adapterRef.current;
      const network = state.network;
      if (!adapter || !network) {
        throw new Error("No wallet connected. Please connect a wallet first.");
      }
      return adapter.signTransaction(txXdr, network);
    },
    [state.network]
  );

  return (
    <WalletContext.Provider
      value={{ ...state, connect, disconnect, signTransaction }}
    >
      {children}
    </WalletContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the current wallet state and actions.
 * Must be called inside a `<WalletProvider>`.
 */
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside <WalletProvider>");
  }
  return ctx;
}
