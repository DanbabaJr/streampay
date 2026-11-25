"use client";

import {
  FEE_PERCENTILE_KEYS,
  FEE_PERCENTILE_LABELS,
  feeAt,
  type FeePercentileKey,
} from "@/lib/fee-stats";
import type { UseClaimSchedulerResult } from "@/lib/use-claim-scheduler";
import type { StreamView } from "@/lib/stellar";

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "…" : n.toLocaleString("en-US");
}

function reasonText(reason: string): string {
  switch (reason) {
    case "fee-below-threshold":
      return "submitted — fee under budget";
    case "deadline-fallback":
      return "submitted — deadline reached (fees never dropped)";
    case "intent-expiring":
      return "submitted — signature was about to expire";
    case "fee-above-threshold":
      return "waiting — fee above budget";
    case "awaiting-signature":
      return "waiting — needs a signature";
    case "signature-expired":
      return "signature expired — needs re-signing";
    case "too-early":
      return "waiting — nothing accrued yet";
    case "disabled":
      return "off";
    default:
      return reason.replace(/-/g, " ");
  }
}

/**
 * Settings + queue panel for opt-in fee-aware claim scheduling. Rendered on
 * the stream detail page for the recipient of an active stream.
 */
export default function ClaimSchedulerSettings({
  stream,
  scheduler,
}: {
  stream: StreamView;
  scheduler: UseClaimSchedulerResult;
}) {
  const {
    policy,
    fee,
    claims,
    lastEvaluation,
    error,
    updatePolicy,
    scheduleClaim,
    cancelClaim,
    resignClaim,
    submitNow,
  } = scheduler;

  const streamClaims = claims.filter((c) => c.streamId === stream.id);
  const hasPending = streamClaims.some((c) => c.status === "pending");
  const feeValue = fee ? feeAt(fee.soroban, policy.percentile) : null;
  const underBudget =
    feeValue !== null && feeValue <= policy.maxFeeStroops && policy.enabled;

  return (
    <section className="card">
      <h2>Fee-aware claim scheduling</h2>
      <p className="muted">
        Opt in to defer your claim: StreamPay signs one <code>withdraw_max</code>{" "}
        and submits it only when the Soroban inclusion-fee percentile is at or
        under your budget. If fees never drop, the claim is submitted anyway
        before the stream matures — funds are never lost either way, because the
        deposit stays in the contract until withdrawn.
      </p>

      <div className="row">
        <label className="sched-check">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(e) => updatePolicy({ enabled: e.target.checked })}
          />
          <span>Enable scheduled claims</span>
        </label>
      </div>

      <div className="sched-grid">
        <div>
          <label htmlFor="sched-percentile">Fee percentile</label>
          <select
            id="sched-percentile"
            value={policy.percentile}
            onChange={(e) =>
              updatePolicy({ percentile: e.target.value as FeePercentileKey })
            }
          >
            {FEE_PERCENTILE_KEYS.map((key) => (
              <option key={key} value={key}>
                {FEE_PERCENTILE_LABELS[key]}
              </option>
            ))}
          </select>
          <p className="muted">Percentile of the Soroban inclusion-fee distribution.</p>
        </div>
        <div>
          <label htmlFor="sched-threshold">Max fee (stroops)</label>
          <input
            id="sched-threshold"
            type="number"
            min="1"
            value={policy.maxFeeStroops}
            onChange={(e) =>
              updatePolicy({ maxFeeStroops: Number(e.target.value) || 0 })
            }
          />
          <p className="muted">Submit only when the percentile is ≤ this value.</p>
        </div>
        <div>
          <label htmlFor="sched-deadline">Deadline lead (minutes)</label>
          <input
            id="sched-deadline"
            type="number"
            min="0"
            value={Math.round(policy.deadlineLeadSeconds / 60)}
            onChange={(e) =>
              updatePolicy({
                deadlineLeadSeconds: Math.max(0, Number(e.target.value) || 0) * 60,
              })
            }
          />
          <p className="muted">
            Submit regardless of fee this long before the stream matures.
          </p>
        </div>
        <div>
          <label htmlFor="sched-validity">Signature window (minutes)</label>
          <input
            id="sched-validity"
            type="number"
            min="1"
            value={Math.round(policy.intentValiditySeconds / 60)}
            onChange={(e) =>
              updatePolicy({
                intentValiditySeconds:
                  Math.max(60, (Number(e.target.value) || 1) * 60),
              })
            }
          />
          <p className="muted">
            How long a signed claim stays valid before it needs re-signing.
          </p>
        </div>
      </div>

      <div className="row sched-status">
        <span className="mono">
          ledger {fee?.ledger ?? "…"} · {policy.percentile} ={" "}
          {fmt(feeValue)} stroops
        </span>
        <span className={underBudget ? "ok" : "muted"}>
          budget {fmt(policy.maxFeeStroops)} ·{" "}
          {underBudget ? "under budget" : "over budget"}
        </span>
        {lastEvaluation && (
          <span className="muted">last: {reasonText(lastEvaluation.reason)}</span>
        )}
      </div>

      {error && <p className="err">{error}</p>}

      <div className="row">
        <button
          type="button"
          disabled={!policy.enabled || hasPending || stream.status !== "Active"}
          onClick={() => void scheduleClaim(stream)}
        >
          {hasPending ? "Claim queued" : "Schedule claim"}
        </button>
      </div>

      {streamClaims.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Claim</th>
              <th>Status</th>
              <th>Signature</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {streamClaims.map((c) => {
              const sig =
                c.signedValidUntil === null
                  ? "none"
                  : new Date(c.signedValidUntil * 1000).toISOString();
              return (
                <tr key={c.id}>
                  <td className="mono">{c.id.slice(0, 8)}</td>
                  <td>
                    <span className={`status-badge status-${c.status}`}>
                      {c.status}
                    </span>
                    {c.txHash && (
                      <div className="mono muted">{c.txHash.slice(0, 12)}…</div>
                    )}
                    {c.lastError && <div className="err">{c.lastError}</div>}
                  </td>
                  <td className="mono">{sig}</td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        disabled={c.status !== "pending"}
                        onClick={() => void resignClaim(c.id)}
                      >
                        Re-sign
                      </button>
                      <button
                        type="button"
                        disabled={c.status !== "pending"}
                        onClick={() => void submitNow(c.id)}
                      >
                        Submit now
                      </button>
                      <button
                        type="button"
                        disabled={c.status !== "pending"}
                        onClick={() => cancelClaim(c.id)}
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
