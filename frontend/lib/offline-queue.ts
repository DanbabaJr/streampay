/**
 * Offline Pending Transaction Queue (Issue #92).
 *
 * Implements a stale-safe queue for signed-but-unsent Stellar Soroban transactions.
 * Refuses submissions with sequence number drift or expired ledger/time bounds.
 */

export type PendingTxAction = "withdraw" | "withdraw_max" | "top_up" | "cancel" | "create";

export type PendingTxStatus = "queued" | "submitting" | "confirmed" | "rejected";

export type RejectionReason =
  | "sequence_drift"
  | "expired_bounds"
  | "precondition_failed"
  | "network_mismatch";

export interface PendingTransaction {
  id: string;
  scope: string;
  action: PendingTxAction;
  streamId?: string;
  sourceAccount: string;
  sequenceNumber: string;
  signedXdr: string;
  minLedger?: number;
  maxLedger?: number;
  minTime?: number;
  maxTime?: number;
  createdAt: number;
  status: PendingTxStatus;
  rejectionReason?: RejectionReason;
  errorMessage?: string;
}

export interface PrecheckResult {
  valid: boolean;
  reason?: RejectionReason;
  message?: string;
}

const STORAGE_PREFIX = "streampay:offline-pending-tx:v1:";

function getStorageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

export function loadPendingTransactions(scope: string): PendingTransaction[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(getStorageKey(scope));
    if (!raw) return [];
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function savePendingTransactions(scope: string, items: PendingTransaction[]): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(getStorageKey(scope), JSON.stringify(items));
  } catch {
    // Quota failures are non-fatal
  }
}

export function enqueuePendingTransaction(
  scope: string,
  tx: Omit<PendingTransaction, "id" | "createdAt" | "status">
): PendingTransaction {
  const queue = loadPendingTransactions(scope);
  const newTx: PendingTransaction = {
    ...tx,
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Math.floor(Date.now() / 1000),
    status: "queued",
  };
  queue.push(newTx);
  savePendingTransactions(scope, queue);
  return newTx;
}

export function removePendingTransaction(scope: string, id: string): void {
  const queue = loadPendingTransactions(scope);
  const filtered = queue.filter((item) => item.id !== id);
  savePendingTransactions(scope, filtered);
}

/**
 * Validates a pending transaction against current ledger and account state before submission.
 * Refuses sequence drift and expired bounds to prevent failed fees and out-of-order execution.
 */
export function validatePreconditions(
  tx: PendingTransaction,
  currentAccountSeq: string,
  currentLedger: number,
  currentTimeSeconds: number
): PrecheckResult {
  const currentSeqNum = BigInt(currentAccountSeq);
  const txSeqNum = BigInt(tx.sequenceNumber);

  // 1. Sequence number drift check
  if (currentSeqNum >= txSeqNum) {
    return {
      valid: false,
      reason: "sequence_drift",
      message: `Account sequence number (${currentAccountSeq}) has drifted past the signed transaction sequence (${tx.sequenceNumber}). Transaction must be re-signed.`,
    };
  }

  // 2. Exact sequence adjacency check (Soroban txs must follow current sequence + 1)
  if (currentSeqNum + 1n !== txSeqNum) {
    return {
      valid: false,
      reason: "precondition_failed",
      message: `Transaction sequence (${tx.sequenceNumber}) is not the immediate successor to current account sequence (${currentAccountSeq}).`,
    };
  }

  // 3. Ledger bounds check
  if (tx.maxLedger !== undefined && currentLedger > tx.maxLedger) {
    return {
      valid: false,
      reason: "expired_bounds",
      message: `Transaction max ledger bound (${tx.maxLedger}) expired at current ledger (${currentLedger}).`,
    };
  }

  if (tx.minLedger !== undefined && currentLedger < tx.minLedger) {
    return {
      valid: false,
      reason: "precondition_failed",
      message: `Transaction min ledger bound (${tx.minLedger}) has not yet been reached at current ledger (${currentLedger}).`,
    };
  }

  // 4. Time bounds check
  if (tx.maxTime !== undefined && currentTimeSeconds > tx.maxTime) {
    return {
      valid: false,
      reason: "expired_bounds",
      message: `Transaction timebound expired at ${tx.maxTime} (current: ${currentTimeSeconds}).`,
    };
  }

  if (tx.minTime !== undefined && currentTimeSeconds < tx.minTime) {
    return {
      valid: false,
      reason: "precondition_failed",
      message: `Transaction timebound not yet active (minTime: ${tx.minTime}, current: ${currentTimeSeconds}).`,
    };
  }

  return { valid: true };
}

/**
 * Processes queued pending transactions for a given scope when connectivity returns.
 */
export async function processQueue(
  scope: string,
  currentAccountSeq: string,
  currentLedger: number,
  currentTimeSeconds: number,
  submitFn: (signedXdr: string) => Promise<{ success: boolean; hash?: string; error?: string }>
): Promise<{
  submitted: number;
  rejected: number;
  remaining: number;
  results: Array<{ id: string; status: PendingTxStatus; error?: string }>;
}> {
  const queue = loadPendingTransactions(scope);
  const results: Array<{ id: string; status: PendingTxStatus; error?: string }> = [];
  let submitted = 0;
  let rejected = 0;

  const nextQueue: PendingTransaction[] = [];
  let currentSeq = BigInt(currentAccountSeq);

  for (const tx of queue) {
    if (tx.status === "confirmed") {
      continue;
    }

    const precheck = validatePreconditions(tx, currentSeq.toString(), currentLedger, currentTimeSeconds);

    if (!precheck.valid) {
      tx.status = "rejected";
      tx.rejectionReason = precheck.reason;
      tx.errorMessage = precheck.message;
      rejected++;
      results.push({ id: tx.id, status: "rejected", error: precheck.message });
      nextQueue.push(tx);
      continue;
    }

    try {
      const res = await submitFn(tx.signedXdr);
      if (res.success) {
        tx.status = "confirmed";
        submitted++;
        currentSeq = BigInt(tx.sequenceNumber);
        results.push({ id: tx.id, status: "confirmed" });
      } else {
        tx.status = "rejected";
        tx.errorMessage = res.error || "Submission failed";
        rejected++;
        results.push({ id: tx.id, status: "rejected", error: tx.errorMessage });
        nextQueue.push(tx);
      }
    } catch (err) {
      tx.status = "queued";
      tx.errorMessage = err instanceof Error ? err.message : String(err);
      results.push({ id: tx.id, status: "queued", error: tx.errorMessage });
      nextQueue.push(tx);
      break;
    }
  }

  savePendingTransactions(scope, nextQueue);

  return {
    submitted,
    rejected,
    remaining: nextQueue.filter((t) => t.status === "queued").length,
    results,
  };
}
