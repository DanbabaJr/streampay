"use client";

/**
 * WalletButton — the primary connect / disconnect control shown in the
 * app header / landing page.
 *
 * When idle: renders a "Connect wallet" button that opens WalletModal.
 * When connecting: shows a spinner.
 * When connected: shows a truncated address + "Disconnect" affordance.
 */

import { useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import WalletModal from "./WalletModal";

interface WalletButtonProps {
  /** Extra CSS class forwarded to the root element. */
  className?: string;
}

export default function WalletButton({ className }: WalletButtonProps) {
  const { address, walletName, connectionState, disconnect } = useWallet();
  const [modalOpen, setModalOpen] = useState(false);

  if (connectionState === "connecting") {
    return (
      <button
        id="wallet-button-connecting"
        className={`wallet-btn wallet-btn--connecting ${className ?? ""}`}
        disabled
        aria-busy="true"
      >
        <span className="wallet-btn__spinner" aria-hidden="true" />
        Connecting…
      </button>
    );
  }

  if (connectionState === "connected" && address) {
    return (
      <div className={`wallet-btn__group ${className ?? ""}`}>
        <span className="wallet-btn__label" id="wallet-address-display">
          {walletName && (
            <span className="wallet-btn__badge">{walletName}</span>
          )}
          <code className="wallet-btn__address">
            {address.slice(0, 6)}…{address.slice(-4)}
          </code>
        </span>
        <button
          id="wallet-disconnect-btn"
          type="button"
          className="wallet-btn wallet-btn--disconnect"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </div>
    );
  }

  // Idle state.
  return (
    <>
      <button
        id="wallet-connect-btn"
        type="button"
        className={`wallet-btn wallet-btn--connect ${className ?? ""}`}
        onClick={() => setModalOpen(true)}
      >
        Connect wallet
      </button>
      <WalletModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
