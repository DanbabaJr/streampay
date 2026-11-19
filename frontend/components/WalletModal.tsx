"use client";

/**
 * WalletModal — wallet-picker dialog.
 *
 * Shows only wallets that are detectable in the current browser (via
 * adapter.isAvailable()).  Unavailable wallets are rendered greyed-out
 * with an "Install" link so users know why they can't connect.
 *
 * Availability is computed once on open (not on every render) because
 * `isAvailable` may touch `window` and we want a stable snapshot.
 */

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import { WALLET_DESCRIPTORS, type WalletId } from "@/lib/wallet-adapter";
import { FreighterAdapter } from "@/lib/adapters/freighter";
import { AlbedoAdapter } from "@/lib/adapters/albedo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Synchronous availability check — one per descriptor. */
function checkAvailability(id: WalletId): boolean {
  switch (id) {
    case "freighter":
      return new FreighterAdapter().isAvailable();
    case "albedo":
      return new AlbedoAdapter().isAvailable();
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WalletModalProps {
  /** Controlled visibility. */
  open: boolean;
  onClose(): void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalletModal({ open, onClose }: WalletModalProps) {
  const { connect, connectionState, lastError } = useWallet();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [connecting, setConnecting] = useState<WalletId | null>(null);

  // Sync HTML dialog open/close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Close on Escape / backdrop click (native <dialog> behaviour).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => onClose();
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [onClose]);

  async function handleChoose(id: WalletId) {
    setConnecting(id);
    try {
      await connect(id);
      onClose();
    } catch {
      // lastError is surfaced from context below.
    } finally {
      setConnecting(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      id="wallet-modal"
      aria-labelledby="wallet-modal-title"
      className="wallet-modal"
    >
      <div className="wallet-modal__inner">
        <header className="wallet-modal__header">
          <h2 id="wallet-modal-title" className="wallet-modal__title">
            Connect a wallet
          </h2>
          <button
            type="button"
            className="wallet-modal__close"
            onClick={onClose}
            aria-label="Close wallet picker"
          >
            ✕
          </button>
        </header>

        {lastError && (
          <p className="wallet-modal__error" role="alert">
            {lastError}
          </p>
        )}

        <ul className="wallet-modal__list" role="list">
          {WALLET_DESCRIPTORS.map((d) => {
            const available = checkAvailability(d.id);
            const isBusy =
              connectionState === "connecting" && connecting === d.id;

            return (
              <li key={d.id} className="wallet-modal__item">
                {available ? (
                  <button
                    id={`wallet-btn-${d.id}`}
                    type="button"
                    className="wallet-modal__btn"
                    disabled={connectionState === "connecting"}
                    onClick={() => handleChoose(d.id)}
                    aria-busy={isBusy}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={d.iconPath}
                      alt=""
                      width={32}
                      height={32}
                      className="wallet-modal__icon"
                      aria-hidden="true"
                    />
                    <span className="wallet-modal__name">{d.name}</span>
                    {isBusy && (
                      <span className="wallet-modal__spinner" aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <a
                    href={d.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wallet-modal__install"
                    id={`wallet-install-${d.id}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={d.iconPath}
                      alt=""
                      width={32}
                      height={32}
                      className="wallet-modal__icon wallet-modal__icon--dim"
                      aria-hidden="true"
                    />
                    <span className="wallet-modal__name wallet-modal__name--dim">
                      {d.name}
                    </span>
                    <span className="wallet-modal__install-badge">Install ↗</span>
                  </a>
                )}
              </li>
            );
          })}
        </ul>

        <p className="wallet-modal__hint">
          Albedo works in any browser — no extension needed.
        </p>
      </div>
    </dialog>
  );
}
