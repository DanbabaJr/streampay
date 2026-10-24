/**
 * Passkey registration and stream claim page — Issue #70.
 *
 * Non-custodial recipients without a browser-extension wallet can:
 * 1. Register a device passkey bound to their Stellar address.
 * 2. Claim accrued stream funds by authenticating with their passkey.
 *
 * Security notes: see contracts/passkey-signer/src/lib.rs.
 */
"use client";

import React, { useState } from "react";
import { registerPasskey, loginWithPasskey, isPasskeyRegistered } from "../../lib/passkey";

type Step = "idle" | "registering" | "registered" | "logging-in" | "claimed" | "error";

export default function PasskeyPage() {
  const [owner, setOwner] = useState("");
  const [requireUV, setRequireUV] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function handleRegister() {
    if (!owner.trim()) return;
    setStep("registering");
    setMessage(null);
    try {
      const result = await registerPasskey(owner.trim(), requireUV);
      setTxHash(result.txHash);
      setStep("registered");
      setMessage(
        `Passkey registered. P-256 key x=${result.x.slice(0, 8)}… registered on-chain.`
      );
    } catch (e) {
      setStep("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClaim() {
    if (!owner.trim()) return;
    setStep("logging-in");
    setMessage(null);
    try {
      const registered = await isPasskeyRegistered(owner.trim());
      if (!registered) {
        setStep("error");
        setMessage("No passkey registered for this address. Register first.");
        return;
      }
      const result = await loginWithPasskey(owner.trim());
      setTxHash(result.txHash);
      setStep("claimed");
      setMessage("Assertion verified on-chain. Your stream claim has been processed.");
    } catch (e) {
      setStep("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  const busy = step === "registering" || step === "logging-in";

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Passkey Stream Claims</h1>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
        Claim streaming payments from your phone using a device-bound passkey —
        no browser extension wallet required.
      </p>

      {/* Security notes */}
      <details style={{ marginBottom: "1.5rem", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "0.75rem 1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.875rem", color: "#374151" }}>
          Security notes
        </summary>
        <ul style={{ marginTop: "0.5rem", paddingLeft: "1.25rem", fontSize: "0.825rem", color: "#6b7280", lineHeight: 1.7 }}>
          <li>
            <strong>Attestation</strong>: We register your P-256 key on-chain without
            verifying attestation. Attestation checks (FIDO MDS3) are recommended for
            high-security deployments and should be done off-chain before calling register.
          </li>
          <li>
            <strong>Assertion</strong>: Every claim performs full WebAuthn Level 3 assertion
            verification on-chain: rpId hash match, user-presence flag, challenge nonce
            (replay prevention), and P-256 ECDSA signature.
          </li>
          <li>
            <strong>Limitations</strong>: On-chain verification cannot confirm which specific
            device produced the credential or that user-verification occurred (unless you
            enable it below).
          </li>
        </ul>
      </details>

      {/* Address input */}
      <label htmlFor="owner-input" style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: "0.875rem" }}>
        Your Stellar address
      </label>
      <input
        id="owner-input"
        type="text"
        placeholder="G… or C…"
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        disabled={busy}
        style={{ width: "100%", padding: "0.5rem 0.75rem", borderRadius: 6, border: "1px solid #ccc", fontSize: "0.95rem", boxSizing: "border-box", marginBottom: "1rem" }}
        aria-label="Stellar address"
      />

      {/* UV option */}
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1.5rem", fontSize: "0.875rem", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={requireUV}
          onChange={(e) => setRequireUV(e.target.checked)}
          disabled={busy}
        />
        Require user verification (PIN / biometric) on every claim
      </label>

      {/* Actions */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          onClick={handleRegister}
          disabled={busy || !owner.trim()}
          style={btnStyle("#2563eb")}
          aria-label="Register passkey"
        >
          {step === "registering" ? "Registering…" : "Register passkey"}
        </button>
        <button
          onClick={handleClaim}
          disabled={busy || !owner.trim()}
          style={btnStyle("#16a34a")}
          aria-label="Claim with passkey"
        >
          {step === "logging-in" ? "Verifying…" : "Claim with passkey"}
        </button>
      </div>

      {/* Status */}
      {message && (
        <div
          role="status"
          style={{
            marginTop: "1.5rem",
            padding: "0.75rem 1rem",
            borderRadius: 6,
            background: step === "error" ? "#fef2f2" : "#f0fdf4",
            border: `1px solid ${step === "error" ? "#fca5a5" : "#86efac"}`,
            fontSize: "0.875rem",
            color: step === "error" ? "#dc2626" : "#15803d",
          }}
        >
          {message}
        </div>
      )}

      {txHash && (
        <p style={{ marginTop: "0.75rem", fontSize: "0.8rem", color: "#9ca3af" }}>
          Transaction: <span style={{ fontFamily: "monospace" }}>{txHash}</span>
        </p>
      )}
    </main>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "0.5rem 1.25rem",
    borderRadius: 6,
    background: bg,
    color: "#fff",
    border: "none",
    cursor: "pointer",
    fontSize: "0.95rem",
    fontWeight: 600,
  };
}
