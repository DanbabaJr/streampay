"use client";

import { useEffect, useId, useState } from "react";
import { parseBatchCsv, type BatchStreamEntry } from "@/lib/batch";
import { fetchAssetMeta, type AssetMeta } from "@/lib/stellar";
import { formatAmount } from "@/lib/format";

export default function BatchStreamForm({
  onCreate,
}: {
  onCreate: (
    token: string,
    entries: BatchStreamEntry[],
    cancelable: boolean
  ) => Promise<boolean>;
}) {
  const [token, setToken] = useState("");
  const [loadedMeta, setLoadedMeta] = useState<AssetMeta | null>(null);
  const [csv, setCsv] = useState("");
  const [cancelable, setCancelable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const assetMeta: AssetMeta = loadedMeta ?? { code: "TOKEN", decimals: 7 };

  useEffect(() => {
    let active = true;
    const trimmed = token.trim();
    if (trimmed) {
      fetchAssetMeta(trimmed).then((meta) => {
        if (active) setLoadedMeta(meta);
      });
    }
    return () => {
      active = false;
    };
  }, [token]);

  // Stable IDs for ARIA associations (WCAG 1.3.1 / 4.1.2)
  const formId = useId();
  const headingId = `${formId}-heading`;
  const formDescId = `${formId}-desc`;
  const tokenId = `${formId}-token`;
  const tokenHintId = `${formId}-token-hint`;
  const csvId = `${formId}-csv`;
  const csvHintId = `${formId}-csv-hint`;
  const cancelableId = `${formId}-cancelable`;
  const errorId = `${formId}-error`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    let entries: BatchStreamEntry[];
    try {
      entries = parseBatchCsv(csv);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setBusy(true);
    try {
      if (await onCreate(token.trim(), entries, cancelable)) {
        setCsv("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card"
      onSubmit={submit}
      aria-labelledby={headingId}
      aria-describedby={formDescId}
      noValidate
    >
      <h2 id={headingId}>Create payroll batch</h2>

      <p id={formDescId} className="sr-only">
        Create multiple payment streams at once by providing a shared token
        contract and a CSV list of recipients. Required fields are marked with
        an asterisk (*).
      </p>

      {/* Token contract field */}
      <label htmlFor={tokenId}>
        Token contract id (shared by all rows){" "}
        <span aria-hidden="true">*</span>
        <span className="sr-only">(required)</span>
      </label>
      <input
        id={tokenId}
        type="text"
        required
        placeholder="C… (SAC id)"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        aria-describedby={tokenHintId}
        autoComplete="off"
      />
      <span id={tokenHintId} className="sr-only">
        The Stellar Asset Contract ID shared by every stream in this batch.
        Starts with the letter C.
      </span>

      {/* CSV field */}
      <label htmlFor={csvId}>
        CSV rows: address,rate,duration{" "}
        <span aria-hidden="true">*</span>
        <span className="sr-only">(required)</span>
      </label>
      <textarea
        id={csvId}
        required
        rows={7}
        placeholder={"address,rate,duration\nG…,1000,2592000"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        aria-describedby={`${csvHintId}${error ? ` ${errorId}` : ""}`}
        aria-invalid={error ? true : undefined}
      />
      <span id={csvHintId} className="sr-only">
        One recipient per line. Columns: Stellar public key, rate in smallest
        token units per second, duration in seconds. Include a header row
        (address,rate,duration) or start directly with data rows.
      </span>

      {/* Cancelable select */}
      <div className="row">
        <div>
          <label htmlFor={cancelableId}>Recipients may cancel?</label>
          <select
            id={cancelableId}
            value={cancelable ? "yes" : "no"}
            onChange={(e) => setCancelable(e.target.value === "yes")}
          >
            <option value="yes">Yes (cancelable)</option>
            <option value="no">No (sender-only)</option>
          </select>
        </div>
      </div>

      <p className="muted">
        Rate is in smallest token units per second; duration is in seconds.
        Each deposit is rate × duration and starts immediately. Approve the
        summed deposits (plus any configured fees) before submitting. The
        contract applies this batch atomically.
      </p>

      {(() => {
        let previewEntries: BatchStreamEntry[] = [];
        try {
          if (csv.trim()) {
            previewEntries = parseBatchCsv(csv);
          }
        } catch {
          // Incomplete input while typing
        }

        if (previewEntries.length === 0) return null;

        const totalDeposit = previewEntries.reduce(
          (sum, e) => sum + BigInt(e.deposit),
          0n
        );

        return (
          <div
            className="stream-preview"
            style={{
              background: "rgba(255, 255, 255, 0.02)",
              border: "1px solid var(--line)",
              borderRadius: "8px",
              padding: "12px 16px",
              marginTop: "14px",
              marginBottom: "14px",
            }}
            aria-label="Batch stream preview"
          >
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "var(--accent2)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: "8px",
              }}
            >
              Batch Preview
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "12px",
              }}
            >
              <div>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Total Batch Deposit
                </div>
                <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  {formatAmount(totalDeposit, assetMeta.decimals)} {assetMeta.code}
                </div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Streams in Batch
                </div>
                <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  {previewEntries.length} stream{previewEntries.length === 1 ? "" : "s"}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Error — role="alert" so SR reads it immediately (WCAG 4.1.3) */}
      {error && (
        <p id={errorId} className="err" role="alert" aria-live="assertive">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Creating batch…" : "Create batch"}
      </button>
    </form>
  );
}
