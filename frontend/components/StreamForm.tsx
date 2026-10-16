"use client";

import { useState } from "react";
import {
  NATIVE_XLM,
  tokenContractId,
  type StreamArgs,
} from "@/lib/stellar";

/** Asset choices on the create form: native XLM, or a token contract id. */
type AssetChoice = "native" | "contract";

export default function StreamForm({
  onCreate,
}: {
  onCreate: (args: StreamArgs) => Promise<void>;
}) {
  const [asset, setAsset] = useState<AssetChoice>("native");
  const [args, setArgs] = useState<StreamArgs>({
    token: "",
    recipient: "",
    deposit: "1000000000",
    days: "30",
    cancelable: true,
  });
  const [busy, setBusy] = useState(false);

  const set =
    (k: keyof StreamArgs) =>
    (
      e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
    ) =>
      setArgs((prev) => ({
        ...prev,
        [k]: k === "cancelable" ? (e.target as HTMLSelectElement).value === "yes" : e.target.value,
      }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Native XLM streams through its Stellar Asset Contract; the contract
      // only ever sees a token contract id either way.
      await onCreate({
        ...args,
        token: asset === "native" ? NATIVE_XLM : args.token.trim(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Create a stream</h2>
      <div className="row">
        <div>
          <label htmlFor="asset">Asset</label>
          <select
            id="asset"
            value={asset}
            onChange={(e) => setAsset(e.target.value as AssetChoice)}
          >
            <option value="native">Native XLM</option>
            <option value="contract">Token contract (USDC-style)</option>
          </select>
        </div>
        {asset === "contract" && (
          <div>
            <label htmlFor="token">Token contract id</label>
            <input
              id="token"
              type="text"
              required
              placeholder="C… (asset's Stellar Asset Contract id)"
              value={args.token}
              onChange={set("token")}
            />
          </div>
        )}
        <div>
          <label htmlFor="recipient">Recipient</label>
          <input
            id="recipient"
            type="text"
            required
            placeholder="G…"
            value={args.recipient}
            onChange={set("recipient")}
          />
        </div>
      </div>
      {asset === "native" && (
        <p className="muted mono" style={{ wordBreak: "break-all" }}>
          Native XLM streams through its Stellar Asset Contract: {tokenContractId(NATIVE_XLM)}
        </p>
      )}
      <div className="row">
        <div>
          <label htmlFor="deposit">Deposit (smallest units)</label>
          <input
            id="deposit"
            type="number"
            min="1"
            required
            value={args.deposit}
            onChange={set("deposit")}
          />
        </div>
        <div>
          <label htmlFor="days">Duration (days)</label>
          <input
            id="days"
            type="number"
            min="0.001"
            step="any"
            required
            value={args.days}
            onChange={set("days")}
          />
        </div>
        <div>
          <label htmlFor="cancelable">Recipient may cancel?</label>
          <select id="cancelable" value={args.cancelable ? "yes" : "no"} onChange={set("cancelable")}>
            <option value="yes">Yes (cancelable)</option>
            <option value="no">No (sender-only)</option>
          </select>
        </div>
      </div>
      <p className="muted">
        Amounts are in smallest units (7 decimals for XLM and testnet USDC).
        The UI checks the token allowance first and asks Freighter to approve
        the deposit only when it is short — expect one or two signatures.
      </p>
      <button type="submit" disabled={busy}>
        {busy ? "Streaming…" : "Create stream"}
      </button>
    </form>
  );
}
