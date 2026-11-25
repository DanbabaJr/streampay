"use client";

import { type InvalidationNotice, type BatchActionType } from "@/lib/batch";

export interface BatchActionBarProps {
  selectedCount: number;
  invalidatedNotices: InvalidationNotice[];
  onClearInvalidated: () => void;
  onDeselectAll: () => void;
  onTriggerBatchAction: (action: BatchActionType) => void;
  isSimulating?: boolean;
}

export default function BatchActionBar({
  selectedCount,
  invalidatedNotices,
  onClearInvalidated,
  onDeselectAll,
  onTriggerBatchAction,
  isSimulating = false,
}: BatchActionBarProps) {
  if (selectedCount === 0 && invalidatedNotices.length === 0) {
    return null;
  }

  return (
    <div className="batch-container" aria-label="Batch operations bar">
      {invalidatedNotices.length > 0 && (
        <div className="batch-warning" role="alert">
          <div className="batch-warning-header">
            <strong>⚠️ Selection Warning (Live State Race Detected)</strong>
            <button
              type="button"
              className="btn-text"
              onClick={onClearInvalidated}
              aria-label="Dismiss warning"
            >
              ✕
            </button>
          </div>
          <ul className="batch-warning-list">
            {invalidatedNotices.map((notice) => (
              <li key={notice.id}>{notice.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="batch-action-bar">
          <div className="batch-summary">
            <span className="batch-badge">{selectedCount}</span>
            <span className="batch-text">
              {selectedCount === 1 ? "stream selected" : "streams selected"}
            </span>
          </div>

          <div className="batch-actions">
            <button
              type="button"
              className="btn-batch btn-withdraw"
              disabled={isSimulating}
              onClick={() => onTriggerBatchAction("withdraw_max")}
              title="Simulate and withdraw max accrued for all selected streams"
            >
              {isSimulating ? "Simulating..." : `Withdraw Max (${selectedCount})`}
            </button>

            <button
              type="button"
              className="btn-batch btn-cancel"
              disabled={isSimulating}
              onClick={() => onTriggerBatchAction("cancel")}
              title="Simulate and cancel all selected streams"
            >
              {isSimulating ? "Simulating..." : `Cancel (${selectedCount})`}
            </button>

            <button
              type="button"
              className="btn-batch btn-clear"
              onClick={onDeselectAll}
            >
              Deselect All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
