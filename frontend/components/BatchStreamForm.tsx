"use client";

import { useState } from "react";
import { parseBatchCsv, type BatchStreamEntry } from "@/lib/batch";

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
  const [csv, setCsv] = useState("");
  const [cancelable, setCancelable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    <form className="card" onSubmit={submit}>
      <h2>Create payroll batch</h2>
      <label htmlFor="batch-token">Token contract id (shared by all rows)</label>
      <input
        id="batch-token"
        type="text"
        required
        placeholder="C… (SAC id)"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <label htmlFor="batch-csv">CSV rows: address,rate,duration</label>
      <textarea
        id="batch-csv"
        required
        rows={7}
        placeholder={"address,rate,duration\nG…,1000,2592000"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <div className="row">
        <div>
          <label htmlFor="batch-cancelable">Recipients may cancel?</label>
          <select
            id="batch-cancelable"
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
      {error && <p className="err">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Creating batch…" : "Create batch"}
      </button>
    </form>
  );
}
