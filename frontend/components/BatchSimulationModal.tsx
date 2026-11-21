"use client";

import {
  type BatchSimulationSummary,
  type BatchExecutionResult,
} from "@/lib/batch";

export interface BatchSimulationModalProps {
  isOpen: boolean;
  onClose: () => void;
  simulation: BatchSimulationSummary | null;
  isLoading: boolean;
  isExecuting: boolean;
  progressText: string;
  onConfirmSubmit: () => Promise<void>;
  executionResult: BatchExecutionResult | null;
}

function stroopsToXlm(stroopsStr: string): string {
  try {
    const val = BigInt(stroopsStr);
    const whole = val / 10000000n;
    const rem = val % 10000000n;
    return `${whole}.${rem.toString().padStart(7, "0").slice(0, 4)} XLM`;
  } catch {
    return `${stroopsStr} stroops`;
  }
}

export default function BatchSimulationModal({
  isOpen,
  onClose,
  simulation,
  isLoading,
  isExecuting,
  progressText,
  onConfirmSubmit,
  executionResult,
}: BatchSimulationModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-header">
          <h2>
            {simulation?.action === "withdraw_max"
              ? "⚡ Batch Withdraw Max: Simulation Preview"
              : "⚠️ Batch Cancel: Simulation Preview"}
          </h2>
          {!isExecuting && (
            <button
              type="button"
              className="btn-text"
              onClick={onClose}
              aria-label="Close modal"
            >
              ✕
            </button>
          )}
        </div>

        {isLoading && (
          <div className="modal-loading">
            <p className="muted">Simulating transactions against on-chain ledger state…</p>
          </div>
        )}

        {!isLoading && simulation && !executionResult && (
          <div className="modal-body">
            <div className="simulation-mode-banner">
              <strong>Execution Engine: </strong>
              {simulation.executionMode === "contract_batch" ? (
                <span className="badge-atomic">Atomic Contract Batch (#9/#3)</span>
              ) : (
                <span className="badge-fallback">
                  Verified Sequential Fallback (atomic batch unmerged)
                </span>
              )}
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Each transaction will be simulated and verified against fresh ledger state
                prior to signing to prevent stale execution races.
              </p>
            </div>

            <h3>Individual Simulation Footprint</h3>
            <div className="table-responsive">
              <table className="sim-table">
                <thead>
                  <tr>
                    <th>Stream</th>
                    <th>Action</th>
                    <th>Est. Fee</th>
                    <th>CPU Instr.</th>
                    <th>RAM</th>
                    <th>Claimable / Effect</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.items.map((item) => (
                    <tr key={item.streamId}>
                      <td className="mono">#{item.streamId}</td>
                      <td className="mono">{item.action}</td>
                      <td className="mono">{stroopsToXlm(item.estimatedFeeStroops)}</td>
                      <td className="mono">{item.cpuInstructions.toLocaleString()}</td>
                      <td className="mono">{item.ramBytes} B</td>
                      <td className="mono">
                        {item.action === "withdraw_max"
                          ? item.claimableAmount > 0n
                            ? `${item.claimableAmount.toString()} units`
                            : "0 (empty)"
                          : "Pro-rata split"}
                      </td>
                      <td>
                        {item.status === "ready" && (
                          <span className="sim-badge badge-ready">READY</span>
                        )}
                        {item.status === "ineligible" && (
                          <span
                            className="sim-badge badge-ineligible"
                            title={item.error}
                          >
                            INELIGIBLE
                          </span>
                        )}
                        {item.status === "failed" && (
                          <span
                            className="sim-badge badge-failed"
                            title={item.error}
                          >
                            ERROR
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {simulation.ineligibleCount > 0 && (
              <p className="err" style={{ margin: "12px 0 0" }}>
                ⚠️ {simulation.ineligibleCount} stream(s) are ineligible and will be skipped
                automatically to prevent failed transactions.
              </p>
            )}

            <div className="aggregate-panel">
              <h4>📊 Aggregate Total Footprint</h4>
              <div className="aggregate-grid">
                <div>
                  <span className="muted">Actionable Streams</span>
                  <strong>{simulation.validCount} / {simulation.items.length}</strong>
                </div>
                {simulation.action === "withdraw_max" && (
                  <div>
                    <span className="muted">Total Claimable</span>
                    <strong>{simulation.totalAmountClaimable.toString()} units</strong>
                  </div>
                )}
                <div>
                  <span className="muted">Estimated Total Fee</span>
                  <strong>{stroopsToXlm(simulation.totalFeeStroops)}</strong>
                </div>
              </div>
            </div>

            {isExecuting && (
              <div className="execution-progress">
                <div className="progress-bar">
                  <div className="progress-bar-fill" />
                </div>
                <p className="muted mono">{progressText}</p>
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={isExecuting}
                onClick={onClose}
              >
                Back / Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={simulation.validCount === 0 || isExecuting}
                onClick={() => void onConfirmSubmit()}
              >
                {isExecuting
                  ? "Processing…"
                  : `Confirm & Sign (${simulation.validCount} streams)`}
              </button>
            </div>
          </div>
        )}

        {executionResult && (
          <div className="modal-result">
            <h3>Batch Execution Complete</h3>
            <p className="muted">
              Mode: <code>{executionResult.mode}</code> &bull; Total: {executionResult.total}
            </p>

            {executionResult.failed.length > 0 && executionResult.succeeded.length > 0 && (
              <div
                className="batch-warning"
                style={{ textAlign: "left", margin: "14px 0" }}
                role="status"
              >
                <strong>⚠️ Partial Batch Success (Mixed Outcome)</strong>
                <p style={{ margin: "4px 0 0", fontSize: "13px" }}>
                  Soroban batch actions are non-atomic. Some operations succeeded, but others reverted on-chain.
                </p>
              </div>
            )}

            <div className="result-stats">
              <div className="ok">
                <strong>{executionResult.succeeded.length}</strong> Succeeded
              </div>
              {executionResult.failed.length > 0 && (
                <div className="err">
                  <strong>{executionResult.failed.length}</strong> Failed / Reverted
                </div>
              )}
              {executionResult.staleSkipped.length > 0 && (
                <div className="muted">
                  <strong>{executionResult.staleSkipped.length}</strong> Skipped (Stale)
                </div>
              )}
            </div>

            {executionResult.results && executionResult.results.length > 0 && (
              <div className="table-responsive" style={{ margin: "16px 0", textAlign: "left" }}>
                <table className="sim-table">
                  <thead>
                    <tr>
                      <th>Stream</th>
                      <th>Outcome</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executionResult.results.map((res) => (
                      <tr key={res.streamId}>
                        <td className="mono">#{res.streamId}</td>
                        <td>
                          {res.status === "success" && (
                            <span className="sim-badge badge-ready">SUCCESS</span>
                          )}
                          {res.status === "failed" && (
                            <span className="sim-badge badge-failed">REVERTED</span>
                          )}
                          {res.status === "stale_skipped" && (
                            <span className="sim-badge badge-ineligible">SKIPPED</span>
                          )}
                        </td>
                        <td className="muted mono" style={{ fontSize: "12px" }}>
                          {res.status === "success" &&
                            (res.paid ? `Paid ${res.paid} units` : "Confirmed on-chain")}
                          {res.status === "failed" && (res.error ?? "Transaction reverted")}
                          {res.status === "stale_skipped" && (res.error ?? "State changed mid-selection")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

