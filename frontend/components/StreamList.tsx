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
        &ldquo;Discover on-chain&rdquo; to scan the contract&apos;s address indexes.
      </p>
    );
  }

  return (
    <table>
      {/* Caption provides an accessible table summary (WCAG 1.3.1) */}
      <caption className="sr-only">Your payment streams</caption>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Token</th>
          <th scope="col">Recipient</th>
          <th scope="col">Deposit</th>
          <th scope="col">Withdrawn</th>
          <th scope="col">Status</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {streams.map((s) => {
          // Stable ID for the per-row amount input so label can reference it
          const amountInputId = `stream-amount-${s.id}`;

          return (
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
                {/* Status badge uses colour + text — WCAG 1.4.1 */}
                <span className={`status-badge status-${s.status.toLowerCase()}`}>
                  {s.status}
                </span>
              </td>
              <td>
                {/*
                 * role="group" with a label provides context for all the
                 * per-row buttons, satisfying WCAG 1.3.1 and 4.1.2.
                 * Each button has a unique aria-label incorporating the
                 * stream ID so AT can distinguish "Withdraw #1" from
                 * "Withdraw #2" (WCAG 2.4.6 Headings and Labels).
                 */}
                <div
                  className="row"
                  role="group"
                  aria-label={`Actions for stream #${s.id}`}
                >
                  {/* Visible label is sr-only; the stream ID in aria-label
                      above gives context; placeholder text gives visual hint */}
                  <label htmlFor={amountInputId} className="sr-only">
                    Amount for stream #{s.id} operations
                  </label>
                  <input
                    id={amountInputId}
                    type="number"
                    min="1"
                    placeholder="amount"
                    value={amounts[s.id] ?? ""}
                    onChange={(e) =>
                      setAmounts((prev) => ({
                        ...prev,
                        [s.id]: e.target.value,
                      }))
                    }
                    aria-label={`Amount for stream #${s.id}`}
                  />
                  <button
                    type="button"
                    onClick={() => onWithdraw(s.id, amounts[s.id] ?? "0")}
                    aria-label={`Withdraw from stream #${s.id}`}
                  >
                    Withdraw
                  </button>
                  <button
                    type="button"
                    onClick={() => onWithdrawMax(s.id)}
                    title="Claim the entire accrued balance in one call"
                    aria-label={`Withdraw maximum from stream #${s.id}`}
                  >
                    Max
                  </button>
                  <button
                    type="button"
                    onClick={() => onTopUp(s.id, amounts[s.id] ?? "0")}
                    aria-label={`Top up stream #${s.id}`}
                  >
                    Top up
                  </button>
                  <button
                    type="button"
                    onClick={() => onCancel(s.id)}
                    aria-label={`Cancel stream #${s.id}`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => onRefresh(s.id)}
                    aria-label={`Refresh stream #${s.id}`}
                  >
                    {/* The ↻ glyph is decorative; the aria-label above is
                        the accessible name (WCAG 4.1.2) */}
                    <span aria-hidden="true">↻</span>
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
