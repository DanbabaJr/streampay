"use client";

import Link from "next/link";
import { useState } from "react";
import { isNativeXlm, type StreamView } from "@/lib/stellar";

export default function StreamList({
  streams,
  onWithdraw,
  onWithdrawMax,
  onTopUp,
  onCancel,
  onRefresh,
}: {
  streams: StreamView[];
  onWithdraw: (id: string, amount: string) => Promise<void>;
  onWithdrawMax: (id: string) => Promise<void>;
  onTopUp: (id: string, amount: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
  onRefresh: (id: string) => void | Promise<void>;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  if (streams.length === 0) {
    return (
      <p className="muted">
        No streams loaded yet. Create one above, fetch one by id, or use
        “Discover on-chain” to scan the contract&apos;s address indexes.
      </p>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Token</th>
          <th>Recipient</th>
          <th>Deposit</th>
          <th>Withdrawn</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {streams.map((s) => (
          <tr key={s.id}>
            <td className="mono">
              <Link href={`/stream/${s.id}`}>#{s.id}</Link>
            </td>
            <td className="mono" title={s.token}>
              {isNativeXlm(s.token) ? "XLM" : `${s.token.slice(0, 10)}…`}
            </td>
            <td className="mono">{s.recipient.slice(0, 8)}…</td>
            <td className="mono">{s.deposit}</td>
            <td className="mono">{s.withdrawn}</td>
            <td>
              <span className={`status-badge status-${s.status.toLowerCase()}`}>
                {s.status}
              </span>
            </td>
            <td>
              <div className="row">
                <input
                  type="number"
                  min="1"
                  placeholder="amount"
                  value={amounts[s.id] ?? ""}
                  onChange={(e) =>
                    setAmounts((prev) => ({ ...prev, [s.id]: e.target.value }))
                  }
                />
                <button onClick={() => onWithdraw(s.id, amounts[s.id] ?? "0")}>
                  Withdraw
                </button>
                <button
                  onClick={() => onWithdrawMax(s.id)}
                  title="Claim the entire accrued balance in one call"
                >
                  Max
                </button>
                <button onClick={() => onTopUp(s.id, amounts[s.id] ?? "0")}>
                  Top up
                </button>
                <button onClick={() => onCancel(s.id)}>Cancel</button>
                <button onClick={() => onRefresh(s.id)}>↻</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
