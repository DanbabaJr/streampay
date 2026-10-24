"use client";

import React, { useState, useEffect } from "react";
import type { StreamView } from "@/lib/stellar";
import {
  computeRateBucket,
  computeDurationBucket,
  coarsenToUtcDay,
} from "@/lib/discovery/bucketing";
import {
  signConsentWithFreighter,
  signWithdrawWithFreighter,
  submitDiscoveryListing,
  withdrawDiscoveryListing,
} from "@/lib/discovery/client";
import {
  getDefaultNetwork,
  getDefaultContractId,
} from "@/lib/discovery/service";

interface DiscoveryConsentModalProps {
  stream: StreamView;
  currentUserAddress: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function DiscoveryConsentModal({
  stream,
  currentUserAddress,
  isOpen,
  onClose,
  onSuccess,
}: DiscoveryConsentModalProps) {
  const [shareAddress, setShareAddress] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [successMsg, setSuccessMsg] = useState<string>("");
  const [pendingProposal, setPendingProposal] = useState<{
    streamId: string;
    nonce: string;
    expiry: number;
    initiatorConsent: {
      address: string;
      signature: string;
      shareAddress: boolean;
    };
  } | null>(null);
  const [existingListingId, setExistingListingId] = useState<string | null>(null);

  const durationSecs = Math.max(1, stream.endTime - stream.startTime);
  const rateBucket = computeRateBucket(stream.deposit, durationSecs);
  const durationBucket = computeDurationBucket(durationSecs);
  const coarsenedDay = coarsenToUtcDay(stream.startTime);

  const isSender = currentUserAddress === stream.sender;
  const isRecipient = currentUserAddress === stream.recipient;
  const isAuthorized = isSender || isRecipient;

  // Check for pending proposals or active listings
  useEffect(() => {
    if (!isOpen || !stream.id) return;
    let ignore = false;

    async function checkProposal() {
      try {
        const propRes = await fetch(`/api/listings/propose?streamId=${stream.id}`);
        if (propRes.ok && !ignore) {
          const data = await propRes.json();
          if (data.proposal) {
            setPendingProposal(data.proposal);
          }
        }
      } catch {
        // ignore
      }
    }

    void checkProposal();
    return () => {
      ignore = true;
    };
  }, [isOpen, stream.id]);

  if (!isOpen) return null;

  async function handleSignConsent() {
    setError("");
    setSuccessMsg("");
    setLoading(true);

    try {
      const network = getDefaultNetwork();
      const contractId = getDefaultContractId();
      const now = Math.floor(Date.now() / 1000);

      // If counterparty already initiated a proposal, use their nonce and expiry
      if (pendingProposal && pendingProposal.initiatorConsent.address !== currentUserAddress) {
        const myConsent = await signConsentWithFreighter({
          signerAddress: currentUserAddress,
          network,
          contractId,
          streamId: stream.id,
          nonce: pendingProposal.nonce,
          expiry: pendingProposal.expiry,
          shareAddress,
        });

        // Determine who is sender and who is recipient
        const senderConsent = isSender ? myConsent : pendingProposal.initiatorConsent;
        const recipientConsent = isRecipient ? myConsent : pendingProposal.initiatorConsent;

        // Both parties have consented! Publish to directory
        const published = await submitDiscoveryListing({
          streamId: stream.id,
          nonce: pendingProposal.nonce,
          expiry: pendingProposal.expiry,
          senderConsent,
          recipientConsent,
        });

        setExistingListingId(published.listingId);
        setPendingProposal(null);
        setSuccessMsg("Listing successfully verified and published to the Discovery Directory!");
        if (onSuccess) onSuccess();
      } else {
        // We are the first party to sign. Create a new proposal
        const nonce = `prop-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`;
        const expiry = now + 7 * 86400; // 7 days

        const myConsent = await signConsentWithFreighter({
          signerAddress: currentUserAddress,
          network,
          contractId,
          streamId: stream.id,
          nonce,
          expiry,
          shareAddress,
        });

        // Save proposal
        const res = await fetch("/api/listings/propose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            streamId: stream.id,
            nonce,
            expiry,
            initiatorConsent: myConsent,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to save proposal");
        }

        setPendingProposal({
          streamId: stream.id,
          nonce,
          expiry,
          initiatorConsent: myConsent,
        });
        setSuccessMsg(
          "Your consent signature was registered! Waiting for the counterparty to sign and finalize publication."
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw() {
    if (!existingListingId) {
      setError("No active listing ID found to withdraw.");
      return;
    }
    setError("");
    setSuccessMsg("");
    setLoading(true);

    try {
      const network = getDefaultNetwork();
      const contractId = getDefaultContractId();
      const now = Math.floor(Date.now() / 1000);
      const nonce = `wth-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`;

      const withdrawPayload = await signWithdrawWithFreighter({
        signerAddress: currentUserAddress,
        network,
        contractId,
        streamId: stream.id,
        listingId: existingListingId,
        nonce,
        timestamp: now,
      });

      await withdrawDiscoveryListing(withdrawPayload);

      setExistingListingId(null);
      setSuccessMsg("Listing has been immediately withdrawn and removed from the directory.");
      if (onSuccess) onSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(10, 14, 22, 0.85)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "16px",
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: "560px",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "20px" }}>Discovery Directory Listing</h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--muted)",
              fontSize: "18px",
              padding: "4px 8px",
              margin: 0,
            }}
          >
            ✕
          </button>
        </div>

        <p className="muted" style={{ margin: "10px 0 16px" }}>
          Publish an anonymized, verifiable proof of this payment stream to the public directory.
          Dual cryptographic consent is required from both sender and recipient.
        </p>

        {/* Live Payload Preview */}
        <div
          style={{
            background: "#0d1320",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            padding: "14px",
            marginBottom: "16px",
          }}
        >
          <div style={{ fontSize: "12px", textTransform: "uppercase", color: "var(--muted)", marginBottom: "8px" }}>
            Listing Preview (Allowlisted Fields Only)
          </div>
          <table style={{ fontSize: "13px" }}>
            <tbody>
              <tr>
                <td style={{ color: "var(--muted)" }}>Asset</td>
                <td className="mono">{stream.token}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--muted)" }}>Flow Rate Band</td>
                <td>
                  <span className="status-badge" style={{ background: "#312e81", color: "#c7d2fe" }}>
                    {rateBucket}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={{ color: "var(--muted)" }}>Duration Band</td>
                <td>
                  <span className="status-badge" style={{ background: "#1e293b", color: "#94a3b8" }}>
                    {durationBucket}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={{ color: "var(--muted)" }}>Listed Date</td>
                <td className="mono">{coarsenedDay} (Coarsened to UTC day)</td>
              </tr>
              <tr>
                <td style={{ color: "var(--muted)" }}>Stream ID</td>
                <td style={{ color: "var(--green)" }}>Protected (Never Published)</td>
              </tr>
              <tr>
                <td style={{ color: "var(--muted)" }}>Exact Amounts</td>
                <td style={{ color: "var(--green)" }}>Protected (Aggregated into Bands)</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Address Disclosure Opt-In */}
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "16px",
            background: shareAddress ? "rgba(139, 124, 255, 0.08)" : "transparent",
          }}
        >
          <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", margin: 0, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={shareAddress}
              onChange={(e) => setShareAddress(e.target.checked)}
              style={{ marginTop: "4px" }}
            />
            <div>
              <div style={{ fontWeight: 600, color: "var(--text)" }}>
                Share my Stellar address publicly
              </div>
              <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
                Off by default. Your address will ONLY appear if <strong>both</strong> you and the
                counterparty explicitly enable this option.
              </div>
            </div>
          </label>
        </div>

        {/* Proposal / Status Feedback */}
        {pendingProposal && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "6px",
              background: "rgba(57, 197, 255, 0.12)",
              color: "var(--accent2)",
              fontSize: "13px",
              marginBottom: "12px",
            }}
          >
            {pendingProposal.initiatorConsent.address === currentUserAddress
              ? "You have signed this proposal. Waiting for counterparty co-signature."
              : "Counterparty has signed the proposal! Sign below to finalize and publish immediately."}
          </div>
        )}

        {error && <p className="err" style={{ marginBottom: "12px" }}>{error}</p>}
        {successMsg && <p className="ok" style={{ marginBottom: "12px" }}>{successMsg}</p>}

        {/* Actions */}
        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--muted)",
              border: "1px solid var(--line)",
            }}
          >
            Close
          </button>

          {existingListingId ? (
            <button
              type="button"
              disabled={loading}
              onClick={handleWithdraw}
              style={{
                background: "var(--red)",
                color: "#fff",
              }}
            >
              {loading ? "Revoking..." : "Withdraw Listing (Unilateral)"}
            </button>
          ) : (
            <button
              type="button"
              disabled={loading || !isAuthorized}
              onClick={handleSignConsent}
            >
              {loading
                ? "Signing..."
                : pendingProposal && pendingProposal.initiatorConsent.address !== currentUserAddress
                ? "Co-Sign & Publish"
                : "Sign Consent with Freighter"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
